'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeSiteList } = require('../blocklist');

const DEFAULTS = {
  version: 1,
  createdAt: null,
  settings: {
    sampleSeconds: 5,
    idleSeconds: 120,
    mediaCeilingMinutes: 120, // null means never; media only counts while no input
    paused: false,
    recordWebsites: true,
    launchAtLogin: false,
    autoUpdate: true, // check GitHub releases and install on quit
    theme: { preset: 'default', accent: '', ground: '', text: '' },
    retentionDays: 90,
    browsers: null, // null means every detected browser
    focusLockdown: false,
    blockedSites: [], // hostnames covered while focusLockdown is on
  },
  days: {},
};

const THEME_PRESETS = new Set(['default', 't3code', 't3chat', 'forest', 'fire', 'custom']);
const HEX = /^#[0-9a-f]{6}$/i;

function dateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date, amount) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  copy.setDate(copy.getDate() + amount);
  return copy;
}

function emptyDay() {
  return {
    apps: {},
    sites: {},
    hours: new Array(24).fill(0),
    totalSeconds: 0,
    browserSeconds: 0,
    firstAt: null,
    lastAt: null,
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
    this.saveTimer = null;
    this.dirty = false;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.data = {
          ...JSON.parse(JSON.stringify(DEFAULTS)),
          ...parsed,
          settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) },
          days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
        };
      }
    } catch {
      // first run, or a file that cannot be parsed: start clean rather than block the app
    }
    if (!this.data.createdAt) this.data.createdAt = new Date().toISOString();
    this.prune();
    return this;
  }

  get settings() {
    return this.data.settings;
  }

  updateSettings(patch) {
    const next = { ...this.settings, ...patch };
    next.sampleSeconds = [5, 10, 30].includes(Number(next.sampleSeconds)) ? Number(next.sampleSeconds) : 5;
    next.idleSeconds = [60, 120, 300, 600].includes(Number(next.idleSeconds)) ? Number(next.idleSeconds) : 120;
    const ceiling = next.mediaCeilingMinutes;
    next.mediaCeilingMinutes = ceiling === null || ceiling === 'never' || Number(ceiling) === 0 ? null
      : [30, 60, 120, 240].includes(Number(ceiling)) ? Number(ceiling) : 120;
    next.retentionDays = [30, 90, 365].includes(Number(next.retentionDays)) ? Number(next.retentionDays) : 90;
    next.paused = Boolean(next.paused);
    next.recordWebsites = Boolean(next.recordWebsites);
    next.launchAtLogin = Boolean(next.launchAtLogin);
    next.autoUpdate = next.autoUpdate !== false;
    next.browsers = Array.isArray(next.browsers) ? next.browsers.map(String) : null;
    next.focusLockdown = Boolean(next.focusLockdown);
    next.blockedSites = normalizeSiteList(next.blockedSites);
    const theme = next.theme && typeof next.theme === 'object' ? next.theme : {};
    next.theme = {
      preset: THEME_PRESETS.has(theme.preset) ? theme.preset : 'default',
      accent: HEX.test(theme.accent || '') ? theme.accent : '',
      ground: HEX.test(theme.ground || '') ? theme.ground : '',
      text: HEX.test(theme.text || '') ? theme.text : '',
    };
    this.data.settings = next;
    this.scheduleSave();
    return next;
  }

  record({ appKey, appName, title, browser, site, seconds, at = new Date() }) {
    if (!appKey || !(seconds > 0)) return;
    const key = dateKey(at);
    const day = (this.data.days[key] ||= emptyDay());
    if (!day.hours || day.hours.length !== 24) day.hours = new Array(24).fill(0);
    if (!day.apps) day.apps = {};
    if (!day.sites) day.sites = {};

    const app = (day.apps[appKey] ||= { name: appName, seconds: 0, title: '', browser: null, lastAt: 0 });
    app.name = appName || app.name;
    app.seconds += seconds;
    if (title) app.title = title;
    if (browser) app.browser = browser;
    app.lastAt = at.getTime();

    const hour = at.getHours();
    day.hours[hour] += seconds;
    day.totalSeconds += seconds;
    if (browser) day.browserSeconds += seconds;
    if (!day.firstAt || at.getTime() < Date.parse(day.firstAt)) day.firstAt = at.toISOString();
    day.lastAt = at.toISOString();

    if (site && site.domain) {
      const entry = (day.sites[site.domain] ||= {
        seconds: 0, title: site.title || '', browser: site.browser || browser, lastAt: 0,
      });
      entry.seconds += seconds;
      if (site.title) entry.title = site.title;
      if (site.browser) entry.browser = site.browser;
      entry.lastAt = at.getTime();
    }

    this.scheduleSave();
  }

  day(key) {
    return this.data.days[key] || null;
  }

  aggregate(dayCount = 1, end = new Date()) {
    const out = {
      totalSeconds: 0,
      browserSeconds: 0,
      daysWithData: 0,
      firstAt: null,
      lastAt: null,
      apps: {},
      sites: {},
      hours: new Array(24).fill(0),
    };
    const keys = [];
    for (let i = dayCount - 1; i >= 0; i--) keys.push(dateKey(addDays(end, -i)));

    for (const key of keys) {
      const day = this.data.days[key];
      if (!day) continue;
      let dayTotal = 0;
      for (const [appKey, app] of Object.entries(day.apps || {})) {
        const seconds = Number(app.seconds) || 0;
        dayTotal += seconds;
        const row = (out.apps[appKey] ||= { key: appKey, name: app.name, seconds: 0, title: '', browser: null, lastAt: 0 });
        row.seconds += seconds;
        if (app.title) row.title = app.title;
        if (app.browser) row.browser = app.browser;
        row.lastAt = Math.max(row.lastAt, app.lastAt || 0);
      }
      out.totalSeconds += dayTotal;
      out.browserSeconds += Number(day.browserSeconds) || 0;
      if (dayTotal > 0) out.daysWithData += 1;
      for (const [domain, site] of Object.entries(day.sites || {})) {
        const seconds = Number(site.seconds) || 0;
        if (!seconds) continue;
        const row = (out.sites[domain] ||= { domain, seconds: 0, title: '', browser: '', lastAt: 0 });
        row.seconds += seconds;
        if (site.title) row.title = site.title;
        if (site.browser) row.browser = site.browser;
        row.lastAt = Math.max(row.lastAt, site.lastAt || 0);
      }
      for (let h = 0; h < 24; h++) out.hours[h] += Number((day.hours || [])[h]) || 0;
      if (day.firstAt && (!out.firstAt || day.firstAt < out.firstAt)) out.firstAt = day.firstAt;
      if (day.lastAt && (!out.lastAt || day.lastAt > out.lastAt)) out.lastAt = day.lastAt;
    }

    out.apps = Object.values(out.apps).sort((a, b) => b.seconds - a.seconds);
    out.sites = Object.values(out.sites).sort((a, b) => b.seconds - a.seconds);
    return out;
  }

  prune() {
    const retention = Number(this.settings.retentionDays) || 90;
    const cutoff = dateKey(addDays(new Date(), -retention));
    let changed = false;
    for (const key of Object.keys(this.data.days)) {
      if (key < cutoff) {
        delete this.data.days[key];
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  clear() {
    this.data.days = {};
    this.scheduleSave(true);
  }

  scheduleSave(immediate = false) {
    this.dirty = true;
    if (this.saveTimer) return;
    if (immediate) {
      this.flush();
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 15000);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  flush() {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.data));
      fs.renameSync(temp, this.file);
      this.dirty = false;
    } catch (error) {
      console.error('[tally] could not save data:', error.message);
    }
  }

  loadDemo(days) {
    this.data.days = days;
    this.data.createdAt = new Date(Date.now() - 30 * 86400000).toISOString();
    this.dirty = false;
  }
}

module.exports = { Store, dateKey, addDays, emptyDay, DEFAULTS };
