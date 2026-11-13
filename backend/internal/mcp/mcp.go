// Package mcp implements `tally-backend mcp`: a newline-delimited JSON-RPC 2.0
// server on stdio that lets local agents drive the running screen-time app.
// Every tool call re-reads the connection file and talks plain HTTP to the API;
// all logging goes to stderr.
package mcp

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/screen-gd/screen-time/backend/internal/connection"
)

const (
	protocolFallback = "2025-06-18"
	notRunning       = "screen-time is not running. Open it and try again."
	tokenHeader      = "X-Tally-Token"
)

var supportedProtocols = map[string]bool{
	"2024-11-05": true, "2025-03-26": true, "2025-06-18": true,
}

var errUnreachable = errors.New(notRunning)

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Server answers one JSON-RPC message at a time. It carries no state besides
// the connection-file path, which is re-read on every tool call so a restarted
// app is picked up without restarting this process.
type Server struct {
	// Version is reported in initialize's serverInfo.
	Version string
	// ConnectionFile overrides the discovery path (TALLY_CONNECTION_FILE applies
	// when it is empty).
	ConnectionFile string
	client         *http.Client
}

func New(version string) *Server {
	return &Server{Version: version, client: &http.Client{Timeout: 10 * time.Second}}
}

// Run serves newline-delimited JSON-RPC from in to out until in closes.
func (s *Server) Run(in io.Reader, out io.Writer) {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	writer := bufio.NewWriter(out)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		if reply := s.Handle(line); reply != nil {
			_, _ = writer.Write(reply)
			_ = writer.WriteByte('\n')
			_ = writer.Flush()
		}
	}
}

// Handle answers one JSON-RPC message; nil means the message was a notification.
func (s *Server) Handle(line []byte) []byte {
	var req request
	if err := json.Unmarshal(line, &req); err != nil {
		out, _ := json.Marshal(response{JSONRPC: "2.0", ID: json.RawMessage("null"),
			Error: &rpcError{Code: -32700, Message: "parse error"}})
		return out
	}
	if len(req.ID) == 0 {
		return nil
	}
	result, rpcErr := s.dispatch(req)
	out, _ := json.Marshal(response{JSONRPC: "2.0", ID: req.ID, Result: result, Error: rpcErr})
	return out
}

func (s *Server) dispatch(req request) (any, *rpcError) {
	switch req.Method {
	case "initialize":
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &params)
		version := params.ProtocolVersion
		if !supportedProtocols[version] {
			version = protocolFallback
		}
		return map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "screen-time", "version": s.Version},
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return map[string]any{"tools": toolDefinitions()}, nil
	case "tools/call":
		var params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil || params.Name == "" {
			return nil, &rpcError{Code: -32602, Message: "invalid params"}
		}
		result, err := s.callTool(params.Name, params.Arguments)
		if err != nil {
			return nil, &rpcError{Code: -32602, Message: err.Error()}
		}
		return result, nil
	default:
		return nil, &rpcError{Code: -32601, Message: "method not found"}
	}
}

// apiRequest re-reads the connection file and calls the app's HTTP API with the
// token and no Origin header. A missing file or a refused call means the app is
// not running.
func (s *Server) apiRequest(method, path string, body any) (int, map[string]any, error) {
	info, err := connection.Read(s.ConnectionFile)
	if err != nil {
		return 0, nil, errUnreachable
	}
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, strings.TrimRight(info.URL, "/")+path, reader)
	if err != nil {
		return 0, nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set(tokenHeader, info.Token)
	resp, err := s.client.Do(req)
	if err != nil {
		return 0, nil, errUnreachable
	}
	defer resp.Body.Close()
	payload := map[string]any{}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	_ = json.Unmarshal(raw, &payload)
	return resp.StatusCode, payload, nil
}

// toolResult is a successful MCP tool result: pretty JSON text plus the same
// object as structured content.
func toolResult(content any) map[string]any {
	raw, err := json.MarshalIndent(content, "", "  ")
	if err != nil {
		raw = []byte("{}")
	}
	return map[string]any{
		"content":           []any{map[string]any{"type": "text", "text": string(raw)}},
		"structuredContent": content,
	}
}

