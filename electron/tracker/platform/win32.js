'use strict';

// Reads the foreground window through Win32 directly (koffi, no helper process).

const { cleanTitle } = require('./common');

let native = null;
let loadError = null;

function loadNative() {
  if (native) return native;
  if (loadError) throw loadError;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const shell32 = koffi.load('shell32.dll');
    native = {
      GetForegroundWindow: user32.func('void *GetForegroundWindow()'),
      GetWindowTextW: user32.func('int GetWindowTextW(void *hWnd, uint16_t *lpString, int nMaxCount)'),
      GetWindowThreadProcessId: user32.func('uint32_t GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *lpdwProcessId)'),
      OpenProcess: kernel32.func('void *OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
      QueryFullProcessImageNameW: kernel32.func('bool QueryFullProcessImageNameW(void *h, uint32_t flags, uint16_t *buf, _Inout_ uint32_t *size)'),
      GetApplicationUserModelId: kernel32.func('int32_t GetApplicationUserModelId(void *h, _Inout_ uint32_t *size, uint16_t *buf)'),
      CloseHandle: kernel32.func('bool CloseHandle(void *h)'),
      GetLastInputInfo: user32.func('bool GetLastInputInfo(_Inout_ void *plii)'),
      GetTickCount64: kernel32.func('uint64_t GetTickCount64()'),
      SHQueryUserNotificationState: shell32.func('int32_t SHQueryUserNotificationState(_Out_ int *state)'),
    };
  } catch (error) {
    loadError = error;
    throw error;
  }
  return native;
}

const titleBuffer = Buffer.alloc(2048);
const pathBuffer = Buffer.alloc(4096);
const aumidBuffer = Buffer.alloc(1024);
const ERROR_INSUFFICIENT_BUFFER = 122;

// A process image and its app id never change while the process lives, so one
// handle per process per minute is enough. This keeps the 5 s tick to a single
// window read in the common case.
const identities = new Map(); // pid -> { exePath, aumid, at }
const IDENTITY_MS = 60 * 1000;

function identityOf(api, pid) {
  const cached = identities.get(pid);
  if (cached && Date.now() - cached.at < IDENTITY_MS) return cached;

  const record = { exePath: '', aumid: '', at: Date.now() };
  const handle = pid ? api.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid) : null;
  if (handle) {
    const size = [2048];
    if (api.QueryFullProcessImageNameW(handle, 0, pathBuffer, size)) {
      record.exePath = pathBuffer.toString('utf16le', 0, size[0] * 2);
    }
    const length = [512];
    let code = api.GetApplicationUserModelId(handle, length, aumidBuffer);
    if (code === ERROR_INSUFFICIENT_BUFFER && length[0] <= 512) {
      code = api.GetApplicationUserModelId(handle, length, aumidBuffer);
    }
    if (code === 0 && length[0] > 0) {
      record.aumid = aumidBuffer.toString('utf16le', 0, (length[0] - 1) * 2).replace(/\0+$/, '');
    }
    api.CloseHandle(handle);
  }

  if (identities.size > 128) {
    const oldest = [...identities.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 64);
    for (const [key] of oldest) identities.delete(key);
  }
  identities.set(pid, record);
  return record;
}

function readForeground() {
  try {
    const api = loadNative();
    const hwnd = api.GetForegroundWindow();
    if (!hwnd) return null;

    const length = api.GetWindowTextW(hwnd, titleBuffer, 1024);
    const title = cleanTitle(titleBuffer.toString('utf16le', 0, Math.max(0, length) * 2));

    const pidOut = [0];
    api.GetWindowThreadProcessId(hwnd, pidOut);
    const pid = pidOut[0] || 0;
    const identity = identityOf(api, pid);

    const info = Buffer.alloc(8);
    info.writeUInt32LE(8, 0);
    let idleMs = 0;
    if (api.GetLastInputInfo(info)) {
      const last = info.readUInt32LE(4);
      const now = Number(api.GetTickCount64()) >>> 0;
      idleMs = (now - last) >>> 0;
    }

    return { title, pid, exePath: identity.exePath, aumid: identity.aumid, bundleId: '', name: '', idleMs };
  } catch (error) {
    return { error: error.message };
  }
}

// QUNS_* from shellapi.h: 2 busy (a full-screen app or presentation mode),
// 3 D3D full screen, 4 presentation mode. Everything else means a normal desktop.
const FULLSCREEN_STATES = new Set([2, 3, 4]);

function readFullscreenState() {
  try {
    const api = loadNative();
    const state = [0];
    if (api.SHQueryUserNotificationState(state) !== 0) return false;
    return FULLSCREEN_STATES.has(state[0]);
  } catch {
    return false;
  }
}

function support() {
  try {
    loadNative();
    return { supported: true, reason: null, message: null };
  } catch (error) {
    return { supported: false, reason: 'load-failed', message: error.message };
  }
}

module.exports = { readForeground, readFullscreenState, support };
