package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/screen-gd/screen-time/backend/internal/store"
)

func TestRecordSnapshotAndCors(t *testing.T) {
	data, err := store.Open(filepath.Join(t.TempDir(), "tally-data.json"))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(New(data, ""))
	defer server.Close()
	response, err := http.Post(server.URL+"/api/v1/record", "application/json", strings.NewReader(`{"appKey":"code.exe","appName":"Visual Studio Code","seconds":12}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("record status = %d", response.StatusCode)
	}
	response, err = http.Get(server.URL + "/api/v1/snapshot")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatal("snapshot did not include CORS header")
	}
	var snapshot map[string]any
	if err := json.NewDecoder(response.Body).Decode(&snapshot); err != nil {
		t.Fatal(err)
	}
	today := snapshot["today"].(map[string]any)
	if today["totalSeconds"].(float64) != 12 {
		t.Fatalf("unexpected snapshot: %+v", today)
	}
}
