# GUI Process Migration System
### Product Requirements Document
_v0.1 | April 2026_

---

## 1. Overview

This document defines requirements for a system that wraps arbitrary Linux GUI applications in a portable, checkpointable container. When an application hangs due to resource exhaustion on the local machine, the system captures its full process state and migrates it to a more powerful remote host, resuming the session transparently from the user's perspective.

> **Core Value Proposition:** Any GUI app — IDEs, renderers, CAD tools, browsers — can be rescued mid-hang and resumed on a beefier machine without losing work. Zero manual save required.

---

## 2. Problem Statement

Long-running GUI applications on resource-constrained machines regularly hang due to memory pressure, CPU starvation, or swap exhaustion. The current user experience is:

- Force-kill the app and lose all unsaved state
- Wait indefinitely hoping the system recovers
- Manually save frequently, disrupting creative flow

There is no existing tool that combines process-level checkpointing with display-protocol isolation into a turnkey product for end users. CRIU and Xpra exist independently but are not packaged together in a way that is accessible or automatic.

---

## 3. Goals & Non-Goals

### 3.1 Goals

- Checkpoint any X11 GUI application with full memory and file descriptor state
- Migrate the checkpoint image to a remote machine and resume transparently
- Preserve the visual session — the user reattaches to an identical window
- Work without modification to the target application
- Support any app launchable as a standard Linux process

### 3.2 Non-Goals (v1)

- Native Wayland app support — protocol does not support reconnect, deferred
- GPU/CUDA state preservation — CRIU limitation
- Apps with hard external network session dependencies (e.g. video calls)
- Windows or macOS support

---

## 4. Architecture

### 4.1 High-Level Flow

1. User launches app via wrapper CLI: `gpms run <app-command>`
2. App starts inside an Xpra session within an LXC container
3. Xpra proxies display to the user's desktop as a seamless window
4. User or daemon detects hang and triggers migration
5. `SIGSTOP` is sent to the process tree
6. CRIU dumps the entire container state to a checkpoint image
7. Image is transferred to the remote host (rsync over SSH)
8. CRIU restores the container on the remote host
9. Xpra session reconnects — user sees their app resume

### 4.2 Component Breakdown

| Component | Role | Technology |
|---|---|---|
| `gpms` CLI | User-facing wrapper. Launches, monitors, and triggers migration. | Python 3 |
| LXC Container | Isolation layer. Provides consistent env for CRIU. | LXC + unprivileged config |
| Xpra Session | X11 display proxy. Keeps display connection alive across migration. | Xpra 4.x |
| CRIU | Process checkpointing and restore engine. | CRIU 3.x (kernel >=5.15) |
| Transfer Layer | Ships checkpoint image to remote host. | rsync over SSH |
| Hang Detector | Monitors process responsiveness; triggers migration automatically. | Python + /proc polling |

---

## 5. Environment Requirements

### 5.1 Host Machine (Machine A)

