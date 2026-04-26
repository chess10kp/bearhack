# bearhack

GridLock / GPMS monorepo: server, client, dashboard, and a shared **Solana** settlement package.

## Solana settlement (devnet)

On-chain payment is **optional**. If the server has no `SOLANA_TREASURY`, migrations complete without charging.

### Layout

- **`solana/`** — Local npm package (`gridlock-solana`) with pricing, wallet helpers, transfer verification, and `/api/solana` route factory. Server and client depend on it via `"file:../solana"` in their `package.json`.
- **Server** — After a successful migration, computes `payment_lamports`, stores `payment_status` (`none` / `pending` / `confirmed`), and broadcasts `solana:payment-request` (default namespace and `/client` for the daemon).
- **Client daemon** — If `GRIDLOCK_WALLET_KEYPAIR` points to a Solana CLI–style JSON keypair, it signs and submits the transfer, then `POST /api/solana/confirm`.

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
| `GRIDLOCK_WALLET_KEYPAIR` | Path to payer keypair JSON. Omit to skip auto-pay (use CLI below). |
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
