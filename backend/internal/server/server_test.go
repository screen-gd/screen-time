package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/screen-gd/screen-time/backend/internal/store"
)

const testToken = "test-token"

func newTestServer(t *testing.T, frontendDir string) *httptest.Server {
	t.Helper()
	data, err := store.Open(filepath.Join(t.TempDir(), "tally-data.json"))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(New(data, frontendDir, Options{Token: testToken}))
	t.Cleanup(server.Close)
	return server
}

func do(t *testing.T, method, url, body string, headers map[string]string) *http.Response {
	t.Helper()
	request, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for key, value := range headers {
		if key == "Host" {
			request.Host = value
			continue
		}
		request.Header.Set(key, value)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { response.Body.Close() })
	return response
}

func TestRecordAndSnapshotWithToken(t *testing.T) {
	server := newTestServer(t, "")
	auth := map[string]string{TokenHeader: testToken, "Content-Type": "application/json"}
	response := do(t, http.MethodPost, server.URL+"/api/v1/record", `{"appKey":"code.exe","appName":"Visual Studio Code","seconds":12}`, auth)
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("record status = %d", response.StatusCode)
	}
	response = do(t, http.MethodGet, server.URL+"/api/v1/snapshot", "", auth)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("snapshot status = %d", response.StatusCode)
	}
	if got := response.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unexpected CORS header %q", got)
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

func TestAPIRequiresToken(t *testing.T) {
	server := newTestServer(t, "")
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/v1/snapshot", ""},
		{http.MethodGet, "/api/v1/range?days=30", ""},
		{http.MethodPost, "/api/v1/clear", "{}"},
		{http.MethodPost, "/api/v1/record", `{"appKey":"x","seconds":1}`},
		{http.MethodPatch, "/api/v1/settings", `{"paused":true}`},
		{http.MethodGet, "/debug/metrics", ""},
	} {
		for _, token := range []string{"", "wrong"} {
			headers := map[string]string{"Content-Type": "text/plain"}
			if token != "" {
				headers[TokenHeader] = token
			}
			if response := do(t, tc.method, server.URL+tc.path, tc.body, headers); response.StatusCode != http.StatusUnauthorized {
				t.Fatalf("%s %s with token %q = %d, want 401", tc.method, tc.path, token, response.StatusCode)
			}
		}
	}
}

func TestCrossOriginRejected(t *testing.T) {
	server := newTestServer(t, "")
	preflight := do(t, http.MethodOptions, server.URL+"/api/v1/snapshot", "", map[string]string{
		"Origin": "https://evil.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": TokenHeader,
	})
	if preflight.StatusCode != http.StatusForbidden || preflight.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("foreign preflight = %d, ACAO %q", preflight.StatusCode, preflight.Header.Get("Access-Control-Allow-Origin"))
	}
	response := do(t, http.MethodGet, server.URL+"/api/v1/snapshot", "", map[string]string{"Origin": "https://evil.example", TokenHeader: testToken})
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign origin status = %d", response.StatusCode)
	}
	same := do(t, http.MethodGet, server.URL+"/api/v1/snapshot", "", map[string]string{"Origin": server.URL, TokenHeader: testToken})
	if same.StatusCode != http.StatusOK {
		t.Fatalf("same origin status = %d", same.StatusCode)
	}
}

func TestRebindingHostRejected(t *testing.T) {
	server := newTestServer(t, "")
	response := do(t, http.MethodGet, server.URL+"/healthz", "", map[string]string{"Host": "attacker.example:43821"})
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("rebinding host status = %d", response.StatusCode)
	}
	if response := do(t, http.MethodGet, server.URL+"/healthz", "", map[string]string{"Host": "localhost:43821"}); response.StatusCode != http.StatusOK {
		t.Fatalf("localhost host status = %d", response.StatusCode)
	}
}

func TestIndexReceivesToken(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html><head></head><body></body></html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := newTestServer(t, dir)
	response := do(t, http.MethodGet, server.URL+"/", "", nil)
	body, _ := io.ReadAll(response.Body)
	if !strings.Contains(string(body), `<meta name="tally-token" content="`+testToken+`">`) {
		t.Fatalf("index did not include token: %s", body)
	}
	if response.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("index must not be readable cross-origin")
	}
}
