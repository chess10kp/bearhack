# bearhack

GridLock / GPMS monorepo: server, client, dashboard, and a shared **Solana** settlement package.

## DCP implementation track (hybrid mode)

The repository now includes a **real DCP integration track** in hybrid mode:

- **Transport selection**: migrations can run with `ssh` (default) or `dcp` transport mode.
- **Runtime setting**: `settings.migration_transport` controls default transport (`ssh` or `dcp`).
- **Fallback behavior**: when transport is `dcp`, server can fallback to SSH transfer if DCP orchestration fails (`DCP_FALLBACK_TO_SSH=true`).
- **DCP metadata**: migrations persist `transport_kind`, `dcp_job_id`, `dcp_scheduler_url`, `dcp_status`, `dcp_error`, and `dcp_result_json`.
- **Work package scaffold**: `dcp-work/checkpoint.js` provides the checkpoint orchestration work-function contract.

Current scope of DCP integration is **control-plane orchestration** while preserving the proven CRIU/Xpra restore path for reliability.

### Server DCP env vars

Add these in `server/.env` as needed:

- `MIGRATION_TRANSPORT=ssh|dcp`
- `DCP_FALLBACK_TO_SSH=true|false`
- `DCP_SCHEDULER_URL=https://scheduler.distributed.computer`
- `DCP_ID_KEYSTORE=`
- `DCP_ACCOUNT_KEYSTORE=`
- `DCP_WORK_SCRIPT=../dcp-work/checkpoint.js`

### Triggering DCP migration

- REST: `POST /api/sessions/:id/migrate` with optional body `{ "targetMachineId": "machine-b", "transportKind": "dcp" }`
- Socket: `session:migrate` payload supports `transportKind: "dcp"`

## Solana settlement (devnet)

On-chain payment is **optional**. If the server has no `SOLANA_TREASURY`, migrations complete without charging.

### Layout

- **`solana/`** — Local npm package (`gridlock-solana`) with pricing, wallet helpers, transfer verification, and `/api/solana` route factory. Server and client depend on it via `"file:../solana"` in their `package.json`.
- **Server** — After a successful migration, computes `payment_lamports`, stores `payment_status` (`none` / `pending` / `confirmed`), and broadcasts `solana:payment-request` (default namespace and `/client` for the daemon).
- **Client daemon** — If `GRIDLOCK_WALLET_PRIVATE_KEY` (or `GRIDLOCK_WALLET_KEYPAIR` file) is set, it signs and submits the transfer, then `POST /api/solana/confirm`. Optional `GRIDLOCK_WALLET_ADDRESS` must match the key.

### Install

From repo root, install the Solana package first (or rely on `npm install` in `server/` and `client/`, which link it):

```bash
cd solana && npm install
cd ../server && npm install
cd ../client && npm install
```

### Server environment

Copy `server/.env.example` to `server/.env` and set as needed:

| Variable | Purpose |
|----------|---------|
| `SOLANA_RPC_URL` | RPC (default devnet public RPC). |
| `SOLANA_CLUSTER` | e.g. `devnet` (for explorer links). |
| `SOLANA_TREASURY` | Base58 pubkey that receives compute payments. **Empty = no settlement.** |
| `SOLANA_BASE_LAMPORTS` | Fixed component of the fee. |
| `SOLANA_LAMPORTS_PER_SECOND` | Variable component × migration `total_seconds`. |

Optional DB settings `solana_base_lamports` / `solana_lamports_per_second` override env if set via settings API.

### Client environment

Copy `client/.env.example` to `client/.env`:

| Variable | Purpose |
|----------|---------|
| `GRIDLOCK_WALLET_PRIVATE_KEY` | Payer key: base58, hex, or JSON array string. If set, used instead of a keypair file. |
| `GRIDLOCK_WALLET_ADDRESS` | Optional; must match pubkey derived from the private key. |
| `GRIDLOCK_WALLET_KEYPAIR` | Path to payer keypair JSON (when `GRIDLOCK_WALLET_PRIVATE_KEY` is empty). Omit all wallet vars to skip auto-pay. |
| `SOLANA_RPC_URL` | Optional; defaults to the RPC URL sent in the socket payload / devnet. |

