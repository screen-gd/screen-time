# Tally process benchmark

Generated 2026-10-28T20:01:49.117Z. Each scenario was warmed for 1000 ms and sampled 3 times. RSS includes the process tree; Electron therefore includes its renderer/GPU children. The decoupled Electron row also includes the separately running Go backend.

## Startup

| Path | Time to ready |
| --- | ---: |
| backend-startup | 55 ms |
| backend-plus-electron-startup | 2580 ms |
| coupled-electron-startup | 2553 ms |

The backend-plus-Electron time includes backend startup followed by frontend startup.

## Runtime memory

| Scenario | Median RSS | Startup | Snapshot median |
| --- | ---: | ---: | ---: |
| coupled-electron-idle | 377.2 MB | 2553 ms | n/a |
| decoupled-backend-only | 14.7 MB | 36 ms | 3.2 ms |
| decoupled-backend-plus-electron-idle | 380.3 MB | 2580 ms | n/a |

The backend-only process uses 96.1% less RSS than the coupled Electron idle run. Keeping the Electron frontend open still costs most of the desktop memory.

The coupled scenario uses the deterministic local Electron store (--demo) so it does not contact the backend. Re-run with npm run benchmark; compare runs on the same machine with other heavy apps unchanged.
