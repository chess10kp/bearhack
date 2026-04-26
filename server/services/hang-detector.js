import { ctx, getIo } from "../context.js";
import * as db from "../db.js";
import { S } from "../socket/events.js";
import { execute as executeMigration, isLocked } from "./migration.js";
import { classify } from "./gemma.js";

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
  const badState = procState === "D";
  const lowCpu = cpuNorm < 0.01;
  if (lowCpu && badState) {
    if (w.badSince == null) w.badSince = Date.now();
    const elapsed = (Date.now() - w.badSince) / 1000;
    if (elapsed >= thr) {
      triggerHang(
        sessionId,
        `cpu ~0% and state ${procState} for ${Math.floor(elapsed)}s`,
        data,
      );
    }
  } else {
    w.badSince = null;
  }
  w.lastCpu = cpuNorm;
}

function buildMetrics(sessionId, hangReason, monitorData) {
  const sess = db.getSession(sessionId);
  if (!sess) return {};
  const nowSec = Math.floor(Date.now() / 1000);
  const st = sess.started_at || nowSec;
  const machine = db.getMachine(sess.machine_id);
  let machineSpecs = "unknown";
  if (machine) {
    const parts = [];
    if (machine.cpu_cores) parts.push(`${machine.cpu_cores} cores`);
    if (machine.ram_gb) parts.push(`${machine.ram_gb} GB RAM`);
    if (machine.gpu) parts.push(machine.gpu);
    machineSpecs = parts.join(", ") || "unknown";
  }
  return {
    appName: sess.app_name || sess.command,
    command: sess.command,
    procState: monitorData?.procState || "unknown",
    cpuNorm: monitorData?.cpuNorm ?? sess.cpu_percent ?? 0,
    memMb: monitorData?.memMb ?? sess.memory_mb ?? 0,
    uptimeSec: nowSec - st,
    hangReason,
    machineSpecs,
  };
}

function emitGemmaStatus(sessionId, status, extra = {}) {
  const io = getIo();
  if (io) {
    io.emit(S.gemmaStatus, { sessionId, status, ...extra });
  }
}

function emitGemmaDecision(sessionId, decision) {
  const io = getIo();
  if (io) {
    io.emit(S.gemmaDecision, { sessionId, ...decision });
  }
  db.insertLog({
    level: "info",
    session_id: sessionId,
    message: `Gemma decision: ${decision.decision} · ${decision.reason} · target=${decision.target_spec || "n/a"} · priority=${decision.priority} · source=${decision.source}`,
  });
}

function triggerHang(sessionId, reason, monitorData) {
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
  tryAutoMigrate(sessionId, reason, monitorData);
}

async function tryAutoMigrate(sessionId, hangReason, monitorData) {
  const am =
    (ctx.getSetting && ctx.getSetting("auto_migrate") === "true") ||
    String(process.env.AUTO_MIGRATE || "").toLowerCase() === "true";
  if (!am) return;
  if (isLocked()) return;

  emitGemmaStatus(sessionId, "classifying");
  const metrics = buildMetrics(sessionId, hangReason, monitorData);
  let decision;
  try {
    decision = await classify(metrics, { getSetting: ctx.getSetting });
  } catch {
    decision = { decision: "MIGRATE", reason: "Classification error — defaulting to migrate", target_spec: "highcpu", priority: 7, source: "fallback" };
  }
  emitGemmaDecision(sessionId, decision);

  if (decision.decision !== "MIGRATE") {
    db.insertLog({
      level: "info",
      session_id: sessionId,
      message: `Gemma decided NOT to migrate: ${decision.reason}`,
    });
    return;
  }

  const target = pickTarget(decision.target_spec);
  if (!target) {
    db.insertLog({
      level: "info",
      session_id: sessionId,
      message: `auto_migrate: no suitable target for spec=${decision.target_spec}, skip`,
    });
    return;
  }
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

function pickTarget(targetSpec) {
  const defaultTarget = ctx.getSetting ? ctx.getSetting("default_remote") : "machine-b";
  if (defaultTarget) return defaultTarget;
  const machines = db.listMachines();
  const online = machines.filter((m) => !m.is_local && m.status !== "offline");
  if (online.length === 0) return null;
  if (targetSpec === "gpu") {
    const gpu = online.find((m) => m.gpu);
    if (gpu) return gpu.id;
  }
  if (targetSpec === "tallram") {
    online.sort((a, b) => (b.ram_gb || 0) - (a.ram_gb || 0));
    if (online[0]) return online[0].id;
  }
  if (targetSpec === "highcpu") {
    online.sort((a, b) => (b.cpu_cores || 0) - (a.cpu_cores || 0));
    if (online[0]) return online[0].id;
  }
  return online[0].id;
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
  tryAutoMigrate(sessionId, "manual", null);
}
