import os from "node:os";
import { config, getKernelVersion, runStartupChecks } from "./config.js";
import * as procfs from "./utils/procfs.js";
import * as monitor from "./services/proc-monitor.js";
import * as client from "./socket/client.js";
import { registerAll } from "./socket/handlers.js";
import { setLogEmitter } from "./utils/logger.js";
import * as log from "./utils/logger.js";

/** @type {Map<string, { pid: number, intervalMs: number, status: string }>} */
export const sessions = new Map();

let heartbeatTimer = /** @type {NodeJS.Timeout | null} */ (null);

function emit(event, data) {
  client.emit(event, data);
}

/**
 * Best-effort: resume monitoring for sessions returned by GET /api/sessions.
 */
async function recoverSessions() {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const r = await fetch(`${config.SERVER_URL}/api/sessions`, {
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!r.ok) return;
    const j = await r.json();
    const list = Array.isArray(j) ? j : j.sessions || [];
    for (const s of list) {
      const mid = s.machineId || s.machine_id;
      const sid = s.id || s.sessionId;
      const pid = Number(s.pid);
      if (mid && mid !== config.LOCAL_MACHINE_ID) continue;
      if (!sid || !Number.isFinite(pid)) continue;
      const intervalMs = config.POLL_INTERVAL_MS;
      sessions.set(String(sid), { pid, intervalMs, status: "monitoring" });
      monitor.startPolling(String(sid), pid, intervalMs, {
        onMetrics: (p) => emit("client:session-metrics", p),
        onStateChange: (e) =>
          emit("client:session-state-change", {
            sessionId: e.sessionId,
            oldState: e.oldState,
            newState: e.newState,
            pid: e.pid,
            reason: e.reason,
          }),
      });
      log.info(`recovered monitoring for session ${sid} pid ${pid}`);
    }
  } catch {
    /* server may be down or route missing */
  }
}

function registerWithServer() {
  const info = procfs.getCPUInfo();
  emit("client:register", {
    machineId: config.LOCAL_MACHINE_ID,
    hostname: os.hostname(),
    kernel: getKernelVersion(),
    cpuCores: info.cores,
    ramGB: info.totalMemoryKB / (1024 * 1024),
  });
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    emit("client:heartbeat", {
      machineId: config.LOCAL_MACHINE_ID,
      uptime: procfs.getUptime(),
      timestamp: Date.now(),
    });
  }, 10_000);
}

/**
 * @param {{ skipCriuCheck?: boolean }} [opts]
 */
export async function runDaemon(opts = {}) {
  runStartupChecks({ skipCriu: opts.skipCriuCheck });
  setLogEmitter(emit);
  const socket = client.connect(config.SERVER_URL);
  socket.on("connect", () => {
    registerWithServer();
    log.info("connected to server");
    client.flushQueue();
  });
  socket.on("disconnect", () => {
    log.warn("disconnected from server (monitoring continues locally; events queued)");
  });
  registerAll({ socket, sessions, emit });
  await recoverSessions();
  startHeartbeat();
  log.info("daemon running", { machineId: config.LOCAL_MACHINE_ID });
}
