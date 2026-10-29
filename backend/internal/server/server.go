package server

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/screen-gd/screen-time/backend/internal/store"
)

type Server struct {
	store       *store.Store
	frontendDir string
	startedAt   time.Time
	mu          sync.RWMutex
	tracking    map[string]any
}

func New(data *store.Store, frontendDir string) *Server {
	return &Server{store: data, frontendDir: frontendDir, startedAt: time.Now(), tracking: map[string]any{
		"supported": false, "lastSampleAt": nil, "app": nil, "site": nil, "title": "", "idleMs": 0,
		"idle": true, "media": false, "mediaSessions": nil, "mediaAvailable": false, "reason": "waiting", "error": "No desktop collector connected.",
	}}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/healthz" || strings.HasPrefix(r.URL.Path, "/debug/") {
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
			http.ServeFile(w, r, path)
			return
		}
	}
	http.NotFound(w, r)
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
