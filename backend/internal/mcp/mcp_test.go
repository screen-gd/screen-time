package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/screen-gd/screen-time/backend/internal/server"
	"github.com/screen-gd/screen-time/backend/internal/store"
)

// rpc sends one message and decodes the reply.
func rpc(t *testing.T, s *Server, line string) map[string]any {
	t.Helper()
	raw := s.Handle([]byte(line))
	if raw == nil {
		t.Fatalf("no reply to %s", line)
	}
	var reply map[string]any
	if err := json.Unmarshal(raw, &reply); err != nil {
		t.Fatalf("bad reply %s: %v", raw, err)
	}
	return reply
}

func TestInitialize(t *testing.T) {
	s := New("9.9.9")
	reply := rpc(t, s, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}`)
	result := reply["result"].(map[string]any)
	if result["protocolVersion"] != "2025-03-26" {
		t.Fatalf("protocolVersion = %v", result["protocolVersion"])
	}
	info := result["serverInfo"].(map[string]any)
	if info["name"] != "screen-time" || info["version"] != "9.9.9" {
		t.Fatalf("serverInfo = %v", info)
	}
	reply = rpc(t, s, `{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"bogus"}}`)
	if got := reply["result"].(map[string]any)["protocolVersion"]; got != "2025-06-18" {
		t.Fatalf("fallback protocolVersion = %v", got)
	}
}

func TestProtocolEdges(t *testing.T) {
	s := New("1.0.0")
	// Notifications get no reply.
	if raw := s.Handle([]byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)); raw != nil {
		t.Fatalf("notification replied: %s", raw)
	}
	// Bad JSON is a parse error with a null id.
	reply := rpc(t, s, `{not json`)
	if reply["id"] != nil || reply["error"].(map[string]any)["code"].(float64) != -32700 {
		t.Fatalf("parse error reply = %v", reply)
	}
	reply = rpc(t, s, `{"jsonrpc":"2.0","id":3,"method":"bogus/method"}`)
	if reply["error"].(map[string]any)["code"].(float64) != -32601 {
		t.Fatalf("unknown method reply = %v", reply)
	}
	reply = rpc(t, s, `{"jsonrpc":"2.0","id":4,"method":"ping"}`)
	if reply["error"] != nil {
		t.Fatalf("ping errored: %v", reply)
	}
}

func TestToolsList(t *testing.T) {
	s := New("1.0.0")
	reply := rpc(t, s, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	tools := reply["result"].(map[string]any)["tools"].([]any)
	names := map[string]bool{}
	for _, tool := range tools {
		row := tool.(map[string]any)
		names[row["name"].(string)] = true
		if row["inputSchema"] == nil || row["description"] == "" {
			t.Fatalf("tool lacks schema or description: %v", row)
		}
	}
	for _, want := range []string{"get_catalog", "get_focus_lists", "set_focus_lists", "get_focus_session", "start_focus_session", "end_focus_session"} {
		if !names[want] {
			t.Fatalf("missing tool %q in %v", want, names)
		}
	}
}

// apiEnv starts a real HTTP API on httptest and points a connection file at it.
func apiEnv(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	data, err := store.Open(filepath.Join(t.TempDir(), "tally-data.json"))
	if err != nil {
		t.Fatal(err)
	}
	api := httptest.NewServer(server.New(data, "", server.Options{Token: "tok"}))
	t.Cleanup(api.Close)
	file := filepath.Join(t.TempDir(), "connection.json")
	info := fmt.Sprintf(`{"version":1,"url":%q,"token":"tok","pid":1234}`, api.URL)
	if err := os.WriteFile(file, []byte(info), 0o600); err != nil {
		t.Fatal(err)
	}
	s := New("1.0.0")
	s.ConnectionFile = file
	return s, api
}

func call(s *Server, t *testing.T, id int, name string, args string) map[string]any {
	t.Helper()
	reply := rpc(t, s, fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":%q,"arguments":%s}}`, id, name, args))
	if reply["error"] != nil {
		t.Fatalf("%s returned a protocol error: %v", name, reply["error"])
	}
	return reply["result"].(map[string]any)
}

