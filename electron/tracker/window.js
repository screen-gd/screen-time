'use strict';

// Picks the foreground-window reader for this OS: Win32, X11 or Cocoa, all
// through koffi. Any other platform gets a stub that reports tracking as
// unsupported.

let impl;
if (process.platform === 'win32') impl = require('./platform/win32');
else if (process.platform === 'darwin') impl = require('./platform/darwin');
else if (process.platform === 'linux') impl = require('./platform/linux');
else {
  impl = {
    readForeground: () => null,
    readFullscreenState: () => false,
    support: () => ({ supported: false, reason: null, message: null }),
  };
}

// On Windows the reader fills idleMs from GetLastInputInfo itself. Elsewhere
// the OS has no input clock, so Electron's powerMonitor supplies it. Plain
// Node (npm run check, the tests) has no powerMonitor: report 0.
function systemIdleMs() {
  try {
    return require('electron').powerMonitor.getSystemIdleTime() * 1000;
  } catch {
    return 0;
  }
}

function readForeground() {
  const foreground = impl.readForeground();
  if (process.platform === 'win32' || !foreground || foreground.error) return foreground;
  return { ...foreground, idleMs: systemIdleMs() };
}

function readFullscreenState() {
  return impl.readFullscreenState();
}

function support() {
  return impl.support();
}

function accessibilityTrusted() {
  return typeof impl.accessibilityTrusted === 'function' ? impl.accessibilityTrusted() : null;
}

module.exports = { readForeground, readFullscreenState, support, accessibilityTrusted };
