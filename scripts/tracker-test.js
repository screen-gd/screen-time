'use strict';

// Exercises the sampling rules in electron/tracker/index.js without a desktop:
// which ticks earn seconds, what the idle loop costs, and the guards around
// sleep, lock and a player left running.
//
// Run with `npm test`.

const assert = require('node:assert/strict');
const { Tracker } = require('../electron/tracker');
const { identify } = require('../electron/tracker/apps');
const { rootsFor } = require('../electron/tracker/browsers');

let clock = Date.parse('2026-10-28T09:00:00Z');
Date.now = () => clock;

const FOREGROUND = {
  title: 'A very long video - player',
  pid: 4242,
  exePath: 'C:\\Program Files\\Player\\player.exe',
  aumid: '',
  idleMs: 0,
};

function makeStore(overrides = {}) {
  return {
    settings: {
      sampleSeconds: 5,
      idleSeconds: 120,
      mediaCeilingMinutes: 120,
      paused: false,
      recordWebsites: false,
      launchAtLogin: false,
      retentionDays: 90,
      browsers: null,
      ...overrides,
    },
    credits: [],
    record(sample) {
      this.credits.push(sample);
    },
  };
}

function makeMedia() {
  return {
    playing: false,
    fullscreen: false,
    reads: 0,
    available: () => true,
    async read() {
      this.reads += 1;
      return { available: true, error: null, playing: this.playing, fullscreen: this.fullscreen, sessions: 1 };
    },
  };
}

function makeTracker(settings) {
  const store = makeStore(settings);
  const media = makeMedia();
  const tracker = new Tracker({
    store,
    mediaSignal: media,
    readWindow: () => ({ ...FOREGROUND }),
    support: () => ({ supported: true, reason: null, message: null }),
  });
  tracker.running = true;
  tracker.lastSampleAt = clock;
  tracker.lastCreditedAt = clock;
  tracker.resuming = true;
  return { tracker, store, media };
}

async function tick(tracker, seconds, patch = {}) {
  clock += seconds * 1000;
  Object.assign(FOREGROUND, patch);
  await tracker.tick();
}

function credited(store) {
  return Math.round(store.credits.reduce((sum, row) => sum + row.seconds, 0));
}

