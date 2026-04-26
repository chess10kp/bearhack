# GridLock Implementation Status

_April 2026 — based on prd.md and PRD.md requirements_

---

## Missing / Not Started

### 1. Ollama/Gemma AI Integration
Neither the server, client, nor worker calls Ollama. PRD.md describes Gemma for:
- **Freeze classification:** Given process metrics, output `{"decision": "MIGRATE|NOT_NEEDED|KILL", "reason": "...", "target_spec": "gpu|tallram|highcpu", "priority": 1-10}`
- **Node selection:** Pick best remote node based on migration target_spec and each node's hardware
- **Completion detection:** Monitor remote process behavior and decide when to trigger return checkpoint
- **User preference parsing:** Natural language rules via Gemma — e.g. "keep Chrome local unless it's encoding video"

Completely absent from all components.

### 2. Anchor Daemon (`anchor/`)
The home PC always-on fallback node described in PRD.md. Directory does not exist.
- Should be an always-on daemon that registers the user's home PC as a backup compute node
- Receives jobs when online, executes CRIU restore, returns results

### 3. DCP Real Checkpoint Transport
Currently a stub (`dcp-work/checkpoint.js` is ~38 lines of control-plane metadata only). Real transport uses SSH/rsync. Missing:
- Actual checkpoint bundle serialization/deserialization as DCP work units
- DCP marketplace integration for node discovery
- DCP-based result return channel

---

## Partial / Needs Work

### 4. DCP Worker Mode
The worker is an HTTP daemon only, not a DCP work function executor. PRD.md describes receiving jobs via DCP, but the worker has no DCP client. Currently the server's `dcp-client.js` submits orchestration metadata jobs, not checkpoint bundles.

### 5. Node Auto-Registration
Machines must be manually registered. No automatic registration flow from client/worker to server. PRD.md implies `gridlock-node register` should be part of the flow.

### 6. Solana Escrow Model
Current implementation is direct SOL transfer. PRD.md describes escrow in a GridLock program account with release on completion. Acceptable simplification for demo (explicitly noted in PRD), but not the described architecture.

---

## Done / Working

### Core Migration Pipeline
- Full CRIU checkpoint/restore (server + client + worker)
- CRIU page-server pre-copy live migration
- SIGSTOP process tree freeze + SIGCONT thaw
- Migration pipeline: freeze → dump → transfer → restore → reattach

### Infrastructure
- LXC container management (create, start, stop, destroy, exec)
- Xpra display proxy with reattach, HTML5 client, screenshots
- SSH/rsync checkpoint transfer with progress parsing
- Worker HTTP API with bearer token auth

### Monitoring & Detection
- Process monitoring via `/proc/{pid}/stat` and `/proc/{pid}/status`
- Hang detection (D-state + low CPU threshold)
- Auto-migration trigger on hang detection
- Real-time Socket.IO metrics streaming

### Payments
- Solana devnet integration with wallet management
- On-chain payment + verification
- Auto-pay after migration completion
- CLI commands: `pay`, `pay-pending`
- Explorer links in dashboard

### UI & CLI
- Polished Tauri v2 desktop dashboard with live data + mock mode
- Full session management UI (launch, migrate, checkpoint, inspect)
- Migration pipeline visualization with step-by-step progress
- Machines grid, migration history, log panel, settings modal
- Client CLI with full command surface (`daemon`, `status`, `migrate`, `checkpoint`, `restore`, `list`, `run`, `criu-check`, `history`, `pay`, `migrate-live`)

### Demo Scripts
- `gpms-precopy-demo.sh` — CRIU page-server pre-copy demo
- `gpms-xpra-mvp.sh` — Xpra MVP testing script

---

## Summary

| Component | Lines | Completeness | Notes |
|-----------|-------|-------------|-------|
| Server | ~3,373 | Mostly Complete | Missing Ollama/Gemma |
| Client | ~2,193 | Mostly Complete | Missing Ollama/Gemma |
| Worker | ~694 | Mostly Complete | Missing Ollama, DCP worker mode |
| Dashboard | ~2,861 | Mostly Complete | Full UI with Tauri |
| Solana | ~379 | Complete | Devnet direct transfer |
| DCP Work | ~38 | Stub | Control-plane only |
| Anchor | 0 | None | Not started |

**Total source code:** ~9,538 lines

**Biggest gap for demo:** Ollama/Gemma AI decision layer. DCP transport and anchor daemon are secondary.
