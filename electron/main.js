'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell, Tray, nativeImage, powerMonitor, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { Store } = require('./tracker/store');
const { Tracker } = require('./tracker');
const browsers = require('./tracker/browsers');
const { Updater } = require('./updater');

const ROOT = path.join(__dirname, '..');
const DEMO = process.env.TALLY_DEMO === '1' || process.argv.includes('--demo');
const SCREENSHOT = process.env.TALLY_SCREENSHOT || null;

// A separate data folder (and single-instance lock) for test copies that run
// beside an installed Tally.
if (process.env.TALLY_USER_DATA) app.setPath('userData', path.resolve(process.env.TALLY_USER_DATA));
let win = null;
let tray = null;
let store = null;
let tracker = null;
let updater = null;
let changeTimer = null;
let rebuildTrayMenu = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function broadcast() {
  if (changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = null;
    send('tally:changed', { at: Date.now() });
  }, 10000);
  if (changeTimer.unref) changeTimer.unref();
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Demo mode stands in a browser list so the sample week matches the machine it describes.
function demoBrowserList() {
  const list = browsers.browserAvailability();
  return list.map((browser) => ({
    ...browser,
    profiles: browser.id === 'chrome' || browser.id === 'edge' ? 1 : 0,
    installed: browser.id === 'chrome' || browser.id === 'edge',
  }));
}

// The sample day is a working day, so the preview pins its clock to the end of
// that day. At 00:30 the chart would otherwise claim nothing happened yet.
function demoNow() {
  const date = new Date();
  date.setHours(18, 47, 0, 0);
  return date;
}

function snapshot() {
  const now = DEMO ? demoNow() : new Date();
  const today = store.aggregate(1);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = store.aggregate(1, yesterdayDate);
  const week = store.aggregate(7);
  const month = store.aggregate(30);
  const storedKeys = Object.keys(store.data.days).sort();
  let fileSize = 0;
  try { fileSize = fs.statSync(store.file).size; } catch { fileSize = 0; }
  if (DEMO) fileSize = Buffer.byteLength(JSON.stringify(store.data.days));
  return {
    now: now.toISOString(),
    todayKey: todayKey(),
    today,
    yesterday,
    ranges: { 1: today, 7: week, 30: month },
    settings: store.settings,
    tracking: {
      ...tracker.getStatus(),
      paused: store.settings.paused,
      sampling: store.settings.sampleSeconds,
      demo: DEMO,
    },
    system: {
      platform: process.platform,
      arch: process.arch,
      version: app.getVersion(),
      dataPath: store.file,
      browserList: DEMO ? demoBrowserList() : browsers.browserAvailability(),
      supported: process.platform === 'win32',
      startedAt: store.data.createdAt,
      update: updater ? updater.getState() : { supported: false, enabled: false, status: 'idle' },
      storedDays: storedKeys.length,
      oldestDay: storedKeys[0] || null,
      fileSize,
    },
  };
}

// Recreate the frontend on demand; closing it releases its renderer.
function showWindow() {
  if (!win) {
    createWindow();
    win.once('ready-to-show', () => { win.show(); win.focus(); });
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  const shotWidth = SCREENSHOT ? Number(process.env.TALLY_WIDTH) || 0 : 0;
  const shotHeight = SCREENSHOT ? Number(process.env.TALLY_HEIGHT) || 0 : 0;
  win = new BrowserWindow({
    width: shotWidth || 1240,
    height: shotHeight || 860,
    useContentSize: Boolean(SCREENSHOT),
    minWidth: shotWidth ? 240 : 880,
    minHeight: shotHeight ? 320 : 640,
    show: false,
    backgroundColor: '#080808',
    icon: path.join(ROOT, 'build', 'icon.png'),
    title: 'Tally',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(ROOT, 'app', 'index.html'),
    SCREENSHOT && process.env.TALLY_ROUTE ? { hash: `/${process.env.TALLY_ROUTE}` } : undefined);
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden') && !SCREENSHOT) win.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });

  if (SCREENSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (process.env.TALLY_SCROLL === '1') {
            win.show();
            await win.webContents.executeJavaScript("const s = document.querySelector('.page-body'); if (s) s.scrollTo(0, s.scrollHeight)");
            await new Promise((resolve) => setTimeout(resolve, 320));
          }
          if (process.env.TALLY_DIALOG === '1') {
            win.show();
            await win.webContents.executeJavaScript("document.getElementById('confirm-dialog').showModal()");
            await new Promise((resolve) => setTimeout(resolve, 320));
          }
          const image = await win.webContents.capturePage();
          fs.writeFileSync(SCREENSHOT, image.toPNG());
          console.log('[tally] screenshot written to', SCREENSHOT);
        } catch (error) {
          console.error('[tally] screenshot failed', error);
        }
        app.isQuitting = true;
        app.quit();
      }, 2200);
    });
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ROOT, 'build', 'tray-32.png'));
  tray = new Tray(icon);
  tray.setToolTip('Tally - screen time');
  let menu = null;
  const rebuild = () => {
    const paused = store.settings.paused;
    const today = store.aggregate(1);
    const status = tracker.getStatus();
    const duration = (seconds) => {
      const minutes = Math.floor(seconds / 60);
      return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
    };
    const label = (name) => String(name).replace(/&/g, '&&');
    tray.setToolTip(paused ? 'Tally - tracking paused' : 'Tally - tracking active');
    menu = Menu.buildFromTemplate([
      { label: paused ? 'Tracking paused' : status.error ? 'Tracking unavailable' : status.idle ? 'Tracking idle' : 'Tracking active', enabled: false },
      { label: `Today: ${duration(today.totalSeconds)}`, enabled: false },
      { label: 'Most used apps today', enabled: false },
      ...today.apps.slice(0, 3).map((entry) => ({ label: `${label(entry.name)}: ${duration(entry.seconds)}`, enabled: false })),
      ...(today.apps.length ? [] : [{ label: 'No activity recorded yet', enabled: false }]),
      { type: 'separator' },
      { label: 'Open Tally', click: showWindow },
      {
        label: paused ? 'Resume tracking' : 'Pause tracking',
        click: () => {
          const settings = store.updateSettings({ paused: !paused });
          if (settings) rebuild();
          send('tally:changed', { at: Date.now() });
        },
      },
      ...(updater && updater.state.status === 'ready'
        ? [{ type: 'separator' }, { label: `Restart to update to ${updater.state.version}`, click: () => updater.install() }]
        : []),
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ]);
  };
  rebuild();
  rebuildTrayMenu = rebuild;
  // Keep the menu unattached: Windows suppresses right-click with setContextMenu.
  // Build from current tracking data each time the menu opens.
  tray.on('right-click', () => {
    rebuild();
    tray.popUpContextMenu(menu);
  });
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

