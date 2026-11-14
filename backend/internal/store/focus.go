package store

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"math"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Focus sessions: one timed block of allowed or blocked apps and sites.
// The rules here are mirrored by electron/focus-session.js so the Electron
// fallback store behaves the same as this backend.

// ISO-8601 UTC with milliseconds, as the shared contract requires.
const isoLayout = "2006-01-02T15:04:05.000Z07:00"

const (
	minSessionSeconds = 60
	maxSessionSeconds = 43200
	sessionListLimit  = 200
)

// Session is the running focus session. Times are UTC ISO strings and the
// lists are always arrays in JSON, never null.
type Session struct {
	ID         string   `json:"id"`
	Goal       string   `json:"goal"`
	Source     string   `json:"source"`
	Mode       string   `json:"mode"`
	Apps       []string `json:"apps"`
	Sites      []string `json:"sites"`
	AllowSites []string `json:"allowSites"`
	StartedAt  string   `json:"startedAt"`
	EndsAt     string   `json:"endsAt"`
}

// FocusData lives in the same JSON file as the rest of the data, under "focus".
type FocusData struct {
	Session         *Session `json:"session"`
	RestoreLockdown *bool    `json:"restoreLockdown"`
}

// SessionInput is the POST /api/v1/focus/session body. Nil list fields mean
// "use the saved lists for the chosen mode"; an explicit empty array is kept.
type SessionInput struct {
	Goal            string   `json:"goal"`
	Source          string   `json:"source"`
	DurationSeconds float64  `json:"durationSeconds"`
	Mode            string   `json:"mode"`
	Apps            []string `json:"apps"`
	Sites           []string `json:"sites"`
	AllowSites      []string `json:"allowSites"`
}

func newSessionID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(buf)
}

// Focus returns the current focus data, ending an expired session first.
func (s *Store) Focus() FocusData {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	return s.data.Focus
}

// StartSession validates the input and starts a session. A running session
// owned by a different source is returned as `conflict` with no changes made;
// the same source replaces its session. A validation problem is returned as err.
func (s *Store) StartSession(input SessionInput) (session *Session, conflict *Session, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	next, err := s.buildSession(input)
	if err != nil {
		return nil, nil, err
	}
	current := s.data.Focus.Session
	if current != nil && current.Source != next.Source {
		return nil, current, nil
	}
	if current == nil {
		restore := s.data.Settings.FocusLockdown
		s.data.Focus.RestoreLockdown = &restore
	}
	s.data.Focus.Session = next
	s.watchSessionLocked()
	s.scheduleLocked(true)
	return next, nil, nil
}

// EndSession ends the running session. "screen-time" (the desktop UI) ends any
// session; another source only ends its own. Returns the conflicting session
// when a different source owns the running one.
func (s *Store) EndSession(source string) (ended bool, conflict *Session, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	source = strings.TrimSpace(source)
	if source == "" {
		return false, nil, errors.New("source is required")
	}
	current := s.data.Focus.Session
	if current == nil {
		return false, nil, nil
	}
	if current.Source != source && source != "screen-time" {
		return false, current, nil
	}
	s.endSessionLocked()
	return true, nil, nil
}

// buildSession validates the input and fills omissions from the saved settings.
func (s *Store) buildSession(input SessionInput) (*Session, error) {
	source := strings.TrimSpace(input.Source)
	if source == "" {
		return nil, errors.New("source is required")
	}
	if len(source) > 64 {
		return nil, errors.New("source must be 64 characters or fewer")
	}
	goal := strings.TrimSpace(input.Goal)
	if goal == "" {
		return nil, errors.New("goal is required")
	}
	if utf8.RuneCountInString(goal) > 200 {
		return nil, errors.New("goal must be 200 characters or fewer")
	}
	seconds := int64(math.Round(input.DurationSeconds))
	if math.IsNaN(input.DurationSeconds) || seconds < minSessionSeconds || seconds > maxSessionSeconds {
		return nil, errors.New("durationSeconds must be a number between 60 and 43200")
	}
	mode := strings.ToLower(strings.TrimSpace(input.Mode))
	if mode == "" {
		mode = s.data.Settings.FocusMode
	}
	if mode != "allow" && mode != "block" {
		return nil, errors.New(`mode must be "allow" or "block"`)
	}
	apps := input.Apps
	if apps == nil {
		if mode == "allow" {
			apps = s.data.Settings.FocusAllowApps
		} else {
			apps = s.data.Settings.FocusBlockApps
		}
	}
	sites := input.Sites
	if sites == nil {
		if mode == "allow" {
			sites = s.data.Settings.FocusAllowSites
		} else {
			sites = s.data.Settings.BlockedSites
		}
	}
	allowSites := input.AllowSites
	if allowSites == nil {
		allowSites = []string{}
	}
	started := s.now().UTC()
	return &Session{
		ID:         newSessionID(),
		Goal:       goal,
		Source:     source,
		Mode:       mode,
		Apps:       normalizeAppList(apps),
		Sites:      normalizeSiteList(sites),
		AllowSites: normalizeSiteList(allowSites),
		StartedAt:  started.Format(isoLayout),
		EndsAt:     started.Add(time.Duration(seconds) * time.Second).Format(isoLayout),
	}, nil
}

