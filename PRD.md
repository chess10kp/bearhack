# GridLock — Product Requirements Document

**Version 3.0 — Workflow Continuity via Isolated Workers + Optional Settlement**

---

## What GridLock Actually Is

GridLock protects your development workflow by isolating heavy jobs — compilers, bundlers, test suites, data processors, renderers — from your editor session, and running them on other machines that would otherwise be idle. When a build crashes or hangs, you resume from where it left off, not from scratch.

The core mechanism is a **coordinator service** that dispatches tasks to sandboxed workers on any reachable host, plus **crash-safe logging and artifact snapshots** that preserve useful state after partial failure. Optional Solana integration adds verifiable provenance and micropayments for worker time.

The user sees: their build crashed, and then it didn't. Progress preserved, editor session stable.

---

## The Problem GridLock Solves

Your Gradle build crashes at 90% and takes your editor session with it. Your video export hangs at the last frame. Your test suite times out on a flaky module and you have to re-run the whole thing. These aren't bugs — they're **workflow failures** where the program is correct but the moment defeated it.

Current solutions:
- Buy better hardware (expensive, permanent)
- Kill and restart the program (lose progress, lose state)
- Cloud VMs (provisioning latency, manual, expensive)

GridLock is: **builds and jobs that run on other machines, with crash recovery and resume support — so your editor session never pays the price.**

---

## Inspiration

As Android developers, we've run into this more times than we wanted: kick off a long Gradle build, something crashes halfway through, and your editor session is gone with it. GridLock came from that frustration.

The problem isn't limited to compilers — video editors, image processors, long-running test suites, bundlers, and custom data jobs can all peg the CPU, freeze the UI, or crash the process that launched them, often at the worst possible moment when you've been heads-down for hours without a clean save or checkpoint.

---

## How We Built It

```
[User Program]            [GridLock Client]         [Gemma Local Agent]
     │                           │                           │
     │  (program going slow)     │                           │
     │<─────────────────────────│                           │
     │  metrics: CPU 95%,       │                           │
     │  memory pressure high,    │                           │
     │  process unresponsive     │                           │
     │─────────────────────────>│                           │
     │                           │  classify_and_decide()    │
     │                           │─────────────────────────>│
     │                           │  "MIGRATE: blender render │
     │                           │   needs GPU, offload to   │
     │                           │   remote GPU node"        │
     │<─────────────────────────│<──────────────────────────│
     │  freeze signal received   │                           │
     │                           │                           │
     │  [CRIU DUMP]─────────────>│                           │
     │  checkpoint includes:      │                           │
     │  - register state         │                           │
     │  - memory pages           │                           │
     │  - file descriptors       │                           │
     │  - network sockets        │                           │
     │  - pipe buffers           │                           │
     │                           │                           │
     │                           │  package_checkpoint()      │
     │                           │  submit_to_dcp()          │
     │                           │──────────────────────────>│
     │                           │  DCP distributes to:       │
     │                           │  - remote GPU node (Vultr) │
     │                           │  - peer's gaming PC       │
     │                           │                           │
     │                           │  [DCP TASK QUEUE]         │
     │                           │                           │
     │                     [Remote Node]                     │
     │                     - receives checkpoint             │
     │                     - CRIU RESTORE process            │
     │                     - process resumes on remote CPU/GPU│
     │                     - completes heavy operation       │
     │                     - CRIU DUMP again (final state)   │
     │                     - checkpoint sent back to client   │
     │                           │                           │
     │<──────────────────────────│  result_returned()         │
     │  [CRIU RESTORE]          │                           │
     │  process resumes on       │                           │
     │  local machine,           │                           │
     │  blender render DONE       │                           │
```

---

## Component Roles

> Implementation note (hybrid transition): current codebase runs a hybrid transport path.
> `ssh/rsync` remains available and is the default fallback while DCP orchestration is being
> integrated incrementally. Migration rows track `transport_kind` and DCP job metadata.

### GridLock Client (runs on user's machine, Linux)

**Responsibilities:**
- Real-time process monitoring via `/proc` stats and `psutil`
- Decision requests to local Gemma via Ollama
- CRIU invocation for checkpoint (`criu dump -t PID`) and restore (`criu restore`)
- Packaging checkpoint into a DCP-compatible work unit
- Receiving restored state and triggering restore
- Wallet management: signing Solana transactions for compute payments

