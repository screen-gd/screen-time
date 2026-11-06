'use strict';

// Builds the media-session addon (native/media) against the Electron version in
// package.json. The build is skipped when the binary is already current, so
// `bun run start` stays fast. A machine without the C++ toolchain still runs the
// app: the tracker falls back to keyboard/mouse idle only.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'native', 'media');
const BINARY = path.join(DIR, 'build', 'Release', 'media.node');
const STAMP = path.join(DIR, 'build', '.stamp');

if (process.platform !== 'win32') {
  console.log('[tally] media sessions are Windows-only; skipping the native build');
  process.exit(0);
}

let electronVersion = '0.0.0';
try {
  electronVersion = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
} catch {
  console.log('[tally] electron is not installed yet; skipping the native build');
  process.exit(0);
}

const stamp = `${process.arch}-${electronVersion}`;
const sources = ['binding.gyp', 'media.cc', 'sdk.js'].map((name) => path.join(DIR, name));
const newestSource = Math.max(0, ...sources.map((file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}));

if (fs.existsSync(BINARY) && fs.existsSync(STAMP)
  && fs.readFileSync(STAMP, 'utf8').trim() === stamp
  && fs.statSync(BINARY).mtimeMs >= newestSource) {
  process.exit(0);
}

const gyp = path.join(ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
if (!fs.existsSync(gyp)) {
  const message = '[tally] node-gyp is missing; the app will run without media detection';
  if (process.env.CI) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
  process.exit(0);
}

console.log(`[tally] building the media addon for Electron ${electronVersion} (${process.arch})`);
// node-gyp takes the Electron target through the npm_config_* environment, the
// same way npm and electron-rebuild drive it.
const env = {
  ...process.env,
  npm_config_target: electronVersion,
  npm_config_runtime: 'electron',
  npm_config_disturl: 'https://electronjs.org/headers',
  npm_config_arch: process.arch,
  npm_config_build_from_source: 'true',
};
const result = spawnSync(process.execPath, [gyp, 'rebuild'], { cwd: DIR, stdio: 'inherit', env });

if (result.status !== 0) {
  const message = '[tally] the media addon did not build; the app will run without media detection';
  if (process.env.CI) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}

if (!fs.existsSync(BINARY)) {
  const message = '[tally] the media addon built but produced no binary';
  if (process.env.CI) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}

fs.mkdirSync(path.dirname(STAMP), { recursive: true });
fs.writeFileSync(STAMP, `${stamp}\n`);
console.log('[tally] media addon ready');
