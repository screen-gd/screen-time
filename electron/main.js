'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell, Tray, nativeImage, powerMonitor, nativeTheme, systemPreferences } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { Store } = require('./tracker/store');
const { Tracker } = require('./tracker');
const browsers = require('./tracker/browsers');
const { Updater } = require('./updater');
const { BackendStore, startBackend, stopBackend } = require('./backend-client');

const ROOT = path.join(__dirname, '..');
const DEMO = process.env.TALLY_DEMO === '1' || process.argv.includes('--demo');
const SCREENSHOT = process.env.TALLY_SCREENSHOT || null;

// A separate data folder (and single-instance lock) for test copies that run
// beside an installed Tally.
if (process.env.TALLY_USER_DATA) {
  const dir = path.resolve(process.env.TALLY_USER_DATA);
  // app.setPath throws when the directory does not exist.
  fs.mkdirSync(dir, { recursive: true });
  app.setPath('userData', dir);
}

// Demo and screenshot runs must never touch the network; the startup gate and
// the settings toggle both go through this.
const updatesAllowed = (settings) => settings.autoUpdate && !DEMO && !SCREENSHOT;
let win = null;
let tray = null;
let store = null;
let tracker = null;
let updater = null;
let changeTimer = null;
let rebuildTrayMenu = null;
let backendRuntime = null;
let remoteBackend = false;
let trackingHeartbeat = null;

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

function localSnapshot() {
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
      supported: tracker.status.supported,
      permissions: { accessibility: tracker.status.accessibility },
      startedAt: store.data.createdAt,
      update: updater ? updater.getState() : { supported: false, enabled: false, status: 'idle' },
      storedDays: storedKeys.length,
      oldestDay: storedKeys[0] || null,
      fileSize,
    },
  };
}

async function snapshot() {
  if (!remoteBackend) return localSnapshot();
  const result = await store.snapshot();
  result.tracking = { ...result.tracking, ...tracker.getStatus(), paused: store.settings.paused, sampling: store.settings.sampleSeconds, demo: false };
  result.system = {
    ...result.system,
    version: app.getVersion(),
    browserList: browsers.browserAvailability(),
    supported: tracker.status.supported,
    permissions: { accessibility: tracker.status.accessibility },
    update: updater ? updater.getState() : result.system.update,
  };
  return result;
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
    if (!process.argv.includes('--hidden') && !SCREENSHOT && !openedAtLogin()) win.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (event) => {
    if (app.isQuitting || SCREENSHOT) return;
    event.preventDefault();
    win.hide();
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
  // macOS wants a template image so the menu bar can tint it; Electron picks
  // up trayTemplate@2x.png for Retina itself.
  const icon = nativeImage.createFromPath(path.join(ROOT, 'build',
    process.platform === 'darwin' ? 'trayTemplate.png' : 'tray-32.png'));
  tray = new Tray(icon);
  tray.setToolTip('Tally - screen time');
  const rebuild = () => {
    const paused = store.settings.paused;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Tally', click: () => { if (win) { win.show(); win.focus(); } } },
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
    ]));
  };
  rebuild();
  rebuildTrayMenu = rebuild;
  tray.on('click', () => { if (win) { win.show(); win.focus(); } });
  tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
}

// macOS login items take no arguments, so a login launch can't carry
// --hidden; the login-item record says whether this launch was one.
function openedAtLogin() {
  try {
    const settings = app.getLoginItemSettings();
    return Boolean(settings && (settings.wasOpenedAtLogin || settings.wasOpenedAsHidden));
  } catch {
    return false;
  }
}

// A quoted Exec argument escapes ", `, $ and \ with a backslash, and a
// literal % is written %% (a bare % starts a field code).
function execArg(value) {
  return `"${String(value).replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%')}"`;
}

