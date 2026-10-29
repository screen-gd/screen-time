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
`GET /debug/metrics`. CORS is enabled for local browser clients, and the default
bind address is `127.0.0.1`.
