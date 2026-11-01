package server

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"html"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/screen-gd/screen-time/backend/internal/store"
)

// TokenHeader carries the per-process API token on every /api and /debug request.
const TokenHeader = "X-Tally-Token"

type Options struct {
	// Token is required on API requests. An empty token is replaced with a random one.
	Token string
	// AllowedHosts are extra Host header names accepted besides loopback names.
	AllowedHosts []string
	// AllowedOrigins are extra cross-origin browser origins (e.g. "http://localhost:5173")
	// allowed to call the API. Same-origin and file:// ("null") pages are always allowed.
	AllowedOrigins []string
}

type Server struct {
	store          *store.Store
	frontendDir    string
	startedAt      time.Time
	token          string
	allowedHosts   map[string]bool
	allowedOrigins map[string]bool
	mu             sync.RWMutex
	tracking       map[string]any
}

func New(data *store.Store, frontendDir string, options Options) *Server {
	token := options.Token
	if token == "" {
		token = RandomToken()
	}
	hosts := map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true}
	for _, host := range options.AllowedHosts {
		if host = strings.ToLower(strings.Trim(strings.TrimSpace(host), "[]")); host != "" {
			hosts[host] = true
		}
	}
	origins := map[string]bool{}
	for _, origin := range options.AllowedOrigins {
		if origin = strings.ToLower(strings.TrimRight(strings.TrimSpace(origin), "/")); origin != "" {
			origins[origin] = true
		}
	}
	return &Server{store: data, frontendDir: frontendDir, startedAt: time.Now(), token: token, allowedHosts: hosts, allowedOrigins: origins, tracking: map[string]any{
		"supported": false, "lastSampleAt": nil, "app": nil, "site": nil, "title": "", "idleMs": 0,
		"idle": true, "media": false, "mediaSessions": nil, "mediaAvailable": false, "reason": "waiting", "error": "No desktop collector connected.",
	}}
}

func RandomToken() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		log.Fatalf("generate API token: %v", err)
	}
	return hex.EncodeToString(buf)
}

func (s *Server) Token() string { return s.token }

// hostAllowed rejects DNS-rebinding requests whose Host is an attacker's name.
func (s *Server) hostAllowed(r *http.Request) bool {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return s.allowedHosts[strings.ToLower(strings.Trim(host, "[]"))]
}

// originAllowed reports whether a browser origin may read API responses.
// Requests without an Origin header come from non-browser clients.
func (s *Server) originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" || origin == "null" {
		return true
	}
	if s.allowedOrigins[strings.ToLower(origin)] {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return parsed.Scheme == "http" && strings.EqualFold(parsed.Host, r.Host)
}

func (s *Server) tokenValid(r *http.Request) bool {
	return subtle.ConstantTimeCompare([]byte(r.Header.Get(TokenHeader)), []byte(s.token)) == 1
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Add("Vary", "Origin")
	if !s.hostAllowed(r) {
		http.Error(w, "invalid host", http.StatusForbidden)
		return
	}
	isAPI := strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/healthz" || strings.HasPrefix(r.URL.Path, "/debug/")
	if isAPI {
		if !s.originAllowed(r) {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, "+TokenHeader)
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.URL.Path != "/healthz" && !s.tokenValid(r) {
			http.Error(w, "missing or invalid API token", http.StatusUnauthorized)
			return
		}
		s.api(w, r)
		return
	}
	if s.frontendDir != "" {
		relative := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		if relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
			http.NotFound(w, r)
			return
		}
		path := filepath.Join(s.frontendDir, relative)
		if r.URL.Path == "/" || path == s.frontendDir || filepath.Ext(path) == "" {
			path = filepath.Join(s.frontendDir, "index.html")
		}
		if _, err := os.Stat(path); err == nil {
			if filepath.Base(path) == "index.html" {
				s.serveIndex(w, r, path)
				return
			}
			http.ServeFile(w, r, path)
			return
		}
	}
	http.NotFound(w, r)
}

