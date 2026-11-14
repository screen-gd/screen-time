package store

import (
	"regexp"
	"strings"
)

// Focus lockdown's block list. Mirrors electron/blocklist.js so both stores keep the same entries.

const blockedSitesLimit = 200

var (
	siteScheme = regexp.MustCompile(`^[a-z][a-z0-9+.-]*://`)
	sitePort   = regexp.MustCompile(`:\d+$`)
	siteHost   = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$`)
)

// normalizeSite turns a pasted address ("https://www.reddit.com/r/all", "*.reddit.com",
// "localhost:3000") into a bare hostname, or "". Entries are dotted hostnames,
// except the literal localhost, which is allowed for local dev pages.
func normalizeSite(value string) string {
	text := siteScheme.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "")
	if i := strings.IndexAny(text, "/?#"); i >= 0 {
		text = text[:i]
	}
	if i := strings.Index(text, "@"); i >= 0 {
		text = text[i+1:]
	}
	text = sitePort.ReplaceAllString(text, "")
	text = strings.TrimPrefix(text, "*.")
	text = strings.TrimPrefix(text, "www.")
	text = strings.TrimSuffix(text, ".")
	if text == "localhost" {
		return text
	}
	if len(text) > 253 || !siteHost.MatchString(text) {
		return ""
	}
	return text
}

func normalizeSiteList(list []string) []string {
	out := []string{}
	for _, item := range list {
		site := normalizeSite(item)
		if site == "" || contains(out, site) {
			continue
		}
		out = append(out, site)
		if len(out) >= blockedSitesLimit {
			break
		}
	}
	return out
}

var innerSpace = regexp.MustCompile(`\s+`)

// normalizeApp turns a path or display name into an app id, or "". Mirrors
// normalizeApp in electron/blocklist.js: "C:\Tools\Resolve.exe" -> "resolve",
// "/Applications/Safari.app" -> "safari", "Visual Studio Code" -> "visual studio code".
func normalizeApp(value string) string {
	text := strings.ToLower(strings.TrimSpace(value))
	if i := strings.LastIndexAny(text, `/\`); i >= 0 {
		text = text[i+1:]
	}
	text = strings.TrimSuffix(text, ".exe")
	text = strings.TrimSuffix(text, ".app")
	text = innerSpace.ReplaceAllString(strings.TrimSpace(text), " ")
	if len(text) < 1 || len(text) > 128 {
		return ""
	}
	return text
}

func normalizeAppList(list []string) []string {
	out := []string{}
	for _, item := range list {
		app := normalizeApp(item)
		if app == "" || contains(out, app) {
			continue
		}
		out = append(out, app)
		if len(out) >= blockedSitesLimit {
			break
		}
	}
	return out
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}
