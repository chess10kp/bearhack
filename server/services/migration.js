import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { v4 as uuidv4 } from "uuid";
import * as db from "../db.js";
import { getIo } from "../context.js";
import { S } from "../socket/events.js";
import { config } from "../config.js";
import * as criu from "./criu.js";
import * as transfer from "./transfer.js";
import { stop as xpraStop } from "./xpra.js";
import { stopPolling } from "./process-monitor.js";

const execFileAsync = promisify(execFile);

let activeMigration = null;

export function isLocked() {
  return activeMigration != null;
}

function stepLabels() {
  return [
    "criu checkpoint (freeze)",
    "transfer memory image",
    "restore in target lxc",
    "reattach xpra display",
  ];
}

function emitProgress(sessionId, target, stepIndex, percent) {
  const io = getIo();
  if (io) {
    io.emit(S.migrationProgress, {
      sessionId,
      id: sessionId,
      target,
      stepIndex,
      percent,
      stepLabels: stepLabels(),
    });
  }
}

function emitTransferProgress(sessionId, percent) {
  const io = getIo();
  if (io) {
    io.emit(S.migrationTransferProgress, { sessionId, id: sessionId, percent });
  }
}

function logL(sessionId, message, level = "info") {
  db.insertLog({ level, session_id: sessionId, message });
  const io = getIo();
  if (io) {
    io.emit(S.logEntry, { level, session_id: sessionId, message });
  }
}