// serveIndex injects the API token so only pages served from this origin can use it.
func (s *Server) serveIndex(w http.ResponseWriter, r *http.Request, path string) {
	page, err := os.ReadFile(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	tag := []byte(`<meta name="tally-token" content="` + html.EscapeString(s.token) + `">`)
	if i := bytes.Index(page, []byte("</head>")); i >= 0 {
		page = append(page[:i:i], append(tag, page[i:]...)...)
	} else {
		page = append(tag, page...)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Frame-Options", "DENY")
	_, _ = w.Write(page)
}

func (s *Server) api(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimSuffix(r.URL.Path, "/")
	switch {
	case path == "/healthz" && r.Method == http.MethodGet:
		s.write(w, http.StatusOK, map[string]any{"ok": true, "uptimeSeconds": time.Since(s.startedAt).Seconds()})
	case path == "/debug/metrics" && r.Method == http.MethodGet:
		var mem runtime.MemStats
		runtime.ReadMemStats(&mem)
		s.write(w, http.StatusOK, map[string]any{"goVersion": runtime.Version(), "goroutines": runtime.NumGoroutine(), "heapBytes": mem.HeapAlloc, "allocBytes": mem.Alloc, "sysBytes": mem.Sys, "uptimeSeconds": time.Since(s.startedAt).Seconds()})
	case path == "/api/v1/snapshot" && r.Method == http.MethodGet:
		s.write(w, http.StatusOK, s.snapshot())
	case path == "/api/v1/range" && r.Method == http.MethodGet:
		days, _ := strconv.Atoi(r.URL.Query().Get("days"))
		if days != 7 && days != 30 {
			days = 1
		}
		s.write(w, http.StatusOK, s.store.Aggregate(days, time.Now()))
	case path == "/api/v1/settings" && r.Method == http.MethodPatch:
		var patch map[string]any
		if !s.decode(w, r, &patch) {
			return
		}
		settings := s.store.UpdateSettings(patch)
		s.write(w, http.StatusOK, map[string]any{"settings": settings, "tracking": s.trackingStatus()})
	case path == "/api/v1/record" && r.Method == http.MethodPost:
		var input struct {
			AppKey  string            `json:"appKey"`
			AppName string            `json:"appName"`
			Title   string            `json:"title"`
			Browser string            `json:"browser"`
			Site    *store.RecordSite `json:"site"`
			Seconds float64           `json:"seconds"`
			At      string            `json:"at"`
		}
		if !s.decode(w, r, &input) {
			return
		}
		at := time.Now()
		if input.At != "" {
			if parsed, err := time.Parse(time.RFC3339Nano, input.At); err == nil {
				at = parsed
			}
		}
		s.store.Record(input.AppKey, input.AppName, input.Title, input.Browser, input.Site, input.Seconds, at)
		w.WriteHeader(http.StatusNoContent)
	case path == "/api/v1/clear" && r.Method == http.MethodPost:
		s.store.Clear()
		s.write(w, http.StatusOK, true)
	case path == "/api/v1/tracking" && r.Method == http.MethodPost:
		var status map[string]any
		if !s.decode(w, r, &status) {
			return
		}
		s.mu.Lock()
		s.tracking = status
		s.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	case path == "/api/v1/tracking" && r.Method == http.MethodGet:
		s.write(w, http.StatusOK, s.trackingStatus())
	case path == "/api/v1/browsers" && r.Method == http.MethodGet:
		s.write(w, http.StatusOK, []any{})
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) snapshot() map[string]any {
	days, oldest, size := s.store.StoredDays()
	today := s.store.Aggregate(1, time.Now())
	week := s.store.Aggregate(7, time.Now())
	month := s.store.Aggregate(30, time.Now())
	settings := s.store.Settings()
	tracking := s.trackingStatus()
	tracking["paused"] = settings.Paused
	tracking["sampling"] = settings.SampleSeconds
	return map[string]any{
		"now": time.Now().UTC().Format(time.RFC3339Nano), "todayKey": time.Now().Format("2006-01-02"), "today": today, "yesterday": s.store.Aggregate(1, time.Now().AddDate(0, 0, -1)), "ranges": map[string]any{"1": today, "7": week, "30": month}, "settings": settings, "tracking": tracking,
		"system": map[string]any{"platform": runtime.GOOS, "arch": runtime.GOARCH, "version": "go-backend", "dataPath": s.store.File(), "browserList": []any{}, "supported": tracking["supported"], "permissions": map[string]any{"accessibility": nil}, "startedAt": s.store.CreatedAt(), "update": map[string]any{"supported": false, "enabled": false, "status": "idle"}, "storedDays": days, "oldestDay": nullable(oldest), "fileSize": size},
	}
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}
func (s *Server) trackingStatus() map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := map[string]any{}
	for key, value := range s.tracking {
		result[key] = value
	}
	return result
}
func (s *Server) decode(w http.ResponseWriter, r *http.Request, target any) bool {
	defer r.Body.Close()
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(target); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return false
	}
	return true
}
func (s *Server) write(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write response: %v", err)
	}
}
