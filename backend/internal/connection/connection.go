// Package connection knows where the running screen-time app leaves its
// connection file, and how to read it. Electron writes the file when it starts
// the backend; local tools (the MCP server) read it to reach the loopback API.
package connection

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
)

const fileName = "connection.json"

// Info is the JSON content of the connection file.
type Info struct {
	Version int    `json:"version"`
	URL     string `json:"url"`
	Token   string `json:"token"`
	PID     int    `json:"pid"`
}

// Path returns the connection file path for this platform. The
// TALLY_CONNECTION_FILE override (a full path) wins, for tests and dev.
func Path() string {
	return PathFor(runtime.GOOS, os.Getenv)
}

// PathFor resolves the contract path from a platform and an env lookup so the
// logic can run in tests on any OS.
func PathFor(goos string, env func(string) string) string {
	if override := env("TALLY_CONNECTION_FILE"); override != "" {
		return override
	}
	home, _ := os.UserHomeDir()
	switch goos {
	case "windows":
		if appData := env("APPDATA"); appData != "" {
			return filepath.Join(appData, "screen-time", fileName)
		}
		return filepath.Join(home, "AppData", "Roaming", "screen-time", fileName)
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "screen-time", fileName)
	default:
		if config := env("XDG_CONFIG_HOME"); config != "" {
			return filepath.Join(config, "screen-time", fileName)
		}
		return filepath.Join(home, ".config", "screen-time", fileName)
	}
}

// Read loads the connection file at path (Path() when path is empty).
func Read(path string) (*Info, error) {
	if path == "" {
		path = Path()
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var info Info
	if err := json.Unmarshal(raw, &info); err != nil {
		return nil, err
	}
	return &info, nil
}
