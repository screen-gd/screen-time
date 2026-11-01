# Tally

A local screen-time tracker for Windows. It records the app in front of you and, when that app is a browser, the site on screen. Four screens: Today, Apps, Websites and Settings.

No account, no extension, no upload. One JSON file on this PC. The only network request is the update check against this repository's releases, and Settings can turn it off.

## Install

Download `Tally-Setup-<version>.exe` from [Releases](https://github.com/screen-gd/screen-time/releases) and run it. The installer is per-user, so it needs no administrator password, and it can create a desktop shortcut.

The build is unsigned, so Windows SmartScreen may ask you to confirm the first launch. The source for every release is the tagged commit in this repository; the installer is built by [`.github/workflows/release.yml`](.github/workflows/release.yml) on GitHub Actions.

Tally updates itself. It checks Releases shortly after it starts and every six hours, downloads a new version in the background and installs it when Tally quits. Settings > About shows the status, has a "Restart to update" button and can turn updates off.

## Run from source

```bash
npm install
npm start        # starts in the tray; closing the window keeps counting
npm run demo     # sample data, tracking off
npm test         # the sampling rules, no desktop needed
```

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
- **Media keeps it awake.** A film, a call or a video in the front window is counted even with hands off the keyboard, because Windows reports the media session and the app that owns it. Media playing in a background app does not keep counting: the window in front still has to be the one playing. A full-screen app or presentation mode also counts, which covers gamepad-only play.
- With nothing playing and no input, the sampler drops from every 5 seconds to every 20, and stops entirely while the screen is locked or the machine sleeps.
- Website names come from the browser's own history file. Tally copies `History` or `places.sqlite` to a temporary folder, matches the window title against recent visits, then deletes the copy. The history itself is never modified.
- Browsers: Chrome, Edge, Brave, Vivaldi, Opera, Opera GX, Firefox and Zen.
- History is kept for 30, 90 or 365 days, then pruned.

Closing the window releases the frontend while tracking continues in the tray. Right-click the tray icon to see today�s total and three most-used apps, pause or resume tracking, or open Tally again. Choose Quit to stop tracking and exit. Starting hidden at login does not load the frontend.

Pause from the tray or the sidebar. Tally can start hidden at login. Settings › Appearance offers preset themes (Ink, T3 Code, T3 Chat, Forest, Fire) or a custom palette built from three colours.

## Where the data lives

`%APPDATA%\Tally\tally-data.json` — the path is shown in Settings, with a button to open the folder.

One file, written atomically, at most every 15 seconds while tracking. Deleting the data in Settings removes every app and site total and leaves the file with default settings.

## Limits

- **Windows only.** Foreground window, idle time, media sessions and the tray use Win32 and WinRT calls; there is no macOS or Linux tracker.
- **Media detection is per app, not per tab.** A browser is credited while any session it owns is playing. A muted tab, a player that never registers with the Windows media transport, or a media addon that did not build all fall back to plain idle rules.
- **Media has a ceiling.** A video left playing in an empty room stops counting after two hours without any input, so an overnight player does not bill the whole night. Settings offers 30 minutes, 1, 2 or 4 hours, or Never.
- **Website names are a heuristic.** A browser window is matched to a recent history entry by title. Private windows, cleared history, a page whose title changed after it loaded, or no recent visit all mean the browser time is counted but the site stays unnamed. No site is guessed from the URL bar.
- **Sampling, not events.** Each sample is credited to the window in front at that moment, so an app opened and closed between samples can be missed.
- **Unsigned installer.** Windows SmartScreen warns on first run; there is no code-signing certificate yet.

## Structure

| Path | What it does |
| --- | --- |
| `electron/main.js` | window, tray, IPC, login item, demo and screenshot modes |
| `electron/preload.js` | the `window.tally` bridge |
| `electron/tracker/window.js` | Win32 foreground window, app id, idle time and full-screen state via `koffi` |
| `electron/tracker/media.js` | which app owns a playing media session, and whether the front window is the one |
| `native/media/` | C++/WinRT addon: reads the Windows media sessions (GSMTC) |
| `electron/tracker/apps.js` | executable names, browser detection, window-title cleanup |
| `electron/tracker/browsers.js` | browser profile discovery, copied history lookup (`sql.js`) |
| `electron/tracker/store.js` | JSON store, per-day totals, aggregation, retention |
| `electron/tracker/index.js` | sampling loop, idle and media rules, self-exclusion |
| `app/` | renderer: shell, three screens, settings, bundled Geist fonts |
| `app/icons/` | brand glyphs bundled from [thesvg.org](https://thesvg.org); `sources.json` lists each slug |
| `scripts/tracker-test.js` | the sampling rules, run by `npm test` |
| `.github/workflows/release.yml` | tests, builds the installer on a `v*` tag and attaches it to the release |

Sample data lives in `app/demo-data.js` and is used only by `npm run demo` and the browser preview.

App and site glyphs are monochrome brand marks from thesvg.org, used only to identify the software they belong to. The marks stay the trademarks of their owners; the file collection is MIT.

