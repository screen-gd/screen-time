'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REQUEST_TIMEOUT_MS = 5000;

function cleanBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

async function request(baseUrl, pathname, options = {}, token = '') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${cleanBaseUrl(baseUrl)}${pathname}`, {
      ...options,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-tally-token': token, ...(options.headers || {}) },
    });
    if (!response.ok) throw new Error(`backend ${response.status}: ${await response.text()}`);
    if (response.status === 204) return null;
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

class BackendStore {
  constructor({ baseUrl, token, file }) {
    this.baseUrl = cleanBaseUrl(baseUrl);
    this.token = token || '';
    this.file = file;
    this.settings = null;
    this.data = { createdAt: null, days: {} };
    this.pendingRecords = Promise.resolve();
  }

  async connect() {
    const snapshot = await this.snapshot();
    this.settings = snapshot.settings;
    this.data.createdAt = snapshot.system && snapshot.system.startedAt;
    return this;
  }

  async snapshot() {
    const snapshot = await request(this.baseUrl, '/api/v1/snapshot', {}, this.token);
    this.settings = snapshot.settings;
    return snapshot;
  }

  async range(days) {
    return request(this.baseUrl, `/api/v1/range?days=${encodeURIComponent(days)}`, {}, this.token);
  }

  async updateSettings(patch) {
    const result = await request(this.baseUrl, '/api/v1/settings', {
      method: 'PATCH', body: JSON.stringify(patch || {}),
    }, this.token);
    this.settings = result.settings;
    return result;
  }

  // Picks up changes made from the browser UI, which talks to the backend directly.
  async refreshSettings() {
    const result = await request(this.baseUrl, '/api/v1/settings', {}, this.token);
    this.settings = result.settings;
    return this.settings;
  }

  record(sample) {
    // Keep sampling non-blocking while serialising writes to preserve data order.
    this.pendingRecords = this.pendingRecords
      .then(() => request(this.baseUrl, '/api/v1/record', { method: 'POST', body: JSON.stringify(sample) }, this.token))
      .catch((error) => console.error('[tally] backend record failed:', error.message));
    return this.pendingRecords;
  }

  async clear() {
    await request(this.baseUrl, '/api/v1/clear', { method: 'POST', body: '{}' }, this.token);
    return true;
  }

  async sendTracking(status) {
    try {
      await request(this.baseUrl, '/api/v1/tracking', { method: 'POST', body: JSON.stringify(status) }, this.token);
    } catch (error) {
      console.error('[tally] backend status failed:', error.message);
    }
  }

  flush() {}
}

function executableCandidates(root) {
  const name = process.platform === 'win32' ? 'tally-backend.exe' : 'tally-backend';
  const resources = process.resourcesPath || root;
  if (__dirname.includes('app.asar')) {
    return [
      path.join(resources, 'app.asar.unpacked', 'backend', name),
      path.join(resources, 'backend', name),
    ];
  }
  return [
    path.join(root, 'backend', name),
    path.join(root, 'backend', 'bin', name),
    path.join(resources, 'backend', name),
    path.join(resources, 'app.asar.unpacked', 'backend', name),
  ];
}

function startBackend({ root, dataFile, frontendDir }) {
  if (process.env.TALLY_BACKEND_URL) {
    return Promise.resolve({ baseUrl: cleanBaseUrl(process.env.TALLY_BACKEND_URL), token: process.env.TALLY_BACKEND_TOKEN || '', process: null });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const binary = executableCandidates(root).find((candidate) => fs.existsSync(candidate));
  const backendRoot = path.join(root, 'backend');
  const command = binary || 'go';
  const backendArgs = ['--port', '0', '--data', dataFile, '--exit-with-stdin', ...(frontendDir ? ['--frontend-dir', frontendDir] : [])];
  const args = binary ? backendArgs : ['run', './cmd/tally-backend', ...backendArgs];
  // stdin stays open for the backend's lifetime: closing it (or Electron dying)
  // tells the backend to save and exit.
  const child = spawn(command, args, {
    cwd: binary ? path.dirname(binary) : backendRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, TALLY_BACKEND_DATA_FILE: dataFile, TALLY_BACKEND_TOKEN: token },
  });
  child.stdin.on('error', () => {});
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error && !child.killed) child.kill();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('backend did not become ready within 10 seconds')), 10000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/TALLY_BACKEND_READY=(https?:\/\/[^\s\r\n]+)/);
      if (match) {
        clearTimeout(timer);
        finish(null, { baseUrl: match[1], token, process: child });
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[tally-backend] ${chunk}`));
    child.once('error', (error) => { clearTimeout(timer); finish(error); });
    child.once('exit', (code) => {
      if (!settled) { clearTimeout(timer); finish(new Error(`backend exited before ready (${code})`)); }
    });
  });
}

// Resolves once the backend has saved and exited, killing it if it takes too long.
function stopBackend(child, timeoutMs = 3000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (child.stdin && !child.stdin.destroyed) child.stdin.end();
    else child.kill();
  });
}

module.exports = { BackendStore, request, startBackend, stopBackend };
