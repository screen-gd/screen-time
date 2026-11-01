'use strict';

const path = require('node:path');

// Known applications get the name people use for them; everything else is derived from the executable.
const NAMES = {
  'chrome.exe': 'Google Chrome',
  'msedge.exe': 'Microsoft Edge',
  'brave.exe': 'Brave',
  'firefox.exe': 'Firefox',
  'vivaldi.exe': 'Vivaldi',
  'opera.exe': 'Opera',
  'opera_gx.exe': 'Opera GX',
  'arc.exe': 'Arc',
  'zen.exe': 'Zen',
  'code.exe': 'Visual Studio Code',
  'code - insiders.exe': 'VS Code Insiders',
  'cursor.exe': 'Cursor',
  'devenv.exe': 'Visual Studio',
  'idea64.exe': 'IntelliJ IDEA',
  'pycharm64.exe': 'PyCharm',
  'webstorm64.exe': 'WebStorm',
  'windowsterminal.exe': 'Terminal',
  'wt.exe': 'Terminal',
  'powershell.exe': 'PowerShell',
  'pwsh.exe': 'PowerShell',
  'cmd.exe': 'Command Prompt',
  'explorer.exe': 'File Explorer',
  'slack.exe': 'Slack',
  'discord.exe': 'Discord',
  'spotify.exe': 'Spotify',
  'figma.exe': 'Figma',
  'notion.exe': 'Notion',
  'obsidian.exe': 'Obsidian',
  'winword.exe': 'Word',
  'excel.exe': 'Excel',
  'powerpnt.exe': 'PowerPoint',
  'outlook.exe': 'Outlook',
  'teams.exe': 'Microsoft Teams',
  'ms-teams.exe': 'Microsoft Teams',
  'zoom.exe': 'Zoom',
  'steam.exe': 'Steam',
  'telegram.exe': 'Telegram',
  'whatsapp.exe': 'WhatsApp',
  'snippingtool.exe': 'Snipping Tool',
  'notepad.exe': 'Notepad',
  't3 code (nightly).exe': 'T3 Code',
  'tally.exe': 'Tally',
};

const BROWSERS_BY_ID = {
  chrome: { id: 'chrome', name: 'Google Chrome', family: 'chromium' },
  chromium: { id: 'chromium', name: 'Chromium', family: 'chromium' },
  edge: { id: 'edge', name: 'Microsoft Edge', family: 'chromium' },
  brave: { id: 'brave', name: 'Brave', family: 'chromium' },
  vivaldi: { id: 'vivaldi', name: 'Vivaldi', family: 'chromium' },
  opera: { id: 'opera', name: 'Opera', family: 'chromium' },
  'opera-gx': { id: 'opera-gx', name: 'Opera GX', family: 'chromium' },
  arc: { id: 'arc', name: 'Arc', family: 'chromium' },
  firefox: { id: 'firefox', name: 'Firefox', family: 'firefox' },
  zen: { id: 'zen', name: 'Zen', family: 'firefox' },
};

const BROWSERS = {
  'chrome.exe': BROWSERS_BY_ID.chrome,
  'msedge.exe': BROWSERS_BY_ID.edge,
  'brave.exe': BROWSERS_BY_ID.brave,
  'vivaldi.exe': BROWSERS_BY_ID.vivaldi,
  'opera.exe': BROWSERS_BY_ID.opera,
  'opera_gx.exe': BROWSERS_BY_ID['opera-gx'],
  'arc.exe': BROWSERS_BY_ID.arc,
  'firefox.exe': BROWSERS_BY_ID.firefox,
  'zen.exe': BROWSERS_BY_ID.zen,
};

// macOS apps are known by their bundle id, not by an executable name.
const MAC_BROWSERS = {
  'com.google.chrome': BROWSERS_BY_ID.chrome,
  'org.chromium.chromium': BROWSERS_BY_ID.chromium,
  'com.microsoft.edgemac': BROWSERS_BY_ID.edge,
  'com.brave.browser': BROWSERS_BY_ID.brave,
  'com.vivaldi.vivaldi': BROWSERS_BY_ID.vivaldi,
  'com.operasoftware.opera': BROWSERS_BY_ID.opera,
  'com.operasoftware.operagx': BROWSERS_BY_ID['opera-gx'],
  'company.thebrowser.browser': BROWSERS_BY_ID.arc,
  'org.mozilla.firefox': BROWSERS_BY_ID.firefox,
  'app.zen-browser.zen': BROWSERS_BY_ID.zen,
};

