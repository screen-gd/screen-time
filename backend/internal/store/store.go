package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type Theme struct {
	Preset string `json:"preset"`
	Accent string `json:"accent"`
	Ground string `json:"ground"`
	Text   string `json:"text"`
}

type Settings struct {
	SampleSeconds       int      `json:"sampleSeconds"`
	IdleSeconds         int      `json:"idleSeconds"`
	MediaCeilingMinutes *int     `json:"mediaCeilingMinutes"`
	Paused              bool     `json:"paused"`
	RecordWebsites      bool     `json:"recordWebsites"`
	LaunchAtLogin       bool     `json:"launchAtLogin"`
	AutoUpdate          bool     `json:"autoUpdate"`
	Theme               Theme    `json:"theme"`
	RetentionDays       int      `json:"retentionDays"`
	Browsers            []string `json:"browsers"`
}

type App struct {
	Name    string  `json:"name"`
	Seconds float64 `json:"seconds"`
	Title   string  `json:"title"`
	Browser string  `json:"browser"`
	LastAt  int64   `json:"lastAt"`
}

type Site struct {
	Seconds float64 `json:"seconds"`
	Title   string  `json:"title"`
	Browser string  `json:"browser"`
	LastAt  int64   `json:"lastAt"`
}

type RecordSite struct {
	Domain  string `json:"domain"`
	Title   string `json:"title"`
	Browser string `json:"browser"`
}

type Day struct {
	Apps           map[string]App  `json:"apps"`
	Sites          map[string]Site `json:"sites"`
	Hours          [24]float64     `json:"hours"`
	TotalSeconds   float64         `json:"totalSeconds"`
	BrowserSeconds float64         `json:"browserSeconds"`
	FirstAt        string          `json:"firstAt"`
	LastAt         string          `json:"lastAt"`
}

type Data struct {
	Version   int            `json:"version"`
	CreatedAt string         `json:"createdAt"`
	Settings  Settings       `json:"settings"`
	Days      map[string]Day `json:"days"`
}

type Store struct {
	mu    sync.RWMutex
	file  string
	data  Data
	dirty bool
	save  *time.Timer
}

func defaultSettings() Settings {
	ceiling := 120
	return Settings{
		SampleSeconds: 5, IdleSeconds: 120, MediaCeilingMinutes: &ceiling,
		RecordWebsites: true, AutoUpdate: true, Theme: Theme{Preset: "default"},
		RetentionDays: 90,
	}
}

func emptyData() Data {
	return Data{Version: 1, Settings: defaultSettings(), Days: map[string]Day{}}
}

