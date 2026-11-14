package store

import (
	"path/filepath"
	"testing"
	"time"
)

func testClock(s *Store) func(offset time.Duration) {
	base := time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)
	current := base
	s.now = func() time.Time { return current }
	return func(offset time.Duration) { current = current.Add(offset) }
}

func TestSessionStartReplaceAndConflict(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "tally-data.json"))
	if err != nil {
		t.Fatal(err)
	}
	move := testClock(s)
	session, conflict, err := s.StartSession(SessionInput{Goal: " write the spec ", Source: "agent", DurationSeconds: 1500})
	if err != nil || conflict != nil || session == nil {
		t.Fatalf("start = %v %v %v", session, conflict, err)
	}
	if session.Goal != "write the spec" || session.Mode != "allow" || session.StartedAt != "2026-11-14T10:00:00.000Z" || session.EndsAt != "2026-11-14T10:25:00.000Z" {
		t.Fatalf("unexpected session: %+v", session)
	}
	if session.Apps == nil || session.Sites == nil || session.AllowSites == nil {
		t.Fatalf("session lists must be arrays: %+v", session)
	}
	// Another source cannot take over a running session.
	other, conflict, err := s.StartSession(SessionInput{Goal: "other", Source: "cli", DurationSeconds: 600})
	if err != nil || other != nil || conflict == nil || conflict.ID != session.ID {
		t.Fatalf("conflict = %v %v %v", other, conflict, err)
	}
	move(time.Minute)
	// The same source replaces: new id, new times, kept restoreLockdown.
	replaced, conflict, err := s.StartSession(SessionInput{Goal: "again", Source: "agent", DurationSeconds: 600})
	if err != nil || conflict != nil || replaced == nil {
		t.Fatalf("replace = %v %v %v", replaced, conflict, err)
	}
	if replaced.ID == session.ID || replaced.StartedAt != "2026-11-14T10:01:00.000Z" || replaced.EndsAt != "2026-11-14T10:11:00.000Z" {
		t.Fatalf("replaced session: %+v", replaced)
	}
	if s.data.Focus.RestoreLockdown == nil || *s.data.Focus.RestoreLockdown != false {
		t.Fatalf("replace lost restoreLockdown")
	}
	// The replaced id is gone; the new one reads back live.
	if got := s.Focus().Session; got == nil || got.ID != replaced.ID {
		t.Fatalf("focus read = %+v", got)
	}
}

func TestSessionRestoresLockdownOnEnd(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "tally-data.json"))
	if err != nil {
		t.Fatal(err)
	}
	s.UpdateSettings(map[string]any{"focusLockdown": true})
	if _, _, err := s.StartSession(SessionInput{Goal: "work", Source: "agent", DurationSeconds: 600}); err != nil {
		t.Fatal(err)
	}
	// Turning the lockdown off during the session is undone when it ends.
	s.UpdateSettings(map[string]any{"focusLockdown": false})
	ended, _, err := s.EndSession("agent")
	if err != nil || !ended {
		t.Fatalf("end = %v %v", ended, err)
	}
	if !s.Settings().FocusLockdown {
		t.Fatal("lockdown was not restored to on")
	}
	// With lockdown off before, ending leaves it off.
	s.UpdateSettings(map[string]any{"focusLockdown": false})
	if _, _, err := s.StartSession(SessionInput{Goal: "more", Source: "agent", DurationSeconds: 600}); err != nil {
		t.Fatal(err)
	}
	s.UpdateSettings(map[string]any{"focusLockdown": true})
	if _, _, err := s.EndSession("agent"); err != nil {
		t.Fatal(err)
	}
	if s.Settings().FocusLockdown {
		t.Fatal("lockdown was not restored to off")
	}
}

