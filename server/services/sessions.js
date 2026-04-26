import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import * as db from "../db.js";
import { getIo } from "../context.js";
import { S } from "../socket/events.js";
import { config } from "../config.js";
import * as xpra from "./xpra.js";
import * as lxc from "./lxc.js";
import * as criu from "./criu.js";
import * as monitor from "./process-monitor.js";
import * as hang from "./hang-detector.js";

function sessionToPayload(s) {
  if (!s) return null;
  const now = Math.floor(Date.now() / 1000);
  const st = s.started_at || now;
  return {
    id: s.id,
    name: s.app_name || s.id,
    app: s.app_name,
    label: s.app_name,
    icon: "📦",
    pid: s.pid,
    cpuPercent: s.cpu_percent,
    memoryPercent: s.memory_percent,
    memPct: s.memory_percent,
    memoryLabel: s.memory_mb != null ? `${Math.round(s.memory_mb)} MB` : "",
    mem: s.memory_mb != null ? `${Math.round(s.memory_mb)} MB` : "",
    status: s.status,
    uptimeSec: now - st,
  };
}

function firstToken(cmd) {
  const t = String(cmd).trim().split(/\s+/)[0] || "app";
  return path.basename(t);
}

/**
 * @param {string} command
 */
export async function launchSession(command) {
  const id = `session-${uuidv4()}`;
  const appName = firstToken(command);
  const cname = `lxc-${id.replace(/[^a-z0-9-]/gi, "-").slice(0, 32)}`;
  let cId;
  let display;
  let xpraStarted = false;
  let dbInserted = false;

  try {
    const { name } = await lxc.createContainer(cname, {});
    cId = name;
    await lxc.startContainer(cId, { initCommand: ["sleep", "infinity"] });
    display = await xpra.findFreeDisplay();
    await xpra.startSession(display, {});
    xpraStarted = true;
    db.insertSession({
      id,
      machine_id: config.localMachineId,
      command,
      app_name: appName,
      status: "starting",
      xpra_display: display,
      container_id: cId,
    });
    dbInserted = true;
    const child = lxc.runInContainer(cId, command, {
      env: { DISPLAY: display },
    });
    if (!child.pid) {
      throw new Error("failed to spawn session command");
    }
    db.updateSession(id, { pid: child.pid, status: "running" });
    const thr = parseInt(
      db.getSetting("hang_threshold_seconds") || "30",
      10,
    );
    hang.start(id, thr);
    const m = db.getMachine(config.localMachineId);
    if (m && (m.is_local === 1 || m.is_local === true)) {
      const poll = parseInt(
        db.getSetting("poll_interval_ms") || String(config.pollIntervalMs),
        10,
      );
      monitor.startPolling(
        id,
        child.pid,
        Number.isFinite(poll) ? poll : config.pollIntervalMs,
      );
    }
    const row = db.getSession(id);
    if (getIo()) {
      getIo().emit(
        S.sessionCreated,
        sessionToPayload(row),
      );
    }
    return row;
  } catch (err) {
    try {
      if (xpraStarted && display) {
        await xpra.stop(display);
      }
    } catch {
      /* best-effort */
    }
    try {
      if (cId) {
        await lxc.stopContainer(cId);
        await lxc.destroyContainer(cId);
      }
    } catch {
      /* best-effort */
    }
    if (dbInserted) {
      try {
        db.deleteSession(id);
      } catch {
        /* best-effort */
      }
    }
    throw err;
  }
}

export function killSession(sessionId) {
  const s = db.getSession(sessionId);
  if (!s) {
    return { ok: false, error: "not found" };
  }
  hang.stop(sessionId);
  monitor.stopPolling(sessionId);
  const m = db.getMachine(s.machine_id);
  if (s.xpra_display) {
    if (m && !(m.is_local === 1 || m.is_local === true)) {
      xpra.stopRemote(m, s.xpra_display).catch(() => {});
    } else {
      xpra.stop(s.xpra_display).catch(() => {});
    }
  }
  if (s.xpra_tunnel_pid) {
    try {
      process.kill(s.xpra_tunnel_pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
  if (s.pid) {
    try {
      process.kill(s.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        if (s.pid) process.kill(s.pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }, 2000);
  }
  if (s.container_id) {
    lxc.stopContainer(s.container_id).catch(() => {});
    lxc.destroyContainer(s.container_id).catch(() => {});
  }
  db.updateSession(sessionId, {
    status: "completed",
    ended_at: Math.floor(Date.now() / 1000),
  });
  if (getIo()) {
    getIo().emit(S.sessionEnded, { id: sessionId, sessionId });
  }
  return { ok: true };
}

export function manualCheckpoint(sessionId) {
  const s = db.getSession(sessionId);
  if (!s || !s.pid) {
    return Promise.reject(new Error("no such session or pid"));
  }
  const outDir = path.join(
    path.resolve(config.serverDir, config.checkpointDir),
    "manual",
    sessionId,
    String(Math.floor(Date.now() / 1000)),
  );
  return criu.checkpoint(s.pid, outDir, { leaveRunning: true });
}

export function startMonitorIfLocal(sessionId) {
  const s = db.getSession(sessionId);
  if (!s || !s.pid) return;
  const m = db.getMachine(s.machine_id);
  if (!m || !(m.is_local === 1 || m.is_local === true)) return;
  const poll = parseInt(
    db.getSetting("poll_interval_ms") || String(config.pollIntervalMs),
    10,
  );
  monitor.startPolling(
    sessionId,
    s.pid,
    Number.isFinite(poll) ? poll : config.pollIntervalMs,
  );
}

export { sessionToPayload };
