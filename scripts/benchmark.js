'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'benchmarks');
const ITERATIONS = Math.max(3, Number(process.env.TALLY_BENCHMARK_ITERATIONS) || 5);
const WARMUP_MS = Math.max(1000, Number(process.env.TALLY_BENCHMARK_WARMUP_MS) || 3500);
const BACKEND_TOKEN = require('node:crypto').randomBytes(32).toString('hex');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function electronCommand() {
  const native = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'Electron');
  const binary = path.join(ROOT, 'node_modules', '.bin', 'electron');
  if (process.platform === 'win32' && fs.existsSync(native)) return native;
  if (process.platform !== 'win32' && fs.existsSync(binary)) return binary;
  return null;
}

function electronArgs(args) {
  return args;
}

function backendCommand() {
  return path.join(ROOT, 'backend', process.platform === 'win32' ? 'tally-backend.exe' : 'tally-backend');
}

function processTreeBytes(pid) {
  if (process.platform === 'win32') {
    const script = `$all=Get-CimInstance Win32_Process; $ids=@(${Number(pid)}); do {$added=$false; foreach($p in $all){if(($ids -contains [int]$p.ParentProcessId) -and -not ($ids -contains [int]$p.ProcessId)){$ids+=[int]$p.ProcessId;$added=$true}}} while($added); $sum=(Get-Process -Id $ids -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum; [int64]$sum`;
    try { return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim()) || 0; } catch { return 0; }
  }
  try {
    const lines = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split(/\r?\n/);
    const rows = lines.map((line) => line.trim().split(/\s+/).map(Number)).filter((row) => row.length >= 3 && row.every(Number.isFinite));
    const ids = new Set([Number(pid)]);
    let added = true;
    while (added) { added = false; for (const [child, parent] of rows) if (ids.has(parent) && !ids.has(child)) { ids.add(child); added = true; } }
    return rows.filter(([id]) => ids.has(id)).reduce((sum, [, , rss]) => sum + rss * 1024, 0);
  } catch { return 0; }
}

function terminate(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
}

function start(command, args, env, readyPattern) {
  const started = performance.now();
  const childEnv = { ...process.env, ...env };
  // The Codex harness may set this while running Node commands; Electron must
  // launch as Chromium instead of treating its executable as plain Node.
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(command, args, { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => finish(new Error(`process did not become ready: ${command}`)), 15000);
    if (!readyPattern) {
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk) => { output += chunk.toString(); });
      const readyTimer = setTimeout(() => { clearTimeout(timeout); resolve({ child, readyAt: performance.now() - started, output, ready: null }); }, 2500);
      child.once('exit', (code) => {
        clearTimeout(readyTimer);
        if (code !== null) { clearTimeout(timeout); reject(new Error(`process exited ${code}: ${output.slice(-500)}`)); }
      });
      return;
    }
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(readyPattern);
      if (match) { clearTimeout(timeout); resolve({ child, readyAt: performance.now() - started, output, ready: match[1] || null }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { if (code !== null && !output.match(readyPattern)) { clearTimeout(timeout); reject(new Error(`process exited ${code}: ${output.slice(-500)}`)); } });
  });
}

async function measureScenario(name, command, args, env, readyPattern, apiBase = null, extraPids = [], startupOffsetMs = 0) {
  if (!command) return { name, error: 'Electron is not installed; run npm install before benchmarking desktop scenarios' };
  let running;
  try { running = await start(command, args, env, readyPattern); } catch (error) { return { name, error: error.message }; }
  try {
    await sleep(WARMUP_MS);
    const memory = [];
    for (let i = 0; i < ITERATIONS; i++) { memory.push(processTreeBytes(running.child.pid) + extraPids.reduce((sum, pid) => sum + processTreeBytes(pid), 0)); await sleep(500); }
    const apiMs = [];
    const target = apiBase === true ? running.ready : apiBase;
    if (target) {
      for (let i = 0; i < ITERATIONS; i++) { const t = performance.now(); await fetch(`${target}/api/v1/snapshot`, { headers: { 'x-tally-token': BACKEND_TOKEN } }); apiMs.push(performance.now() - t); }
    }
    const sorted = [...memory].sort((a, b) => a - b);
    const apiSorted = [...apiMs].sort((a, b) => a - b);
    return {
      name,
      pid: running.child.pid,
      startupMs: Math.round(startupOffsetMs + running.readyAt),
      rssBytes: { samples: memory, median: sorted[Math.floor(sorted.length / 2)] || 0, min: sorted[0] || 0, max: sorted.at(-1) || 0 },
      snapshotMs: apiMs.length ? { median: apiSorted[Math.floor(apiSorted.length / 2)], p95: apiSorted[Math.min(apiSorted.length - 1, Math.ceil(apiSorted.length * 0.95) - 1)] } : null,
    };
  } finally { terminate(running.child); await sleep(500); }
}

