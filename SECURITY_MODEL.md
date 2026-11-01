# Security model: Tally (screen-time)

Threat model used by the security scan profile `screen-gd threat-modeled security scan`. Component names below are the ones findings are tagged with; keep them stable. Built from the code and the owner's answers on 2026-10-30.

## System overview and trust boundaries
Electron app (`electron/main.js`, `preload.js` contextBridge, renderer `app/`) that samples the foreground window and browser history (`electron/tracker/*`, copies Chromium `History` / Firefox `places.sqlite`), a Go loopback backend (`backend/`, default bind 127.0.0.1:43821) owning the JSON data file, settings and aggregation, with `Access-Control-Allow-Origin: *`. Self-update from GitHub Releases (`electron/updater.js`); builds are unsigned. Native media helper (`native/`).

## Components
- **Tally Electron shell**: `electron/main.js`, `electron/preload.js`, `electron/backend-client.js`, `electron/updater.js`.
- **Tally tracker**: `electron/tracker/*`, `native/`.
- **Tally backend**: `backend/cmd`, `backend/internal/server`, `backend/internal/store`.
- **Tally renderer**: `app/` (also served by the backend as a web UI).
- **Tally build and release**: `scripts/`, `.github/workflows/release.yml`, `build/`.

## Entry points
- Loopback HTTP API `/api/v1/*`, `/healthz`, `/debug/*` (any local process, and any website via CORS `*` if the browser can reach 127.0.0.1:43821).
- Electron IPC channels exposed through `preload.js`.
- Update feed: GitHub Releases over HTTPS.
- Local filesystem: browser history databases (read), data JSON (read/write).

## Assets
- Full browsing history and app-usage record (sensitive personal data).
- Settings and the data file; integrity of the installed binary (update path).

## Attackers
- Malicious website in the user's browser calling the loopback API (read history, change settings, clear data).
- Attacker controlling the update channel or a MITM (unsigned builds, unverified downloads).
- Other local users/malware on the same machine (file permissions on the data JSON and copied history DBs).

## Existing controls
Loopback bind by default; contextBridge-limited IPC; demo/screenshot modes never touch the network; updates can be disabled.

## Owner priorities
- Attackers that matter: malicious websites reaching 127.0.0.1:43821; other local users or malware on the same machine; browser-history/usage data leaving the machine; tampered update or release channel.

## Out of scope / accepted risk
- Unsigned desktop installers are accepted risk. Tampering with the update/release channel itself (GitHub Releases feed, download integrity) is NOT accepted and stays in scope.

## Open questions
- Is the Go backend ever bound to a non-loopback address on purpose?
