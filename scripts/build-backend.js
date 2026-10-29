'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const output = path.join(root, 'backend', process.platform === 'win32' ? 'tally-backend.exe' : 'tally-backend');
const result = spawnSync('go', ['build', '-trimpath', '-o', output, './cmd/tally-backend'], {
  cwd: path.join(root, 'backend'),
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log(`[tally] backend written to ${output}`);
