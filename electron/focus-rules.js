'use strict';

// The focus session's decision rules, kept pure so the guard, the tests and
// any preview can run them without a desktop. What applies right now comes
// from rulesFor(); judge() turns it into a verdict for the window in front.

const { normalizeSiteList, normalizeAppList, appIdOf, blockedEntry } = require('./blocklist');
const { BROWSERS_BY_ID } = require('./tracker/apps');

// Surfaces that must never be covered, in either mode: the desktop, the task
// switcher, the lock screen, Settings and screen-time itself would otherwise
// lock the machine out of reach. App ids on Windows/Linux, bundle ids (and a
// few names) on macOS.
const ALWAYS_ALLOWED = {
  win32: [
    'explorer', 'searchhost', 'searchapp', 'searchui', 'startmenuexperiencehost',
    'shellexperiencehost', 'shellhost', 'textinputhost', 'lockapp', 'logonui',
    'consent', 'credentialuibroker', 'taskmgr', 'systemsettings', 'systemsettingsadminflows',
    'applicationframehost', 'sndvol', 'osk', 'magnify', 'narrator', 'atbroker',
    'smartscreen', 'werfault', 'openwith', 'pickerhost',
    'windowsinternal.composableshell.experiences.textinput.inputapp',
  ],
  darwin: [
    'com.apple.finder', 'com.apple.dock', 'com.apple.systemuiserver', 'com.apple.controlcenter',
    'com.apple.notificationcenterui', 'com.apple.spotlight', 'com.apple.loginwindow',
    'com.apple.screensaver.engine', 'com.apple.systempreferences', 'com.apple.systemsettings',
    'com.apple.activitymonitor', 'com.apple.securityagent', 'com.apple.coreservices.uiagent',
    'com.apple.usernotificationcenter', 'com.apple.windowmanager',
    'com.apple.accessibility.universalaccessauthwarn',
    'finder', 'dock', 'systemuiserver', 'controlcenter', 'loginwindow',
    'screensaverengine', 'system settings', 'system preferences', 'activity monitor',
    'securityagent',
  ],
  linux: [
    'gnome-shell', 'plasmashell', 'kwin_x11', 'kwin_wayland', 'xfce4-panel',
    'xfdesktop', 'xfwm4', 'cinnamon', 'mate-panel', 'budgie-panel', 'lxpanel',
    'gnome-control-center', 'systemsettings', 'xfce4-settings-manager', 'cinnamon-settings',
    'gnome-system-monitor', 'plasma-systemmonitor', 'ksysguard', 'xfce4-taskmanager',
    'polkit-gnome-authentication-agent-1', 'polkit-kde-authentication-agent-1',
    'lxpolkit', 'gnome-screensaver', 'xscreensaver', 'light-locker', 'i3lock',
    'swaylock', 'kscreenlocker_greet',
  ],
};

// screen-time itself: covering it would trap the controls under the cover.
const SELF_IDS = ['screen-time', 'tally', 'electron'];

// True for the always-allowed surfaces and for a foreground read with no
// executable path, which a list can never name.
function alwaysAllowed(foreground, platform = process.platform) {
  const list = [...(ALWAYS_ALLOWED[platform] || []), ...SELF_IDS];
  if (!foreground || !foreground.exePath) return true;
  const candidates = [
    appIdOf(foreground.exePath),
    String(foreground.bundleId || '').toLowerCase(),
    String(foreground.aumid || '').toLowerCase(),
    String(foreground.name || '').toLowerCase(),
  ].filter(Boolean);
  return candidates.some((candidate) => list.includes(candidate));
}

// The rules in force right now: a live session wins over the between-sessions
// block list. null means nothing is enforced.
function rulesFor(settings, session, nowMs) {
  if (session && Date.parse(session.endsAt) > nowMs) {
    return {
      mode: session.mode,
      apps: normalizeAppList(session.apps),
      sites: normalizeSiteList(session.sites),
      allowSites: normalizeSiteList(session.allowSites),
      session,
    };
  }
  if (settings && settings.focusLockdown) {
    const apps = normalizeAppList(settings.focusBlockApps);
    const sites = normalizeSiteList(settings.blockedSites);
    if (apps.length || sites.length) {
      return { mode: 'block', apps, sites, allowSites: [], session: null };
    }
  }
  return null;
}

// A list entry covers the foreground when it equals the exe's id, the display
// name, the bundle id or the aumid.
function appListed(apps, app) {
  const names = [
    app.id,
    String(app.name || '').toLowerCase(),
    String(app.bundleId || '').toLowerCase(),
    String(app.aumid || '').toLowerCase(),
  ].filter(Boolean);
  return names.some((name) => apps.includes(name));
}

// The verdict for the window in front: null lets it be, anything else is a
// { kind: 'app'|'site'|'page', label } for the cover. `app` is
// { id, name, bundleId, aumid }, `site` the normalized domain or null, `blank`
// a new-tab-like page.
function judge(rules, { app = {}, browser = false, site = null, blank = false }) {
  if (!rules) return null;
  const label = app.name || app.id || 'This app';
  if (!browser) {
    const listed = appListed(rules.apps, app);
    if (rules.mode === 'allow') return listed ? null : { kind: 'app', label };
    return listed ? { kind: 'app', label } : null;
  }
  // Browsers are restricted when the session allows everything else (allow
  // mode) or when the browser itself is on the block list.
  const restricted = rules.mode === 'allow' || appListed(rules.apps, app);
  if (restricted) {
    const open = rules.mode === 'allow' ? [...rules.sites, ...rules.allowSites] : rules.allowSites;
    if (!open.length) return { kind: 'app', label };
    if (site) return blockedEntry(site, open) ? null : { kind: 'site', label: site };
    if (blank) return null;
    return { kind: 'page', label };
  }
  if (site) {
    const matched = blockedEntry(site, rules.sites);
    if (matched && !blockedEntry(site, rules.allowSites)) return { kind: 'site', label: matched };
  }
  return null;
}

// Cleaned titles that mean "no page yet": a new tab shows nothing to judge. An
// empty title is not blank — macOS without Accessibility reads no title at all
// and must still reach the unknown-page cover.
const BLANK_TITLES = new Set([
  'new tab', 'new private tab', 'new incognito tab', 'new inprivate tab',
  'inprivate', 'private browsing', 'start page', 'speed dial',
  ...Object.values(BROWSERS_BY_ID).map((browser) => browser.name.toLowerCase()),
  'mozilla firefox', 'zen browser',
]);

function blankPage(cleanedTitle) {
  return BLANK_TITLES.has(String(cleanedTitle || '').trim().toLowerCase());
}

module.exports = { ALWAYS_ALLOWED, alwaysAllowed, rulesFor, judge, appListed, blankPage, BLANK_TITLES };
