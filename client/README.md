# GPMS client daemon (`gpms-client`)

Node.js (ESM) local agent for GPMS: connects to the GPMS server on the `/client` Socket.IO namespace, reports `/proc` metrics, and runs CRIU checkpoint/restore and process signals on the same machine as the monitored workloads.

## Requirements

- Linux (reads `/proc`)
- **Root or sudo** in production: CRIU and signal-to-arbitrary PIDs need elevated privileges. The npm `start` script uses `sudo node`.
- [CRIU](https://criu.org/) installed and on `PATH` or set `CRIU_BIN`.
- A GPMS **server** that implements the events below; the dashboard in this repo still uses a separate default-namespace protocol until the server bridge is complete.

## Setup

```bash
cd client
cp .env.example .env
npm install
```

## Commands

| Command | Purpose |
|--------|----------|
| `npm run start` / `node index.js daemon` | Long-running agent (use `sudo` in production) |
| `node index.js status` | `GET` `${SERVER_URL}/api/sessions` (JSON) |
| `node index.js list` | Same with optional `?machineId=`; falls back to plain `/api/sessions` |
| `node index.js migrate <session-id>` | `POST` `/api/sessions/:id/migrate` |
| `node index.js checkpoint <session-id>` | `POST` `/api/sessions/:id/checkpoint` |
| `node index.js restore <dir>` | `POST` `/api/checkpoints/restore` with `{ checkpointDir }`, or if that returns 404/405, **local** `criu restore` in `<dir>` |
| `node index.js criu-check` | Prints local CRIU/kernel capability JSON (no server) |

`daemon` subcommand: `--no-criu-check` skips the `criu --version` startup check (developer convenience only).

## Environment (`/.env`)

See `.env.example`. Important keys:

- `SERVER_URL` — e.g. `http://localhost:3000` (no trailing slash; code strips one)
- `LOCAL_MACHINE_ID` — id this machine uses when sending `client:register`
- `POLL_INTERVAL_MS` — default proc polling interval
- `CHECKPOINT_DIR` — world-writable (under root) directory for CRIU images
- `CRIU_BIN` — default `/usr/sbin/criu`

## Server contract (Socket.IO)

Connect to namespace **`/client`**, using the same Socket.IO `path` as the server (default `/socket.io`).

**Client → server (examples):**

- `client:register` — `{ machineId, hostname, kernel, cpuCores, ramGB }`
- `client:heartbeat` — every 10s: `{ machineId, uptime, timestamp }`
- `client:session-metrics` — per poll: `{ sessionId, pid, cpuPercent, memoryMB, memoryPercent, state, threads, timestamp }`
- `client:session-state-change` — `{ sessionId, oldState, newState, pid, reason? }` (e.g. frozen, gone)
- `client:launch-ready` — after validating `server:launch` command
- `client:checkpoint-progress` / `client:checkpoint-complete` / `client:checkpoint-failed`
- `client:restore-complete` / `client:restore-failed`
- `client:log-entry` — structured log lines

**Server → client (examples):**

- `server:launch` — `{ sessionId, command }`
- `server:start-monitor` — `{ sessionId, pid, intervalMs? }`
- `server:stop-monitor` — `{ sessionId }`
- `server:freeze` / `server:checkpoint` / `server:restore` / `server:kill` — with `sessionId` and `pid` or `checkpointDir` as in the project plan
- `server:get-sessions` — callback ack: `{ sessions: [...] }`

REST routes used by CLI shortcuts are shared with the Tauri dashboard (`/api/sessions`, etc.); implement or proxy them on the server as needed.

## Delete legacy bundle

The old static judge UI under `client/dist/` is removed; this package replaces it entirely.
