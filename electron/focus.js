'use strict';

const windowModule = require('./tracker/window');
const { identify, cleanBrowserTitle } = require('./tracker/apps');
const browsers = require('./tracker/browsers');
const { normalizeSiteList, blockedEntry, titleEntry } = require('./blocklist');

// Faster than the tracker's sampling so a blocked page is covered within about a second.
const POLL_MS = 1000;

// A history answer covers the page only if the title matched it closely, or the
// visit is this fresh. A loose match to an old visit (or the latest-visit guess
// from browsers.lookup) can name a blocked site the browser is no longer on.
const FRESH_VISIT_MS = 60 * 1000;
const STRONG_MATCH = 90;

// A new page may not be in history yet; ask again this soon rather than after
// the tracker's 45-second negative cache.
const LOOKUP_RETRY_MS = 10 * 1000;

// Focus lockdown watches the browser in front and covers the screen while it
// shows a blocked site. Nothing is blocked on the network: the cover stays up
// until the tab or the app in front changes. `cover` is { show(site), hide() };
// the rest is injectable so the rules run without a desktop.
class FocusGuard {
  constructor({
    store,
    cover,
    readWindow = windowModule.readForeground,
    lookup = browsers.lookup,
    identifyApp = identify,
    interval = POLL_MS,
    selfPid = process.pid,
  }) {
    this.store = store;
    this.cover = cover;
    this.readWindow = readWindow;
    this.lookup = lookup;
    this.identifyApp = identifyApp;
    this.interval = interval;
    this.selfPid = selfPid;
    this.timer = null;
    this.busy = false;
    this.blocking = null;
  }

  get running() {
    return this.timer !== null;
  }

  active() {
    const settings = this.store.settings || {};
    return Boolean(settings.focusLockdown) && normalizeSiteList(settings.blockedSites).length > 0;
  }

  // Call after any settings change: starts or stops the watch to match.
  sync() {
    if (this.active()) this.start();
    else this.stop();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.check().catch((error) => console.error('[tally] focus check failed:', error.message));
    }, this.interval);
    if (this.timer.unref) this.timer.unref();
    this.check().catch(() => {});
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clear();
  }

  async check() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.active()) {
        this.clear();
        return;
      }
      const list = normalizeSiteList(this.store.settings.blockedSites);
      const foreground = this.readWindow();
      if (!foreground || foreground.error) return;
      // screen-time's own window in front: lift the cover so it can be used. A click
      // on the cover itself also lands here, and must not dismiss it.
      if (foreground.pid === this.selfPid) {
        if (!(this.cover.isFocused && this.cover.isFocused())) this.clear();
        return;
      }
      const { browser } = this.identifyApp(foreground);
      if (!browser) {
        this.clear();
        return;
      }
      const title = cleanBrowserTitle(browser, foreground.title);
      let site = titleEntry(foreground.title, list);
      if (!site) {
        let found = null;
        try { found = await this.lookup(browser, title, { negativeMs: LOOKUP_RETRY_MS }); } catch { found = null; }
        const fresh = found && Date.now() - found.visitedAt < FRESH_VISIT_MS;
        const trusted = found && (fresh || (!found.guessed && found.match >= STRONG_MATCH));
        if (trusted) site = blockedEntry(found.domain, list);
      }
      // Lockdown may have been turned off while history was read.
      if (!this.active()) {
        this.clear();
        return;
      }
      if (site) this.block(site);
      else this.clear();
    } finally {
      this.busy = false;
    }
  }

  // Shown on every blocked check, not only the first: the cover may have been
  // dismissed to open screen-time while the browser stayed on the same page.
  block(site) {
    this.blocking = site;
    this.cover.show(site);
  }

  clear() {
    this.blocking = null;
    this.cover.hide();
  }
}

module.exports = { FocusGuard, POLL_MS };
