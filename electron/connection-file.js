'use strict';

// Where the running app publishes its API address and token so local tools
// (the MCP server) can reach it. backend/internal/connection resolves the
// same paths on the Go side.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function connectionPath(platform = process.platform, env = process.env, home = os.homedir()) {
  if (env.TALLY_CONNECTION_FILE) return env.TALLY_CONNECTION_FILE;
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'screen-time', 'connection.json');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'screen-time', 'connection.json');
  }
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(config, 'screen-time', 'connection.json');
}

// Written atomically, 0600 where permissions exist.
function writeConnection(file, info) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(info), { mode: 0o600 });
  fs.renameSync(temp, file);
}

// Removes the file only if it still names this process: a newer run of the
// app may already have replaced it.
function removeConnection(file, pid) {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (info && info.pid === pid) fs.unlinkSync(file);
  } catch {
    // already gone or unreadable
  }
}

module.exports = { connectionPath, writeConnection, removeConnection };