// Linux browsers are known by the executable's basename. Snap and distro
// builds rename the binary, so each id lists its flavours.
const LINUX_BROWSERS = {
  chrome: BROWSERS_BY_ID.chrome,
  'google-chrome': BROWSERS_BY_ID.chrome,
  chromium: BROWSERS_BY_ID.chromium,
  'chromium-browser': BROWSERS_BY_ID.chromium,
  msedge: BROWSERS_BY_ID.edge,
  'microsoft-edge': BROWSERS_BY_ID.edge,
  brave: BROWSERS_BY_ID.brave,
  'brave-browser': BROWSERS_BY_ID.brave,
  vivaldi: BROWSERS_BY_ID.vivaldi,
  'vivaldi-bin': BROWSERS_BY_ID.vivaldi,
  opera: BROWSERS_BY_ID.opera,
  firefox: BROWSERS_BY_ID.firefox,
  'firefox-bin': BROWSERS_BY_ID.firefox,
  'firefox-esr': BROWSERS_BY_ID.firefox,
  zen: BROWSERS_BY_ID.zen,
  'zen-bin': BROWSERS_BY_ID.zen,
};

const LINUX_NAMES = {
  chrome: 'Google Chrome',
  'google-chrome': 'Google Chrome',
  chromium: 'Chromium',
  'chromium-browser': 'Chromium',
  msedge: 'Microsoft Edge',
  'microsoft-edge': 'Microsoft Edge',
  brave: 'Brave',
  'brave-browser': 'Brave',
  vivaldi: 'Vivaldi',
  'vivaldi-bin': 'Vivaldi',
  opera: 'Opera',
  firefox: 'Firefox',
  'firefox-bin': 'Firefox',
  'firefox-esr': 'Firefox ESR',
  zen: 'Zen',
  'zen-bin': 'Zen',
  code: 'Visual Studio Code',
  cursor: 'Cursor',
  slack: 'Slack',
  discord: 'Discord',
  spotify: 'Spotify',
  obsidian: 'Obsidian',
  'telegram-desktop': 'Telegram',
  'gnome-terminal-server': 'Terminal',
  konsole: 'Konsole',
  nautilus: 'Files',
  dolphin: 'Dolphin',
  steam: 'Steam',
  zoom: 'Zoom',
  tally: 'Tally',
};

function exeName(exePath) {
  return path.win32.basename(exePath || '').toLowerCase();
}

function titleCase(base) {
  const stem = String(base || '').replace(/\.exe$/i, '').replace(/[-_]+/g, ' ');
  return stem
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function appName(exePath) {
  const base = exeName(exePath);
  if (!base) return 'Unknown app';
  if (NAMES[base]) return NAMES[base];
  return titleCase(base);
}

function browserFor(exePath) {
  return BROWSERS[exeName(exePath)] || null;
}

// Turns a foreground read into the name shown and the browser profile to look
// up. `platform` is a parameter so tests can run darwin/linux cases anywhere.
function identify(foreground, platform = process.platform) {
  const exePath = String(foreground && foreground.exePath || '');
  if (platform === 'darwin') {
    const bundleId = String(foreground.bundleId || '').toLowerCase();
    const base = path.posix.basename(exePath).replace(/\.app$/i, '');
    return { name: foreground.name || base || 'Unknown app', browser: MAC_BROWSERS[bundleId] || null };
  }
  if (platform === 'linux') {
    const key = exePath.split(/[\\/]/).pop().toLowerCase();
    let browser = LINUX_BROWSERS[key] || null;
    let name = LINUX_NAMES[key];
    // Snap and distro builds of Chromium ship a binary named chrome.
    if (browser && browser.id === 'chrome' && exePath.toLowerCase().includes('chromium')) {
      browser = BROWSERS_BY_ID.chromium;
      name = 'Chromium';
    }
    return { name: name || (key ? titleCase(key) : 'Unknown app'), browser };
  }
  return { name: appName(exePath), browser: browserFor(exePath) };
}

// Window titles end with the browser's name and, with several profiles, the profile name.
const TITLE_SUFFIXES = [
  /\s+[-–—]\s+Google Chrome$/i,
  /\s+[-–—]\s+Chromium$/i,
  /\s+[-–—]\s+Microsoft Edge$/i,
  /\s+[-–—]\s+Mozilla Firefox$/i,
  /\s+[-–—]\s+Zen Browser$/i,
  /\s+[-–—]\s+Brave$/i,
  /\s+[-–—]\s+Vivaldi$/i,
  /\s+[-–—]\s+Opera( GX)?$/i,
  /\s+[-–—]\s+Arc$/i,
  /\s+and \d+ more pages?\s+[-–—]\s+.*$/i,
  /\s+[-–—]\s+(Personal|Work|Profile \d+)$/i,
];

function cleanBrowserTitle(browser, title) {
  let out = String(title || '');
  for (let i = 0; i < 2; i++) {
    for (const pattern of TITLE_SUFFIXES) out = out.replace(pattern, '');
  }
  // Firefox sometimes prefixes the window with the profile.
  if (browser.family === 'firefox') out = out.replace(/^Mozilla Firefox\s+[-–—]\s+/i, '');
  // Unread counts ("(2) WhatsApp") belong to the window, not to the page's name.
  return out.replace(/^\(\d+\)\s*/, '').trim();
}

module.exports = { appName, exeName, browserFor, identify, cleanBrowserTitle, BROWSERS, BROWSERS_BY_ID, MAC_BROWSERS, LINUX_BROWSERS, LINUX_NAMES, NAMES };