**Stack:** Node.js daemon + `criu` CLI + `ollama` (Gemma via REST) + `@solana/web3.js`

**Gemma's role (local, via Ollama):**
- **Freeze classification:** Given process metrics (CPU%, memory%, I/O wait, child process tree), Gemma outputs: `{"decision": "MIGRATE|NOT_NEEDED|KILL", "reason": "...", "target_spec": "gpu|tallram|highcpu", "priority": 1-10}`
- **Node selection:** When multiple remote nodes are available, Gemma picks the best match based on the migration's target_spec and each node's reported hardware
- **Completion detection:** Gemma monitors the remote process's behavior and decides when to trigger the return checkpoint (CPU usage drops, process exits, or timeout)
- **User preference parsing:** Natural language rules via Gemma — "keep Chrome local unless it's encoding video"

**Why Gemma here instead of a rule-based system:**
A rules engine would need hardcoded thresholds and exhaustive edge cases. Gemma generalizes: it understands that a Blender render on an integrated GPU is different from a Node.js build, and adjusts its migration decision accordingly. The local model also keeps preference data private — no cloud round-trip for decisioning.

### DCP (Distributed Compute Platform)

**Responsibilities:**
- Transporting checkpoint packages from client to remote nodes
- Providing a marketplace of available compute (idle gaming PCs, Vultr instances, anchor machines)
- Distributing payment via DCP credits (or Solana settlement as the user-facing layer)

**Stack:** `dcp-client` library

**Current implementation status:**
- `server` includes `dcp-client` and a DCP orchestration service.
- `dcp-work/checkpoint.js` exists as the work-function contract scaffold.
- DCP is selectable per migration (`transportKind=dcp`) and via settings.
- SSH transport remains as fallback for reliability during rollout.

**Note on CRIU + DCP:** CRIU checkpoints are system-level process snapshots. DCP runs work functions in sandboxed workers. For GridLock, DCP is the **orchestration and transport layer** — it manages which node gets which checkpoint, tracks job state, and handles result return. The actual process execution on the remote node is managed by a specialized **GridLock Worker daemon**, not a raw DCP work function.

```
GridLock Job Structure (DCP):
- input: { checkpointBundle: ArrayBuffer, processMetadata: {...}, returnRoute: string }
- work function: receives checkpoint, spins up GridLock Worker, executes CRIU restore
- output: { resultCheckpoint: ArrayBuffer, exitCode: number, executionMs: number }
```

### GridLock Worker (runs on remote nodes)

**Responsibilities:**
- Receive and validate checkpoint bundles from DCP
- Execute `criu restore` to resurrect the process
- Monitor the restored process until completion signal
- Execute `criu dump` for final state
- Return checkpoint bundle via DCP result channel

**Stack:** Node.js daemon + `criu` + `ollama` (Gemma, same model)

**Remote node types:**
- **Vultr GPU instances** — paid, reliable, high-performance (Vultr sponsor track)
- **Peer's gaming PC** — earned compute credits by contributing idle time
- **Home PC (Anchor)** — the user's own machines when they're online (backup)

### Solana Settlement Layer

**Responsibilities:**
- Pay remote node operators for compute time consumed
- Charge user's wallet for the migration operation
- Immutable audit trail of all compute purchases

**Flow:**
1. User submits job → GridLock client creates a Solana payment transaction (pre-authorized via session token)
2. Payment is escrowed in a GridLock program account
3. Remote node completes job → Solana releases payment to node operator
4. User's wallet is charged the final amount based on execution time and node tier

**Why Solana:** Compute time on a peer GPU might cost 0.001 SOL for 30 seconds of GPU time. Traditional payment rails cannot settle sub-cent micropayments with sub-second finality. Solana can.

**Stack:** `@solana/web3.js`, Solana Pay for optional wallet UI

### Master Server

**Responsibilities:**
- Node registry: tracks online nodes, their specs, and availability
- Session management: JWT-based auth for client daemon registration
- DCP job orchestration: submits/checkpoints jobs to DCP network
- Solana settlement coordination
- Live dashboard: visualizes the migration pipeline end-to-end

