import { ctx, getIo } from "../context.js";
import * as db from "../db.js";
import { S } from "../socket/events.js";
import { execute as executeMigration, isLocked } from "./migration.js";

const watch = new Map();

export function start(sessionId, thresholdSec) {
  const th = Math.max(5, Number(thresholdSec) || 30);
  watch.set(sessionId, {
    thresholdSec: th,
    badSince: null,
    lastCpu: null,
  });
}

export function stop(sessionId) {
  watch.delete(sessionId);
}

/**
 * @param {string} sessionId
 * @param {{ cpuNorm: number, procState: string, memMb: number }} data
 */
export function onMonitorTick(sessionId, data) {
  const w = watch.get(sessionId);
  if (!w) return;
  const sess = db.getSession(sessionId);
  if (!sess || sess.status !== "running") return;
  const thr = w.thresholdSec;
  const { cpuNorm, procState } = data;
  /* D-state (uninterruptible) is the strong signal; S is too common for idle GUIs */
  const badState = procState === "D";
  const lowCpu = cpuNorm < 0.01;
  if (lowCpu && badState) {
    if (w.badSince == null) w.badSince = Date.now();
    const elapsed = (Date.now() - w.badSince) / 1000;
    if (elapsed >= thr) {
      triggerHang(
        sessionId,
        `cpu ~0% and state ${procState} for ${Math.floor(elapsed)}s`,
      );
    }
  } else {
    w.badSince = null;
  }
  w.lastCpu = cpuNorm;
}

function triggerHang(sessionId, reason) {
  const s = watch.get(sessionId);
  if (s) s.badSince = null;
  const sess = db.getSession(sessionId);
  if (!sess || sess.status === "hung") return;
  db.updateSessionStatus(sessionId, "hung", { ended_at: null });
  db.insertLog({ level: "warn", session_id: sessionId, message: `Hang: ${reason}` });
  const row = db.getSession(sessionId);
  const io = getIo();
  if (io) {
    const now = Math.floor(Date.now() / 1000);
    const st = row?.started_at || now;
    io.emit(S.sessionHung, {
      id: sessionId,
      name: row?.app_name || sessionId,
      status: "hung",
      cpuPercent: row?.cpu_percent,
      reason,
      uptimeSec: now - st,
    });
  }
  db.insertLog({
    level: "warn",
    session_id: sessionId,
    message: "session:hung emitted",
  });
  tryAutoMigrate(sessionId);
}

function tryAutoMigrate(sessionId) {
  const am =
    (ctx.getSetting && ctx.getSetting("auto_migrate") === "true") ||
    String(process.env.AUTO_MIGRATE || "").toLowerCase() === "true";
  if (!am) return;
  if (isLocked()) return;
  const target = ctx.getSetting
    ? ctx.getSetting("default_remote")
    : "machine-b";
  if (!target) return;
  const m = db.getMachine(target);
  if (!m || m.status === "offline") {
    db.insertLog({
      level: "info",
      session_id: sessionId,
      message: `auto_migrate: target ${target} not online, skip`,
    });
    return;
  }
  executeMigration(sessionId, target).catch((e) => {
    console.error("auto_migrate", e);
  });
}

/**
 * For dashboard-driven predictable demo: mark session as hung.
 */
export function markHungManually(sessionId) {
  const sess = db.getSession(sessionId);
  if (!sess) return;
  db.updateSessionStatus(sessionId, "hung", { ended_at: null });
  db.insertLog({
    level: "warn",
    session_id: sessionId,
    message: "Hang: manual",
  });
  const row = db.getSession(sessionId);
  const io = getIo();
  if (io && row) {
    const now = Math.floor(Date.now() / 1000);
    const st = row.started_at || now;
    io.emit(S.sessionHung, {
      id: sessionId,
      name: row.app_name || sessionId,
      status: "hung",
      cpuPercent: row.cpu_percent,
      reason: "manual",
      uptimeSec: now - st,
    });
  }
  tryAutoMigrate(sessionId);
}
