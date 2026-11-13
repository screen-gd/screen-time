'use strict';

const windowModule = require('./tracker/window');
const { identify, cleanBrowserTitle } = require('./tracker/apps');
const browsers = require('./tracker/browsers');
const { normalizeSite, appIdOf, titleEntry } = require('./blocklist');
const { alwaysAllowed, rulesFor, judge, blankPage } = require('./focus-rules');

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

// A page neither history nor its title can name gets a short grace before the
// cover drops: history often learns it within a few seconds.
const UNKNOWN_PAGE_MS = 4000;

// The focus guard watches the window in front and covers the screen while a
// session or the block list disallows it. Nothing is blocked on the network:
// the cover stays up until the window or the rules change. `cover` is
// { show(target), hide() }; the rest is injectable so the rules run without a
// desktop.
class FocusGuard {
  constructor({
    store,
    cover,
    readWindow = windowModule.readForeground,
    lookup = browsers.lookup,
    identifyApp = identify,
    interval = POLL_MS,
    selfPid = process.pid,
    platform = process.platform,
  }) {
    this.store = store;
    this.cover = cover;
    this.readWindow = readWindow;
    this.lookup = lookup;
    this.identifyApp = identifyApp;
    this.interval = interval;
    this.selfPid = selfPid;
    this.platform = platform;
    this.timer = null;
    this.busy = false;
    this.blocking = null;
    this.unknownKey = null;
    this.unknownSince = 0;
  }

  get running() {
    return this.timer !== null;
  }

  rules() {
    return rulesFor(this.store.settings, this.store.focusSession, Date.now());
  }

  active() {
    return this.rules() !== null;
  }

  // Call after any settings or session change: starts or stops the watch to match.
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
      let rules = this.rules();
      if (!rules) {
        this.clear();
        return;
      }
      const foreground = this.readWindow();
      if (!foreground || foreground.error) return;
      // screen-time's own window in front: lift the cover so it can be used. A click
      // on the cover itself also lands here, and must not dismiss it.
      if (foreground.pid === this.selfPid) {
        if (!(this.cover.isFocused && this.cover.isFocused())) this.clear();
        return;
      }
      // The shell, the lock screen and friends are allowed in every mode.
      if (alwaysAllowed(foreground, this.platform)) {
        this.clear();
        return;
      }
      const identified = this.identifyApp(foreground);
      const app = {
        id: appIdOf(foreground.exePath),
        name: identified.name,
        bundleId: String(foreground.bundleId || '').toLowerCase(),
        aumid: String(foreground.aumid || '').toLowerCase(),
      };
      let verdict;
      if (!identified.browser) {
        verdict = judge(rules, { app });
      } else {
        const seen = await this.readSite(foreground, identified, rules);
        // The session may have ended while history was read; judge under the
        // rules in force now, not the ones the lookup started with.
        rules = this.rules();
        if (!rules) {
          this.clear();
          return;
        }
        verdict = judge(rules, { app, browser: true, site: seen.site, guessed: seen.guessed, blank: seen.blank });
      }
      if (verdict && verdict.kind === 'page') {
        if (!this.pageGraceExpired(foreground)) verdict = null;
      } else {
        // A page judged allowed — or covered another way — ends any open
        // grace; the next unknown page earns a fresh one.
        this.unknownKey = null;
      }
      if (verdict) this.block(verdict, rules, foreground);
      else this.clear();
    } finally {
      this.busy = false;
    }
  }

  // Resolves the site a browser shows: the title first — the longest listed
  // site it names wins outright, so an allowSites exception beats its parent
  // block — then the history lookup. A guessed answer is flagged so judge can
  // let it cover, never open: it may name a site from another tab while the
  // title shows a different one.
  async readSite(foreground, identified, rules) {
    const title = cleanBrowserTitle(identified.browser, foreground.title);
    let site = titleEntry(foreground.title, [...rules.allowSites, ...rules.sites].sort((a, b) => b.length - a.length));
    let guessed = false;
    if (!site) {
      let found = null;
      try { found = await this.lookup(identified.browser, title, { negativeMs: LOOKUP_RETRY_MS }); } catch { found = null; }
      const fresh = found && Date.now() - found.visitedAt < FRESH_VISIT_MS;
      const trusted = found && (fresh || (!found.guessed && found.match >= STRONG_MATCH));
      if (trusted) site = normalizeSite(found.domain);
      guessed = Boolean(trusted && found.guessed);
    }
    return { site, guessed, blank: blankPage(title) };
  }

  // An unnamed page is covered only once the same window has stayed unknown
  // for the grace period, whatever its title says; a cover already showing it
  // stays up.
  pageGraceExpired(foreground) {
    const key = foreground.pid;
    if (this.blocking && this.blocking.key === key) return true;
    if (this.unknownKey === key) return Date.now() - this.unknownSince >= UNKNOWN_PAGE_MS;
    this.unknownKey = key;
    this.unknownSince = Date.now();
    return false;
  }

  // Shown on every blocked check, not only the first: the cover may have been
  // dismissed to open screen-time while the page stayed in front.
  block(verdict, rules, foreground) {
    const target = {
      kind: verdict.kind,
      label: verdict.label,
      mode: rules.mode,
      goal: rules.session ? rules.session.goal : null,
      endsAt: rules.session ? rules.session.endsAt : null,
    };
    this.blocking = { key: foreground.pid, target };
    this.cover.show(target);
  }

  clear() {
    this.blocking = null;
    // The grace key survives a clear: it names a window, and only a different
    // window (or the same window after it earned a cover) should restart it.
    this.cover.hide();
  }
}

module.exports = { FocusGuard, POLL_MS, UNKNOWN_PAGE_MS };
