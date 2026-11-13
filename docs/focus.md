# Focus sessions

A focus session has a goal, a mode, app and site lists, and an end time. While
it runs, screen-time covers the screen whenever the window in front is not
allowed. It ends by itself at `endsAt`, including after a crash or restart, and
ending restores the `focusLockdown` value from before the session.

The cover is an overlay, not a lock: it can always be dismissed to reach
screen-time, and quitting screen-time ends enforcement entirely.

## Modes and rules

- **Allow** (`"allow"`): only the listed apps are usable, and browsers open
  only the listed `sites` plus `allowSites`. A browser window on any other site,
  or a page screen-time cannot name, is covered after a short grace.
- **Block** (`"block"`): only the listed apps and sites are covered. A site in
  `allowSites` stays reachable even on the block list.
- **Block list between sessions**: the old "Focus lockdown" switch. With no
  session running and `focusLockdown` on, the saved block lists
  (`focusBlockApps` + `blockedSites`) apply as block mode.

Always-allowed surfaces are never covered in either mode: the desktop shell,
task switcher, lock screen, Settings and screen-time itself
(`explorer`, `searchhost`, `taskmgr`, `lockapp` on Windows;
`com.apple.finder`, `com.apple.dock`, `com.apple.systemsettings` on macOS;
`gnome-shell`, `plasmashell`, `kwin_*` on Linux; the full list is in
`electron/focus-rules.js`). A foreground window with no readable executable
path is also allowed.

App list entries are normalized ids: lowercased basename minus `.exe`/`.app`
(`C:\Tools\VSCode\code.exe` -> `code`, `Visual Studio Code` -> `visual studio
code`). An entry matches the exe id, the display name, the bundle id or the
aumid. Site entries are bare hostnames; a listed site covers its subdomains.
The literal `localhost` is also accepted — ports are dropped, so it covers
every local port — but it is recognized from browser history, not the window
title, so a localhost page in a private window is covered after the unknown-page
grace like any unnamed page.

`PATCH /api/v1/settings` (or the UI) can still flip `focusLockdown` during a
session, but the change is undone when the session ends.

## Settings

`focusMode` (`allow`|`block`, default `allow`), `focusAllowApps`,
`focusAllowSites`, `focusBlockApps`, `blockedSites` (the block-mode site list),
`focusMinutes` (15/25/50/90/120/180, default 50). All accepted by
`PATCH /api/v1/settings`. `GET /api/v1/focus/lists` reads them as
`{ mode, allow: { apps, sites }, block: { apps, sites } }` and
`PATCH /api/v1/focus/lists` merges any subset.

## Endpoints

All endpoints need the `X-Tally-Token` header; requests without an Origin are
accepted as before.

### `GET /api/v1/focus/session`

`200 { "session": Session | null }`. Reading also ends an expired session.

### `POST /api/v1/focus/session`

Body `{ goal, source, durationSeconds, mode?, apps?, sites?, allowSites? }`.

- `201 { "session": Session }` — started. A session from the same source is
  replaced (new `id`, new times).
- `409 { "session": <current> }` — a session from a different source is running.
- `400 { "error": "..." }` — validation: `source` required, <= 64 chars;
  `goal` required, <= 200 runes; `durationSeconds` a number in [60, 43200];
  `mode` only `allow` or `block`.

Omitted `mode` uses the saved `focusMode`; omitted `apps`/`sites` use the saved
lists for the chosen mode; `allowSites` defaults to `[]`.

### `DELETE /api/v1/focus/session?source=<s>`

`200 { "session": null }` when it matched (or nothing runs). A different source
gets `409 { "session": <current> }`. `source=screen-time` (the UI) ends any
session. Missing `source` is a `400`.

### `GET /api/v1/focus/catalog?days=1|7|30`

`200 { "apps": [{ "id", "name", "seconds", "lastAt", "browser" }], "sites": [{ "domain", "seconds", "lastAt" }] }`,
sorted by seconds. Apps are merged by normalized id; use the `id` values in
session lists.

### `GET /api/v1/snapshot`

Now includes `"focus": { "session": Session | null }`.

### Session shape

`{ "id", "goal", "source", "mode", "apps", "sites", "allowSites", "startedAt", "endsAt" }`.
Lists are always arrays; times are UTC ISO strings with milliseconds
(`2026-11-14T10:00:00.000Z`).

## The connection file

While the app runs it writes its API address and token for local tools:

- Windows `%APPDATA%\screen-time\connection.json`
- macOS `~/Library/Application Support/screen-time/connection.json`
- Linux `$XDG_CONFIG_HOME/screen-time/connection.json`, else `~/.config/screen-time/connection.json`

`TALLY_CONNECTION_FILE` overrides the path (used by tests). Contents:
`{ "version": 1, "url": "http://127.0.0.1:<port>", "token": "<token>", "pid": <electron pid> }`.
The file is `0600` on POSIX and removed on quit (only by the pid that wrote it).

## MCP: `tally-backend mcp`

The backend binary doubles as an MCP server over stdio (newline-delimited
JSON-RPC, logs only to stderr). It reads the connection file on every call, so
it always talks to the running instance. Add it to your agent's MCP config —
or copy the ready-made snippet from the Focus page (screen-time fills in the
binary path):

```json
{ "mcpServers": { "screen-time": { "command": "<path to tally-backend>", "args": ["mcp"] } } }
```

Packaged install on Windows:
`%LOCALAPPDATA%\Programs\screen-time\resources\app.asar.unpacked\backend\tally-backend.exe`.

When screen-time is not running, tool calls answer "screen-time is not
running. Open it and try again."

Tools:

| Tool | What it does |
| --- | --- |
| `get_catalog` | `{ days?: 1\|7\|30 }` — apps and sites screen-time has seen; use `id` values in lists |
| `get_focus_lists` | the saved mode and allow/block lists |
| `set_focus_lists` | `{ mode?, allow?, block? }` — merge into the saved lists |
| `get_focus_session` | the running session or null |
| `start_focus_session` | `{ goal, minutes, mode?, apps?, sites?, allowSites?, source? }` — starts a session (minutes 1–720) |
| `end_focus_session` | `{ source? }` — ends the session belonging to the source |

A session started by an agent blocks other sources with a `409` until it ends;
it can always be ended from the screen-time window.
