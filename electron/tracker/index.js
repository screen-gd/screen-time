'use strict';

const { EventEmitter } = require('node:events');
const windowModule = require('./window');
const { identify, cleanBrowserTitle } = require('./apps');
const browsers = require('./browsers');
const media = require('./media');

// The lock screen and friends carry no app name on any OS; macOS names them
// loginwindow.app and ScreenSaverEngine.app.
const IGNORED_EXES = new Set([
  'logonui.exe', 'lockapp.exe', 'screensaver.scr', 'searchhost.exe', 'shellexperiencehost.exe',
  'loginwindow.app', 'screensaverengine.app', 'loginwindow', 'screensaverengine',
]);

// Once nothing is being counted, the loop drops to this cadence. One cheap read
// every twenty seconds is enough to notice a video starting or a hand on a key.
const IDLE_POLL_MS = 20 * 1000;

// A player left running in an empty room should not bill the whole night. The
// ceiling is a setting (mediaCeilingMinutes; null means never), defaulting to
// two hours of media with no input at all before a real person has to appear.
const DEFAULT_MEDIA_CEILING_MINUTES = 120;

// A gap longer than this means the machine slept, not that time passed quietly.
const MAX_TRUSTED_GAP_S = 120;

class Tracker extends EventEmitter {
  // `readWindow`, `mediaSignal` and `support` are injectable so the sampling
  // rules can be exercised without a real desktop; main.js passes neither.
  constructor({ store, readWindow = windowModule.readForeground, mediaSignal = media, support = windowModule.support } = {}) {
    super();
    this.store = store;
    this.readWindow = readWindow;
    this.mediaSignal = mediaSignal;
    this.support = support;
    let caps = { supported: false, message: null };
    try { caps = support() || caps; } catch { caps = { supported: false, message: null }; }
    this.unsupportedMessage = caps.message || null;
    this.timer = null;
    this.lastSampleAt = null;
    this.lastCreditedAt = null;
    this.mediaSince = null;
    this.resuming = true;
    this.suspended = false;
    this.nextDelay = null;
    this.running = false;
    this.busy = false;
    this.status = {
      supported: Boolean(caps.supported),
      lastSampleAt: null,
      app: null,
      site: null,
      title: '',
      idleMs: 0,
      idle: false,
      media: false,
      mediaSessions: null,
      mediaAvailable: mediaSignal.available ? mediaSignal.available() : false,
      accessibility: process.platform === 'darwin' ? false : null,
      reason: 'starting',
      error: null,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.suspended = false;
    this.lastSampleAt = Date.now();
    this.lastCreditedAt = Date.now();
    this.resuming = true;
    this.mediaSince = null;
    this.schedule(300);
    if (!this.status.supported) {
      this.status.error = this.unsupportedMessage;
    }
  }

  stop() {
    this.running = false;
    this.suspended = false;
    this.clearTimer();
  }

  restart() {
    this.stop();
    this.start();
  }

  // Locked screen or sleep: there is nothing to count, so stop the timer rather
  // than wake up and ask. main.js drives these from powerMonitor.
  suspend() {
    if (!this.running || this.suspended) return;
    this.suspended = true;
    this.clearTimer();
    this.mediaSince = null;
    this.status.media = false;
    this.status.mediaSessions = null;
    this.status.reason = 'idle';
    if (!this.status.idle) {
      this.status.idle = true;
      this.emit('change');
    }
  }

  wake() {
    if (!this.running || !this.suspended) return;
    this.suspended = false;
    this.lastSampleAt = Date.now();
    this.lastCreditedAt = Date.now();
    this.resuming = true;
    this.mediaSince = null;
    this.status.idle = false;
    this.status.reason = 'starting';
    this.schedule(300);
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delay = null) {
    if (!this.running || this.suspended) return;
    const wait = delay == null ? this.store.settings.sampleSeconds * 1000 : delay;
    this.timer = setTimeout(() => {
      this.tick()
        .catch((error) => {
          this.status.error = error.message;
        })
        .finally(() => {
          const next = this.nextDelay;
          this.nextDelay = null;
          this.schedule(next);
        });
    }, wait);
    if (this.timer.unref) this.timer.unref();
  }

  setIdle(next) {
    if (this.status.idle === next) return;
    this.status.idle = next;
    this.emit('change');
  }

  // The sidebar names the cause, not just the flag: an idle desk and a player
  // left running both stop the total, but only one of them needs explaining.
  setReason(next) {
    if (this.status.reason === next) return;
    this.status.reason = next;
    this.emit('change');
  }

  mediaCeilingMs() {
    const minutes = this.store.settings.mediaCeilingMinutes;
    if (minutes === null || minutes === 'never') return null;
    const value = minutes === undefined ? DEFAULT_MEDIA_CEILING_MINUTES : Number(minutes);
    return value > 0 ? value * 60 * 1000 : null;
  }

  // Why keep counting when the keyboard has been quiet: something is playing in
  // the app in front, or a full-screen app is up (a game on a gamepad reads as
  // idle to Windows). Returns the reason the sample counts, or why it does not.
  async countWithoutInput(now, foreground) {
    const signal = await this.mediaSignal.read(foreground);
    this.status.mediaAvailable = signal.available;
    this.status.media = signal.playing;
    this.status.mediaSessions = Number.isFinite(signal.sessions) ? signal.sessions : null;
    if (signal.playing) {
      if (!this.mediaSince) this.mediaSince = now;
      const ceiling = this.mediaCeilingMs();
      if (ceiling !== null && now - this.mediaSince > ceiling) return 'limit';
      return 'media';
    }
    this.mediaSince = null;
    return signal.fullscreen ? 'fullscreen' : 'idle';
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    const now = Date.now();
    const previous = this.lastSampleAt;
    this.lastSampleAt = now;

    try {
      const settings = this.store.settings;
      // The Accessibility grant can change while Tally runs; the sidebar and
      // Settings reflect it on every tick. null off macOS.
      this.status.accessibility = process.platform === 'darwin' ? Boolean(windowModule.accessibilityTrusted()) : null;
      const foreground = this.readWindow();
      if (!foreground) {
        this.status.lastSampleAt = now;
        return;
      }
      if (foreground.error) {
        this.status.error = foreground.error;
        this.status.lastSampleAt = now;
        this.setReason('error');
        return;
      }

      this.status.error = null;
      this.status.lastSampleAt = now;
      this.status.idleMs = foreground.idleMs;
      this.status.title = foreground.title;

      if (previous == null) {
        this.lastCreditedAt = now;
        this.setReason('starting');
        return;
      }

      const sinceSample = (now - previous) / 1000;
      const slept = !(sinceSample > 0) || sinceSample > Math.max(MAX_TRUSTED_GAP_S, settings.sampleSeconds * 6);
      if (slept) {
        this.lastCreditedAt = now;
        this.resuming = true;
        this.setReason('starting');
        return;
      }

      if (settings.paused) {
        this.lastCreditedAt = now;
        this.resuming = true;
        this.mediaSince = null;
        this.status.media = false;
        this.status.mediaSessions = null;
        this.setIdle(false);
        this.setReason('paused');
        return;
      }

      if (foreground.pid === process.pid) {
        this.lastCreditedAt = now;
        this.setReason('self');
        return;
      }

      const exe = foreground.exePath ? foreground.exePath.split(/[\\/]/).pop().toLowerCase() : '';
      if (!foreground.exePath || IGNORED_EXES.has(exe)) {
        this.lastCreditedAt = now;
        this.setIdle(true);
        this.setReason('idle');
        this.nextDelay = Math.max(IDLE_POLL_MS, settings.sampleSeconds * 1000);
        return;
      }

      let reason = 'recording';
      let keep = foreground.idleMs < settings.idleSeconds * 1000;
      if (keep) {
        this.mediaSince = null;
        this.status.media = false;
        this.status.mediaSessions = null;
      } else {
        const hold = await this.countWithoutInput(now, foreground);
        keep = hold === 'media' || hold === 'fullscreen';
        reason = hold === 'limit' ? 'limit' : hold === 'idle' ? 'idle' : hold === 'media' ? 'media' : 'recording';
      }

      this.setIdle(!keep);
      this.setReason(reason);

      if (!keep) {
        this.lastCreditedAt = now;
        this.resuming = true;
        this.nextDelay = Math.max(IDLE_POLL_MS, settings.sampleSeconds * 1000);
        return;
      }

      const sinceCredited = this.lastCreditedAt == null ? sinceSample : (now - this.lastCreditedAt) / 1000;
      let seconds = Math.min(sinceCredited, sinceSample, settings.sampleSeconds * 2);
      if (this.resuming) seconds = Math.min(seconds, settings.sampleSeconds);
      this.resuming = false;
      this.lastCreditedAt = now;
      if (!(seconds > 0.2)) return;

      const { name, browser } = identify(foreground);
      const appKey = foreground.exePath.toLowerCase();
      this.status.app = name;

      let site = null;
      const enabled = settings.browsers === null || settings.browsers.includes(browser?.id);
      const windowTitle = browser ? cleanBrowserTitle(browser, foreground.title) : foreground.title;
      if (browser && settings.recordWebsites && enabled) {
        try {
          site = await browsers.lookup(browser, windowTitle);
        } catch {
          site = null;
        }
      }
      this.status.site = site ? site.domain : null;

      this.store.record({
        appKey,
        appName: name,
        title: windowTitle,
        browser: browser ? browser.name : null,
        site,
        seconds,
        at: new Date(now),
      });
      this.emit('change');
    } finally {
      this.busy = false;
    }
  }

  getStatus() {
    return { ...this.status };
  }
}

module.exports = { Tracker };
