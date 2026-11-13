package server

import (
	"encoding/json"
	"net/http"
	"regexp"
	"testing"
)

var isoMS = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)

func auth() map[string]string {
	return map[string]string{TokenHeader: testToken, "Content-Type": "application/json"}
}

func decodeBody(t *testing.T, response *http.Response) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body
}

func TestFocusSessionLifecycle(t *testing.T) {
	server := newTestServer(t, "")
	session := server.URL + "/api/v1/focus/session"

	response := do(t, http.MethodPost, session, `{"goal":"Ship the release","source":"agent","durationSeconds":600,"mode":"allow","apps":["Code.exe"],"sites":["https://github.com/"],"allowSites":["docs.google.com"]}`, auth())
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("start status = %d", response.StatusCode)
	}
	first := decodeBody(t, response)["session"].(map[string]any)
	if first["goal"] != "Ship the release" || first["source"] != "agent" || first["mode"] != "allow" {
		t.Fatalf("unexpected session: %+v", first)
	}
	if !isoMS.MatchString(first["endsAt"].(string)) || !isoMS.MatchString(first["startedAt"].(string)) {
		t.Fatalf("times are not UTC ISO with ms: %+v", first)
	}
	if apps := first["apps"].([]any); len(apps) != 1 || apps[0] != "code" {
		t.Fatalf("apps not normalized: %+v", apps)
	}

	// The same source replaces the session; another source gets a 409 with it.
	response = do(t, http.MethodPost, session, `{"goal":"Again","source":"agent","durationSeconds":600}`, auth())
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("replace status = %d", response.StatusCode)
	}
	second := decodeBody(t, response)["session"].(map[string]any)
	if second["id"] == first["id"] {
		t.Fatal("replace kept the session id")
	}
	response = do(t, http.MethodPost, session, `{"goal":"Takeover","source":"cli","durationSeconds":600}`, auth())
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("conflict status = %d", response.StatusCode)
	}
	if got := decodeBody(t, response)["session"].(map[string]any)["id"]; got != second["id"] {
		t.Fatalf("409 did not name the running session: %v", got)
	}

	response = do(t, http.MethodGet, session, "", auth())
	if got := decodeBody(t, response)["session"].(map[string]any)["id"]; got != second["id"] {
		t.Fatalf("GET session id = %v", got)
	}

	// A mismatched delete is a 409; the right source ends it; a repeat is a quiet 200.
	response = do(t, http.MethodDelete, session+"?source=cli", "", auth())
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("mismatched delete = %d", response.StatusCode)
	}
	response = do(t, http.MethodDelete, session+"?source=agent", "", auth())
	if response.StatusCode != http.StatusOK {
		t.Fatalf("delete = %d", response.StatusCode)
	}
	if got := decodeBody(t, response)["session"]; got != nil {
		t.Fatalf("delete body session = %v", got)
	}
	response = do(t, http.MethodDelete, session+"?source=agent", "", auth())
	if response.StatusCode != http.StatusOK {
		t.Fatalf("delete of nothing = %d", response.StatusCode)
	}
}

func TestScreenTimeSourceEndsAnySession(t *testing.T) {
	server := newTestServer(t, "")
	session := server.URL + "/api/v1/focus/session"
	if response := do(t, http.MethodPost, session, `{"goal":"g","source":"agent","durationSeconds":600}`, auth()); response.StatusCode != http.StatusCreated {
		t.Fatalf("start status = %d", response.StatusCode)
	}
	response := do(t, http.MethodDelete, session+"?source=screen-time", "", auth())
	if response.StatusCode != http.StatusOK {
		t.Fatalf("screen-time delete = %d", response.StatusCode)
	}
}

func TestFocusSessionValidation(t *testing.T) {
	server := newTestServer(t, "")
	session := server.URL + "/api/v1/focus/session"
	for _, body := range []string{
		`{"goal":"g","durationSeconds":600}`,
		`{"source":"a","durationSeconds":600}`,
		`{"goal":"g","source":"a","durationSeconds":10}`,
		`{"goal":"g","source":"a","durationSeconds":600,"mode":"weird"}`,
	} {
		response := do(t, http.MethodPost, session, body, auth())
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("body %s = %d, want 400", body, response.StatusCode)
		}
		if decodeBody(t, response)["error"] == nil {
			t.Fatalf("400 body %s carries no error", body)
		}
	}
	if response := do(t, http.MethodDelete, session, "", auth()); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("delete without source = %d", response.StatusCode)
	}
}

