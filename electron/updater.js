'use strict';

// Keeps an installed Tally current from GitHub releases (electron-updater reads
// the latest.yml each release carries). Updates download in the background and
// install when Tally quits, or straight away from Settings or the tray.
//
// This is the app's only network traffic: the release check and the installer
// download. It runs only in a packaged build and only while the "Install
// updates automatically" setting is on.

const { app } = require('electron');

const FIRST_CHECK_MS = 15 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

class Updater {
  // `onChange` fires whenever `state` changes, so main.js can refresh the
  // window and the tray.
  constructor({ enabled, onChange }) {
    this.onChange = onChange;
    this.enabled = false;
    this.timer = null;
    this.updater = null;
    this.download = null; // cancellation token for an in-flight download
    this.state = {
      // macOS updates need a signed app (Squirrel.Mac refuses unsigned), and
      // .deb installs are never updated in place. That leaves Windows and the
      // AppImage, which only exists while APPIMAGE is set.
      supported: app.isPackaged && (process.platform === 'win32' || (process.platform === 'linux' && Boolean(process.env.APPIMAGE))),
      status: 'idle', // idle | checking | downloading | ready | current | error
      version: null,
      percent: 0,
      checkedAt: null,
      error: null,
    };
    this.setEnabled(enabled);
  }

  // Lazily wires electron-updater so dev and demo runs never touch it.
  load() {
    if (this.updater) return this.updater;
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'current', checkedAt: Date.now() }));
    autoUpdater.on('update-available', (info) => this.set({ status: 'downloading', version: info.version, percent: 0, checkedAt: Date.now() }));
    autoUpdater.on('download-progress', (progress) => this.set({ status: 'downloading', percent: Math.round(progress.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => {
      this.download = null;
      this.set({ status: 'ready', version: info.version, percent: 100 });
    });
    autoUpdater.on('update-cancelled', () => {
      this.download = null;
      this.set({ status: 'idle', version: null, percent: 0 });
    });
    autoUpdater.on('error', (error) => this.set({ status: 'error', error: shortError(error), checkedAt: Date.now() }));
    this.updater = autoUpdater;
    return autoUpdater;
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    if (this.onChange) this.onChange(this.state);
  }

  setEnabled(enabled) {
    const next = Boolean(enabled) && this.state.supported;
    if (next === this.enabled) return;
    this.enabled = next;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (next) {
      this.load().autoInstallOnAppQuit = true;
      this.schedule(FIRST_CHECK_MS);
    } else if (this.updater) {
      // Stop a download in flight; a download already on disk still waits for
      // an explicit restart.
      if (this.state.status === 'downloading' && this.download) this.download.cancel();
      this.download = null;
      this.updater.autoInstallOnAppQuit = false;
    }
  }

  schedule(delay) {
    this.timer = setTimeout(() => {
      this.check();
      this.schedule(CHECK_EVERY_MS);
    }, delay);
    if (this.timer.unref) this.timer.unref();
  }

  check() {
    if (!this.enabled || this.state.status === 'downloading' || this.state.status === 'ready') return;
    this.load().checkForUpdates().then((result) => {
      // A resolved check carries the download's cancellation token. Failures
      // and cancellations already arrive through the 'error' and
      // 'update-cancelled' events, so the promise itself is swallowed.
      this.download = (result && result.cancellationToken) || null;
      if (result && result.downloadPromise) result.downloadPromise.catch(() => {});
      // Updates were turned off while the check was still running.
      if (!this.enabled && this.download) this.download.cancel();
    }).catch((error) => {
      this.set({ status: 'error', error: shortError(error), checkedAt: Date.now() });
    });
  }

  // Quits and runs the downloaded installer silently, then reopens Tally.
  install() {
    if (this.state.status !== 'ready' || !this.updater) return false;
    app.isQuitting = true;
    setImmediate(() => this.updater.quitAndInstall(true, true));
    return true;
  }

  getState() {
    return { ...this.state, enabled: this.enabled };
  }
}

// GitHub and network errors arrive with stack traces and response bodies.
function shortError(error) {
  const text = String((error && error.message) || error || 'Update check failed');
  return text.split('\n')[0].slice(0, 160);
}

module.exports = { Updater };