| Requirement | Detail |
|---|---|
| OS | Debian 12 (Bookworm) — stable kernel, best CRIU compatibility |
| Kernel | >= 5.15, with `CONFIG_CHECKPOINT_RESTORE=y` |
| CRIU | 3.x from Debian repos (`apt install criu`) |
| Xpra | 4.x from xpra.org repo (not Debian's outdated version) |
| LXC | 5.x unprivileged containers (`apt install lxc`) |
| Display | X11 or XWayland — Xpra needs an X backend to proxy from |
| Privileges | `CAP_SYS_PTRACE` + `CAP_SYS_ADMIN`, or run CRIU as root |
| SSH | Key-based auth to remote host pre-configured |

### 5.2 Remote Machine (Machine B)

| Requirement | Detail |
|---|---|
| OS | Debian 12 — must match kernel series closely for CRIU restore |
| Kernel | Same minor version as Machine A is safest; same major required |
| CRIU | Same version as Machine A |
| Xpra | Same version as Machine A |
| LXC | Same version as Machine A |
| Resources | More RAM/CPU than Machine A — the whole point |
| Network | SSH accessible from Machine A; low latency preferred for Xpra |

> **Why Debian?** CRIU is highly sensitive to kernel version mismatches between checkpoint and restore hosts. Debian Stable pins the kernel, making it straightforward to match machines. Ubuntu LTS is an acceptable alternative if both machines run identical Ubuntu versions.

---

## 6. Known Constraints & Risk Areas

### 6.1 CRIU Hard Limits

- Apps in `D` state (uninterruptible sleep) cannot be checkpointed — migration is impossible until the blocking I/O resolves
- OpenGL / GPU state is not captured — any app using hardware rendering will crash on restore
- Kernel version delta between A and B is the #1 restore failure cause — version pinning is mandatory
- Some apps open `/dev/*` or `/proc/*` paths that CRIU cannot restore across hosts

### 6.2 Xpra Constraints

- App must be an X11 client — native Wayland clients are out of scope for v1
- Xpra adds ~5–15ms display latency locally; acceptable tradeoff for migration capability
- Audio forwarding is possible but optional for v1

### 6.3 App Compatibility

| App Category | Compatibility | Notes |
|---|---|---|
| Blender, FreeCAD, GIMP, Krita | High | CPU/RAM hangs, X11 native, no GPU required in CPU render mode |
| VSCode, IntelliJ (non-GPU) | High | Electron/JVM, tolerate CRIU well |
| Firefox, Chrome | Medium | Complex fd landscape; sandbox may interfere |
| Any OpenGL app | Low | GPU state not capturable |
| Native Wayland apps | None (v1) | Protocol incompatible with reconnect model |

---

## 7. User Experience

### 7.1 Launch

User starts any app through the wrapper:

```bash
gpms run blender my_scene.blend
gpms run code /path/to/project
gpms run inkscape artwork.svg
```

The app opens as a normal window on the user's desktop. No visible difference from a native launch.

### 7.2 Hang Detection & Migration Trigger

- **Automatic:** hang detector polls `/proc/<pid>/status` and sends test X events; triggers migration after N seconds of unresponsiveness (configurable, default 30s)
- **Manual:** user runs `gpms migrate <session-id>` to trigger immediately

### 7.3 Migration Experience

- User sees a non-blocking notification: _"App is unresponsive. Migrating to remote host..."_
- Window goes dark/frozen (expected — `SIGSTOP` is sent)
- After transfer + restore (target: under 60 seconds for <4GB process), window resumes
- User is back in their session, on the more powerful machine, as if nothing happened

---

## 8. Delivery Milestones

| Milestone | Deliverable | Estimate |
|---|---|---|
| M1 | Manual CRIU checkpoint/restore of a single X11 app on one machine | 1 week |
| M2 | App runs inside LXC + Xpra; manual reattach works | 2 weeks |
| M3 | Manual migration: checkpoint → rsync → restore on Machine B | 1 week |
| M4 | Hang detector + automatic migration trigger | 1 week |
| M5 | `gpms` CLI wrapping the full flow end to end | 1 week |
| M6 | Testing matrix across target app categories | 1 week |

---

## 9. Open Questions

- What is the acceptable checkpoint image transfer time? Determines whether to optimize for compression vs raw speed.
- Should the system support bi-directional migration (migrate back to A after resources free up)?
- Is there a requirement to support multiple simultaneous sessions?
- Should the LXC container be pre-built and shipped, or built on-demand per app?
- What is the security model for SSH key management between machines?

---

## 10. Appendix: Key Tool References

| Tool | Reference |
|---|---|
| CRIU | criu.org — checkpoint/restore engine, the core of migration |
| Xpra | xpra.org — persistent X11 session proxy, screen-for-X |
| LXC | linuxcontainers.org — lightweight system containers |
| Debian 12 | debian.org/releases/stable — recommended base OS |
| rsync | Standard transfer; consider lz4 compression for large images |
