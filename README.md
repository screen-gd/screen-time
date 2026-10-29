# Tally

A local screen-time tracker for Windows, macOS and Linux. It records the app in front of you and, when that app is a browser, the site on screen. Four screens: Today, Apps, Websites and Settings.

No account, no extension, no upload. One JSON file on this computer. Its only network traffic is for updates: checking this repository's releases and downloading new versions. Settings can turn updates off.

## Install

Download from [Releases](https://github.com/screen-gd/screen-time/releases):

- **Windows:** `Tally-Setup-<version>.exe`. The installer is per-user, so it needs no administrator password, and it can create a desktop shortcut.
- **macOS:** `Tally-<version>-mac-arm64.dmg` or `-x64.dmg` (zip files also work). The build is not notarized, so macOS blocks the first launch. Open System Settings › Privacy & Security and choose Open Anyway, or run `xattr -dr com.apple.quarantine /Applications/Tally.app`.
- **Linux:** `Tally-<version>-linux-x86_64.AppImage`, or `Tally-<version>-linux-amd64.deb` for a package-managed install.

The build is unsigned, so Windows SmartScreen may ask you to confirm the first launch. The source for every release is the tagged commit in this repository; the installers are built by [`.github/workflows/release.yml`](.github/workflows/release.yml) on GitHub Actions.

On Windows and on the Linux AppImage, Tally updates itself. It checks Releases shortly after it starts and every six hours, downloads a new version in the background and installs it when Tally quits. Settings > About shows the status, has a "Restart to update" button and can turn updates off. The macOS app and the .deb package do not update themselves yet; that needs a signed app and in-place package updates.

## Run from source

```bash
npm install
npm start        # starts in the tray; closing the window keeps counting
npm run demo     # sample data, tracking off
npm test         # the sampling rules, no desktop needed
npm run backend:start # Go backend plus the same UI at http://127.0.0.1:43821
npm run benchmark    # repeatable RSS/startup/API comparison
```

Normal Electron launches start a loopback Go backend automatically. The Electron
tracker remains the desktop collector because foreground-window and browser-history
access are OS-specific; it sends samples to the backend, which owns the JSON file,
settings and aggregation. This keeps the data interface independent of the UI and
allows the same `app/` renderer to run in a browser.

To use the browser surface, run `npm run backend:start` and open
<http://127.0.0.1:43821>. The backend serves the bundled renderer and exposes the
read/write interface under `/api/v1/`, protected by a per-process token that is
injected into the served page. A separately hosted renderer can set
`window.TALLY_BACKEND_URL` and `window.TALLY_BACKEND_TOKEN` before `web-api.js`
loads, and its origin must be allowed with `--allow-origin`. The backend is loopback-only
by default; use `--bind` only when you intentionally want another machine to reach
it.

`npm run benchmark` writes [`benchmarks/latest.md`](benchmarks/latest.md) and the
raw samples in `benchmarks/latest.json`. The checked-in Windows run measured a
14.7 MB median Go backend when the Electron frontend was closed, compared with
377.2 MB for the coupled Electron idle process (a 96.1% lower resident set).
Keeping the Electron frontend open with the backend measured 380.3 MB because
Chromium still dominates memory; the saving comes from being able to leave that
frontend closed.

The same run measured startup at 55 ms for the backend alone, 2,580 ms for the
backend followed by Electron, and 2,553 ms for the coupled Electron app.

The first run starts empty. Tally samples the foreground window every 5 seconds and saves after the first few records.

If nothing is recorded, `npm run check` prints the foreground window, its process, its media sessions and the idle clock through the same calls the tracker uses.

`npm start` builds the small media addon in `native/media` on first run. It needs the Visual Studio C++ tools and a Windows SDK; without them the app still starts and falls back to keyboard-and-mouse idle alone, and Settings says so.

## Build

```bash
npm run dist     # dist/Tally-Setup-<version>.exe, the same file Releases ships
npm run icons    # refresh the bundled brand glyphs from thesvg.org
```

The installer is about 120 MB because it carries Chromium; the app itself is a few hundred KB.

Every merge to `main` publishes a release. [`.github/workflows/release.yml`](.github/workflows/release.yml) tags the merged commit with the next patch after the newest release, builds the installer with that version and attaches it. For a minor or major release, raise the version in `package.json` in the PR; the workflow uses it when it is ahead of every release.

## What it counts

- The process and window title of the foreground window, every 5 seconds (5/10/30 in Settings).
- Idle time past 2 minutes is not counted (1/2/5/10 in Settings). The threshold is measured from the last keyboard or mouse input.
- **Media keeps it awake.** On Windows, a film, a call or a video in the front window is counted even with hands off the keyboard, because Windows reports the media session and the app that owns it. Media playing in a background app does not keep counting: the window in front still has to be the one playing. Media sessions are Windows-only; on macOS and Linux a video counts by the plain idle rules. A full-screen app or presentation mode counts on all three, which covers gamepad-only play.
- With nothing playing and no input, the sampler drops from every 5 seconds to every 20, and stops entirely while the screen is locked or the machine sleeps.
- Website names come from the browser's own history file. Tally copies `History` or `places.sqlite` to a temporary folder, matches the window title against recent visits, then deletes the copy. The history itself is never modified.
- Browsers: Chrome, Chromium, Edge, Brave, Vivaldi, Opera, Opera GX, Arc, Firefox and Zen.
- History is kept for 30, 90 or 365 days, then pruned.

Pause from the tray or the sidebar. Tally can start hidden at login. Settings › Appearance offers preset themes (Ink, T3 Code, T3 Chat, Forest, Fire) or a custom palette built from three colours.

## Where the data lives

`%APPDATA%\Tally\tally-data.json` on Windows, `~/Library/Application Support/Tally/tally-data.json` on macOS, `~/.config/Tally/tally-data.json` on Linux. The path is shown in Settings, with a button to open the folder.

One file, written atomically, at most every 15 seconds while tracking. Deleting the data in Settings removes every app and site total and leaves the file with default settings.

## Limits

- **Linux needs an X11 session.** On Wayland, apps cannot read the active window, so Tally reports tracking as unavailable and counts nothing. Sign in with an X11 session to track.
- **macOS needs Accessibility for titles.** Without the grant, Tally still tracks which app is in front, but window titles and website names stay empty. The app is ad-hoc signed, so a new version may need the grant again. Safari is not supported: its history needs Full Disk Access.
- **Media detection is per app, not per tab.** A browser is credited while any session it owns is playing. A muted tab, a player that never registers with the Windows media transport, or a media addon that did not build all fall back to plain idle rules. Media sessions exist only on Windows.
- **Media has a ceiling.** A video left playing in an empty room stops counting after two hours without any input, so an overnight player does not bill the whole night. Settings offers 30 minutes, 1, 2 or 4 hours, or Never.
- **Website names are a heuristic.** A browser window is matched to a recent history entry by title. Private windows, cleared history, a page whose title changed after it loaded, or no recent visit all mean the browser time is counted but the site stays unnamed. No site is guessed from the URL bar.
- **Sampling, not events.** Each sample is credited to the window in front at that moment, so an app opened and closed between samples can be missed.
- **Unsigned builds.** Windows SmartScreen warns on first run; there is no code-signing certificate yet. The macOS app is ad-hoc signed and not notarized, so Gatekeeper blocks the first launch until you allow it. On Ubuntu 24.04+ the AppImage may need `--no-sandbox` because of AppArmor restrictions.
- **The media addon is Windows-only.** `npm start` builds `native/media` only on Windows; other OSes skip it and use idle rules.

## Structure

| Path | What it does |
| --- | --- |
| `electron/main.js` | window, tray, IPC, login item, demo and screenshot modes |
| `electron/preload.js` | the `window.tally` bridge |
| `electron/tracker/window.js` | picks the OS reader and fills idle time |
| `electron/tracker/platform/` | foreground readers: `win32.js` (Win32), `darwin.js` (NSWorkspace + AXUIElement), `linux.js` (X11 `_NET_ACTIVE_WINDOW`), all via `koffi` |
| `electron/tracker/media.js` | which app owns a playing media session, and whether the front window is the one |
| `native/media/` | C++/WinRT addon: reads the Windows media sessions (GSMTC) |
| `electron/tracker/apps.js` | executable names, browser detection, window-title cleanup |
| `electron/tracker/browsers.js` | browser profile discovery, copied history lookup (`sql.js`) |
| `electron/tracker/store.js` | JSON store, per-day totals, aggregation, retention |
| `electron/tracker/index.js` | sampling loop, idle and media rules, self-exclusion |
| `electron/backend-client.js` | starts the Go process and adapts its HTTP interface to the tracker/UI seam |
| `backend/` | standalone Go data backend, HTTP interface, static browser hosting and tests |
| `app/` | renderer: shell, three screens, settings, bundled Geist fonts |
| `app/icons/` | brand glyphs bundled from [thesvg.org](https://thesvg.org); `sources.json` lists each slug |
| `scripts/tracker-test.js` | the sampling rules, run by `npm test` |
| `scripts/benchmark.js` | measures process-tree RSS, startup time and backend snapshot latency |
| `.github/workflows/release.yml` | tests and builds all three platforms; publishes them as a release on every merge to `main` or a pushed `v*` tag |

Sample data lives in `app/demo-data.js` and is used only by `npm run demo` and the browser preview.

App and site glyphs are monochrome brand marks from thesvg.org, used only to identify the software they belong to. The marks stay the trademarks of their owners; the file collection is MIT.