const results = [];
async function scenario(name, fn) {
  clock = Date.parse('2026-10-28T09:00:00Z');
  Object.assign(FOREGROUND, { idleMs: 0, title: 'A very long video - player', pid: 4242, exePath: 'C:\\Program Files\\Player\\player.exe' });
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}\n     ${error.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  await scenario('input credits every sample', async () => {
    const { tracker, store } = makeTracker();
    for (let i = 0; i < 4; i++) await tick(tracker, 5, { idleMs: 0 });
    assert.equal(credited(store), 20);
  });

  await scenario('idle without media credits nothing', async () => {
    const { tracker, store, media } = makeTracker();
    await tick(tracker, 5, { idleMs: 200000 });
    assert.equal(credited(store), 0);
    assert.equal(tracker.status.idle, true);
    assert.equal(tracker.nextDelay, 20000, 'idle poll should slow to 20 s');
    assert.equal(media.reads, 1);
  });

  await scenario('media in the front app keeps counting while idle', async () => {
    const { tracker, store, media } = makeTracker();
    media.playing = true;
    await tick(tracker, 5, { idleMs: 200000 });
    await tick(tracker, 5, { idleMs: 210000 });
    await tick(tracker, 5, { idleMs: 215000 });
    assert.equal(credited(store), 15);
    assert.equal(tracker.status.idle, false);
    assert.equal(tracker.status.media, true);
  });

  await scenario('background media does not hold the clock', async () => {
    const { tracker, store, media } = makeTracker();
    media.playing = false;
    await tick(tracker, 20, { idleMs: 200000 });
    assert.equal(credited(store), 0);
  });

  await scenario('media starting after a pause credits one sample, not the gap', async () => {
    const { tracker, store, media } = makeTracker();
    await tick(tracker, 20, { idleMs: 200000 });
    assert.equal(credited(store), 0);
    media.playing = true;
    await tick(tracker, 20, { idleMs: 220000 });
    assert.equal(credited(store), 5, 'the first credited sample is capped at the sample length');
  });

  await scenario('media stopping returns to idle', async () => {
    const { tracker, store, media } = makeTracker();
    media.playing = true;
    await tick(tracker, 5, { idleMs: 200000 });
    assert.equal(credited(store), 5);
    media.playing = false;
    await tick(tracker, 5, { idleMs: 205000 });
    assert.equal(credited(store), 5);
  });

  await scenario('two hours of untouched media ends the run', async () => {
    const { tracker, store, media } = makeTracker();
    media.playing = true;
    await tick(tracker, 5, { idleMs: 200000 });
    tracker.mediaSince = Date.now() - (2 * 60 * 60 * 1000) - 1000;
    await tick(tracker, 5, { idleMs: 205000 });
    assert.equal(credited(store), 5);
    assert.equal(tracker.status.reason, 'limit', 'the sidebar can say why counting stopped');
  });

  await scenario('the media ceiling is a setting, and never is allowed', async () => {
    const { tracker, store, media } = makeTracker({ mediaCeilingMinutes: null });
    media.playing = true;
    await tick(tracker, 5, { idleMs: 200000 });
    tracker.mediaSince = Date.now() - (9 * 60 * 60 * 1000);
    await tick(tracker, 5, { idleMs: 205000 });
    assert.equal(credited(store), 10);
    assert.equal(tracker.status.reason, 'media');
  });

  await scenario('a shorter ceiling stops media sooner', async () => {
    const { tracker, store, media } = makeTracker({ mediaCeilingMinutes: 30 });
    media.playing = true;
    await tick(tracker, 5, { idleMs: 200000 });
    tracker.mediaSince = Date.now() - (31 * 60 * 1000);
    await tick(tracker, 5, { idleMs: 205000 });
    assert.equal(credited(store), 5);
    assert.equal(tracker.status.reason, 'limit');
    assert.equal(tracker.status.idle, true);
  });

  await scenario('the reason follows the desk', async () => {
    const { tracker, media } = makeTracker();
    await tick(tracker, 5, { idleMs: 0 });
    assert.equal(tracker.status.reason, 'recording');
    assert.equal(tracker.status.mediaSessions, null, 'media is not read while input is fresh');
    await tick(tracker, 5, { idleMs: 200000 });
    assert.equal(tracker.status.reason, 'idle');
    media.playing = true;
    await tick(tracker, 5, { idleMs: 205000 });
    assert.equal(tracker.status.reason, 'media');
    assert.equal(tracker.status.mediaSessions, 1);
    await tick(tracker, 5, { pid: process.pid, idleMs: 0 });
    assert.equal(tracker.status.reason, 'self');
  });

  await scenario('paused and sleep both say so', async () => {
    const { tracker } = makeTracker({ paused: true });
    await tick(tracker, 5, { idleMs: 0 });
    assert.equal(tracker.status.reason, 'paused');
    tracker.store.settings.paused = false;
    await tick(tracker, 600, { idleMs: 0 });
    assert.equal(tracker.status.reason, 'starting', 'a gap is not credited and does not claim to be recording');
  });

  await scenario('a full-screen app counts as in use', async () => {
    const { tracker, store, media } = makeTracker();
    media.fullscreen = true;
    await tick(tracker, 5, { idleMs: 200000 });
    assert.equal(credited(store), 5);
    assert.equal(tracker.status.idle, false);
  });

  await scenario('a sleep gap is never credited', async () => {
    const { tracker, store } = makeTracker();
    await tick(tracker, 600, { idleMs: 0 });
    assert.equal(credited(store), 0);
  });

  await scenario('pausing stops credit and idle resumes it', async () => {
    const { tracker, store } = makeTracker({ paused: true });
    await tick(tracker, 5, { idleMs: 0 });
    assert.equal(credited(store), 0);
    tracker.store.settings.paused = false;
    await tick(tracker, 5, { idleMs: 0 });
    assert.equal(credited(store), 5);
  });

  await scenario('suspending clears the timer', async () => {
    const { tracker } = makeTracker();
    tracker.suspend();
    assert.equal(tracker.suspended, true);
    assert.equal(tracker.timer, null);
    tracker.wake();
    assert.equal(tracker.suspended, false);
  });

  await scenario('identify reads macOS apps by bundle id', async () => {
    const chrome = identify(
      { exePath: '/Applications/Google Chrome.app', bundleId: 'com.google.Chrome', name: 'Google Chrome' },
      'darwin');
    assert.equal(chrome.name, 'Google Chrome');
    assert.equal(chrome.browser.id, 'chrome');
    const zen = identify({ exePath: '/Applications/Zen.app', bundleId: 'app.zen-browser.zen', name: 'Zen' }, 'darwin');
    assert.equal(zen.browser.id, 'zen');
    // No bundle id, no OS name: the bundle path supplies the name.
    const other = identify({ exePath: '/Applications/Things 3.app', bundleId: '', name: '' }, 'darwin');
    assert.equal(other.name, 'Things 3');
    assert.equal(other.browser, null);
  });

  await scenario('identify reads Linux executables', async () => {
    const snap = identify({ exePath: '/snap/chromium/3365/usr/lib/chromium-browser/chrome' }, 'linux');
    assert.equal(snap.browser.id, 'chromium', 'a chrome binary inside a chromium path is Chromium');
    assert.equal(snap.name, 'Chromium');
    const chrome = identify({ exePath: '/usr/bin/google-chrome' }, 'linux');
    assert.equal(chrome.browser.id, 'chrome');
    assert.equal(chrome.name, 'Google Chrome');
    const esr = identify({ exePath: '/usr/lib/firefox-esr/firefox-esr' }, 'linux');
    assert.equal(esr.browser.id, 'firefox');
    const term = identify({ exePath: '/usr/libexec/gnome-terminal-server' }, 'linux');
    assert.equal(term.name, 'Terminal');
    assert.equal(term.browser, null);
    const unknown = identify({ exePath: '/opt/better-sqlite-gui/run' }, 'linux');
    assert.equal(unknown.name, 'Run');
  });

  await scenario('rootsFor lays out each OS', async () => {
    const win = rootsFor('win32', 'C:\\Users\\u', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' });
    assert.deepEqual(win.chromium.chrome, ['C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data']);
    const mac = rootsFor('darwin', '/Users/u', {});
    assert.deepEqual(mac.chromium.chrome, ['/Users/u/Library/Application Support/Google/Chrome']);
    assert.deepEqual(mac.chromium.arc, ['/Users/u/Library/Application Support/Arc/User Data']);
    assert.deepEqual(mac.firefox.zen, ['/Users/u/Library/Application Support/zen/Profiles']);
    const linux = rootsFor('linux', '/home/u', {});
    assert.deepEqual(linux.chromium.chrome, ['/home/u/.config/google-chrome']);
    assert.deepEqual(linux.chromium.chromium, ['/home/u/.config/chromium', '/home/u/snap/chromium/common/chromium']);
    assert.ok(linux.firefox.firefox.includes('/home/u/.mozilla/firefox'));
    assert.ok(linux.firefox.firefox.includes('/home/u/.var/app/org.mozilla.firefox/.mozilla/firefox'));
    const xdg = rootsFor('linux', '/home/u', { XDG_CONFIG_HOME: '/custom/cfg' });
    assert.deepEqual(xdg.chromium.chrome, ['/custom/cfg/google-chrome']);
  });

  await scenario('an unsupported platform says why', async () => {
    const store = makeStore();
    const media = makeMedia();
    const tracker = new Tracker({
      store,
      mediaSignal: media,
      readWindow: () => null,
      support: () => ({ supported: false, reason: 'wayland', message: 'Wayland hides the active window from apps. Sign in with an X11 session to track.' }),
    });
    assert.equal(tracker.status.supported, false);
    tracker.start();
    assert.equal(tracker.status.error, 'Wayland hides the active window from apps. Sign in with an X11 session to track.');
    tracker.stop();
  });

  console.log(results.join('\n'));
  console.log(process.exitCode ? '\nFAILED' : '\nall tracker rules hold');
}

main();