func Open(file string) (*Store, error) {
	s := &Store{file: file, data: emptyData()}
	if raw, err := os.ReadFile(file); err == nil {
		var parsed Data
		if json.Unmarshal(raw, &parsed) == nil {
			defaults := emptyData()
			var envelope map[string]json.RawMessage
			_ = json.Unmarshal(raw, &envelope)
			var rawSettings map[string]json.RawMessage
			if encoded, ok := envelope["settings"]; ok {
				_ = json.Unmarshal(encoded, &rawSettings)
			}
			if parsed.Version != 0 {
				s.data.Version = parsed.Version
			}
			s.data.CreatedAt, s.data.Settings, s.data.Days = parsed.CreatedAt, parsed.Settings, parsed.Days
			if s.data.Days == nil {
				s.data.Days = defaults.Days
			}
			s.data.Settings = mergeSettings(s.data.Settings, defaults.Settings, rawSettings)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if s.data.CreatedAt == "" {
		s.data.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	s.pruneLocked(time.Now())
	return s, nil
}

func normalizeSettings(in, defaults Settings) Settings {
	if in.SampleSeconds != 5 && in.SampleSeconds != 10 && in.SampleSeconds != 30 {
		in.SampleSeconds = defaults.SampleSeconds
	}
	if in.IdleSeconds != 60 && in.IdleSeconds != 120 && in.IdleSeconds != 300 && in.IdleSeconds != 600 {
		in.IdleSeconds = defaults.IdleSeconds
	}
	if in.MediaCeilingMinutes != nil && *in.MediaCeilingMinutes != 30 && *in.MediaCeilingMinutes != 60 && *in.MediaCeilingMinutes != 120 && *in.MediaCeilingMinutes != 240 {
		in.MediaCeilingMinutes = defaults.MediaCeilingMinutes
	}
	if in.RetentionDays != 30 && in.RetentionDays != 90 && in.RetentionDays != 365 {
		in.RetentionDays = defaults.RetentionDays
	}
	if in.Theme.Preset != "default" && in.Theme.Preset != "t3code" && in.Theme.Preset != "t3chat" && in.Theme.Preset != "forest" && in.Theme.Preset != "fire" && in.Theme.Preset != "custom" {
		in.Theme.Preset = defaults.Theme.Preset
	}
	if in.Browsers != nil {
		copied := append([]string(nil), in.Browsers...)
		in.Browsers = copied
	}
	return in
}

func mergeSettings(in, defaults Settings, raw map[string]json.RawMessage) Settings {
	if _, ok := raw["mediaCeilingMinutes"]; !ok {
		in.MediaCeilingMinutes = defaults.MediaCeilingMinutes
	}
	if _, ok := raw["recordWebsites"]; !ok {
		in.RecordWebsites = defaults.RecordWebsites
	}
	if _, ok := raw["autoUpdate"]; !ok {
		in.AutoUpdate = defaults.AutoUpdate
	}
	if _, ok := raw["theme"]; !ok {
		in.Theme = defaults.Theme
	}
	if _, ok := raw["browsers"]; !ok {
		in.Browsers = defaults.Browsers
	}
	return normalizeSettings(in, defaults)
}

func dateKey(t time.Time) string { return t.Local().Format("2006-01-02") }
func dayFor(t time.Time) Day     { return Day{Apps: map[string]App{}, Sites: map[string]Site{}} }

func (s *Store) File() string       { return s.file }
func (s *Store) Settings() Settings { s.mu.RLock(); defer s.mu.RUnlock(); return s.data.Settings }
func (s *Store) CreatedAt() string  { s.mu.RLock(); defer s.mu.RUnlock(); return s.data.CreatedAt }

func (s *Store) UpdateSettings(patch map[string]any) Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.data.Settings
	if value, ok := patch["sampleSeconds"]; ok {
		next.SampleSeconds = asInt(value, next.SampleSeconds)
	}
	if value, ok := patch["idleSeconds"]; ok {
		next.IdleSeconds = asInt(value, next.IdleSeconds)
	}
	if value, ok := patch["mediaCeilingMinutes"]; ok {
		if value == nil || value == "never" || asInt(value, -1) == 0 {
			next.MediaCeilingMinutes = nil
		} else {
			v := asInt(value, 120)
			next.MediaCeilingMinutes = &v
		}
	}
	if value, ok := patch["paused"]; ok {
		next.Paused = asBool(value, next.Paused)
	}
	if value, ok := patch["recordWebsites"]; ok {
		next.RecordWebsites = asBool(value, next.RecordWebsites)
	}
	if value, ok := patch["launchAtLogin"]; ok {
		next.LaunchAtLogin = asBool(value, next.LaunchAtLogin)
	}
	if value, ok := patch["autoUpdate"]; ok {
		next.AutoUpdate = asBool(value, next.AutoUpdate)
	}
	if value, ok := patch["retentionDays"]; ok {
		next.RetentionDays = asInt(value, next.RetentionDays)
	}
	if value, ok := patch["browsers"]; ok {
		if value == nil {
			next.Browsers = nil
		} else if list, ok := value.([]any); ok {
			next.Browsers = make([]string, 0, len(list))
			for _, item := range list {
				next.Browsers = append(next.Browsers, asString(item, ""))
			}
		}
	}
	if value, ok := patch["theme"].(map[string]any); ok {
		next.Theme.Preset = asString(value["preset"], next.Theme.Preset)
		next.Theme.Accent = asString(value["accent"], next.Theme.Accent)
		next.Theme.Ground = asString(value["ground"], next.Theme.Ground)
		next.Theme.Text = asString(value["text"], next.Theme.Text)
	}
	next = normalizeSettings(next, defaultSettings())
	s.data.Settings = next
	s.scheduleLocked(false)
	return next
}

func asInt(value any, fallback int) int {
	switch v := value.(type) {
	case float64:
		return int(v)
	case int:
		return v
	case string:
		var n int
		if _, err := fmt.Sscanf(v, "%d", &n); err == nil {
			return n
		}
	}
	return fallback
}
func asBool(value any, fallback bool) bool {
	if v, ok := value.(bool); ok {
		return v
	}
	return fallback
}
func asString(value any, fallback string) string {
	if v, ok := value.(string); ok {
		return v
	}
	return fallback
}

func (s *Store) Record(appKey, appName, title, browser string, site *RecordSite, seconds float64, at time.Time) {
	if appKey == "" || seconds <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := dateKey(at)
	day, ok := s.data.Days[key]
	if !ok {
		day = dayFor(at)
	}
	if day.Apps == nil {
		day.Apps = map[string]App{}
	}
	if day.Sites == nil {
		day.Sites = map[string]Site{}
	}
	app := day.Apps[appKey]
	app.Name = appName
	app.Seconds += seconds
	if title != "" {
		app.Title = title
	}
	if browser != "" {
		app.Browser = browser
	}
	app.LastAt = at.UnixMilli()
	day.Apps[appKey] = app
	day.Hours[at.Local().Hour()] += seconds
	day.TotalSeconds += seconds
	if browser != "" {
		day.BrowserSeconds += seconds
	}
	iso := at.UTC().Format(time.RFC3339Nano)
	if day.FirstAt == "" || iso < day.FirstAt {
		day.FirstAt = iso
	}
	day.LastAt = iso
	if site != nil && site.Domain != "" {
		entry := day.Sites[site.Domain]
		entry.Seconds += seconds
		if site.Title != "" {
			entry.Title = site.Title
		}
		if site.Browser != "" {
			entry.Browser = site.Browser
		}
		entry.LastAt = at.UnixMilli()
		day.Sites[site.Domain] = entry
	}
	s.data.Days[key] = day
	s.scheduleLocked(false)
}

func (s *Store) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Days = map[string]Day{}
	s.scheduleLocked(true)
}

func (s *Store) scheduleLocked(immediate bool) {
	s.dirty = true
	if immediate {
		s.flushLocked()
		return
	}
	if s.save != nil {
		return
	}
	s.save = time.AfterFunc(15*time.Second, func() { s.mu.Lock(); defer s.mu.Unlock(); s.save = nil; s.flushLocked() })
}
func (s *Store) Flush() { s.mu.Lock(); defer s.mu.Unlock(); s.flushLocked() }
func (s *Store) flushLocked() {
	if !s.dirty {
		return
	}
	if err := os.MkdirAll(filepath.Dir(s.file), 0o755); err != nil {
		return
	}
	raw, err := json.Marshal(s.data)
	if err != nil {
		return
	}
	temp := s.file + ".tmp"
	if os.WriteFile(temp, raw, 0o600) == nil {
		_ = os.Rename(temp, s.file)
		s.dirty = false
	}
}

type Aggregate struct {
	TotalSeconds   float64         `json:"totalSeconds"`
	BrowserSeconds float64         `json:"browserSeconds"`
	DaysWithData   int             `json:"daysWithData"`
	FirstAt        string          `json:"firstAt"`
	LastAt         string          `json:"lastAt"`
	Apps           []AggregateApp  `json:"apps"`
	Sites          []AggregateSite `json:"sites"`
	Hours          [24]float64     `json:"hours"`
}
type AggregateApp struct {
	Key     string  `json:"key"`
	Name    string  `json:"name"`
	Seconds float64 `json:"seconds"`
	Title   string  `json:"title"`
	Browser string  `json:"browser"`
	LastAt  int64   `json:"lastAt"`
}
type AggregateSite struct {
	Domain  string  `json:"domain"`
	Seconds float64 `json:"seconds"`
	Title   string  `json:"title"`
	Browser string  `json:"browser"`
	LastAt  int64   `json:"lastAt"`
}

func (s *Store) Aggregate(days int, end time.Time) Aggregate {
	if days != 7 && days != 30 {
		days = 1
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := Aggregate{Apps: make([]AggregateApp, 0), Sites: make([]AggregateSite, 0)}
	apps := map[string]AggregateApp{}
	sites := map[string]AggregateSite{}
	for i := days - 1; i >= 0; i-- {
		day := end.AddDate(0, 0, -i)
		item, ok := s.data.Days[dateKey(day)]
		if !ok {
			continue
		}
		dayTotal := 0.0
		for key, app := range item.Apps {
			dayTotal += app.Seconds
			row := apps[key]
			row.Key, row.Name = key, app.Name
			row.Seconds += app.Seconds
			if app.Title != "" {
				row.Title = app.Title
			}
			if app.Browser != "" {
				row.Browser = app.Browser
			}
			if app.LastAt > row.LastAt {
				row.LastAt = app.LastAt
			}
			apps[key] = row
		}
		out.TotalSeconds += dayTotal
		out.BrowserSeconds += item.BrowserSeconds
		if dayTotal > 0 {
			out.DaysWithData++
		}
		for domain, site := range item.Sites {
			if site.Seconds == 0 {
				continue
			}
			row := sites[domain]
			row.Domain, row.Seconds = domain, row.Seconds+site.Seconds
			if site.Title != "" {
				row.Title = site.Title
			}
			if site.Browser != "" {
				row.Browser = site.Browser
			}
			if site.LastAt > row.LastAt {
				row.LastAt = site.LastAt
			}
			sites[domain] = row
		}
		for h, seconds := range item.Hours {
			out.Hours[h] += seconds
		}
		if item.FirstAt != "" && (out.FirstAt == "" || item.FirstAt < out.FirstAt) {
			out.FirstAt = item.FirstAt
		}
		if item.LastAt != "" && (out.LastAt == "" || item.LastAt > out.LastAt) {
			out.LastAt = item.LastAt
		}
	}
	for _, app := range apps {
		out.Apps = append(out.Apps, app)
	}
	for _, site := range sites {
		out.Sites = append(out.Sites, site)
	}
	sort.Slice(out.Apps, func(i, j int) bool { return out.Apps[i].Seconds > out.Apps[j].Seconds })
	sort.Slice(out.Sites, func(i, j int) bool { return out.Sites[i].Seconds > out.Sites[j].Seconds })
	return out
}

func (s *Store) pruneLocked(now time.Time) {
	cutoff := dateKey(now.AddDate(0, 0, -s.data.Settings.RetentionDays))
	changed := false
	for key := range s.data.Days {
		if strings.Compare(key, cutoff) < 0 {
			delete(s.data.Days, key)
			changed = true
		}
	}
	if changed {
		s.scheduleLocked(false)
	}
}
func (s *Store) StoredDays() (int, string, int64) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	keys := make([]string, 0, len(s.data.Days))
	for key := range s.data.Days {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	size := int64(0)
	if info, err := os.Stat(s.file); err == nil {
		size = info.Size()
	}
	oldest := ""
	if len(keys) > 0 {
		oldest = keys[0]
	}
	return len(keys), oldest, size
}
