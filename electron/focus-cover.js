'use strict';

const path = require('node:path');
const { app, BrowserWindow, screen } = require('electron');

// One always-on-top window per display, so a blocked page is hidden whichever
// screen the browser is on. Windows are kept and reused between blocks.
class FocusCover {
  constructor({ root }) {
    this.root = root;
    this.windows = new Map(); // display id -> BrowserWindow
    this.site = null;
  }

  create(display) {
    const win = new BrowserWindow({
      ...display.bounds,
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
    win.shownSite = null;
    return win;
  }

  show(site) {
    const displays = screen.getAllDisplays();
    for (const [id, win] of this.windows) {
      if (win.isDestroyed() || !displays.some((display) => display.id === id)) {
        if (!win.isDestroyed()) win.destroy();
        this.windows.delete(id);
      }
    }
    for (const display of displays) {
      let win = this.windows.get(display.id);
      if (!win) {
        win = this.create(display);
        this.windows.set(display.id, win);
      }
      win.setBounds(display.bounds);
      if (win.shownSite !== site) {
        win.shownSite = site;
        win.loadFile(path.join(this.root, 'app', 'focus.html'), { query: { site } });
      }
      // Inactive, so keys still reach the browser underneath: Ctrl+W closes the tab.
      if (!win.isVisible()) win.showInactive();
      win.moveTop();
    }
    this.site = site;
  }

  hide() {
    this.site = null;
    for (const win of this.windows.values()) {
      if (!win.isDestroyed() && win.isVisible()) win.hide();
    }
  }

  isFocused() {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed() && win.isVisible() && win.isFocused()) return true;
    }
    return false;
  }

  owns(webContents) {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed() && win.webContents === webContents) return true;
    }
    return false;
  }

  destroy() {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.destroy();
    }
    this.windows.clear();
  }
}

module.exports = { FocusCover };