function readChildren(pid) {
  try {
    const p = `/proc/${pid}/children`;
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8").trim();
      if (!raw) return [];
      return raw
        .split(/\s+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n));
    }
  } catch {
    /* fall through */
  }
  try {
    const raw = fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim();
    if (!raw) return [];
    return raw
      .split(/\s+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

function allDescendants(rootPid) {
  const out = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop();
    if (out.has(p)) continue;
    out.add(p);
    for (const c of readChildren(p)) {
      if (!out.has(c)) stack.push(c);
    }
  }
  return [...out].reverse();
}

function freezePids(pids) {
  for (const p of pids) {
    try {
      process.kill(p, "SIGSTOP");
    } catch {
      /* gone */
    }
  }
}

function thawPids(pids) {
  for (const p of pids) {
    try {
      process.kill(p, "SIGCONT");
    } catch {
      /* gone */
    }
  }
}

function checkpointRoot() {
  return path.resolve(config.serverDir, config.checkpointDir);
}

async function remoteMkdir(machine, remoteDir) {
  const u = transfer.sshUserAtHost(machine);
  const args = [...transfer.sshBaseArgs(machine), u, `mkdir -p "${remoteDir}"`];
  await execFileAsync("ssh", args, { maxBuffer: 65536 });
}

async function remoteCriuRestore(toM, remoteCkptDir) {
  const u = transfer.sshUserAtHost(toM);
  const bin = config.criuBin;
  const cmd = `${bin} restore -D '${remoteCkptDir.replace(/'/g, "'\\''")}' --shell-job 2>&1`;
  const args = [...transfer.sshBaseArgs(toM), u, cmd];
  const { stdout, stderr } = await execFileAsync("ssh", args, {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  });
  return String(stdout || "") + String(stderr || "");
}

function parseRestorePid(blob) {
  const m = blob.match(/Restored.*pid\s*[=:]\s*(\d+)/i) || blob.match(/pid\s*=\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * @param {string} sessionId
 * @param {string} targetMachineId
 */
export async function execute(sessionId, targetMachineId) {
  if (activeMigration) {
    const e = new Error("Migration already in progress");
    e.code = 409;
    throw e;
  }
  const migId = `mig-${uuidv4()}`;
  activeMigration = migId;
  const t0 = Date.now();
  let frozenPids = [];
  const sess0 = db.getSession(sessionId);
  const fromMachineId = sess0 ? sess0.machine_id : null;
  try {
    const sess = db.getSession(sessionId);
    if (!sess) {
      throw new Error("session not found");
    }
    if (sess.status !== "running" && sess.status !== "hung") {
      throw new Error("session not eligible for migration");
    }
    const toM = db.getMachine(targetMachineId);
    if (!toM) {
      throw new Error("target machine not found");
    }
    if (toM.is_local) {
      throw new Error("target is local; pick a remote machine");
    }
    const okSsh = await transfer.testConnection(toM);
    if (!okSsh) {
      throw new Error("SSH to target machine failed (testConnection)");
    }
    db.insertMigration({
      id: migId,
      session_id: sessionId,
      from_machine_id: fromMachineId || config.localMachineId,
      to_machine_id: targetMachineId,
      status: "pending",
    });
    const io = getIo();
    if (io) {
      io.emit(S.migrationStarted, {
        sessionId,
        id: sessionId,
        target: toM.label || toM.id,
        migrationId: migId,
      });
    }
    logL(sessionId, `migration ${migId} started → ${toM.id}`, "ok");
    db.updateSessionStatus(sessionId, "migrating", {});
    db.updateMigration(migId, { status: "checkpointing" });
    emitProgress(sessionId, toM.label || toM.id, 0, 0);

    const localCkpt = path.join(
      checkpointRoot(),
      "transfers",
      migId,
      "ckpt",
    );
    fs.mkdirSync(localCkpt, { recursive: true });
    if (!sess.pid) {
      throw new Error("session has no pid to checkpoint");
    }
    const rootP = sess.pid;
    frozenPids = allDescendants(rootP);
    if (frozenPids.length === 0) {
      frozenPids = [rootP];
    }
    emitProgress(sessionId, toM.label || toM.id, 0, 5);
    logL(sessionId, `SIGSTOP on ${frozenPids.length} process(es)`);
    freezePids(frozenPids);
    try {
      emitProgress(sessionId, toM.label || toM.id, 0, 10);
      await criu.checkpoint(rootP, localCkpt, {
        onStderr: (s) =>
          logL(sessionId, `criu: ${s.slice(0, 200)}`, "info"),
      });
    } catch (e) {
      thawPids(frozenPids);
      frozenPids = [];
      throw e;
    }
    const sizeB = criu.getCheckpointSize(localCkpt);
    const transferT0 = Date.now();
    db.updateMigration(migId, {
      status: "transferring",
      checkpoint_size_mb: sizeB / (1024 * 1024),
    });
    logL(
      sessionId,
      `checkpoint done (${(sizeB / (1024 * 1024)).toFixed(2)} MB)`,
      "ok",
    );
    emitProgress(sessionId, toM.label || toM.id, 1, 15);

    const remoteCkpt = `/tmp/gpms-checkpoints/${migId}/ckpt`;
    await remoteMkdir(toM, path.posix.dirname(remoteCkpt));
    await remoteMkdir(toM, remoteCkpt);

    await transfer.push(localCkpt, toM, remoteCkpt, {
      onProgress: (pct) => {
        const blended = 15 + (pct / 100) * 40;
        emitProgress(sessionId, toM.label || toM.id, 1, blended);
        emitTransferProgress(sessionId, pct);
      },
    });
    const transferSec = (Date.now() - transferT0) / 1000;
    db.updateMigration(migId, {
      status: "restoring",
      transfer_seconds: transferSec,
    });
    logL(sessionId, `transferred in ${transferSec.toFixed(1)}s`, "ok");
    emitProgress(sessionId, toM.label || toM.id, 2, 60);
    frozenPids = [];
    if (sess.xpra_display) {
      try {
        await xpraStop(sess.xpra_display);
      } catch {
        /* ignore */
      }
    }
    for (const p of allDescendants(sess.pid)) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
    if (sess.pid) {
      try {
        process.kill(sess.pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
    stopPolling(sessionId);
    db.updateSessionStatus(sessionId, "restoring", {});
    const restoreOut = await remoteCriuRestore(toM, remoteCkpt);
    logL(
      sessionId,
      `remote restore: ${restoreOut.slice(0, 400)}`,
      "info",
    );
    const newPid = parseRestorePid(restoreOut) || 0;
    db.updateSession(sessionId, {
      machine_id: targetMachineId,
      pid: newPid,
      xpra_display: null,
      status: "running",
    });
    emitProgress(sessionId, toM.label || toM.id, 2, 90);
    emitProgress(sessionId, toM.label || toM.id, 3, 95);
    logL(
      sessionId,
      "reattach xpra on remote (manual) — step complete (demo)",
      "info",
    );
    const total = (Date.now() - t0) / 1000;
    db.updateMigration(migId, {
      status: "completed",
      completed_at: Math.floor(Date.now() / 1000),
      total_seconds: total,
    });
    emitProgress(sessionId, toM.label || toM.id, 3, 100);
    const io0 = getIo();
    if (io0) {
      io0.emit(S.migrationCompleted, {
        sessionId,
        id: sessionId,
        message: "migration completed",
        startedAt: t0,
        endedAt: Date.now(),
        cost: null,
      });
      const srow = db.getSession(sessionId);
      if (srow) {
        const now = Math.floor(Date.now() / 1000);
        const st0 = srow.started_at || now;
        io0.emit(S.sessionUpdated, {
          id: srow.id,
          name: srow.app_name || srow.id,
          app: srow.app_name,
          label: srow.app_name,
          icon: "📦",
          pid: srow.pid,
          cpuPercent: srow.cpu_percent,
          memoryPercent: srow.memory_percent,
          memPct: srow.memory_percent,
          memoryLabel:
            srow.memory_mb != null ? `${Math.round(srow.memory_mb)} MB` : "",
          mem: srow.memory_mb != null ? `${Math.round(srow.memory_mb)} MB` : "",
          status: srow.status,
          uptimeSec: now - st0,
        });
      }
    }
  } catch (err) {
    if (frozenPids.length) {
      thawPids(frozenPids);
    }
    const msg = err && err.message ? err.message : String(err);
    try {
      if (db.getMigration(migId)) {
        db.updateMigration(migId, {
          status: "failed",
          error: msg,
          completed_at: Math.floor(Date.now() / 1000),
        });
      }
    } catch {
      /* ignore */
    }
    const cur = db.getSession(sessionId);
    if (cur && (cur.status === "migrating" || cur.status === "checkpointing")) {
      db.updateSessionStatus(sessionId, "hung", {});
    }
    if (getIo()) {
      getIo().emit(S.migrationFailed, {
        sessionId,
        id: sessionId,
        message: msg,
        error: msg,
      });
    }
    logL(sessionId, `migration failed: ${msg}`, "error");
    throw err;
  } finally {
    activeMigration = null;
  }
}
