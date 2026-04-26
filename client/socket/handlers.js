import * as monitor from "../services/proc-monitor.js";
import * as control from "../services/process-control.js";
import * as criu from "../services/criu.js";
import * as launcher from "../services/launcher.js";
import { config } from "../config.js";

/**
 * @typedef {Object} HandlerCtx
 * @property {import('socket.io-client').Socket} socket
 * @property {Map<string, { pid: number, intervalMs: number, status: string }>} sessions
 * @property {(e: string, p?: any) => void} emit
 */

/**
 * @param {HandlerCtx} ctx
 */
export function registerAll(ctx) {
  const { socket, sessions, emit } = ctx;
  socket.on("server:launch", async (data) => {
    const sessionId = data?.sessionId;
    const command = data?.command;
    if (!sessionId) return;
    const prep = launcher.prepare(String(command));
    if (!prep.valid) {
      emit("client:launch-ready", { sessionId, valid: false, error: "invalid command" });
      return;
    }
    emit("client:launch-ready", {
      sessionId,
      valid: true,
      app: prep.app,
      args: prep.args,
    });
  });

  socket.on("server:start-monitor", async (data) => {
    const sessionId = data?.sessionId;
    const pid = Number(data?.pid);
    const intervalMs = data?.intervalMs
      ? Number(data.intervalMs)
      : config.POLL_INTERVAL_MS;
    if (!sessionId || !Number.isFinite(pid)) return;
    sessions.set(sessionId, { pid, intervalMs, status: "monitoring" });
    monitor.startPolling(sessionId, pid, intervalMs, {
      onMetrics: (p) => emit("client:session-metrics", p),
      onStateChange: (e) =>
        emit("client:session-state-change", {
          ...e,
          oldState: e.oldState,
          newState: e.newState,
        }),
    });
  });

  socket.on("server:stop-monitor", async (data) => {
    const sessionId = data?.sessionId;
    if (!sessionId) return;
    monitor.stopPolling(sessionId);
    sessions.delete(sessionId);
  });

  socket.on("server:freeze", async (data) => {
    const sessionId = data?.sessionId;
    const pid = Number(data?.pid);
    if (!sessionId || !Number.isFinite(pid)) return;
    await control.freeze(pid, sessionId, (ev) =>
      emit("client:session-state-change", {
        sessionId,
        state: ev.state,
        oldState: "running",
        newState: "frozen",
        pid: ev.pid,
      }),
    );
  });

  socket.on("server:checkpoint", async (data) => {
    const sessionId = data?.sessionId;
    const pid = Number(data?.pid);
    const checkpointDir = data?.checkpointDir;
    if (!sessionId || !Number.isFinite(pid) || !checkpointDir) return;
    try {
      const r = await criu.checkpoint(pid, String(checkpointDir), {
        sessionId,
        onProgress: (p) =>
          emit("client:checkpoint-progress", {
            ...p,
            percent: p.percent,
          }),
      });
      emit("client:checkpoint-complete", {
        sessionId,
        checkpointDir: r.dir,
        sizeBytes: r.sizeBytes,
        durationMs: r.durationMs,
      });
    } catch (e) {
      emit("client:checkpoint-failed", {
        sessionId,
        error: (e && e.message) || String(e),
      });
    }
  });

  socket.on("server:restore", async (data) => {
    const sessionId = data?.sessionId;
    const checkpointDir = data?.checkpointDir;
    if (!sessionId || !checkpointDir) return;
    try {
      const r = await criu.restore(String(checkpointDir));
      emit("client:restore-complete", {
        sessionId,
        newPid: r.pid,
        durationMs: r.durationMs,
      });
      const iv = config.POLL_INTERVAL_MS;
      sessions.set(sessionId, {
        pid: r.pid,
        intervalMs: iv,
        status: "monitoring",
      });
      monitor.startPolling(sessionId, r.pid, iv, {
        onMetrics: (p) => emit("client:session-metrics", p),
        onStateChange: (e) =>
          emit("client:session-state-change", {
            ...e,
            oldState: e.oldState,
            newState: e.newState,
          }),
      });
    } catch (e) {
      emit("client:restore-failed", {
        sessionId,
        error: (e && e.message) || String(e),
      });
    }
  });

  socket.on("server:kill", async (data) => {
    const sessionId = data?.sessionId;
    const pid = Number(data?.pid);
    if (!sessionId || !Number.isFinite(pid)) return;
    await control.kill(pid);
    monitor.stopPolling(sessionId);
    sessions.delete(sessionId);
    emit("client:session-state-change", {
      sessionId,
      oldState: "running",
      newState: "killed",
      pid,
    });
  });

  socket.on("server:get-sessions", (data, callback) => {
    const out = [];
    for (const [id, s] of sessions) {
      out.push({ sessionId: id, ...s, metrics: monitor.getMetrics(id) });
    }
    if (typeof callback === "function") {
      try {
        callback({ sessions: out });
      } catch {
        /* */
      }
    }
  });
}