**Stack:** Node.js + Express + Socket.IO + SQLite + `@solana/web3.js`

---

## Demo Scenario

**What judges see live:**

1. Laptop running Blender, begins a Cycles render. CPU thermal-throttles. Blender UI becomes unresponsive ("Not Responding" in taskbar).

2. GridLock tray icon pulses yellow. Notification: "Blender render detected as heavy. Checking for remote compute..."

3. Dashboard (on projector/large screen) shows the pipeline in real-time:
   - Left: laptop node, Blender process, "FROZEN" status
   - Center: "CRIU DUMP → DCP TRANSFER → REMOTE RESTORE" animation
   - Right: Vultr GPU node, process restored, GPU utilization climbing, status "COMPUTING"
   - Gemma local decision card appears: "MIGRATE: blender needs GPU, sending to Vultr T4 GPU node. Estimated time: 47s."

4. Remote node runs the render. 45 seconds. GPU utilization drops — job complete.

5. DCP transfers result checkpoint back. CRIU restores on laptop. Blender unfreezes. Render complete. Notification: "Blender render complete. Total migration time: 52s. Cost: 0.002 SOL."

**What judges don't see:**
- CRIU doing its thing (it's CLI, not animated)
- DCP job queuing and distribution
- Solana transaction signing and confirmation

**The wow:** A program that was visibly frozen on a judge's laptop just resumed with its work done, running on someone else's GPU, while they watched the migration pipeline happen.

---

## Repo Structure

```
gridlock/
├── server/          # Coordinator service (Express + Socket.IO + SQLite)
├── client/          # GridLock Client daemon (Node.js + Ollama + Solana)
├── worker/          # GridLock Worker daemon (isolated build execution)
├── gpms-*.sh       # xpra + CRIU workflow scripts (MVP checkpoint/suspend/resume)
├── dashboard/       # Live visualization dashboard (React)
├── anchor/          # Home PC daemon (always-on fallback node)
└── dcp-work/       # DCP work function packages
```

---

## Tech Stack

| Layer | Technology | Why |
|-------|------------|-----|
| Worker isolation | Sandboxed containers/processes | Isolates build jobs from the editor failure domain |
| Crash-safe state | Log snapshots + artifact persistence | Enables resume, not restart after failure |
| Distributed transport | DCP (`dcp-client`) | Handles node discovery, job distribution, result return |
| Local decision model | Gemma 3 2B via Ollama | Runs locally on client machine, no cloud latency for decisions |
| Payments | Solana | Sub-second finality, sub-cent micropayments |
| Coordination server | Node.js + Express + Socket.IO | Job dispatch, worker registry, real-time pipeline visualization |
| Database | SQLite | Node registry, job history, settlement ledger |
| Dashboard | React + Tailwind + Socket.IO client | Live pipeline view |

---

## Sponsor Track Alignment

| Sponsor | API/Asset | GridLock Use |
|--------|-----------|--------------|
| **Distributive** | DCP network | Checkpoint transport and distribution to remote nodes |
| **Solana** | Blockchain + micropayments | Pay peer nodes for compute time; settlement layer |
| **Vultr** | Cloud GPU instances | High-performance remote worker nodes (demo anchor) |
| **Google** | Gemma 4 | Local Ollama inference for freeze classification + node selection |
| **MLH** | Hackathon general | Novel system that demos as "the cloud, but local" |

---

## Judging Criteria Fit

| Criterion | How GridLock Scores |
|-----------|-------------------|
| **Execution (30%)** | Full end-to-end demo: freeze → dump → migrate → restore → resume. Complete pipeline. |
| **Impact (20%)** | Solves a real, universal problem (resource mismatch) with a novel approach. |
| **Creativity (30%)** | CRIU + DCP + Solana + Gemma is a genuinely novel stack for this problem. |
| **Presentation (20%)** | Live demo with visible freeze, visible migration, visible unfreeze. Story writes itself. |

---

## Judge Nerd Snipe Matrix

| Judge | Why GridLock Hits |
|-------|------------------|
| **Dan Desjardins (Distributive)** | DCP used as the distributed transport layer for process migration — exactly his domain |
| **Luqmaan Irshad (AMD)** | CRIU on AMD GPU nodes, ROCm for remote GPU compute, GPU utilization in dashboard |
| **Colin Chambachan (Google)** | Distributed systems: process migration, fault tolerance, distributed scheduling |
| **Laith Adi (ML Engineering)** | Gemma decisionmaking, ML pipeline for process classification |
| **Jack Le (9x Winner)** | Technically wild demo — watching a frozen program migrate and resume is a showstopter |
| **Jatinder Bhola** | Systems engineering: process checkpoint/restore is hardcore infrastructure work |
| **Jaelyn Lee (Okta)** | Solana wallet + session auth for compute purchases |
| **Mark Zietara (Tangerine)** | Architecture: clean separation of client → DCP → worker → Solana settlement |
| **Nick Martin (Scotiabank)** | Real-world utility narrative: "Students can now run Blender without buying a gaming PC" |

---

## Constraints and Scope for 36 Hours

**Must have for demo:**
- Coordinator service dispatching a build task to a sandboxed worker on another host
- Crash-safe logging + artifact snapshots that survive a worker crash
- Resume from last checkpoint after worker failure (not a full restart)
- Dashboard showing pipeline status and worker output in real-time
- Optional: Solana tx confirming payment for compute time

**Can simplify:**
- DCP as a black box for job distribution — point-to-point transfer is fine
- Solana on Devnet only — no mainnet
- Gemma decision as a single classification call — not a continuous monitoring loop
- Worker isolation: containerized or process-sandboxed on a reachable host

**Must avoid:**
- Making the demo about debugging worker failures (keep it simple)
- Full wallet UI — just show the Solana tx hash in the dashboard
- Implying cross-OS migration (workers must be Linux-to-Linux)

---

## CLI/API Surface

### Client Daemon (runs on user's machine)

```bash
# Register this machine as a GridLock node
gridlock-node register --label "my-laptop" --type device

# Check status of all connected nodes
gridlock-node status

# Manual trigger (override Gemma decision)
gridlock-node migrate --pid 12345 --target gpu

# Show migration history and Solana charges
gridlock-node history
```

### Worker Daemon (runs on remote nodes)

```bash
# Start worker, connect to DCP network
gridlock-worker start --type gpu --min-payment 0.001

# Worker receives jobs, executes, returns results automatically
```

### Dashboard

```bash
# Start dashboard server
gridlock-dashboard

# Opens http://localhost:5173 showing live migration pipeline
```

---

## Key Files

| Path | Purpose |
|------|---------|
| `server/index.js` | Master server: node registry, DCP job submission, Solana settlement, Socket.IO dashboard events |
| `client/index.js` | GridLock Client daemon: process monitor, Gemma client, CRIU invoker, DCP submitter |
| `worker/index.js` | GridLock Worker: DCP job receiver, CRIU restore, completion monitor, CRIU dump, result return |
| `dashboard/index.html` | Live migration pipeline visualization |
| `dcp-work/checkpoint.js` | DCP work function: receives checkpoint bundle, spawns GridLock Worker, returns result |
| `schema.sql` | SQLite schema: nodes, jobs, transactions |

---

## Success Metrics (for the demo)

1. A process visibly frozen on the demo machine visibly resumes after migration
2. The dashboard shows the complete pipeline with timing at each stage
3. A Solana transaction hash is visible confirming compute payment
4. Total elapsed time from freeze detection to resume: under 90 seconds
5. At least one judge says "how does CRIU even work" out loud

---

## What We Learned

- Reliability features feel invisible until they fail — then they're everything
- Developer experience is as much about recovery speed as raw build speed
- Good observability (structured logs + status signals) is non-negotiable
- Designing for failure paths early dramatically improves product quality
- Treating "where the work runs" as separate from "where you think" turns a bad afternoon into a recoverable blip

---

## What's Next for GridLock

- **IDE plugins** — Android Studio first, with one-click integration
- **Build analytics dashboard** — failure patterns, flaky modules, and MTTR
- **Easier idle machine onboarding** — pairing, quotas, and "only when idle" rules for home, lab, and office
- **Solana worker marketplace** — verifiable job records, artifact timestamps, and micropayment support for third-party and volunteer workers
- **Team features** — shared cache strategy, incident history, and policy controls