func TestSessionExpiryByClockAndOnOpen(t *testing.T) {
	file := filepath.Join(t.TempDir(), "tally-data.json")
	s, err := Open(file)
	if err != nil {
		t.Fatal(err)
	}
	move := testClock(s)
	s.UpdateSettings(map[string]any{"focusLockdown": true})
	if _, _, err := s.StartSession(SessionInput{Goal: "work", Source: "agent", DurationSeconds: 600}); err != nil {
		t.Fatal(err)
	}
	move(11 * time.Minute)
	if got := s.Focus().Session; got != nil {
		t.Fatalf("expired session still live: %+v", got)
	}
	if !s.Settings().FocusLockdown {
		t.Fatal("expiry did not restore the lockdown")
	}

	// A session persisted live ends up expired after a restart.
	s.UpdateSettings(map[string]any{"focusLockdown": false})
	if _, _, err := s.StartSession(SessionInput{Goal: "again", Source: "agent", DurationSeconds: 60}); err != nil {
		t.Fatal(err)
	}
	s.UpdateSettings(map[string]any{"focusLockdown": true})
	s.Flush()
	reopened, err := Open(file)
	if err != nil {
		t.Fatal(err)
	}
	// The stored endsAt is a fake-clock time; force the clock past it.
	reopened.now = func() time.Time { return time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC) }
	if got := reopened.Focus().Session; got != nil {
		t.Fatalf("expired session survived Open: %+v", got)
	}
	if reopened.Settings().FocusLockdown {
		t.Fatal("Open did not restore the pre-session lockdown")
	}
}

func TestSessionListsFallBackToSavedLists(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "tally-data.json"))
	if err != nil {
		t.Fatal(err)
	}
	testClock(s)
	s.UpdateSettings(map[string]any{
		"focusAllowApps": []any{"Code.exe"}, "focusAllowSites": []any{"https://github.com"},
		"focusBlockApps": []any{"Games.exe"}, "blockedSites": []any{"reddit.com"},
	})
	allow, _, err := s.StartSession(SessionInput{Goal: "g", Source: "agent", DurationSeconds: 600, Mode: "allow"})
	if err != nil {
		t.Fatal(err)
	}
	if len(allow.Apps) != 1 || allow.Apps[0] != "code" || len(allow.Sites) != 1 || allow.Sites[0] != "github.com" {
		t.Fatalf("allow fallback: %+v", allow)
	}
	if _, _, err := s.EndSession("agent"); err != nil {
		t.Fatal(err)
	}
	block, _, err := s.StartSession(SessionInput{Goal: "g", Source: "agent", DurationSeconds: 600, Mode: "block"})
	if err != nil {
		t.Fatal(err)
	}
	if len(block.Apps) != 1 || block.Apps[0] != "games" || len(block.Sites) != 1 || block.Sites[0] != "reddit.com" {
		t.Fatalf("block fallback: %+v", block)
	}
	// An explicit empty list is kept, not replaced by the saved lists.
	if _, _, err := s.EndSession("agent"); err != nil {
		t.Fatal(err)
	}
	explicit, _, err := s.StartSession(SessionInput{Goal: "g", Source: "agent", DurationSeconds: 600, Mode: "allow", Apps: []string{}, AllowSites: []string{"docs.google.com"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(explicit.Apps) != 0 || len(explicit.AllowSites) != 1 || explicit.AllowSites[0] != "docs.google.com" {
		t.Fatalf("explicit lists: %+v", explicit)
	}
}

func TestSessionValidation(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "tally-data.json"))
	if err != nil {
		t.Fatal(err)
	}
	cases := []SessionInput{
		{Goal: "g", DurationSeconds: 600},                    // no source
		{Goal: "g", Source: "   ", DurationSeconds: 600},     // blank source
		{Goal: "g", Source: string(make([]byte, 65)), DurationSeconds: 600}, // long source
		{Source: "a", DurationSeconds: 600},                  // no goal
		{Goal: "g", Source: "a", DurationSeconds: 59},        // too short
		{Goal: "g", Source: "a", DurationSeconds: 43201},     // too long
		{Goal: "g", Source: "a", DurationSeconds: 600, Mode: "weird"},
	}
	for i, input := range cases {
		session, conflict, err := s.StartSession(input)
		if session != nil || conflict != nil || err == nil {
			t.Fatalf("case %d: expected a validation error, got %v %v %v", i, session, conflict, err)
		}
	}
	long := make([]rune, 201)
	for i := range long {
		long[i] = 'x'
	}
	if _, _, err := s.StartSession(SessionInput{Goal: string(long), Source: "a", DurationSeconds: 600}); err == nil {
		t.Fatal("a 201-rune goal was accepted")
	}
}

