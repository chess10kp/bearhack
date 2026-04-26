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
import * as dcpTransport from "./dcp-transport.js";
import * as dcpPow from "./dcp-pow.js";
import * as worker from "./worker-client.js";
import * as xpra from "./xpra.js";
import { stopPolling } from "./process-monitor.js";
import { sessionToPayload } from "./sessions.js";
import { getSolanaConfig, isSettlementEnabled } from "../../solana/config.js";
import { computeLamports, lamportsToSolDisplay } from "../../solana/pricing.js";

const execFileAsync = promisify(execFile);

let activeMigration = null;

export function isLocked() {
  return activeMigration != null;
}

function stepLabels() {
  return [
    "criu checkpoint (freeze)",
    "transfer/orchestrate memory image",
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

function emitDcpSubmitted(sessionId, payload) {
  const io = getIo();
  if (io) {
    io.emit(S.migrationDcpSubmitted, {
      sessionId,
      id: sessionId,
      ...payload,
    });
  }
}

function emitDcpStatus(sessionId, payload) {
  const io = getIo();
  if (io) {
    io.emit(S.migrationDcpStatus, {
      sessionId,
      id: sessionId,
      ...payload,
    });
  }
}

function emitPowStatus(sessionId, payload) {
  const io = getIo();
  if (io) {
    io.emit(S.migrationPowStatus, {
      sessionId,
      id: sessionId,
      ...payload,
    });
  }
}

function logL(sessionId, message, level = "info") {
  db.insertLog({ level, session_id: sessionId, message });
  const io = getIo();
  if (io) {
    io.emit(S.logEntry, { level, session_id: sessionId, message });
  }
}

function resolveTransportKind(requested) {
  const v = String(requested || config.migrationTransport || "ssh").toLowerCase();
  return v === "dcp" ? "dcp" : "ssh";
}

async function transferCheckpoint({
  transportKind,
  migId,
  sessionId,
  targetMachineId,
  localCkpt,
  toM,
  remoteCkpt,
  onSshProgress,
}) {
  if (transportKind !== "dcp") {
    const sshRes = await transfer.push(localCkpt, toM, remoteCkpt, {
      onProgress: onSshProgress,
    });
    return {
      transportKind: "ssh",
      transferResult: sshRes,
      dcpMeta: null,
    };
  }

  emitDcpStatus(sessionId, { status: "submitting" });
  db.updateMigration(migId, { dcp_status: "submitting" });
  const dcpRes = await dcpTransport.submitCheckpointOrchestration({
    migrationId: migId,
    sessionId,
    targetMachineId,
    localCheckpointDir: localCkpt,
    onStatus: (st) => {
      const runStatus = st && st.runStatus ? String(st.runStatus) : "unknown";
      db.updateMigration(migId, { dcp_status: runStatus });
      emitDcpStatus(sessionId, {
        status: runStatus,
        total: st?.total ?? null,
        distributed: st?.distributed ?? null,
        computed: st?.computed ?? null,
        error: st?.error || null,
      });
    },
  });
  const dcpJobId = dcpRes?.dcp?.jobId || null;
  db.updateMigration(migId, {
    dcp_job_id: dcpJobId,
    dcp_scheduler_url: dcpRes?.dcp?.schedulerUrl || null,
    dcp_status: "completed",
    dcp_result_json: JSON.stringify(dcpRes?.dcp?.result || null),
  });
  emitDcpSubmitted(sessionId, {
    jobId: dcpJobId,
    schedulerUrl: dcpRes?.dcp?.schedulerUrl || null,
  });
  emitDcpStatus(sessionId, { status: "completed", jobId: dcpJobId });

  const sshRes = await transfer.push(localCkpt, toM, remoteCkpt, {
    onProgress: onSshProgress,
  });
  return {
    transportKind: "dcp",
    transferResult: sshRes,
    dcpMeta: dcpRes,
  };
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
    // /proc/${pid}/children may not exist on this kernel; try task path below
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
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    console.error(`[migration] readChildren for pid ${pid}:`, e);
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
      // ESRCH: process already exited
    }
  }
}

