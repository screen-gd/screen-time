package connection

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestPathOverride(t *testing.T) {
	env := func(key string) string {
		if key == "TALLY_CONNECTION_FILE" {
			return `C:\custom\connection.json`
		}
		return ""
	}
	for _, goos := range []string{"windows", "darwin", "linux"} {
		if got := PathFor(goos, env); got != `C:\custom\connection.json` {
			t.Fatalf("%s path = %q", goos, got)
		}
	}
}

func TestPlatformPaths(t *testing.T) {
	home, _ := os.UserHomeDir()
	env := func(values map[string]string) func(string) string {
		return func(key string) string { return values[key] }
	}
	if got := PathFor("windows", env(map[string]string{"APPDATA": `C:\Users\u\AppData\Roaming`})); got != `C:\Users\u\AppData\Roaming\screen-time\connection.json` {
		t.Fatalf("windows path = %q", got)
	}
	if got := PathFor("darwin", env(map[string]string{})); got != filepath.Join(home, "Library", "Application Support", "screen-time", "connection.json") {
		t.Fatalf("darwin path = %q", got)
	}
	if got := PathFor("linux", env(map[string]string{"XDG_CONFIG_HOME": "/cfg"})); got != filepath.Join("/cfg", "screen-time", "connection.json") {
		t.Fatalf("xdg path = %q", got)
	}
	if got := PathFor("linux", env(map[string]string{})); got != filepath.Join(home, ".config", "screen-time", "connection.json") {
		t.Fatalf("linux path = %q", got)
	}
}

func TestRead(t *testing.T) {
	file := filepath.Join(t.TempDir(), "connection.json")
	if err := os.WriteFile(file, []byte(`{"version":1,"url":"http://127.0.0.1:43821","token":"abc","pid":42}`), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := Read(file)
	if err != nil {
		t.Fatal(err)
	}
	if info.Version != 1 || info.URL != "http://127.0.0.1:43821" || info.Token != "abc" || info.PID != 42 {
		t.Fatalf("info = %+v", info)
	}
	if _, err := Read(filepath.Join(t.TempDir(), "missing.json")); err == nil {
		t.Fatal("a missing file was read")
	}
	if _, err := Read(""); runtime.GOOS != "" && err == nil && !fileExists(Path()) {
		t.Fatal("Path() read unexpectedly succeeded")
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