func TestSessionToolsAgainstAPI(t *testing.T) {
	s, _ := apiEnv(t)

	result := call(s, t, 1, "start_focus_session", `{"goal":"Write the report","minutes":25,"mode":"allow","sites":["github.com"]}`)
	if result["isError"] == true {
		t.Fatalf("start failed: %v", result)
	}
	session := result["structuredContent"].(map[string]any)["session"].(map[string]any)
	if session["goal"] != "Write the report" || session["source"] != "agent" {
		t.Fatalf("session = %v", session)
	}

	// A second start from another source is an isError naming the running session.
	result = call(s, t, 2, "start_focus_session", `{"goal":"Other","minutes":10,"source":"cli"}`)
	if result["isError"] != true {
		t.Fatalf("expected isError, got %v", result)
	}
	text := result["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "Write the report") || !strings.Contains(text, "agent") {
		t.Fatalf("conflict text = %q", text)
	}

	result = call(s, t, 3, "get_focus_session", `{}`)
	if result["structuredContent"].(map[string]any)["session"] == nil {
		t.Fatal("get_focus_session lost the session")
	}

	// Ending from the wrong source explains who owns it.
	result = call(s, t, 4, "end_focus_session", `{"source":"cli"}`)
	if result["isError"] != true || !strings.Contains(result["content"].([]any)[0].(map[string]any)["text"].(string), "agent") {
		t.Fatalf("mismatch end = %v", result)
	}
	result = call(s, t, 5, "end_focus_session", `{}`)
	if result["isError"] == true {
		t.Fatalf("end failed: %v", result)
	}
	result = call(s, t, 6, "get_focus_session", `{}`)
	if result["structuredContent"].(map[string]any)["session"] != nil {
		t.Fatal("session still running")
	}
}

func TestListsAndCatalogTools(t *testing.T) {
	s, _ := apiEnv(t)
	result := call(s, t, 1, "set_focus_lists", `{"mode":"allow","allow":{"apps":["Code.exe"],"sites":["github.com"]}}`)
	if result["isError"] == true {
		t.Fatalf("set lists failed: %v", result)
	}
	lists := result["structuredContent"].(map[string]any)
	if apps := lists["allow"].(map[string]any)["apps"].([]any); len(apps) != 1 || apps[0] != "code" {
		t.Fatalf("allow.apps = %v", apps)
	}
	result = call(s, t, 2, "get_focus_lists", `{}`)
	if result["structuredContent"].(map[string]any)["mode"] != "allow" {
		t.Fatalf("lists = %v", result["structuredContent"])
	}
	result = call(s, t, 3, "get_catalog", `{"days":1}`)
	if _, ok := result["structuredContent"].(map[string]any)["apps"].([]any); !ok {
		t.Fatalf("catalog = %v", result["structuredContent"])
	}
}

func TestReservedSourceName(t *testing.T) {
	s, _ := apiEnv(t)
	for i, args := range []string{
		`{"goal":"x","minutes":5,"source":" Screen-Time "}`,
		`{"goal":"x","minutes":5,"source":"screen-time"}`,
	} {
		result := call(s, t, i+1, "start_focus_session", args)
		if result["isError"] != true {
			t.Fatalf("expected isError, got %v", result)
		}
		if text := result["content"].([]any)[0].(map[string]any)["text"].(string); text != reservedSource {
			t.Fatalf("error text = %q", text)
		}
	}
	result := call(s, t, 3, "end_focus_session", `{"source":"SCREEN-TIME"}`)
	if result["isError"] != true {
		t.Fatalf("expected isError, got %v", result)
	}
	if text := result["content"].([]any)[0].(map[string]any)["text"].(string); text != reservedSource {
		t.Fatalf("error text = %q", text)
	}
}

// A non-empty non-JSON body surfaces as an error, not an empty result.
func TestUnreadableAnswer(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("not json"))
	}))
	t.Cleanup(api.Close)
	file := filepath.Join(t.TempDir(), "connection.json")
	info := fmt.Sprintf(`{"version":1,"url":%q,"token":"tok","pid":1234}`, api.URL)
	if err := os.WriteFile(file, []byte(info), 0o600); err != nil {
		t.Fatal(err)
	}
	s := New("1.0.0")
	s.ConnectionFile = file
	result := call(s, t, 1, "get_focus_session", `{}`)
	if result["isError"] != true {
		t.Fatalf("expected isError, got %v", result)
	}
	if text := result["content"].([]any)[0].(map[string]any)["text"].(string); text != "the app sent an unreadable answer" {
		t.Fatalf("error text = %q", text)
	}
}

func TestMissingConnectionFile(t *testing.T) {
	s := New("1.0.0")
	s.ConnectionFile = filepath.Join(t.TempDir(), "nope.json")
	result := call(s, t, 1, "get_focus_session", `{}`)
	if result["isError"] != true {
		t.Fatalf("expected isError, got %v", result)
	}
	text := result["content"].([]any)[0].(map[string]any)["text"].(string)
	if text != "screen-time is not running. Open it and try again." {
		t.Fatalf("error text = %q", text)
	}
}

