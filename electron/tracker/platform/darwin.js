'use strict';

// Reads the frontmost app on macOS through Objective-C (libobjc + NSWorkspace)
// and, when Accessibility is granted, the focused window's title through the
// AXUIElement API. All through koffi, no helper process.

const { cleanTitle } = require('./common');

let api = null;
let loadError = null;
let attrs = null; // CFString attribute names, created once
const cfBuffer = Buffer.alloc(2048);
const UTF8 = 0x08000100; // kCFStringEncodingUTF8

// The accessibility grant flips in System Settings while Tally runs; a short
// cache keeps AXIsProcessTrusted off the tick's hot path.
let trusted = { at: 0, value: false };
const TRUSTED_MS = 5 * 1000;

function ensure() {
  if (api) return true;
  if (loadError) return false;
  try {
    const koffi = require('koffi');
    const objc = koffi.load('/usr/lib/libobjc.A.dylib');
    // Loading AppKit registers NSWorkspace's classes for plain Node callers.
    koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
    const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
    const ax = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
    api = {
      koffi,
      poolPush: objc.func('void *objc_autoreleasePoolPush()'),
      poolPop: objc.func('void objc_autoreleasePoolPop(void *pool)'),
      getClass: objc.func('void *objc_getClass(const char *name)'),
      sel: objc.func('void *sel_registerName(const char *name)'),
      // objc_msgSend is redeclared per return type: object, int, C string.
      msgObj: objc.func('void *objc_msgSend(void *self, void *op)'),
      msgInt: objc.func('int objc_msgSend(void *self, void *op)'),
      msgStr: objc.func('const char *objc_msgSend(void *self, void *op)'),
      AXIsProcessTrusted: ax.func('bool AXIsProcessTrusted()'),
      AXUIElementCreateApplication: ax.func('void *AXUIElementCreateApplication(int pid)'),
      AXUIElementSetMessagingTimeout: ax.func('int AXUIElementSetMessagingTimeout(void *element, float timeout)'),
      AXUIElementCopyAttributeValue: ax.func('int AXUIElementCopyAttributeValue(void *element, void *attribute, _Out_ void **value)'),
      CFStringCreateWithCString: cf.func('void *CFStringCreateWithCString(void *alloc, const char *str, uint32_t encoding)'),
      CFStringGetCString: cf.func('bool CFStringGetCString(void *str, _Out_ uint8_t *buf, long size, uint32_t encoding)'),
      CFGetTypeID: cf.func('unsigned long CFGetTypeID(void *obj)'),
      CFStringGetTypeID: cf.func('unsigned long CFStringGetTypeID()'),
      CFBooleanGetValue: cf.func('bool CFBooleanGetValue(void *b)'),
      CFRelease: cf.func('void CFRelease(void *obj)'),
    };
    attrs = {
      focusedWindow: api.CFStringCreateWithCString(null, 'AXFocusedWindow', UTF8),
      title: api.CFStringCreateWithCString(null, 'AXTitle', UTF8),
      fullscreen: api.CFStringCreateWithCString(null, 'AXFullScreen', UTF8),
    };
    return true;
  } catch (error) {
    loadError = error;
    return false;
  }
}

function accessibilityTrusted() {
  if (!ensure()) return false;
  if (Date.now() - trusted.at < TRUSTED_MS) return trusted.value;
  try {
    trusted = { at: Date.now(), value: Boolean(api.AXIsProcessTrusted()) };
  } catch {
    trusted = { at: Date.now(), value: false };
  }
  return trusted.value;
}

// An NSString*'s UTF8String, or ''. Null checks come first: messaging nil is
// legal in Objective-C but a nil receiver must not reach the FFI layer.
function nsString(obj) {
  if (!obj) return '';
  const text = api.msgStr(obj, api.sel('UTF8String'));
  return text || '';
}

function cfString(obj) {
  if (!obj || api.CFGetTypeID(obj) !== api.CFStringGetTypeID()) return '';
  if (!api.CFStringGetCString(obj, cfBuffer, cfBuffer.length, UTF8)) return '';
  const end = cfBuffer.indexOf(0);
  return cfBuffer.toString('utf8', 0, end === -1 ? cfBuffer.length : end);
}

function frontmost() {
  const cls = api.getClass('NSWorkspace');
  const workspace = cls ? api.msgObj(cls, api.sel('sharedWorkspace')) : null;
  return workspace ? api.msgObj(workspace, api.sel('frontmostApplication')) : null;
}

// The focused AXUIElement of the frontmost app, or null. The caller CFReleases.
function focusedWindow() {
  const front = frontmost();
  if (!front) return null;
  const pid = api.msgInt(front, api.sel('processIdentifier'));
  const el = api.AXUIElementCreateApplication(pid);
  if (!el) return null;
  api.AXUIElementSetMessagingTimeout(el, 0.25); // a hung app cannot stall the tick
  const out = [null];
  let win = null;
  try {
    if (api.AXUIElementCopyAttributeValue(el, attrs.focusedWindow, out) === 0) win = out[0];
  } finally {
    api.CFRelease(el);
  }
  return win;
}

function windowTitle() {
  const win = focusedWindow();
  if (!win) return '';
  try {
    const out = [null];
    if (api.AXUIElementCopyAttributeValue(win, attrs.title, out) !== 0 || !out[0]) return '';
    try {
      return cleanTitle(cfString(out[0]));
    } finally {
      api.CFRelease(out[0]);
    }
  } finally {
    api.CFRelease(win);
  }
}

function readForeground() {
  if (!ensure()) return { error: loadError.message };
  const pool = api.poolPush();
  try {
    const front = frontmost();
    if (!front) return null;
    const pid = api.msgInt(front, api.sel('processIdentifier'));
    const name = cleanTitle(nsString(api.msgObj(front, api.sel('localizedName'))));
    const bundleId = nsString(api.msgObj(front, api.sel('bundleIdentifier')));
    const url = api.msgObj(front, api.sel('bundleURL'));
    const exePath = url ? nsString(api.msgObj(url, api.sel('path'))) : '';
    // Titles need the Accessibility grant; apps still count without it.
    const title = accessibilityTrusted() ? windowTitle() : '';
    return { title, pid, exePath, aumid: '', bundleId, name };
  } catch (error) {
    return { error: error.message };
  } finally {
    api.poolPop(pool);
  }
}

function readFullscreenState() {
  if (!ensure() || !accessibilityTrusted()) return false;
  const pool = api.poolPush();
  try {
    const win = focusedWindow();
    if (!win) return false;
    try {
      const out = [null];
      if (api.AXUIElementCopyAttributeValue(win, attrs.fullscreen, out) !== 0 || !out[0]) return false;
      const value = Boolean(api.CFBooleanGetValue(out[0]));
      api.CFRelease(out[0]);
      return value;
    } finally {
      api.CFRelease(win);
    }
  } catch {
    return false;
  } finally {
    api.poolPop(pool);
  }
}

function support() {
  if (ensure()) return { supported: true, reason: null, message: null };
  return { supported: false, reason: 'load-failed', message: loadError.message };
}

module.exports = { readForeground, readFullscreenState, support, accessibilityTrusted };
