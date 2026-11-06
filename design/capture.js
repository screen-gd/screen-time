'use strict';

// Renders every design comp to a PNG at its native 1440x810 size.
// Run with: bunx electron design/capture.js
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const DIR = __dirname;
const COMPS = path.join(DIR, 'comps');
const OUT = path.join(DIR, 'out');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const files = fs.readdirSync(COMPS).filter((name) => name.endsWith('.html')).sort();

  const win = new BrowserWindow({
    width: 1440,
    height: 810,
    useContentSize: true,
    show: true,
    frame: false,
    x: -2200,
    y: 0,
    backgroundColor: '#f2f4f7',
    webPreferences: { backgroundThrottling: false, offscreen: false },
  });

  for (const file of files) {
    await win.loadURL(pathToFileURL(path.join(COMPS, file)).href);
    win.webContents.setZoomFactor(1);
    await wait(700);
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1440, height: 810 });
    const png = path.join(OUT, file.replace(/\.html$/, '.png'));
    fs.writeFileSync(png, image.toPNG());
    console.log('[comp]', path.basename(png), image.getSize());
  }

  app.quit();
}).catch((error) => {
  console.error('[comp] failed:', error && error.message);
  app.exit(1);
});
