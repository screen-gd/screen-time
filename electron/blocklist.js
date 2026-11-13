'use strict';

// Focus lockdown's block list: bare hostnames, matched with their subdomains.
// The Go backend (backend/internal/store) normalises entries the same way.

const LIST_LIMIT = 200;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

// Accepts what people paste: "https://www.reddit.com/r/all", "*.reddit.com", "Reddit.com".
function normalizeSite(value) {
  const text = String(value || '').trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]
    .replace(/^[^@]*@/, '')
    .replace(/:\d+$/, '')
    .replace(/^\*\./, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  return HOST.test(text) ? text : null;
}

function normalizeSiteList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const site = normalizeSite(item);
    if (site && !out.includes(site)) out.push(site);
    if (out.length >= LIST_LIMIT) break;
  }
  return out;
}

// The list entry that covers this domain, or null.
function blockedEntry(domain, list) {
  const host = normalizeSite(domain);
  if (!host) return null;
  return list.find((entry) => host === entry || host.endsWith(`.${entry}`)) || null;
}

// App list entries are normalized names or paths: "C:\Tools\Resolve.exe" and
// "Visual Studio Code" -> "resolve" and "visual studio code". The Go backend
// (backend/internal/store/blocklist.go) does the same.
function normalizeApp(value) {
  const text = String(value || '').trim().toLowerCase()
    .split(/[\\/]/).pop()
    .replace(/\.(exe|app)$/, '')
    .replace(/\s+/g, ' ');
  return text.length >= 1 && text.length <= 128 ? text : null;
}

function normalizeAppList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const app = normalizeApp(item);
    if (app && !out.includes(app)) out.push(app);
    if (out.length >= LIST_LIMIT) break;
  }
  return out;
}

// The id a recorded or foreground app path counts as.
function appIdOf(exePath) {
  return normalizeApp(exePath);
}

// Some pages and browsers put the address in the window title; that catches a
// site even when history has no match for it, as in a private window.
function titleEntry(title, list) {
  const text = String(title || '').toLowerCase();
  if (!text) return null;
  return list.find((entry) => {
    const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The end must not run on into a longer hostname: reddit.com.au is not reddit.com.
    return new RegExp(`(^|[^a-z0-9-])([a-z0-9-]+\\.)*${escaped}(?![a-z0-9-]|\\.[a-z0-9])`).test(text);
  }) || null;
}

module.exports = { normalizeSite, normalizeSiteList, normalizeApp, normalizeAppList, appIdOf, blockedEntry, titleEntry, LIST_LIMIT };
