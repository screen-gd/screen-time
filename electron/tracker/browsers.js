'use strict';

// Names the website behind a browser window by reading the browser's own history file.
// The history file is copied to a temporary folder, queried with an in-process SQLite, and deleted.
// Nothing is uploaded and nothing outside the history file is read.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const IS_WIN = process.platform === 'win32';

// Where each browser keeps its profile directories, per OS. A browser id maps
// to an array because flavours install in more than one place (snap, flatpak).
// Pure: the platform, home and env come in as arguments so tests can ask for
// any OS's layout. Chromium profiles are <root>/<Default|Profile N>/History;
// Firefox profiles are <root>/<profile>/places.sqlite on every OS.
function rootsFor(platform, home, env = {}) {
  if (platform === 'win32') {
    const join = path.win32.join;
    const local = env.LOCALAPPDATA || '';
    const roaming = env.APPDATA || '';
    return {
      chromium: {
        chrome: [join(local, 'Google', 'Chrome', 'User Data')],
        edge: [join(local, 'Microsoft', 'Edge', 'User Data')],
        brave: [join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')],
        vivaldi: [join(local, 'Vivaldi', 'User Data')],
        opera: [join(roaming, 'Opera Software', 'Opera Stable')],
        'opera-gx': [join(roaming, 'Opera Software', 'Opera GX Stable')],
      },
      firefox: {
        firefox: [join(roaming, 'Mozilla', 'Firefox', 'Profiles')],
        zen: [join(roaming, 'zen', 'Profiles')],
      },
    };
  }
  const join = path.posix.join;
  if (platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support');
    return {
      chromium: {
        chrome: [join(base, 'Google', 'Chrome')],
        chromium: [join(base, 'Chromium')],
        edge: [join(base, 'Microsoft Edge')],
        brave: [join(base, 'BraveSoftware', 'Brave-Browser')],
        vivaldi: [join(base, 'Vivaldi')],
        opera: [join(base, 'com.operasoftware.Opera')],
        'opera-gx': [join(base, 'com.operasoftware.OperaGX')],
        arc: [join(base, 'Arc', 'User Data')],
      },
      firefox: {
        firefox: [join(base, 'Firefox', 'Profiles')],
        zen: [join(base, 'zen', 'Profiles')],
      },
    };
  }
  const config = env.XDG_CONFIG_HOME || join(home, '.config');
  return {
    chromium: {
      chrome: [join(config, 'google-chrome')],
      chromium: [join(config, 'chromium'), join(home, 'snap', 'chromium', 'common', 'chromium')],
      edge: [join(config, 'microsoft-edge')],
      brave: [join(config, 'BraveSoftware', 'Brave-Browser')],
      vivaldi: [join(config, 'vivaldi')],
      opera: [join(config, 'opera')],
    },
    firefox: {
      firefox: [
        join(home, '.mozilla', 'firefox'),
        join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
        join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'),
      ],
      zen: [join(home, '.zen')],
    },
  };
}

const ROOTS = rootsFor(process.platform, os.homedir(), process.env);
const CHROMIUM_ROOTS = ROOTS.chromium;
const FIREFOX_ROOTS = ROOTS.firefox;

const BROWSER_LABELS = {
  chrome: 'Google Chrome',
  chromium: 'Chromium',
  edge: 'Microsoft Edge',
  brave: 'Brave',
  vivaldi: 'Vivaldi',
  opera: 'Opera',
  'opera-gx': 'Opera GX',
  arc: 'Arc',
  firefox: 'Firefox',
  zen: 'Zen',
};

const GENERIC = new Set([
  'new tab', 'new tab page', 'start page', 'untitled', 'about:blank', 'settings', 'extensions',
  'history', 'downloads', 'bookmarks', 'home', 'blank page', 'search',
]);

const cache = new Map(); // `${browserId}|${title}` -> { value, at }
const CACHE_MS = 10 * 60 * 1000;
const NEGATIVE_MS = 45 * 1000;
let profileCache = null;
let profileCacheAt = 0;
let sqlPromise = null;

function loadSql() {
  if (!sqlPromise) {
    const initSqlJs = require('sql.js');
    const wasm = require.resolve('sql.js/dist/sql-wasm.wasm');
    sqlPromise = initSqlJs({ locateFile: () => wasm });
  }
  return sqlPromise;
}

function chromiumProfiles(browserId) {
  const out = [];
  for (const root of CHROMIUM_ROOTS[browserId] || []) {
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^(Default|Profile \d+|Guest Profile)$/i.test(entry.name) && !fs.existsSync(path.join(root, entry.name, 'History'))) continue;
      const file = path.join(root, entry.name, 'History');
      try {
        const stat = fs.statSync(file);
        if (stat.isFile() && stat.size > 0) out.push({ browserId, family: 'chromium', file, label: entry.name, mtime: stat.mtimeMs });
      } catch {
        // a profile without history is normal
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function firefoxProfiles(browserId) {
  const out = [];
  for (const root of FIREFOX_ROOTS[browserId] || []) {
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'places.sqlite');
      try {
        const stat = fs.statSync(file);
        if (stat.isFile() && stat.size > 0) out.push({ browserId, family: 'firefox', file, label: entry.name, mtime: stat.mtimeMs });
      } catch {
        // no places database in this profile
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function discoverProfiles(force = false) {
  const now = Date.now();
  if (!force && profileCache && now - profileCacheAt < 5 * 60 * 1000) return profileCache;
  const all = [];
  for (const id of Object.keys(CHROMIUM_ROOTS)) all.push(...chromiumProfiles(id));
  for (const id of Object.keys(FIREFOX_ROOTS)) all.push(...firefoxProfiles(id));
  profileCache = all;
  profileCacheAt = now;
  return all;
}

function browserAvailability() {
  const profiles = discoverProfiles();
  const installedRoot = (id) => (CHROMIUM_ROOTS[id] || []).some((dir) => fs.existsSync(dir))
    || (FIREFOX_ROOTS[id] || []).some((dir) => fs.existsSync(dir));
  return Object.keys(BROWSER_LABELS).map((id) => ({
    id,
    name: BROWSER_LABELS[id],
    profiles: profiles.filter((p) => p.browserId === id).length,
    installed: profiles.some((p) => p.browserId === id) || installedRoot(id),
  }));
}

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^\(\d+\)\s*/, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreTitle(query, candidate) {
  const a = normalizeTitle(query);
  const b = normalizeTitle(candidate);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.startsWith(b) || b.startsWith(a)) {
    const diff = Math.abs(a.length - b.length);
    return Math.max(55, 92 - diff / 2);
  }
  if (a.includes(b) || b.includes(a)) return Math.max(45, 78 - Math.abs(a.length - b.length) / 3);
  const tokens = new Set(b.split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  if (!tokens.size) return 0;
  const common = a.split(/[^a-z0-9]+/).filter((t) => t.length > 2 && tokens.has(t)).length;
  return common / tokens.size >= 0.6 ? 40 : 0;
}

function domainOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

function copyHistory(profile) {
  const dir = path.join(os.tmpdir(), `tally-history-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, path.basename(profile.file));
  fs.copyFileSync(profile.file, target);
  for (const suffix of ['-wal', '-shm']) {
    const extra = `${profile.file}${suffix}`;
    if (fs.existsSync(extra)) {
      try { fs.copyFileSync(extra, `${target}${suffix}`); } catch { /* a locked wal is optional */ }
    }
  }
  return { dir, target };
}

async function readProfile(profile, limit = 500) {
  const SQL = await loadSql();
  const copy = copyHistory(profile);
  let db = null;
  try {
    db = new SQL.Database(new Uint8Array(fs.readFileSync(copy.target)));
    const sql = profile.family === 'firefox'
      ? `SELECT p.url, p.title, v.visit_date FROM moz_places p JOIN moz_historyvisits v ON v.place_id = p.id WHERE p.url LIKE 'http%' ORDER BY v.visit_date DESC LIMIT ${limit}`
      : `SELECT url, title, last_visit_time FROM urls WHERE url LIKE 'http%' ORDER BY last_visit_time DESC LIMIT ${limit}`;
    const result = db.exec(sql);
    if (!result.length) return [];
    return result[0].values.map(([url, title, time]) => ({
      url: String(url || ''),
      title: String(title || ''),
      // Chromium counts microseconds since 1601; Firefox microseconds since 1970.
      visitedAt: profile.family === 'firefox' ? Math.round(Number(time) / 1000) : Math.round(Number(time) / 1000 - 11644473600000),
    })).filter((row) => row.title && domainOf(row.url));
  } finally {
    if (db) db.close();
    try { fs.rmSync(copy.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function lookup(browser, cleanedTitle) {
  const title = String(cleanedTitle || '').trim();
  if (!title || GENERIC.has(normalizeTitle(title))) return null;

  const key = `${browser.id}|${normalizeTitle(title)}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < (cached.value ? CACHE_MS : NEGATIVE_MS)) return cached.value;

  const profiles = discoverProfiles().filter((p) => p.browserId === browser.id).slice(0, 4);
  if (!profiles.length) {
    cache.set(key, { value: null, at: Date.now() });
    return null;
  }

  let best = null;
  for (const profile of profiles) {
    let rows = [];
    try {
      rows = await readProfile(profile);
    } catch {
      continue;
    }
    const now = Date.now();
    for (const row of rows) {
      const score = scoreTitle(title, row.title);
      if (!score) continue;
      const ageMinutes = Math.max(0, (now - row.visitedAt) / 60000);
      const total = score - Math.min(ageMinutes / 8, 18);
      if (!best || total > best.total) best = { total, row, profile };
    }
    if (best && best.total >= 70) break;
  }

  // No title match: a visit in the last few minutes is still a fair answer for a page whose title
  // changed after it loaded (a live dashboard, a video, a mail client).
  if (!best && profiles.length) {
    try {
      const rows = await readProfile(profiles[0], 40);
      const recent = rows.find((row) => Date.now() - row.visitedAt < 5 * 60 * 1000);
      if (recent) best = { total: 10, row: recent, profile: profiles[0] };
    } catch {
      // no fallback available
    }
  }

  if (!best) {
    cache.set(key, { value: null, at: Date.now() });
    return null;
  }

  const domain = domainOf(best.row.url);
  const value = {
    domain,
    url: best.row.url,
    title: best.row.title,
    browser: browser.name,
    browserId: browser.id,
    visitedAt: best.row.visitedAt,
  };
  if (cache.size > 400) cache.clear();
  cache.set(key, { value, at: Date.now() });
  return value;
}

module.exports = {
  lookup,
  discoverProfiles,
  browserAvailability,
  rootsFor,
  domainOf,
  normalizeTitle,
  IS_WIN,
};