func toolError(message string) map[string]any {
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": message}},
		"isError": true,
	}
}

func argString(args map[string]any, key string) string {
	if v, ok := args[key].(string); ok {
		return v
	}
	return ""
}

func argNumber(args map[string]any, key string) (float64, bool) {
	switch v := args[key].(type) {
	case float64:
		return v, true
	case json.Number:
		n, err := v.Float64()
		return n, err == nil
	}
	return 0, false
}

func (s *Server) callTool(name string, args map[string]any) (any, error) {
	if args == nil {
		args = map[string]any{}
	}
	switch name {
	case "get_catalog":
		days := 30
		if value, ok := argNumber(args, "days"); ok && (value == 1 || value == 7 || value == 30) {
			days = int(value)
		}
		return s.simpleTool(http.MethodGet, fmt.Sprintf("/api/v1/focus/catalog?days=%d", days), nil)
	case "get_focus_lists":
		return s.simpleTool(http.MethodGet, "/api/v1/focus/lists", nil)
	case "set_focus_lists":
		return s.simpleTool(http.MethodPatch, "/api/v1/focus/lists", args)
	case "get_focus_session":
		return s.simpleTool(http.MethodGet, "/api/v1/focus/session", nil)
	case "start_focus_session":
		return s.startSession(args)
	case "end_focus_session":
		return s.endSession(args)
	default:
		return nil, fmt.Errorf("unknown tool %q", name)
	}
}

// simpleTool wraps a call whose 2xx payload becomes the tool result verbatim.
func (s *Server) simpleTool(method, path string, body any) (any, error) {
	status, payload, err := s.apiRequest(method, path, body)
	if errors.Is(err, errUnreachable) {
		return toolError(notRunning), nil
	}
	if err != nil {
		return toolError(err.Error()), nil
	}
	if status < 200 || status >= 300 {
		return toolError(errorText(payload, fmt.Sprintf("the app answered %d", status))), nil
	}
	return toolResult(payload), nil
}

func errorText(payload map[string]any, fallback string) string {
	if message, ok := payload["error"].(string); ok && message != "" {
		return message
	}
	return fallback
}

func (s *Server) startSession(args map[string]any) (any, error) {
	goal := strings.TrimSpace(argString(args, "goal"))
	if goal == "" {
		return toolError("goal is required"), nil
	}
	minutes, ok := argNumber(args, "minutes")
	if !ok || math.IsNaN(minutes) || minutes < 1 || minutes > 720 {
		return toolError("minutes must be a number between 1 and 720"), nil
	}
	source := strings.TrimSpace(argString(args, "source"))
	if source == "" {
		source = "agent"
	}
	body := map[string]any{"goal": goal, "source": source, "durationSeconds": math.Round(minutes * 60)}
	for _, key := range []string{"mode", "apps", "sites", "allowSites"} {
		if value, ok := args[key]; ok && value != nil {
			body[key] = value
		}
	}
	status, payload, err := s.apiRequest(http.MethodPost, "/api/v1/focus/session", body)
	if errors.Is(err, errUnreachable) {
		return toolError(notRunning), nil
	}
	if err != nil {
		return toolError(err.Error()), nil
	}
	switch status {
	case http.StatusCreated:
		return toolResult(payload), nil
	case http.StatusConflict:
		running, _ := payload["session"].(map[string]any)
		return toolError(fmt.Sprintf("A focus session is already running: %q (started by %s). End it before starting another.",
			running["goal"], running["source"])), nil
	default:
		return toolError(errorText(payload, fmt.Sprintf("the session was not started (%d)", status))), nil
	}
}