function thawPids(pids) {
  for (const p of pids) {
    try {
      process.kill(p, "SIGCONT");
    } catch {
      // ESRCH: process already exited
    }
  }
}

function checkpointRoot() {
  return path.resolve(config.serverDir, config.checkpointDir);
}

async function remoteMkdir(machine, remoteDir) {
  if (worker.hasWorker(machine)) {
    await worker.ensureCheckpointDir(machine, remoteDir);
    return;
  }
  const u = transfer.sshUserAtHost(machine);
  const args = [...transfer.sshBaseArgs(machine), u, `mkdir -p "${remoteDir}"`];
  await execFileAsync("ssh", args, { maxBuffer: 65536 });
}

async function remoteCriuRestore(toM, remoteCkptDir) {
  if (worker.hasWorker(toM)) {
    const out = await worker.criuRestore(toM, remoteCkptDir);
    return String(out.output || "");
  }
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
 * @param {object} machine
 * @param {number} pid
 * @param {string} [logSessionId] session id for log lines on check failure
 */
async function remotePidAlive(machine, pid, logSessionId) {
  if (!pid) return false;
  if (worker.hasWorker(machine)) {
    try {
      const out = await worker.processAlive(machine, pid);
      return out && out.alive === true;
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (logSessionId) {
        logL(
          logSessionId,
          `worker processAlive error (treat as not alive): ${msg}`,
          "warn",
        );
      } else {
        console.error("[migration] worker processAlive", e);
      }
      return false;
    }
  }
  const u = transfer.sshUserAtHost(machine);
  const args = [
    ...transfer.sshBaseArgs(machine),
    u,
    `test -d /proc/${pid} && echo ok`,
  ];
  try {
    const { stdout } = await execFileAsync("ssh", args, {
      maxBuffer: 4096,
      timeout: 10_000,
    });
    return String(stdout).trim() === "ok";
  } catch (e) {
    // Remote `test` failure → exit 1: process not in /proc (expected when dead)
    if (e && e.code === 1) return false;
    const msg = e && e.message ? e.message : String(e);
    if (logSessionId) {
      logL(
        logSessionId,
        `remote /proc check error (treat as not alive): ${msg}`,
        "warn",
      );
    } else {
      console.error("[migration] remotePidAlive ssh", e);
    }
    return false;
  }
}

/**
 * @param {object} machine
 * @param {number} pid
 */
async function remoteSigKillPid(machine, pid) {
  if (!pid) return;
  if (worker.hasWorker(machine)) {
    await worker.processKill(machine, pid).catch((e) => {
      console.error("[migration] worker processKill", e);
    });
    return;
  }
  const u = transfer.sshUserAtHost(machine);
  const args = [
    ...transfer.sshBaseArgs(machine),
    u,
    `kill -9 ${pid} 2>/dev/null; true`,
  ];
  await execFileAsync("ssh", args, { maxBuffer: 4096, timeout: 10_000 }).catch(
    (e) => {
      console.error("[migration] remote kill -9", e);
    },
  );
}

/**
 * @param {string} sessionId
 * @param {string} targetMachineId
 */
export async function execute(sessionId, targetMachineId, opts = {}) {
  if (activeMigration) {
    const e = new Error("Migration already in progress");
    e.code = 409;
    throw e;
  }
  const migId = `mig-${uuidv4()}`;
  activeMigration = migId;
  const t0 = Date.now();
  let frozenPids = [];
  let tunnelPid = null;
  let remoteAppPid = 0;
  let toM = null;
  const sess0 = db.getSession(sessionId);
  const fromMachineId = sess0 ? sess0.machine_id : null;
  try {
    const transportKind = resolveTransportKind(
      opts.transportKind || db.getSetting("migration_transport"),
    );
    const sess = db.getSession(sessionId);
    if (!sess) {
      throw new Error("session not found");
    }
    if (sess.status !== "running" && sess.status !== "hung") {
      throw new Error("session not eligible for migration");
    }
    toM = db.getMachine(targetMachineId);
    if (!toM) {
      throw new Error("target machine not found");
    }
    if (toM.is_local) {
      throw new Error("target is local; pick a remote machine");
    }
    if (worker.hasWorker(toM)) {
      await worker.health(toM);
      logL(sessionId, `worker daemon is reachable on ${toM.id}`, "ok");
    } else {
      const okSsh = await transfer.testConnection(toM);
      if (!okSsh) {
        throw new Error("SSH to target machine failed (testConnection)");
      }
    }
    db.insertMigration({
      id: migId,
      session_id: sessionId,
      from_machine_id: fromMachineId || config.localMachineId,
      to_machine_id: targetMachineId,
      status: "pending",
      transport_kind: transportKind,
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
    logL(
      sessionId,
      `migration ${migId} started → ${toM.id} (transport=${transportKind})`,
      "ok",
    );
    db.updateSessionStatus(sessionId, "migrating", {});
    db.updateMigration(migId, { status: "checkpointing" });
    emitProgress(sessionId, toM.label || toM.id, 0, 0);

    if (transportKind === "dcp") {
      logL(sessionId, `DCP PoW: challenging ${toM.id} to prove compute capacity`, "info");
      emitPowStatus(sessionId, { status: "challenging", targetMachineId: toM.id });
      db.updateMigration(migId, { pow_status: "challenging" });

      try {
        const powResult = await dcpPow.submitPowChallenge({
          migrationId: migId,
          targetMachineId: toM.id,
          difficulty: 16,
          requiredMs: 2000,
          onStatus: (st) => {
            emitPowStatus(sessionId, {
              status: st?.runStatus || "unknown",
              total: st?.total ?? null,
              distributed: st?.distributed ?? null,
              computed: st?.computed ?? null,
            });
          },
        });

        db.updateMigration(migId, {
          pow_status: powResult.passed ? "passed" : "failed",
          pow_hashes_per_sec: powResult.hashesPerSec,
          pow_elapsed_ms: powResult.elapsedMs,
        });
        emitPowStatus(sessionId, {
          status: powResult.passed ? "passed" : "failed",
          hashesPerSec: powResult.hashesPerSec,
          elapsedMs: powResult.elapsedMs,
          reason: powResult.reason,
        });

        if (!powResult.passed) {
          throw new Error(`PoW verification failed: ${powResult.reason}`);
        }
        logL(
          sessionId,
          `PoW passed: ${powResult.hashesPerSec} H/s in ${powResult.elapsedMs}ms — target node has compute`,
          "ok",
        );
      } catch (powErr) {
        const msg = powErr?.message || String(powErr);
        db.updateMigration(migId, { pow_status: "failed" });
        emitPowStatus(sessionId, { status: "failed", error: msg });
        if (config.dcpFallbackToSsh) {
          logL(sessionId, `PoW failed (${msg}), falling back to SSH transport`, "warn");
        } else {
          throw powErr;
        }
      }
    }

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
        leaveRunning: true,
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

    let transferResult;
    try {
      const tx = await transferCheckpoint({
        transportKind,
        migId,
        sessionId,
        targetMachineId,
        localCkpt,
        toM,
        remoteCkpt,
        onSshProgress: (pct) => {
          const blended = 15 + (pct / 100) * 40;
          emitProgress(sessionId, toM.label || toM.id, 1, blended);
          emitTransferProgress(sessionId, pct);
        },
      });
      transferResult = tx.transferResult;
      if (transportKind === "dcp") {
        logL(sessionId, `DCP orchestration complete (job=${tx?.dcpMeta?.dcp?.jobId || "n/a"})`, "ok");
      }
    } catch (e) {
      if (transportKind === "dcp" && config.dcpFallbackToSsh) {
        const msg = e && e.message ? e.message : String(e);
        db.updateMigration(migId, {
          dcp_status: "failed",
          dcp_error: msg,
        });
        emitDcpStatus(sessionId, { status: "failed", error: msg });
        logL(sessionId, `DCP failed; falling back to SSH transfer: ${msg}`, "warn");
        transferResult = await transfer.push(localCkpt, toM, remoteCkpt, {
          onProgress: (pct) => {
            const blended = 15 + (pct / 100) * 40;
            emitProgress(sessionId, toM.label || toM.id, 1, blended);
            emitTransferProgress(sessionId, pct);
          },
        });
      } else {
        throw e;
      }
    }
    const transferSec = (Date.now() - transferT0) / 1000;
    db.updateMigration(migId, {
      status: "restoring",
      transfer_seconds: transferSec,
    });
    if (transferResult.bytesTransferred > 0) {
      const mb = transferResult.bytesTransferred / (1024 * 1024);
      logL(
        sessionId,
        `transferred in ${transferSec.toFixed(1)}s (~${mb.toFixed(2)} MB)`,
        "ok",
      );
    } else {
      logL(sessionId, `transferred in ${transferSec.toFixed(1)}s`, "ok");
    }
    emitProgress(sessionId, toM.label || toM.id, 2, 55);
    if (sess.xpra_display) {
      try {
        await xpra.stop(sess.xpra_display);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        logL(sessionId, `xpra.stop before restore (continuing): ${msg}`, "warn");
      }
    }
    db.updateSessionStatus(sessionId, "restoring", {});
    const restoreOut = await remoteCriuRestore(toM, remoteCkpt);
    logL(
      sessionId,
      `remote restore: ${restoreOut.slice(0, 400)}`,
      "info",
    );
    remoteAppPid = parseRestorePid(restoreOut) || 0;
    if (!remoteAppPid) {
      throw new Error("remote CRIU restore did not report a valid pid");
    }
    if (sess.xpra_display) {
      try {
        await xpra.startRemote(toM, sess.xpra_display);
        logL(
          sessionId,
          `remote Xpra started for ${sess.xpra_display} (port ${xpra.xpraPortForDisplay(sess.xpra_display)})`,
          "ok",
        );
      } catch (e) {
        await remoteSigKillPid(toM, remoteAppPid);
        throw e;
      }
      const live = await xpra.waitRemoteDisplayLive(
        toM,
        sess.xpra_display,
        { timeoutMs: 5000 },
      );
      if (!live) {
        logL(
          sessionId,
          "remote Xpra display not LIVE within 5s (continuing anyway)",
          "warn",
        );
      }
      const port = xpra.xpraPortForDisplay(sess.xpra_display);
      const t = xpra.startTunnel(toM, {
        localPort: port,
        remotePort: port,
      });
      tunnelPid = t.pid;
      if (tunnelPid) {
        logL(
          sessionId,
          `SSH Xpra port forward ${port} (tunnel pid ${tunnelPid})`,
          "ok",
        );
      } else {
        logL(sessionId, "SSH Xpra port forward: no pid (spawn may have failed)", "warn");
      }
    }
    emitProgress(sessionId, toM.label || toM.id, 2, 80);
    const remoteAlive = await remotePidAlive(toM, remoteAppPid, sessionId);
    if (!remoteAlive) {
      if (tunnelPid) {
        try {
          process.kill(tunnelPid, "SIGKILL");
        } catch {
          // tunnel may already be dead
        }
        tunnelPid = null;
      }
      if (sess.xpra_display) {
        await xpra.stopRemote(toM, sess.xpra_display).catch((e) => {
          logL(
            sessionId,
            `xpra.stopRemote after failed /proc check: ${
              e && e.message ? e.message : String(e)
            }`,
            "warn",
          );
        });
      }
      await remoteSigKillPid(toM, remoteAppPid);
      throw new Error("restored process not found on target host (/proc check)");
    }
    stopPolling(sessionId);
    for (const p of allDescendants(rootP)) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
        // ESRCH
      }
    }
    try {
      process.kill(rootP, "SIGKILL");
    } catch {
      // ESRCH
    }
    frozenPids = [];
    const sessionFields = {
      machine_id: targetMachineId,
      pid: remoteAppPid,
      status: "running",
      xpra_tunnel_pid: tunnelPid,
    };
    if (sess.xpra_display) {
      sessionFields.xpra_display = sess.xpra_display;
    } else {
      sessionFields.xpra_display = null;
    }
    db.updateSession(sessionId, sessionFields);
    if (sess.xpra_display) {
      xpra.attachTunnel(toM, sess.xpra_display);
      logL(
        sessionId,
        `Xpra client attach: tcp/127.0.0.1:${xpra.xpraPortForDisplay(sess.xpra_display)}`,
        "ok",
      );
    } else {
      logL(
        sessionId,
        "session had no xpra display; skipped remote xpra, tunnel, and attach",
        "warn",
      );
    }
    emitProgress(sessionId, toM.label || toM.id, 2, 92);
    emitProgress(sessionId, toM.label || toM.id, 3, 96);
    logL(sessionId, "reattach xpra display: complete", "ok");
    const total = (Date.now() - t0) / 1000;
    const solCfg = getSolanaConfig();
    let paymentLamports = 0;
    let paymentStatus = "none";
    if (isSettlementEnabled(solCfg)) {
      paymentLamports = computeLamports(total, solCfg, (k) => db.getSetting(k));
      if (paymentLamports > 0) {
        paymentStatus = "pending";
      }
    }
    db.updateMigration(migId, {
      status: "completed",
      completed_at: Math.floor(Date.now() / 1000),
      total_seconds: total,
      payment_lamports: paymentLamports > 0 ? paymentLamports : null,
      payment_status: paymentStatus,
    });
    emitProgress(sessionId, toM.label || toM.id, 3, 100);
    const io0 = getIo();
    const costSol =
      paymentLamports > 0 ? lamportsToSolDisplay(paymentLamports) : null;
    if (io0) {
      io0.emit(S.migrationCompleted, {
        sessionId,
        id: sessionId,
        message: "migration completed",
        startedAt: t0,
        endedAt: Date.now(),
        cost: costSol,
        costLamports: paymentLamports > 0 ? paymentLamports : null,
        migrationId: migId,
        solanaSignature: null,
        solanaExplorerTx: null,
        paymentPending: paymentStatus === "pending",
        cluster: solCfg.cluster,
      });
      if (paymentStatus === "pending" && paymentLamports > 0) {
        const payPayload = {
          migrationId: migId,
          sessionId,
          lamports: paymentLamports,
          treasury: solCfg.treasury,
          rpcUrl: solCfg.rpcUrl,
          cluster: solCfg.cluster,
        };
        io0.emit(S.solanaPaymentRequest, payPayload);
        io0.of("/client").emit(S.solanaPaymentRequest, payPayload);
      }
      const srow = db.getSession(sessionId);
      if (srow) {
        io0.emit(S.sessionUpdated, sessionToPayload(srow));
      }
    }
  } catch (err) {
    if (tunnelPid) {
      try {
        process.kill(tunnelPid, "SIGKILL");
      } catch {
        // tunnel may already be dead
      }
    }
    if (remoteAppPid > 0 && toM) {
      await remoteSigKillPid(toM, remoteAppPid);
    }
    if (toM && sess0 && sess0.xpra_display) {
      try {
        await xpra.stopRemote(toM, sess0.xpra_display);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        logL(sessionId, `xpra.stopRemote in migration cleanup: ${msg}`, "warn");
      }
    }
    if (frozenPids.length) {
      thawPids(frozenPids);
      frozenPids = [];
      if (db.getSession(sessionId)) {
        db.updateSessionStatus(sessionId, "running", {});
      }
    } else {
      const cur = db.getSession(sessionId);
      if (
        cur &&
        (cur.status === "migrating" ||
          cur.status === "checkpointing" ||
          cur.status === "restoring")
      ) {
        db.updateSessionStatus(sessionId, "hung", {});
      }
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
    } catch (e) {
      const imsg = e && e.message ? e.message : String(e);
      logL(
        sessionId,
        `failed to persist migration failure status: ${imsg}`,
        "error",
      );
      console.error("[migration] updateMigration on failure", e);
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