// expireLocked ends the session when its end has passed. Called on every read
// so a crashed or restarted process still unwinds an expired session.
func (s *Store) expireLocked() {
	session := s.data.Focus.Session
	if session == nil {
		return
	}
	endsAt, err := time.Parse(isoLayout, session.EndsAt)
	if err == nil && endsAt.After(s.now()) {
		return
	}
	s.endSessionLocked()
}

// endSessionLocked clears the session and puts the pre-session lockdown back.
func (s *Store) endSessionLocked() {
	if s.data.Focus.RestoreLockdown != nil {
		s.data.Settings.FocusLockdown = *s.data.Focus.RestoreLockdown
	}
	s.data.Focus.Session = nil
	s.data.Focus.RestoreLockdown = nil
	if s.sessionTimer != nil {
		s.sessionTimer.Stop()
		s.sessionTimer = nil
	}
	s.scheduleLocked(true)
}

// watchSessionLocked schedules the real-time expiry for the current session.
func (s *Store) watchSessionLocked() {
	if s.sessionTimer != nil {
		s.sessionTimer.Stop()
		s.sessionTimer = nil
	}
	session := s.data.Focus.Session
	if session == nil {
		return
	}
	endsAt, err := time.Parse(isoLayout, session.EndsAt)
	if err != nil {
		return
	}
	s.sessionTimer = time.AfterFunc(time.Until(endsAt), func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.expireLocked()
	})
}

// CatalogEntryApp is one merged app row in the focus catalog.
type CatalogApp struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Seconds float64 `json:"seconds"`
	LastAt  int64   `json:"lastAt"`
	Browser bool    `json:"browser"`
}

// CatalogSite is one site row in the focus catalog.
type CatalogSite struct {
	Domain  string  `json:"domain"`
	Seconds float64 `json:"seconds"`
	LastAt  int64   `json:"lastAt"`
}

// Catalog is what GET /api/v1/focus/catalog returns.
type Catalog struct {
	Apps  []CatalogApp  `json:"apps"`
	Sites []CatalogSite `json:"sites"`
}

// Catalog merges the app's per-day records into suggestion rows: app keys that
// share an id are summed, named after the biggest contributor.
func (s *Store) Catalog(days int, end time.Time) Catalog {
	if days != 1 && days != 7 && days != 30 {
		days = 30
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	type keyAcc struct {
		name    string
		seconds float64
		lastAt  int64
		browser bool
	}
	perKey := map[string]*keyAcc{}
	sites := map[string]*CatalogSite{}
	for i := days - 1; i >= 0; i-- {
		day, ok := s.data.Days[dateKey(end.AddDate(0, 0, -i))]
		if !ok {
			continue
		}
		for key, app := range day.Apps {
			row := perKey[key]
			if row == nil {
				row = &keyAcc{}
				perKey[key] = row
			}
			row.seconds += app.Seconds
			if app.Name != "" {
				row.name = app.Name
			}
			if app.Browser != "" {
				row.browser = true
			}
			if app.LastAt > row.lastAt {
				row.lastAt = app.LastAt
			}
		}
		for domain, site := range day.Sites {
			if site.Seconds == 0 {
				continue
			}
			row := sites[domain]
			if row == nil {
				row = &CatalogSite{Domain: domain}
				sites[domain] = row
			}
			row.Seconds += site.Seconds
			if site.LastAt > row.LastAt {
				row.LastAt = site.LastAt
			}
		}
	}
	out := Catalog{Apps: []CatalogApp{}, Sites: []CatalogSite{}}
	biggest := map[string]float64{}
	for key, acc := range perKey {
		id := normalizeApp(key)
		if id == "" || acc.seconds <= 0 {
			continue
		}
		var row *CatalogApp
		for i := range out.Apps {
			if out.Apps[i].ID == id {
				row = &out.Apps[i]
				break
			}
		}
		if row == nil {
			out.Apps = append(out.Apps, CatalogApp{ID: id})
			row = &out.Apps[len(out.Apps)-1]
		}
		row.Seconds += acc.seconds
		if acc.lastAt > row.LastAt {
			row.LastAt = acc.lastAt
		}
		if acc.browser {
			row.Browser = true
		}
		if acc.seconds > biggest[id] {
			biggest[id] = acc.seconds
			row.Name = acc.name
		}
	}
	for _, site := range sites {
		out.Sites = append(out.Sites, *site)
	}
	sort.Slice(out.Apps, func(i, j int) bool { return out.Apps[i].Seconds > out.Apps[j].Seconds })
	sort.Slice(out.Sites, func(i, j int) bool { return out.Sites[i].Seconds > out.Sites[j].Seconds })
	return out
}
