package store

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRecordAggregateAndReload(t *testing.T) {
	file := filepath.Join(t.TempDir(), "tally-data.json")
	s, err := Open(file)
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 28, 9, 30, 0, 0, time.Local)
	s.Record("chrome.exe", "Google Chrome", "Docs - Google Chrome", "Google Chrome", &RecordSite{Domain: "docs.google.com", Title: "Docs", Browser: "Google Chrome"}, 15, at)
	s.Record("code.exe", "Visual Studio Code", "main.go", "", nil, 30, at.Add(time.Hour))
	aggregate := s.Aggregate(1, at)
	if aggregate.TotalSeconds != 45 || aggregate.BrowserSeconds != 15 {
		t.Fatalf("unexpected totals: %+v", aggregate)
	}
	if len(aggregate.Apps) != 2 || aggregate.Apps[0].Name != "Visual Studio Code" {
		t.Fatalf("unexpected apps: %+v", aggregate.Apps)
	}
	if len(aggregate.Sites) != 1 || aggregate.Sites[0].Domain != "docs.google.com" {
		t.Fatalf("unexpected sites: %+v", aggregate.Sites)
	}
	s.Flush()
	if _, err := os.Stat(file); err != nil {
		t.Fatal(err)
	}
	reloaded, err := Open(file)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.Aggregate(1, at).TotalSeconds; got != 45 {
		t.Fatalf("reloaded total = %v", got)
	}
}

func TestSettingsPatchNormalizesValues(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "tally-data.json"))
	if err != nil {
		t.Fatal(err)
	}
	never := s.UpdateSettings(map[string]any{"sampleSeconds": 10, "idleSeconds": 600, "mediaCeilingMinutes": nil, "paused": true, "theme": map[string]any{"preset": "forest"}})
	if never.SampleSeconds != 10 || never.IdleSeconds != 600 || never.MediaCeilingMinutes != nil || !never.Paused || never.Theme.Preset != "forest" {
		t.Fatalf("unexpected settings: %+v", never)
	}
	invalid := s.UpdateSettings(map[string]any{"sampleSeconds": 99, "retentionDays": 1, "theme": map[string]any{"preset": "unknown"}})
	if invalid.SampleSeconds != 5 || invalid.RetentionDays != 90 || invalid.Theme.Preset != "default" {
		t.Fatalf("invalid values were not normalized: %+v", invalid)
	}
}
