'use strict';

// Reads the active window on X11 through libX11 (koffi, no child processes).
// Wayland is refused outright: under it _NET_ACTIVE_WINDOW only reflects
// XWayland windows, so reading it would silently miss native apps.

const fs = require('node:fs');
const { cleanTitle } = require('./common');

const WAYLAND_MESSAGE = 'Wayland hides the active window from apps. Sign in with an X11 session to track.';
const NO_DISPLAY_MESSAGE = 'No X display to read the active window from.';

let koffi = null;
let api = null;
let display = null;
let root = 0;
let atoms = null;
let loadError = null; // { reason, message }
let xErrorHandler = null; // keep the registered callback alive; never unregister

// A process image never changes while the process lives, so /proc is read once
// per pid per minute.
const identities = new Map(); // pid -> { exePath, at }
const IDENTITY_MS = 60 * 1000;

function wayland() {
  return process.env.XDG_SESSION_TYPE === 'wayland' || (process.env.WAYLAND_DISPLAY && !process.env.DISPLAY);
}

function ensure() {
  if (api) return true;
  if (loadError) return false;
  if (wayland()) {
    loadError = { reason: 'wayland', message: WAYLAND_MESSAGE };
    return false;
  }
  try {
    koffi = require('koffi');
    const x11 = koffi.load('libX11.so.6');
    const XErrorEvent = koffi.struct('XErrorEvent', {
      type: 'int',
      display: 'void *',
      resourceid: 'unsigned long',
      serial: 'unsigned long',
      error_code: 'uint8_t',
      request_code: 'uint8_t',
      minor_code: 'uint8_t',
    });
    // Declared before XSetErrorHandler, whose signature names it.
    koffi.proto('int tallyXErrorHandler(void *display, XErrorEvent *event)');
    api = {
      XOpenDisplay: x11.func('void *XOpenDisplay(const char *display_name)'),
      // XDefaultRootWindow is a macro in Xlib.h, not an exported symbol.
      XDefaultScreen: x11.func('int XDefaultScreen(void *display)'),
      XRootWindow: x11.func('unsigned long XRootWindow(void *display, int screen)'),
      XInternAtom: x11.func('unsigned long XInternAtom(void *display, const char *atom_name, int only_if_exists)'),
      // Window and Atom are C unsigned longs; Bool is int; longs are 8 bytes.
      XGetWindowProperty: x11.func('int XGetWindowProperty(void *display, unsigned long w, unsigned long property, long long_offset, long long_length, int delete, unsigned long req_type, _Out_ unsigned long *actual_type_return, _Out_ int *actual_format_return, _Out_ unsigned long *nitems_return, _Out_ unsigned long *bytes_after_return, _Out_ void **prop_return)'),
      XFree: x11.func('int XFree(void *data)'),
      XSetErrorHandler: x11.func('void *XSetErrorHandler(tallyXErrorHandler *handler)'),
    };
    display = api.XOpenDisplay(null);
    if (!display) {
      api = null;
      loadError = { reason: 'no-display', message: NO_DISPLAY_MESSAGE };
      return false;
    }
    // The default error handler exits the process, and a window closing between
    // reads raises BadWindow on the next property read. Swallow X errors and
    // let the next tick retry. koffi.register wants the pointer type 'Name *'.
    xErrorHandler = koffi.register(() => 0, 'tallyXErrorHandler *');
    api.XSetErrorHandler(xErrorHandler);
    root = Number(api.XRootWindow(display, api.XDefaultScreen(display)));
    atoms = {};
    for (const name of [
      '_NET_ACTIVE_WINDOW', '_NET_WM_PID', '_NET_WM_NAME', 'UTF8_STRING',
      'WM_NAME', '_NET_WM_STATE', '_NET_WM_STATE_FULLSCREEN',
    ]) {
      atoms[name] = Number(api.XInternAtom(display, name, 0));
    }
    return true;
  } catch (error) {
    api = null;
    loadError = { reason: 'load-failed', message: error.message };
    return false;
  }
}

// Reads a property and frees the X buffer before returning. Format-32 items
// are C longs, 8 bytes each on 64-bit: decode as unsigned long, not uint32.
function property(window, atom) {
  const type = [0];
  const format = [0];
  const nitems = [0];
  const after = [0];
  const prop = [null];
  const status = api.XGetWindowProperty(display, window, atom, 0, 1024, 0, 0, type, format, nitems, after, prop);
  if (status !== 0 || !prop[0]) return null;
  try {
    const count = Number(nitems[0]);
    if (format[0] === 8) {
      return { format: 8, bytes: Buffer.from(Object.values(koffi.decode(prop[0], koffi.array('uint8_t', count)))) };
    }
    if (format[0] === 32) {
      return { format: 32, items: Object.values(koffi.decode(prop[0], koffi.array('unsigned long', count))).map(Number) };
    }
    if (format[0] === 16) {
      return { format: 16, items: Object.values(koffi.decode(prop[0], koffi.array('unsigned short', count))).map(Number) };
    }
    return null;
  } finally {
    api.XFree(prop[0]);
  }
}

function activeWindow() {
  const prop = property(root, atoms._NET_ACTIVE_WINDOW);
  if (!prop || prop.format !== 32 || !prop.items.length) return 0;
  return Number(prop.items[0]);
}

function windowTitle(window) {
  const utf8 = property(window, atoms._NET_WM_NAME);
  if (utf8 && utf8.format === 8 && utf8.bytes.length) return cleanTitle(utf8.bytes.toString('utf8'));
  const latin = property(window, atoms.WM_NAME);
  if (latin && latin.format === 8 && latin.bytes.length) return cleanTitle(latin.bytes.toString('latin1'));
  return '';
}

function windowPid(window) {
  const prop = property(window, atoms._NET_WM_PID);
  if (!prop || prop.format !== 32 || !prop.items.length) return 0;
  return Number(prop.items[0]);
}

function identityOf(pid) {
  const cached = identities.get(pid);
  if (cached && Date.now() - cached.at < IDENTITY_MS) return cached;

  let exePath = '';
  if (pid) {
    try {
      exePath = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '');
    } catch {
      try { exePath = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { exePath = ''; }
    }
  }

  if (identities.size > 128) {
    const oldest = [...identities.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 64);
    for (const [key] of oldest) identities.delete(key);
  }
  const record = { exePath, at: Date.now() };
  identities.set(pid, record);
  return record;
}

function readForeground() {
  if (!ensure()) return { error: loadError.message };
  try {
    const window = activeWindow();
    if (!window) return null;
    const pid = windowPid(window);
    const title = windowTitle(window);
    const identity = identityOf(pid);
    return { title, pid, exePath: identity.exePath, aumid: '', bundleId: '', name: '' };
  } catch (error) {
    return { error: error.message };
  }
}

function readFullscreenState() {
  if (!ensure()) return false;
  try {
    const window = activeWindow();
    if (!window) return false;
    const prop = property(window, atoms._NET_WM_STATE);
    if (!prop || prop.format !== 32) return false;
    return prop.items.includes(atoms._NET_WM_STATE_FULLSCREEN);
  } catch {
    return false;
  }
}

function support() {
  if (ensure()) return { supported: true, reason: null, message: null };
  return { supported: false, reason: loadError.reason, message: loadError.message };
}

module.exports = { readForeground, readFullscreenState, support };