function applyLoginItem(settings) {
  try {
    if (process.platform === 'win32') {
      app.setLoginItemSettings({
        openAtLogin: Boolean(settings.launchAtLogin),
        path: process.execPath,
        // In dev, Electron needs the app folder as its first argument; a packaged Tally does not.
        args: app.isPackaged ? ['--hidden'] : [ROOT, '--hidden'],
      });
    } else if (process.platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: Boolean(settings.launchAtLogin) });
    } else if (process.platform === 'linux') {
      // Linux has no login-item API; an autostart .desktop file is the convention.
      const file = path.join(os.homedir(), '.config', 'autostart', 'tally.desktop');
      if (!settings.launchAtLogin) {
        fs.rmSync(file, { force: true });
        return;
      }
      const exe = process.env.APPIMAGE || process.execPath;
      const args = app.isPackaged ? '--hidden' : `${execArg(ROOT)} --hidden`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Tally\nExec=${execArg(exe)} ${args}\nX-GNOME-Autostart-enabled=true\n`);
    }
  } catch (error) {
    console.error('[tally] could not set login item:', error.message);
  }
}

function registerIpc() {
  ipcMain.handle('tally:snapshot', () => snapshot());
  ipcMain.handle('tally:range', async (_event, days) => {
    const count = [1, 7, 30].includes(Number(days)) ? Number(days) : 1;
    return remoteBackend ? store.range(count) : store.aggregate(count);
  });
  ipcMain.handle('tally:settings:update', async (_event, patch) => {
    const before = { ...store.settings };
    const result = await store.updateSettings(patch && typeof patch === 'object' ? patch : {});
    const settings = result.settings || result;
    if (settings.launchAtLogin !== before.launchAtLogin) applyLoginItem(settings);
    if (settings.autoUpdate !== before.autoUpdate && updater) updater.setEnabled(updatesAllowed(settings));
    if (settings.sampleSeconds !== before.sampleSeconds) tracker.restart();
    if (settings.paused !== before.paused) {
      send('tally:changed', { at: Date.now() });
      if (rebuildTrayMenu) rebuildTrayMenu();
      if (tray) tray.setToolTip(settings.paused ? 'Tally - tracking paused' : 'Tally - screen time');
    }
    return { settings, tracking: result.tracking || tracker.getStatus() };
  });
  ipcMain.handle('tally:clear', async () => {
    await store.clear();
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
  ipcMain.handle('tally:permissions:accessibility', () => {
    // Prompts macOS for the Accessibility grant on first call, then reports it.
    if (process.platform !== 'darwin' || typeof systemPreferences.isTrustedAccessibilityClient !== 'function') return false;
    return Boolean(systemPreferences.isTrustedAccessibilityClient(true));
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('com.tally.screentime');
    // macOS needs a real menu bar for Cmd+Q/C/V to work; other OSes hide it.
    Menu.setApplicationMenu(process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
      : null);

    const dataFile = path.join(app.getPath('userData'), 'tally-data.json');
    if (!DEMO) {
      try {
        backendRuntime = await startBackend({ root: ROOT, dataFile, frontendDir: app.isPackaged ? '' : path.join(ROOT, 'app') });
        store = await new BackendStore({ baseUrl: backendRuntime.baseUrl, token: backendRuntime.token, file: dataFile }).connect();
        remoteBackend = true;
        console.log('[tally] using Go backend at', backendRuntime.baseUrl);
      } catch (error) {
        console.error('[tally] Go backend unavailable, using local store:', error.message);
        stopBackend(backendRuntime && backendRuntime.process);
        backendRuntime = null;
      }
    }
    if (!store) store = new Store(dataFile).load();
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
      enabled: updatesAllowed(store.settings),
      onChange: (state) => {
        const statusChanged = state.status !== lastUpdate.status;
        if (!statusChanged && Math.abs(state.percent - lastUpdate.percent) < 10) return;
        lastUpdate = { status: state.status, percent: state.percent };
        send('tally:changed', { at: Date.now() });
        if (statusChanged && rebuildTrayMenu) rebuildTrayMenu();
      },
    });

    tracker = new Tracker({ store });
    tracker.on('change', () => {
      broadcast();
      if (remoteBackend) store.sendTracking(tracker.getStatus());
    });
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
    if (remoteBackend) store.sendTracking(tracker.getStatus());
    if (remoteBackend) {
      trackingHeartbeat = setInterval(() => store.sendTracking(tracker.getStatus()), 10000);
      if (trackingHeartbeat.unref) trackingHeartbeat.unref();
    }

    // Stop the sampler outright while the screen is locked or the machine sleeps,
    // and pick it up again without crediting the gap.
    powerMonitor.on('lock-screen', () => tracker.suspend());
    powerMonitor.on('suspend', () => tracker.suspend());
    powerMonitor.on('unlock-screen', () => tracker.wake());
    powerMonitor.on('resume', () => tracker.wake());

    applyLoginItem(store.settings);
    registerIpc();
    createWindow();
    createTray();

    app.on('activate', () => {
      if (!win) createWindow();
      else win.show();
    });
  });

  app.on('window-all-closed', () => {
    // keep tracking from the tray until Quit is chosen
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    if (tracker) tracker.stop();
    if (trackingHeartbeat) clearInterval(trackingHeartbeat);
    if (store) store.flush();
    stopBackend(backendRuntime && backendRuntime.process);
  });
}