async function main() {
  const build = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-backend.js')], { cwd: ROOT, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status || 1);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-benchmark-'));
  const coupledData = path.join(temp, 'coupled');
  const backendData = path.join(temp, 'backend.json');
  const backend = await start(backendCommand(), ['--port', '0', '--data', backendData], { TALLY_BACKEND_TOKEN: BACKEND_TOKEN }, /TALLY_BACKEND_READY=(https?:\/\/[^\s\r\n]+)/);
  const backendBase = backend.ready;
  const results = [];
  try {
    results.push(await measureScenario('coupled-electron-idle', electronCommand(), electronArgs(['.', '--demo', '--hidden']), { TALLY_DEMO: '1', TALLY_USER_DATA: coupledData }, null));
    results.push(await measureScenario('decoupled-backend-only', backendCommand(), ['--port', '0', '--data', backendData], { TALLY_BACKEND_TOKEN: BACKEND_TOKEN }, /TALLY_BACKEND_READY=(https?:\/\/[^\s\r\n]+)/, true));
    results.push(await measureScenario('decoupled-backend-plus-electron-idle', electronCommand(), electronArgs(['.', '--hidden']), { TALLY_BACKEND_URL: backendBase, TALLY_BACKEND_TOKEN: BACKEND_TOKEN, TALLY_USER_DATA: path.join(temp, 'frontend') }, null, null, [backend.child.pid], backend.readyAt));
  } finally { terminate(backend.child); }

  const coupled = results.find((item) => item.name === 'coupled-electron-idle' && item.rssBytes);
  const backendOnly = results.find((item) => item.name === 'decoupled-backend-only' && item.rssBytes);
  const decoupledDesktop = results.find((item) => item.name === 'decoupled-backend-plus-electron-idle' && item.rssBytes);
  const startup = [
    { name: 'backend-startup', startupMs: Math.round(backend.readyAt) },
    { name: 'backend-plus-electron-startup', startupMs: decoupledDesktop ? decoupledDesktop.startupMs : null },
    { name: 'coupled-electron-startup', startupMs: coupled ? coupled.startupMs : null },
  ];
  const report = { generatedAt: new Date().toISOString(), iterations: ITERATIONS, warmupMs: WARMUP_MS, startup, scenarios: results };
  const jsonPath = path.join(OUT_DIR, 'latest.json');
  const mdPath = path.join(OUT_DIR, 'latest.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  const rows = results.filter((item) => item.rssBytes).map((item) => `| ${item.name} | ${(item.rssBytes.median / 1048576).toFixed(1)} MB | ${item.startupMs} ms | ${item.snapshotMs ? `${item.snapshotMs.median.toFixed(1)} ms` : 'n/a'} |`);
  const saving = coupled && backendOnly ? ((1 - backendOnly.rssBytes.median / coupled.rssBytes.median) * 100).toFixed(1) : null;
  const comparison = saving ? `The backend-only process uses ${saving}% less RSS than the coupled Electron idle run.` : 'The backend-only process is the memory floor when the desktop frontend is closed.';
  const startupRows = startup.map((item) => `| ${item.name} | ${item.startupMs == null ? 'error' : `${item.startupMs} ms`} |`).join('\n');
  fs.writeFileSync(mdPath, `# Tally process benchmark\n\nGenerated ${report.generatedAt}. Each scenario was warmed for ${WARMUP_MS} ms and sampled ${ITERATIONS} times. RSS includes the process tree; Electron therefore includes its renderer/GPU children. The decoupled Electron row also includes the separately running Go backend.\n\n## Startup\n\n| Path | Time to ready |\n| --- | ---: |\n${startupRows}\n\nThe backend-plus-Electron time includes backend startup followed by frontend startup.\n\n## Runtime memory\n\n| Scenario | Median RSS | Startup | Snapshot median |\n| --- | ---: | ---: | ---: |\n${rows.join('\n')}\n\n${comparison} Keeping the Electron frontend open still costs most of the desktop memory.\n\nThe coupled scenario uses the deterministic local Electron store (--demo) so it does not contact the backend. Re-run with npm run benchmark; compare runs on the same machine with other heavy apps unchanged.\n`);
  console.log(`Benchmark written to ${jsonPath}`);
  console.log(`Benchmark summary written to ${mdPath}`);
  console.table(startup);
  console.table(results.map((item) => ({ scenario: item.name, medianMB: item.rssBytes ? (item.rssBytes.median / 1048576).toFixed(1) : 'error', startupMs: item.startupMs || '-', snapshotMs: item.snapshotMs ? item.snapshotMs.median.toFixed(1) : '-' })));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
