'use strict';

const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// One always-on-top window the size of the window it covers. It moves with
// the blocked window, is reused between blocks, and never takes the keys.
class FocusCover {
  constructor({ root }) {
    this.root = root;
    this.win = null;
    this.target = null;
  }

  create() {
    const win = new BrowserWindow({
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#080808',
      title: 'Focus lockdown',
      webPreferences: {
        preload: path.join(__dirname, 'focus-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    // Closing the cover only hides it; the next check puts it back if the site is still in front.
    win.on('close', (event) => {
      if (app.isQuitting) return;
      event.preventDefault();
      win.hide();
    });
    win.shownKey = null;
    return win;
  }

  // The verdict decides the cover's copy: { kind, label, mode, goal, endsAt }.
  // Only a change reloads the page; the remaining time ticks on the page itself.
  // rect is the dip bounds the cover takes, usually the blocked window's frame.
  show(target, rect) {
    const key = JSON.stringify(target);
    const query = {};
    for (const name of ['kind', 'label', 'mode', 'goal', 'endsAt']) {
      if (target[name] !== null && target[name] !== undefined) query[name] = String(target[name]);
    }
    if (!this.win || this.win.isDestroyed()) {
      this.win = this.create();
      this.win.shownKey = null;
    }
    const win = this.win;
    if (rect) this.place(win, rect);
    if (win.shownKey !== key) {
      win.shownKey = key;
      win.loadFile(path.join(this.root, 'app', 'focus.html'), { query });
    }
    // Inactive, so keys still reach the browser underneath: Ctrl+W closes the tab.
    if (!win.isVisible()) win.showInactive();
    win.moveTop();
    this.target = target;
  }

  // setBounds once; mixed-DPI moves on Windows can rescale it, so a mismatch
  // earns a second setBounds with the same numbers.
  place(win, rect) {
    const now = win.getBounds();
    if (now.x === rect.x && now.y === rect.y && now.width === rect.width && now.height === rect.height) return;
    win.setBounds(rect);
    const applied = win.getBounds();
    if (applied.x !== rect.x || applied.y !== rect.y || applied.width !== rect.width || applied.height !== rect.height) {
      win.setBounds(rect);
    }
  }

  // Follow the blocked window between checks.
  move(rect) {
    if (!rect || !this.win || this.win.isDestroyed()) return;
    this.place(this.win, rect);
  }

  hide() {
    this.target = null;
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
  }

  isFocused() {
    return Boolean(this.win) && !this.win.isDestroyed() && this.win.isFocused();
  }

  owns(webContents) {
    return Boolean(this.win) && !this.win.isDestroyed() && this.win.webContents === webContents;
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { FocusCover };
