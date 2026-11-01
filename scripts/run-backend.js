'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const binary = path.join(root, 'backend', process.platform === 'win32' ? 'tally-backend.exe' : 'tally-backend');
const child = spawn(binary, ['--frontend-dir', path.join(root, 'app'), ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: false,
});
child.on('exit', (code, signal) => process.exit(code || (signal ? 1 : 0)));