func TestFocusListsAndCatalog(t *testing.T) {
	server := newTestServer(t, "")
	lists := server.URL + "/api/v1/focus/lists"

	response := do(t, http.MethodPatch, lists, `{"mode":"block","allow":{"apps":["Visual Studio Code"],"sites":["https://github.com/x"]},"block":{"apps":["Steam.exe"],"sites":["www.reddit.com/r/all"]}}`, auth())
	if response.StatusCode != http.StatusOK {
		t.Fatalf("patch lists = %d", response.StatusCode)
	}
	body := decodeBody(t, response)
	if body["mode"] != "block" {
		t.Fatalf("mode = %v", body["mode"])
	}
	allow := body["allow"].(map[string]any)
	if apps := allow["apps"].([]any); len(apps) != 1 || apps[0] != "visual studio code" {
		t.Fatalf("allow.apps = %v", apps)
	}
	block := body["block"].(map[string]any)
	if sites := block["sites"].([]any); len(sites) != 1 || sites[0] != "reddit.com" {
		t.Fatalf("block.sites = %v", sites)
	}

	// A partial patch merges: allow.apps stays, block.sites changes.
	response = do(t, http.MethodPatch, lists, `{"block":{"sites":["x.com"]}}`, auth())
	body = decodeBody(t, response)
	if got := body["allow"].(map[string]any)["apps"].([]any)[0]; got != "visual studio code" {
		t.Fatalf("allow.apps lost: %v", got)
	}
	if got := body["block"].(map[string]any)["sites"].([]any)[0]; got != "x.com" {
		t.Fatalf("block.sites = %v", got)
	}

	response = do(t, http.MethodGet, lists, "", auth())
	if response.StatusCode != http.StatusOK {
		t.Fatalf("get lists = %d", response.StatusCode)
	}

	do(t, http.MethodPost, server.URL+"/api/v1/record", `{"appKey":"C:\\Apps\\chrome.exe","appName":"Google Chrome","browser":"Google Chrome","seconds":30,"site":{"domain":"github.com"}}`, auth())
	response = do(t, http.MethodGet, server.URL+"/api/v1/focus/catalog?days=1", "", auth())
	if response.StatusCode != http.StatusOK {
		t.Fatalf("catalog = %d", response.StatusCode)
	}
	catalog := decodeBody(t, response)
	apps := catalog["apps"].([]any)
	if len(apps) != 1 || apps[0].(map[string]any)["id"] != "chrome" || apps[0].(map[string]any)["browser"] != true {
		t.Fatalf("catalog apps = %v", apps)
	}
}

func TestSnapshotCarriesFocus(t *testing.T) {
	server := newTestServer(t, "")
	response := do(t, http.MethodGet, server.URL+"/api/v1/snapshot", "", auth())
	snapshot := decodeBody(t, response)
	focus, ok := snapshot["focus"].(map[string]any)
	if !ok || focus["session"] != nil {
		t.Fatalf("snapshot.focus = %v", snapshot["focus"])
	}
	do(t, http.MethodPost, server.URL+"/api/v1/focus/session", `{"goal":"g","source":"agent","durationSeconds":600}`, auth())
	snapshot = decodeBody(t, do(t, http.MethodGet, server.URL+"/api/v1/snapshot", "", auth()))
	if snapshot["focus"].(map[string]any)["session"] == nil {
		t.Fatal("snapshot.focus lost the running session")
	}
}

func TestFocusEndpointsNeedAToken(t *testing.T) {
	server := newTestServer(t, "")
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/v1/focus/session", ""},
		{http.MethodPost, "/api/v1/focus/session", `{"goal":"g","source":"a","durationSeconds":60}`},
		{http.MethodDelete, "/api/v1/focus/session?source=screen-time", ""},
		{http.MethodGet, "/api/v1/focus/lists", ""},
		{http.MethodPatch, "/api/v1/focus/lists", `{}`},
		{http.MethodGet, "/api/v1/focus/catalog", ""},
	} {
		if response := do(t, tc.method, server.URL+tc.path, tc.body, nil); response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s %s without token = %d", tc.method, tc.path, response.StatusCode)
		}
	}
	// Non-browser clients send no Origin and are accepted with the token.
	response := do(t, http.MethodPost, server.URL+"/api/v1/focus/session", `{"goal":"g","source":"a","durationSeconds":60}`, auth())
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("no-Origin start = %d", response.StatusCode)
	}
}
