# GPMS Worker Daemon (`gpms-worker`)

Persistent remote-node daemon used by the server during migration restore.

## What it does

- exposes authenticated HTTP endpoints for remote restore operations
- creates checkpoint directories under a configured base directory
- runs `criu restore` and returns parsed output/pid
- reports process liveness and supports remote process kill
- optionally starts/stops/lists Xpra sessions

## Setup

```bash
cd worker
cp .env.example .env
npm install
npm run start
```

## Machine configuration on server

When creating or updating a machine, include:

- `worker_url` (for example, `http://10.0.0.25:3400`)
- `worker_token` (must match `WORKER_TOKEN` on worker, if set)

If `worker_url` is present, migration restore steps use the worker API instead of SSH command execution for those operations.
