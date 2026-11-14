'use strict';

// The session rules from backend/internal/store/focus.go, mirrored for the
// local store so sessions behave the same when the Go backend is not running.
// They mutate a data object shaped { settings, focus: { session,
// restoreLockdown } }; the caller decides when to save.

const crypto = require('node:crypto');
const { normalizeSiteList, normalizeAppList } = require('./blocklist');

const MIN_SECONDS = 60;
const MAX_SECONDS = 43200;

function fail(error) {
  return { ok: false, status: 400, error };
}

// An expired session ends: the lockdown it saw is restored and the marker
// cleared. Returns true when it did so.
function expireFocus(data, now = Date.now) {
  const session = data.focus && data.focus.session;
  if (!session) return false;
  const ends = Date.parse(session.endsAt);
  if (!Number.isNaN(ends) && ends > now()) return false;
  endSession(data);
  return true;
}

// Writes back the lockdown value a session replaced and clears the session.
function endSession(data) {
  if (data.focus.restoreLockdown !== null && data.focus.restoreLockdown !== undefined) {
    data.settings.focusLockdown = Boolean(data.focus.restoreLockdown);
  }
  data.focus.session = null;
  data.focus.restoreLockdown = null;
}

// Validates a start request and installs the session. A session from another
// source conflicts; one from the same source is replaced.
function startFocus(data, input = {}, now = Date.now) {
  expireFocus(data, now);
  const source = String(input.source || '').trim();
  if (!source) return fail('source is required');
  if (source.length > 64) return fail('source must be 64 characters or fewer');
  const goal = String(input.goal || '').trim();
  if (!goal) return fail('goal is required');
  if ([...goal].length > 200) return fail('goal must be 200 characters or fewer');
  const seconds = Math.round(Number(input.durationSeconds));
  if (!Number.isFinite(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
    return fail('durationSeconds must be a number between 60 and 43200');
  }
  let mode = String(input.mode || '').trim().toLowerCase();
  if (!mode) mode = data.settings.focusMode;
  if (mode !== 'allow' && mode !== 'block') return fail('mode must be "allow" or "block"');
  const apps = input.apps === undefined
    ? (mode === 'allow' ? data.settings.focusAllowApps : data.settings.focusBlockApps)
    : input.apps;
  const sites = input.sites === undefined
    ? (mode === 'allow' ? data.settings.focusAllowSites : data.settings.blockedSites)
    : input.sites;
  const allowSites = input.allowSites === undefined ? [] : input.allowSites;
  const current = data.focus.session;
  if (current && current.source !== source) return { ok: false, status: 409, session: current };
  // Only a fresh run remembers the lockdown to restore; a replaced session
  // keeps the value its source already saved.
  if (!current) data.focus.restoreLockdown = Boolean(data.settings.focusLockdown);
  const started = now();
  const session = {
    id: crypto.randomBytes(16).toString('hex'),
    goal,
    source,
    mode,
    apps: normalizeAppList(apps),
    sites: normalizeSiteList(sites),
    allowSites: normalizeSiteList(allowSites),
    startedAt: new Date(started).toISOString(),
    endsAt: new Date(started + seconds * 1000).toISOString(),
  };
  data.focus.session = session;
  return { ok: true, session };
}

// Ends the session belonging to a source; "screen-time" ends any session.
function endFocus(data, source, now = Date.now) {
  expireFocus(data, now);
  source = String(source || '').trim();
  if (!source) return fail('source is required');
  const current = data.focus.session;
  if (!current) return { ok: true, session: null };
  if (current.source !== source && source !== 'screen-time') {
    return { ok: false, status: 409, session: current };
  }
  endSession(data);
  return { ok: true, session: null };
}

module.exports = { startFocus, endFocus, expireFocus, MIN_SECONDS, MAX_SECONDS };
