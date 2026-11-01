'use strict';

// Run with `npm run check`: prints what the tracker sees right now, through the
// same calls the sampler makes. Useful when nothing is being recorded.
//
// `npm run check -- --expect <substring>` exits 1 unless tracking is supported
// and the foreground app has a pid and an exePath containing the substring
// (case-insensitive); `--expect` with no value only requires a pid and an
// exePath. CI uses it as a smoke test on each OS.

const windowModule = require('../electron/tracker/window');
const media = require('../electron/tracker/media');

async function main() {
  const args = process.argv.slice(2);
  const expectAt = args.indexOf('--expect');
  const expecting = expectAt !== -1;
  const expectValue = expecting && args[expectAt + 1] && !args[expectAt + 1].startsWith('-')
    ? args[expectAt + 1]
    : null;

  const support = windowModule.support();
  console.log('platform    ', process.platform);
  console.log('support     ', support.supported ? 'yes' : `no${support.reason ? ` (${support.reason})` : ''}${support.message ? ` - ${support.message}` : ''}`);

  let foreground = null;
  if (support.supported) {
    foreground = windowModule.readForeground();
  } else {
    console.log('foreground  ', 'not read (unsupported)');
  }

  if (foreground && foreground.error) {
    console.log('foreground   failed:', foreground.error);
    foreground = null;
  } else if (support.supported && !foreground) {
    console.log('foreground   no window (nothing focused)');
  }

  if (foreground) {
    console.log('title       ', foreground.title || '(none)');
    console.log('process     ', foreground.exePath || '(unavailable)', `pid ${foreground.pid}`);
    if (process.platform === 'darwin') {
      console.log('bundle id   ', foreground.bundleId || '(none)');
      console.log('app name    ', foreground.name || '(none)');
      console.log('accessibility', windowModule.accessibilityTrusted() ? 'trusted' : 'not trusted');
    } else {
      console.log('app id      ', foreground.aumid || '(none)');
    }
    console.log('idle        ', `${Math.round(foreground.idleMs / 1000)} s since the last keyboard or mouse input`);
  }

  if (process.platform === 'darwin' && !foreground) {
    console.log('accessibility', windowModule.accessibilityTrusted() ? 'trusted' : 'not trusted');
  }

  if (!media.available()) {
    console.log('media       ', 'addon missing - idle falls back to keyboard and mouse alone');
  } else {
    const listed = await media.sessions();
    if (listed.error) console.log('media error ', listed.error);
    console.log('media       ', `${listed.sessions.length} session${listed.sessions.length === 1 ? '' : 's'}`);
    for (const row of listed.sessions) {
      console.log('            ', row.aumid, row.playing ? 'playing' : `status ${row.status}`);
    }
  }

  if (foreground) {
    const signal = await media.read(foreground);
    console.log('front app   ', signal.playing ? 'is playing media' : 'is not playing media');
  }
  console.log('full screen ', windowModule.readFullscreenState() ? 'yes' : 'no');

  if (expecting) {
    const exe = foreground && foreground.exePath ? foreground.exePath : '';
    const ok = support.supported
      && foreground && foreground.pid > 0 && exe.length > 0
      && (!expectValue || exe.toLowerCase().includes(expectValue.toLowerCase()));
    console.log('expect      ', ok
      ? `matched${expectValue ? ` '${expectValue}'` : ''}`
      : `FAILED - wanted pid and exePath${expectValue ? ` containing '${expectValue}'` : ''}`);
    process.exitCode = ok ? 0 : 1;
  }
}

main();