func TestEndSessionSources(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "tally-data.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.EndSession(""); err == nil {
		t.Fatal("a missing source was accepted")
	}
	// Nothing running: any source is a no-op success.
	if ended, conflict, err := s.EndSession("agent"); ended || conflict != nil || err != nil {
		t.Fatalf("idle end = %v %v %v", ended, conflict, err)
	}
	if _, _, err := s.StartSession(SessionInput{Goal: "g", Source: "agent", DurationSeconds: 600}); err != nil {
		t.Fatal(err)
	}
	if ended, conflict, err := s.EndSession("cli"); ended || conflict == nil || err != nil {
		t.Fatalf("mismatched end = %v %v %v", ended, conflict, err)
	}
	// screen-time (the desktop UI) ends any session.
	if ended, _, err := s.EndSession("screen-time"); !ended || err != nil {
		t.Fatalf("screen-time end = %v %v", ended, err)
	}
	if got := s.Focus().Session; got != nil {
		t.Fatalf("session still live: %+v", got)
	}
}

func TestNormalizeAppExamples(t *testing.T) {
	cases := map[string]string{
		`C:\Program Files\DaVinci Resolve\Resolve.exe`: "resolve",
		"/Applications/Safari.app":                     "safari",
		"Visual Studio Code":                          "visual studio code",
		"com.apple.FinalCut":                          "com.apple.finalcut",
		"  spaced   out  ":                            "spaced out",
	}
	for in, want := range cases {
		if got := normalizeApp(in); got != want {
			t.Fatalf("normalizeApp(%q) = %q, want %q", in, got, want)
		}
	}
	for _, bad := range []string{"", "   ", ".exe"} {
		if got := normalizeApp(bad); got != "" {
			t.Fatalf("normalizeApp(%q) = %q, want empty", bad, got)
		}
	}
}

func TestCatalogMergesAppsByID(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "tally-data.json"))
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 11, 14, 9, 30, 0, 0, time.Local)
	s.Record(`C:\Apps\Code.exe`, "Visual Studio Code", "a.go", "", nil, 100, at)
	s.Record(`D:\other\code.exe`, "VS Code Portable", "b.go", "", nil, 50, at)
	s.Record(`C:\Apps\chrome.exe`, "Google Chrome", "t", "Google Chrome", &RecordSite{Domain: "github.com"}, 200, at)
	catalog := s.Catalog(1, at)
	if len(catalog.Apps) != 2 {
		t.Fatalf("catalog apps: %+v", catalog.Apps)
	}
	if catalog.Apps[0].ID != "chrome" || !catalog.Apps[0].Browser || catalog.Apps[0].Seconds != 200 {
		t.Fatalf("top app: %+v", catalog.Apps[0])
	}
	merged := catalog.Apps[1]
	if merged.ID != "code" || merged.Seconds != 150 || merged.Name != "Visual Studio Code" || merged.Browser {
		t.Fatalf("merged app: %+v", merged)
	}
	if len(catalog.Sites) != 1 || catalog.Sites[0].Domain != "github.com" || catalog.Sites[0].Seconds != 200 {
		t.Fatalf("catalog sites: %+v", catalog.Sites)
	}
}