func (s *Server) endSession(args map[string]any) (any, error) {
	source := strings.TrimSpace(argString(args, "source"))
	if source == "" {
		source = "agent"
	}
	status, payload, err := s.apiRequest(http.MethodDelete, "/api/v1/focus/session?source="+url.QueryEscape(source), nil)
	if errors.Is(err, errUnreachable) {
		return toolError(notRunning), nil
	}
	if err != nil {
		return toolError(err.Error()), nil
	}
	switch status {
	case http.StatusOK:
		return toolResult(payload), nil
	case http.StatusConflict:
		running, _ := payload["session"].(map[string]any)
		return toolError(fmt.Sprintf("The running focus session belongs to %s, not to you. It can be ended from the screen-time window.",
			running["source"])), nil
	default:
		return toolError(errorText(payload, fmt.Sprintf("the session was not ended (%d)", status))), nil
	}
}

// toolDefinitions describes the tools for tools/list. The mode note is part of
// every list-taking tool: allow mode only permits what is listed, block mode
// only forbids it, and either way screen-time and the system stay usable.
func toolDefinitions() []map[string]any {
	stringArray := map[string]any{"type": "array", "items": map[string]any{"type": "string"}}
	modeEnum := map[string]any{"type": "string", "enum": []string{"allow", "block"}}
	listShape := func(appsHint, sitesHint string) map[string]any {
		return map[string]any{
			"type":       "object",
			"properties": map[string]any{"apps": stringArray, "sites": stringArray},
			"additionalProperties": false,
			"description":          fmt.Sprintf("%s %s", appsHint, sitesHint),
		}
	}
	return []map[string]any{
		{
			"name": "get_catalog",
			"description": "Lists the apps and sites screen-time has seen on this computer, most-used first. " +
				"Use the `id` values of the app rows in app lists for start_focus_session and set_focus_lists.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"days": map[string]any{"type": "integer", "enum": []int{1, 7, 30},
						"description": "How many days of history to read (default 30)."},
				},
			},
		},
		{
			"name": "get_focus_lists",
			"description": "Reads the saved focus lists: the default mode and the allow-mode and block-mode app/site " +
				"lists a session falls back to when it is started without its own lists.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			"name": "set_focus_lists",
			"description": "Edits the saved focus lists; every field is optional and merged. \"allow\" mode permits only the " +
				"listed apps and sites (screen-time and system surfaces like the desktop, task switcher and Settings always " +
				"stay usable, and browsers only open the listed sites). \"block\" mode covers only the listed apps and sites.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"mode":  modeEnum,
					"allow": listShape("App ids allowed during allow-mode sessions.", "Sites browsers may open during allow-mode sessions."),
					"block": listShape("App ids covered during block-mode sessions and between-session blocking.", "Sites covered during block-mode sessions and between-session blocking."),
				},
				"additionalProperties": false,
			},
		},
		{
			"name":        "get_focus_session",
			"description": "Reads the currently running focus session, or null when none runs.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			"name": "start_focus_session",
			"description": "Starts a timed focus session. \"allow\" mode permits only the listed apps and sites: screen-time and " +
				"system surfaces always stay usable, and browsers only open the listed sites (plus allowSites). \"block\" mode " +
				"covers only the listed apps and sites (allowSites always stays open). Omitted lists fall back to the saved " +
				"lists for the mode. Fails while a session from another source runs.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"goal", "minutes"},
				"properties": map[string]any{
					"goal":       map[string]any{"type": "string", "description": "What the session is for, e.g. \"Write the report\"."},
					"minutes":    map[string]any{"type": "number", "minimum": 1, "maximum": 720, "description": "Session length in minutes (1-720)."},
					"mode":       modeEnum,
					"apps":       stringArray,
					"sites":      stringArray,
					"allowSites": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Sites that always stay open in browsers."},
					"source":     map[string]any{"type": "string", "description": "Who owns the session (default \"agent\")."},
				},
				"additionalProperties": false,
			},
		},
		{
			"name": "end_focus_session",
			"description": "Ends the running focus session early, restoring the pre-session block list setting. Only the source " +
				"that started the session can end it; a session from another source is ended from the screen-time window.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"source": map[string]any{"type": "string", "description": "Your source name (default \"agent\")."},
				},
				"additionalProperties": false,
			},
		},
	}
}
