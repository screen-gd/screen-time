'use strict';

// The focus-session rules in electron/focus-rules.js and the local store's
// session lifecycle in electron/focus-session.js, run without a desktop.
// browser-window scenarios for the guard live in tracker-test.js.
//
// Run with `bun run test`.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeApp, normalizeAppList, appIdOf } = require('../electron/blocklist');
const { alwaysAllowed, rulesFor, judge, blankPage } = require('../electron/focus-rules');
const { FocusGuard, UNKNOWN_PAGE_MS } = require('../electron/focus');
const { Store } = require('../electron/tracker/store');
const { connectionPath, writeConnection, removeConnection } = require('../electron/connection-file');

let clock = Date.parse('2026-11-14T10:00:00Z');
Date.now = () => clock;

function session(overrides = {}) {
  return {
    id: 's1', goal: 'Write the spec', source: 'screen-time', mode: 'allow',
    apps: ['code'], sites: ['github.com'], allowSites: [],
    startedAt: new Date(clock - 600000).toISOString(),
    endsAt: new Date(clock + 1500000).toISOString(),
    ...overrides,
  };
}

const results = [];
async function scenario(name, fn) {
  clock = Date.parse('2026-11-14T10:00:00Z');
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}\n     ${error.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  await scenario('app ids normalize like site entries', async () => {
    assert.equal(normalizeApp('C:\\Tools\\Editor\\code.exe'), 'code');
    assert.equal(normalizeApp(' Visual  Studio   Code '), 'visual studio code');
    assert.equal(normalizeApp('/Applications/Slack.app'), 'slack');
    assert.equal(normalizeApp('C:\\'), null);
    assert.equal(normalizeApp(''), null);
    assert.equal(normalizeApp(null), null);
    assert.deepEqual(normalizeAppList(['Code.exe', 'code', 'Slack.app', 'x'.repeat(200)]), ['code', 'slack']);
    assert.equal(appIdOf('C:\\Program Files\\Notion\\Notion.exe'), 'notion');
  });

  await scenario('the shell and other always-allowed surfaces are never covered', async () => {
    const fg = (exePath, extra = {}) => ({ pid: 5, exePath, title: 'x', ...extra });
    assert.equal(alwaysAllowed(fg('C:\\Windows\\explorer.exe'), 'win32'), true);
    assert.equal(alwaysAllowed(fg('C:\\Windows\\System32\\Taskmgr.exe'), 'win32'), true);
    assert.equal(alwaysAllowed(fg('C:\\Windows\\SystemApps\\LockApp.exe'), 'win32'), true);
    assert.equal(alwaysAllowed(fg('C:\\Program Files\\App\\app.exe', { aumid: 'Microsoft.Windows.Explorer' }), 'win32'), false);
    assert.equal(alwaysAllowed(fg('/System/Apps/Finder.app', { bundleId: 'com.apple.finder' }), 'darwin'), true);
    assert.equal(alwaysAllowed(fg('/System/Apps/Stuff.app', { bundleId: 'com.apple.dock' }), 'darwin'), true);
    assert.equal(alwaysAllowed(fg('/usr/bin/gnome-shell'), 'linux'), true);
    assert.equal(alwaysAllowed(fg(''), 'win32'), true, 'an exe-less window cannot be covered');
    assert.equal(alwaysAllowed(fg('C:\\screen-time\\screen-time.exe'), 'win32'), true, 'the app itself stays reachable');
    assert.equal(alwaysAllowed(fg('C:\\electron\\electron.exe'), 'win32'), true, 'dev runs under electron.exe');
    assert.equal(alwaysAllowed(fg('C:\\chrome.exe'), 'win32'), false);
  });

  await scenario('a live session wins over the block list, expiry hands back', async () => {
    const settings = { focusLockdown: true, blockedSites: ['reddit.com'], focusBlockApps: ['slack'] };
    const live = rulesFor(settings, session(), clock);
    assert.equal(live.mode, 'allow');
    assert.equal(live.session.goal, 'Write the spec');
    const expired = rulesFor(settings, session({ endsAt: new Date(clock - 1000).toISOString() }), clock);
    assert.equal(expired.mode, 'block');
    assert.equal(expired.session, null);
    assert.deepEqual(expired.sites, ['reddit.com']);
    assert.deepEqual(expired.apps, ['slack']);
    assert.equal(rulesFor({ focusLockdown: true, blockedSites: [], focusBlockApps: [] }, null, clock), null,
      'lockdown with empty lists enforces nothing');
    assert.equal(rulesFor({ focusLockdown: false }, null, clock), null);
  });

  await scenario('allow mode covers anything not listed', async () => {
    const rules = rulesFor({}, session({ apps: ['code'], sites: ['github.com'], allowSites: ['stackoverflow.com'] }), clock);
    assert.equal(judge(rules, { app: { id: 'code', name: 'Visual Studio Code' } }), null);
    assert.deepEqual(judge(rules, { app: { id: 'notion', name: 'Notion' } }), { kind: 'app', label: 'Notion' });
    // Browsers open only the listed sites, whatever the app list says.
    assert.equal(judge(rules, { app: { id: 'chrome', name: 'Google Chrome' }, browser: true, site: 'github.com' }), null);
    assert.equal(judge(rules, { app: { id: 'chrome', name: 'Google Chrome' }, browser: true, site: 'gist.github.com' }), null, 'subdomains match');
    assert.equal(judge(rules, { app: { id: 'chrome', name: 'Google Chrome' }, browser: true, site: 'stackoverflow.com' }), null, 'allowSites stay open');
    assert.deepEqual(judge(rules, { app: { id: 'chrome', name: 'Google Chrome' }, browser: true, site: 'reddit.com' }), { kind: 'site', label: 'reddit.com' });
    assert.deepEqual(judge(rules, { app: { id: 'chrome', name: 'Google Chrome' }, browser: true, site: null, blank: false }), { kind: 'page', label: 'Google Chrome' });
    assert.equal(judge(rules, { app: { id: 'chrome' }, browser: true, site: null, blank: true }), null, 'a new tab is no page yet');
    const empty = rulesFor({}, session({ sites: [], allowSites: [] }), clock);
    assert.deepEqual(judge(empty, { app: { id: 'chrome', name: 'Google Chrome' }, browser: true, site: 'github.com' }), { kind: 'app', label: 'Google Chrome' },
      'empty open lists cover the whole browser');
  });

  await scenario('block mode covers only the listed apps and sites', async () => {
    const rules = rulesFor({}, session({ mode: 'block', apps: ['slack'], sites: ['reddit.com'], allowSites: ['status.reddit.com'] }), clock);
    assert.deepEqual(judge(rules, { app: { id: 'slack', name: 'Slack' } }), { kind: 'app', label: 'Slack' });
    assert.equal(judge(rules, { app: { id: 'code' } }), null);
    // A browser not on the app list only trips on the blocked sites.
    assert.deepEqual(judge(rules, { app: { id: 'chrome' }, browser: true, site: 'reddit.com' }), { kind: 'site', label: 'reddit.com' });
    assert.deepEqual(judge(rules, { app: { id: 'chrome' }, browser: true, site: 'old.reddit.com' }), { kind: 'site', label: 'reddit.com' });
    assert.equal(judge(rules, { app: { id: 'chrome' }, browser: true, site: 'status.reddit.com' }), null, 'allowSites overrides');
    assert.equal(judge(rules, { app: { id: 'chrome' }, browser: true, site: 'news.ycombinator.com' }), null);
    assert.equal(judge(rules, { app: { id: 'chrome' }, browser: true, site: null, blank: false }), null, 'unknown pages are allowed');
    // A browser on the app list keeps only allowSites open.
    const blocked = rulesFor({}, session({ mode: 'block', apps: ['firefox'], allowSites: ['github.com'] }), clock);
    assert.equal(judge(blocked, { app: { id: 'firefox' }, browser: true, site: 'github.com' }), null);
    assert.deepEqual(judge(blocked, { app: { id: 'firefox', name: 'Firefox' }, browser: true, site: 'reddit.com' }), { kind: 'site', label: 'reddit.com' });
    assert.deepEqual(judge(blocked, { app: { id: 'firefox', name: 'Firefox' }, browser: true, site: null, blank: false }), { kind: 'page', label: 'Firefox' });
  });

  await scenario('new-tab-like titles count as blank pages', async () => {
    for (const title of ['New tab', 'New Private Tab', 'new incognito tab', 'InPrivate', 'Private Browsing', 'Start Page', 'Speed Dial', 'Google Chrome', 'Mozilla Firefox', '']) {
      assert.equal(blankPage(title), true, title);
    }
    for (const title of ['Inbox - Gmail', 'Weekly notes', 'github.com']) {
      assert.equal(blankPage(title), false, title);
    }
  });

  function makeGuard({ store, foreground, found = null, identified = null }) {
    const cover = { shown: null, shows: 0, show(target) { this.shown = target; this.shows += 1; }, hide() { this.shown = null; } };
    const guard = new FocusGuard({
      store,
      cover,
      readWindow: () => foreground.current,
      identifyApp: identified || ((fg) => ({ name: fg.exePath.replace(/.*[\\/]/, ''), browser: null })),
      lookup: async () => (typeof found === 'function' ? found() : found),
      selfPid: 1,
      platform: 'win32',
    });
    return { guard, cover };
  }

  await scenario('the guard covers an unlisted app with the session payload', async () => {
    const live = session();
    const store = { settings: {}, focusSession: live };
    const foreground = { current: { pid: 7, exePath: 'C:\\Notion\\Notion.exe', title: 'Notes' } };
    const { guard, cover } = makeGuard({ store, foreground, identified: () => ({ name: 'Notion', browser: null }) });
    await guard.check();
    assert.equal(cover.shown.kind, 'app');
    assert.equal(cover.shown.label, 'Notion');
    assert.equal(cover.shown.mode, 'allow');
    assert.equal(cover.shown.goal, 'Write the spec');
    assert.equal(cover.shown.endsAt, live.endsAt);
    // A listed app lifts it again.
    foreground.current = { pid: 8, exePath: 'C:\\code.exe', title: 'main.go' };
    const { guard: guard2, cover: cover2 } = makeGuard({ store, foreground });
    guard2.identifyApp = () => ({ name: 'Visual Studio Code', browser: null });
    await guard2.check();
    assert.equal(cover2.shown, null);
  });

  await scenario('the shell is never covered even when the block list names it', async () => {
    const store = { settings: { focusLockdown: true, blockedSites: [], focusBlockApps: ['explorer', 'slack'] }, focusSession: null };
    const foreground = { current: { pid: 8, exePath: 'C:\\Windows\\explorer.exe', title: 'Documents' } };
    const { guard, cover } = makeGuard({ store, foreground });
    await guard.check();
    assert.equal(cover.shown, null);
    // But a listed ordinary app still is.
    foreground.current = { pid: 9, exePath: 'C:\\Slack\\slack.exe', title: 'Slack' };
    await guard.check();
    assert.equal(cover.shown.kind, 'app');
    assert.equal(cover.shown.mode, 'block');
    assert.equal(cover.shown.goal, null);
  });

  await scenario('an unnamed page is covered only after the grace period', async () => {
    const store = { settings: {}, focusSession: session() };
    const foreground = { current: { pid: 9, exePath: 'C:\\chrome.exe', title: 'Some page - Google Chrome' } };
    const identified = () => ({ name: 'Google Chrome', browser: { id: 'chrome', name: 'Google Chrome', family: 'chromium' } });
    const { guard, cover } = makeGuard({ store, foreground, identified });
    await guard.check();
    assert.equal(cover.shown, null, 'a new page gets a grace');
    clock += UNKNOWN_PAGE_MS - 100;
    await guard.check();
    assert.equal(cover.shown, null, 'still inside the grace');
    clock += 200;
    await guard.check();
    assert.equal(cover.shown.kind, 'page');
    assert.equal(cover.shown.label, 'Google Chrome');
    // A different window resets the grace.
    foreground.current = { pid: 10, exePath: 'C:\\chrome.exe', title: 'Other page - Google Chrome' };
    await guard.check();
    assert.equal(cover.shown, null);
  });

  await scenario('a session expiring lifts the cover on the next check', async () => {
    const live = session();
    const store = { settings: {}, focusSession: live };
    const foreground = { current: { pid: 7, exePath: 'C:\\Notion\\Notion.exe', title: 'Notes' } };
    const { guard, cover } = makeGuard({ store, foreground, identified: () => ({ name: 'Notion', browser: null }) });
    await guard.check();
    assert.equal(cover.shown.kind, 'app');
    live.endsAt = new Date(clock - 1000).toISOString();
    await guard.check();
    assert.equal(cover.shown, null, 'the expired session stopped enforcing');
    assert.equal(guard.active(), false);
  });

  await scenario('the local store keeps a session and restores the lockdown', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-focus-'));
    const file = path.join(dir, 'tally-data.json');
    const store = new Store(file).load();
    assert.equal(store.focusSession, null);
    const result = store.startFocus({ goal: 'Write', source: 'screen-time', durationSeconds: 1500 });
    assert.equal(result.ok, true);
    assert.equal(result.session.goal, 'Write');
    assert.match(result.session.endsAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The shared file sees the session right away, not after the save delay.
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.focus.session.goal, 'Write');
    assert.equal(onDisk.focus.restoreLockdown, false);
    // A lockdown switched on during the session is undone when it ends.
    store.updateSettings({ focusLockdown: true });
    const ended = store.endFocus('screen-time');
    assert.equal(ended.ok, true);
    assert.equal(store.settings.focusLockdown, false, 'the pre-session lockdown is restored');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).focus.session, null);
  });

  await scenario('start and end honor the source rules', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-focus-'));
    const store = new Store(path.join(dir, 'tally-data.json')).load();
    const started = store.startFocus({ goal: 'Agent run', source: 'claude', durationSeconds: 300 });
    assert.equal(started.ok, true);
    const conflict = store.startFocus({ goal: 'Mine', source: 'screen-time', durationSeconds: 300 });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.session.goal, 'Agent run');
    const mismatch = store.endFocus('screen-time');
    assert.equal(mismatch.ok, true, 'screen-time ends any session');
    assert.equal(store.focusSession, null);
    const again = store.startFocus({ goal: 'A', source: 'agent', durationSeconds: 300 });
    const replaced = store.startFocus({ goal: 'B', source: 'agent', durationSeconds: 300 });
    assert.equal(replaced.ok, true, 'the same source replaces its session');
    assert.notEqual(replaced.session.id, again.session.id);
    const wrong = store.endFocus('other-agent');
    assert.equal(wrong.status, 409);
    const invalid = store.startFocus({ goal: '', source: 'x', durationSeconds: 300 });
    assert.equal(invalid.status, 400);
    const short = store.startFocus({ goal: 'g', source: 'x', durationSeconds: 30 });
    assert.equal(short.status, 400);
    const noSource = store.endFocus('');
    assert.equal(noSource.status, 400);
  });

  await scenario('an expired session in the file ends on open', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-focus-'));
    const file = path.join(dir, 'tally-data.json');
    const data = {
      settings: { focusLockdown: true },
      focus: { session: session({ endsAt: '2020-01-01T00:00:00.000Z' }), restoreLockdown: false },
    };
    fs.writeFileSync(file, JSON.stringify(data));
    const store = new Store(file).load();
    assert.equal(store.focusSession, null);
    assert.equal(store.settings.focusLockdown, false, 'the stored lockdown value was restored');
  });

  await scenario('the catalog merges app keys into app ids', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-focus-'));
    const store = new Store(path.join(dir, 'tally-data.json')).load();
    store.record({ appKey: 'C:\\Apps\\Code\\code.exe', appName: 'Visual Studio Code', seconds: 100 });
    store.record({ appKey: '/opt/vscode/code', appName: 'Code', seconds: 50 });
    store.record({ appKey: 'C:\\chrome.exe', appName: 'Google Chrome', browser: { id: 'chrome' }, seconds: 200 });
    const catalog = store.catalog(30);
    const code = catalog.apps.find((app) => app.id === 'code');
    assert.equal(code.seconds, 150);
    assert.equal(code.name, 'Visual Studio Code', 'the heaviest key names the id');
    assert.equal(code.browser, false);
    const chrome = catalog.apps.find((app) => app.id === 'chrome');
    assert.equal(chrome.browser, true);
  });

  await scenario('the new settings normalize like the old ones', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-focus-'));
    const store = new Store(path.join(dir, 'tally-data.json')).load();
    const next = store.updateSettings({
      focusMode: 'block',
      focusAllowApps: ['VSCode.exe', 'vscode.exe'],
      focusAllowSites: ['https://github.com/'],
      focusBlockApps: ['Slack.app'],
      focusMinutes: 90,
    });
    assert.equal(next.focusMode, 'block');
    assert.deepEqual(next.focusAllowApps, ['vscode'], 'dedupe after normalization');
    assert.deepEqual(next.focusAllowSites, ['github.com']);
    assert.deepEqual(next.focusBlockApps, ['slack']);
    assert.equal(next.focusMinutes, 90);
    const bad = store.updateSettings({ focusMode: 'everything', focusMinutes: 999 });
    assert.equal(bad.focusMode, 'allow');
    assert.equal(bad.focusMinutes, 50);
  });

  await scenario('the connection file lives at the contract path', async () => {
    const env = { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' };
    assert.equal(connectionPath('win32', env, 'C:\\Users\\u'),
      path.join('C:\\Users\\u\\AppData\\Roaming', 'screen-time', 'connection.json'));
    assert.equal(connectionPath('darwin', {}, '/Users/u'),
      path.join('/Users/u/Library/Application Support', 'screen-time', 'connection.json'));
    assert.equal(connectionPath('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/u'),
      path.join('/xdg', 'screen-time', 'connection.json'));
    assert.equal(connectionPath('linux', {}, '/home/u'),
      path.join('/home/u/.config', 'screen-time', 'connection.json'));
    assert.equal(connectionPath('win32', { TALLY_CONNECTION_FILE: 'D:\\conn.json' }, 'C:\\u'), 'D:\\conn.json',
      'the env override wins on every platform');
  });

  await scenario('the connection file is written and removed by pid', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-conn-'));
    const file = path.join(dir, 'deep', 'connection.json');
    writeConnection(file, { version: 1, url: 'http://127.0.0.1:1234', token: 'abc', pid: 42 });
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(info.token, 'abc');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    // A different owner must not delete a newer run's file.
    removeConnection(file, 99);
    assert.equal(fs.existsSync(file), true);
    removeConnection(file, 42);
    assert.equal(fs.existsSync(file), false);
    // Removing a file that is already gone is not an error.
    removeConnection(file, 42);
  });

  console.log(results.join('\n'));
  console.log(process.exitCode ? '\nFAILED' : '\nall focus rules hold');
}

main();