Fund the payer on **devnet** (faucet) before testing real transfers.

### CLI (client)

- `npm run history` — Lists migrations and payment fields from `GET /api/migrations`.
- `npm run pay -- <migrationId>` — Pays a single pending migration (`mig-…`).
- `npm run pay-pending` — Pays every migration returned by `GET /api/solana/pending`.

### Dashboard

Migration history includes a **Solana tx** link when `payment_signature` is present (explorer URL uses `solanaCluster` from `GET /api/solana/config`).

### Notes

- This is a **direct transfer** to the treasury for demos, not a custom on-chain escrow program.
- `POST /api/solana/confirm` checks the chain: the signature must contain a matching `system` transfer to `SOLANA_TREASURY` for the recorded `payment_lamports`.

## Live migration (CRIU page-server pre-copy)

Stream dirty pages directly from Machine A's CRIU into a `criu page-server` on
Machine B — no intermediate storage, no rsync of pages, no temp files. Only the
small per-snapshot metadata images go over a separate HTTP upload to the worker.

```
A: criu pre-dump --page-server --address B --port 1234   (round 0, 1, …)
A: criu dump     --page-server --address B --port 1234   (final, only delta)
B: criu page-server -D <snap> --port 1234                (per snapshot)
B: criu restore  -D <final-snap>
A->B: xpra reattach to the new host
```

### Setup

On **Machine B** (target):

```bash
cd worker && npm install
WORKER_HOST=0.0.0.0 WORKER_PORT=3400 \
  CHECKPOINT_BASE_DIR=/var/lib/gpms-checkpoints \
  npm start
```

On **Machine A** (source):

```bash
export MACHINE_B_HOST=10.0.0.42       # hardcoded for the demo
export MACHINE_B_USER=jac
export WORKER_URL=http://${MACHINE_B_HOST}:3400
export PAGE_PORT=1234
export ITERATIONS=3                   # 2 pre-dumps + 1 final dump
export CHILD_CMD='xterm -e "while true; do date; sleep 1; done"'

./gpms-precopy-demo.sh up           # start xpra :110 + child app
./gpms-precopy-demo.sh tunnel       # ssh -L 1234:127.0.0.1:1234 to B
./gpms-precopy-demo.sh migrate      # pre-copy → final dump → restore on B
./gpms-precopy-demo.sh attach       # xpra attach tcp://B:14600/
```

If the page-server flakes during the demo, fall back to a local dump + tar
upload + remote restore:

```bash
./gpms-precopy-demo.sh migrate-fallback
```

### Direct CLI

The migration is also a first-class client command:

```bash
sudo node client/index.js migrate-live \
  --pid 12345 \
  --worker http://machine-b:3400 \
  --page-host 127.0.0.1 --page-port 1234 \
  --iterations 3 \
  --migration-id mig-demo-1
```

### Worker endpoints (Machine B)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/worker/migration/prepare` | Create snapshot dir, link `parent` to previous snapshot |
| `POST` | `/api/worker/migration/page-server/start` | Spawn `criu page-server -D <snap> --port` |
| `POST` | `/api/worker/migration/page-server/wait` | Wait for page-server to exit (after dump finishes) |
| `POST` | `/api/worker/migration/page-server/stop` | Force-kill page-server (cleanup) |
| `GET`  | `/api/worker/migration/page-server/list` | Running page-servers |
| `PUT`  | `/api/worker/migration/file?migrationId=&snapshotIndex=&name=` | Upload one metadata image into snapshot dir |
| `POST` | `/api/worker/migration/restore` | `criu restore` from the final snapshot dir |
| `POST` | `/api/worker/migration/extract` | Fallback: extract uploaded `dump.tar` |