function applyLoginItem(settings) {
  if (process.platform !== 'win32') return;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(settings.launchAtLogin),
      path: process.execPath,
      // In dev, Electron needs the app folder as its first argument; a packaged Tally does not.
      args: app.isPackaged ? ['--hidden'] : [ROOT, '--hidden'],
    });
  } catch (error) {
    console.error('[tally] could not set login item:', error.message);
  }
}

function registerIpc() {
  ipcMain.handle('tally:snapshot', () => snapshot());
  ipcMain.handle('tally:range', (_event, days) => {
    const count = [1, 7, 30].includes(Number(days)) ? Number(days) : 1;
    return store.aggregate(count);
  });
  ipcMain.handle('tally:settings:update', (_event, patch) => {
    const before = { ...store.settings };
    const settings = store.updateSettings(patch && typeof patch === 'object' ? patch : {});
    if (settings.launchAtLogin !== before.launchAtLogin) applyLoginItem(settings);
    if (settings.autoUpdate !== before.autoUpdate && updater) updater.setEnabled(settings.autoUpdate);
    if (settings.sampleSeconds !== before.sampleSeconds) tracker.restart();
    if (settings.paused !== before.paused) {
      send('tally:changed', { at: Date.now() });
      if (rebuildTrayMenu) rebuildTrayMenu();
      if (tray) tray.setToolTip(settings.paused ? 'Tally - tracking paused' : 'Tally - screen time');
    }
    return { settings, tracking: tracker.getStatus() };
  });
  ipcMain.handle('tally:clear', () => {
    store.clear();
    store.flush();
    send('tally:changed', { at: Date.now() });
    return true;
  });
  ipcMain.handle('tally:open-data-folder', () => {
    shell.showItemInFolder(store.file);
    return true;
  });
  ipcMain.handle('tally:update:install', () => (updater ? updater.install() : false));
  ipcMain.handle('tally:update:check', () => {
    if (updater) updater.check();
    return updater ? updater.getState() : null;
  });
  ipcMain.handle('tally:browsers:rescan', () => {
    browsers.discoverProfiles(true);
    return browsers.browserAvailability();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    app.setAppUserModelId('com.tally.screentime');
    Menu.setApplicationMenu(null);

    store = new Store(path.join(app.getPath('userData'), 'tally-data.json')).load();
    if (DEMO) {
      const demo = require('../app/demo-data.js');
      store.loadDemo(demo.buildDays(30));
      // Screenshots of a non-default theme: TALLY_THEME=forest electron . --demo
      if (process.env.TALLY_THEME) store.updateSettings({ theme: { preset: process.env.TALLY_THEME } });
    }

    // Download progress arrives many times a second; the window only needs a
    // new status or every tenth percent.
    let lastUpdate = { status: null, percent: -10 };
    updater = new Updater({
      enabled: store.settings.autoUpdate && !DEMO && !SCREENSHOT,
      onChange: (state) => {
        const statusChanged = state.status !== lastUpdate.status;
        if (!statusChanged && Math.abs(state.percent - lastUpdate.percent) < 10) return;
        lastUpdate = { status: state.status, percent: state.percent };
        send('tally:changed', { at: Date.now() });
        if (statusChanged && rebuildTrayMenu) rebuildTrayMenu();
      },
    });

    tracker = new Tracker({ store });
    tracker.on('change', broadcast);
    if (!DEMO && !SCREENSHOT) tracker.start();
    else if (DEMO) {
      tracker.status.lastSampleAt = demoNow().getTime();
      tracker.status.app = 'Google Chrome';
      tracker.status.site = 'youtube.com';
      tracker.status.title = 'How a mechanical watch works - YouTube';
      tracker.status.reason = 'media';
      tracker.status.idle = false;
      tracker.status.media = true;
      tracker.status.mediaSessions = 2;
      tracker.status.mediaAvailable = true;
    }

    // Stop the sampler outright while the screen is locked or the machine sleeps,
    // and pick it up again without crediting the gap.
    powerMonitor.on('lock-screen', () => tracker.suspend());
    powerMonitor.on('suspend', () => tracker.suspend());
    powerMonitor.on('unlock-screen', () => tracker.wake());
    powerMonitor.on('resume', () => tracker.wake());

    applyLoginItem(store.settings);
    registerIpc();
    if (!process.argv.includes('--hidden') || SCREENSHOT) createWindow();
    createTray();

    app.on('activate', showWindow);
  });

  app.on('window-all-closed', () => {
    // keep tracking from the tray until Quit is chosen
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    if (tracker) tracker.stop();
    if (store) store.flush();
  });
}
