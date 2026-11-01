# Tally Go backend

The backend owns the shared `tally-data.json` file and exposes the renderer
contract over loopback HTTP. Electron sends foreground samples to it; the browser
renderer reads the same endpoints.

```bash
go run ./cmd/tally-backend --data ./tally-data.json --frontend-dir ../app
```

Open `http://127.0.0.1:43821` after starting it. Use `--port 0` when a caller
needs an automatically selected port; the process prints
`TALLY_BACKEND_READY=http://...` when it is ready.

The public endpoints are `GET /api/v1/snapshot`, `GET /api/v1/range?days=1|7|30`,
`PATCH /api/v1/settings`, `POST /api/v1/record`, `POST /api/v1/clear`, and
`GET /debug/metrics`. The default bind address is `127.0.0.1`.

Every `/api/` and `/debug/` request must send the per-process token in the
`X-Tally-Token` header; otherwise the backend answers `401`. The token comes from
`TALLY_BACKEND_TOKEN` (Electron sets it when it launches the backend) or is
generated randomly at startup and injected into the served `index.html`. Requests
whose `Host` is not a loopback name are rejected to block DNS rebinding, and
cross-origin browser pages are refused unless listed with `--allow-origin`
(`TALLY_BACKEND_ALLOWED_ORIGINS`). Use `--allow-host` (`TALLY_BACKEND_ALLOWED_HOSTS`)
to accept extra Host names when binding to a non-loopback address.
