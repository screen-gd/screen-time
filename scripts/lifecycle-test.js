'use strict';

// Check window disposal, tray reopening and tracking controls without a desktop.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');

async function check(hidden, backend = false) {
  const windows = [];
  let tray;
  let menu;
  let stopped = false;
  let backendStopped = false;
  let exited = false;
  class Window extends EventEmitter {
    constructor() {
      super();
      windows.push(this);
      this.webContents = { send() {}, setWindowOpenHandler() {} };
    }
    loadFile() {}
    show() { this.visible = true; }
    focus() {}
    isMinimized() { return false; }
    isDestroyed() { return false; }
    close() { this.emit('close', { preventDefault() { throw Error('Close was blocked'); } }); this.emit('closed'); }
  }
  const app = new EventEmitter();
  Object.assign(app, {
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    setAppUserModelId() {}, setName() {}, setPath() {}, getPath: () => require('node:os').tmpdir(), setLoginItemSettings() {},
    quit() {
      let prevented = false;
      this.emit('before-quit', { preventDefault() { prevented = true; } });
      if (!prevented) exited = true;
    },
  });
  let totalSeconds = 7200;
  const store = {
    settings: { paused: false, focusLockdown: false, blockedSites: [], focusBlockApps: [] },
    focusSession: null,
    load() { return this; },
    pendingRecords: Promise.resolve(),
    connect() { return this; },
    sendTracking() {},
    async refreshSettings() { return this.settings; },
    async refreshFocus() { return this.focusSession; },
    async startFocus() { return { ok: true, session: null }; },
    async endFocus() { return { ok: true, session: null }; },
    async catalog() { return { apps: [], sites: [] }; },
    async range() { return this.aggregate(); },
    aggregate: () => ({ totalSeconds, apps: [1, 2, 3, 4].map(n => ({ name: `App ${n}`, seconds: 600 * n })) }),
    updateSettings(patch) { return Object.assign(this.settings, patch); },
    flush() {},
  };
  const electron = {
    app, BrowserWindow: Window, ipcMain: { handle() {} }, shell: {}, nativeTheme: {},
    nativeImage: { createFromPath() {} }, powerMonitor: new EventEmitter(),
    Menu: { setApplicationMenu() {}, buildFromTemplate(items) { menu = items; return items; } },
    Tray: class extends EventEmitter {
      constructor() { super(); tray = this; }
      setToolTip() {}
      setContextMenu(value) { this.contextMenu = value; }
      popUpContextMenu(value) { this.opened = true; this.shownMenu = value || this.contextMenu; }
      // Windows opens attached menus directly instead of emitting right-click.
      async rightClick() {
        if (this.contextMenu) this.popUpContextMenu();
        else await this.listeners('right-click')[0]();
      }
    },
  };
  const mocks = {
    electron,
    './tracker/store': { Store: class { constructor() { return store; } } },
    './tracker': { Tracker: class extends EventEmitter { start() {} stop() { stopped = true; } getStatus() { return {}; } } },
    './tracker/browsers': {},
    './backend-client': {
      BackendStore: class { constructor() { return store; } },
      async startBackend() { if (!backend) throw Error('Local store test'); return { baseUrl: 'http://localhost', token: 't', process: {} }; },
      async stopBackend(child) { if (!child) return; await new Promise(resolve => setImmediate(resolve)); backendStopped = true; },
      backendBinary: () => null,
    },
    './connection-file': { connectionPath: () => 'x', writeConnection() {}, removeConnection() {} },
    './updater': { Updater: class { constructor() { this.state = {}; } } },
    './focus': { FocusGuard: class { sync() {} stop() {} } },
    './focus-cover': { FocusCover: class { hide() {} destroy() {} move() {} owns() { return false; } } },
    './cover-bounds': { coverRect: () => ({ rect: null, fallback: true }) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8'), {
    require: name => mocks[name] || require(name),
    __dirname: path.join(__dirname, '../electron'),
    process: { env: {}, argv: hidden ? ['--hidden'] : [], platform: 'win32', execPath: 'electron', on() {} },
    setTimeout, setInterval: () => ({ unref() {} }), clearInterval() {}, console,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(windows.length, hidden ? 0 : 1);
  if (!hidden) { windows[0].close(); assert.equal(stopped, false); }
  await tray.rightClick();
  assert.equal(tray.opened, true);
  assert(tray.shownMenu.some(item => item.label === 'Today: 2h 0m'));
  totalSeconds = 10800;
  await tray.rightClick();
  assert(tray.shownMenu.some(item => item.label === 'Today: 3h 0m'));
  assert.equal(menu.filter(item => /^App /.test(item.label)).length, 3);
  menu.find(item => item.label === 'Open screen-time').click();
  windows.at(-1).emit('ready-to-show');
  assert.equal(windows.at(-1).visible, true);
  await menu.find(item => item.label === 'Pause tracking').click();
  assert.equal(store.settings.paused, true);
  assert(menu.some(item => item.label === 'Resume tracking'));
  menu.find(item => item.label === 'Quit').click();
  assert.equal(stopped, true);
  // With a backend, the quit waits until it has saved and exited.
  assert.equal(exited, !backend);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(backendStopped, backend);
  assert.equal(exited, true);
}

(async () => {
  await check(false);
  await check(true);
  await check(false, true);
  await check(true, true);
  console.log('Window and tray lifecycle checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

