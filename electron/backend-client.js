'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REQUEST_TIMEOUT_MS = 5000;

function cleanBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

async function request(baseUrl, pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${cleanBaseUrl(baseUrl)}${pathname}`, {
      ...options,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    if (!response.ok) throw new Error(`backend ${response.status}: ${await response.text()}`);
    if (response.status === 204) return null;
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

class BackendStore {
  constructor({ baseUrl, file }) {
    this.baseUrl = cleanBaseUrl(baseUrl);
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
    const snapshot = await request(this.baseUrl, '/api/v1/snapshot');
    this.settings = snapshot.settings;
    return snapshot;
  }

  async range(days) {
    return request(this.baseUrl, `/api/v1/range?days=${encodeURIComponent(days)}`);
  }

  async updateSettings(patch) {
    const result = await request(this.baseUrl, '/api/v1/settings', {
      method: 'PATCH', body: JSON.stringify(patch || {}),
    });
    this.settings = result.settings;
    return result;
  }

  record(sample) {
    // Keep sampling non-blocking while serialising writes to preserve data order.
    this.pendingRecords = this.pendingRecords
      .then(() => request(this.baseUrl, '/api/v1/record', { method: 'POST', body: JSON.stringify(sample) }))
      .catch((error) => console.error('[tally] backend record failed:', error.message));
    return this.pendingRecords;
  }

  async clear() {
    await request(this.baseUrl, '/api/v1/clear', { method: 'POST', body: '{}' });
    return true;
  }

  async sendTracking(status) {
    try {
      await request(this.baseUrl, '/api/v1/tracking', { method: 'POST', body: JSON.stringify(status) });
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
    return Promise.resolve({ baseUrl: cleanBaseUrl(process.env.TALLY_BACKEND_URL), process: null });
  }
  const binary = executableCandidates(root).find((candidate) => fs.existsSync(candidate));
  const backendRoot = path.join(root, 'backend');
  const command = binary || 'go';
  const args = binary
    ? ['--port', '0', '--data', dataFile, ...(frontendDir ? ['--frontend-dir', frontendDir] : [])]
    : ['run', './cmd/tally-backend', '--port', '0', '--data', dataFile, ...(frontendDir ? ['--frontend-dir', frontendDir] : [])];
  const child = spawn(command, args, {
    cwd: binary ? path.dirname(binary) : backendRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, TALLY_BACKEND_DATA_FILE: dataFile },
  });
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
        finish(null, { baseUrl: match[1], process: child });
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[tally-backend] ${chunk}`));
    child.once('error', (error) => { clearTimeout(timer); finish(error); });
    child.once('exit', (code) => {
      if (!settled) { clearTimeout(timer); finish(new Error(`backend exited before ready (${code})`)); }
    });
  });
}

function stopBackend(child) {
  if (!child || child.killed) return;
  child.kill();
}

module.exports = { BackendStore, request, startBackend, stopBackend };
