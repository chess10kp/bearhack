import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

/**
 * @typedef {Object} MigrationTarget
 * @property {string} workerUrl   e.g. http://machine-b:3400
 * @property {string} pageHost    page-server hostname/IP reachable from Machine A
 * @property {number} pagePort    page-server TCP port
 * @property {string} [token]     Bearer token for worker API
 */

/**
 * @typedef {Object} PreCopyOpts
 * @property {number} pid
 * @property {string} migrationId
 * @property {MigrationTarget} target
 * @property {string} [localRoot]      defaults to <CHECKPOINT_DIR>/migrations/<id>
 * @property {number} [iterations]     pre-dump iteration count (default 2)
 * @property {(e: { phase: string, snapshot?: number, [k: string]: any }) => void} [onProgress]
 * @property {string[]} [extraDumpArgs]
 */

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function workerCall(target, pathName, body, method = "POST") {
  const url = `${target.workerUrl}${pathName}`;
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders(target.token) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`worker ${method} ${pathName} -> ${r.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Upload one local file to the worker into snapshot dir.
 */
async function uploadFile(target, migrationId, snapshotIndex, localPath, remoteName) {
  const buf = fs.readFileSync(localPath);
  const url =
    `${target.workerUrl}/api/worker/migration/file` +
    `?migrationId=${encodeURIComponent(migrationId)}` +
    `&snapshotIndex=${snapshotIndex}` +
    `&name=${encodeURIComponent(remoteName)}`;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(buf.length),
      ...authHeaders(target.token),
    },
    body: buf,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`upload ${remoteName} -> ${r.status}: ${t}`);
  }
  return buf.length;
}

/**
 * Sync metadata images (everything except pages-*.img — those went via page-server).
 */
async function syncMetadata(target, migrationId, snapshotIndex, localDir) {
  const files = fs
    .readdirSync(localDir)
    .filter((f) => {
      // skip the pages we already streamed via page-server
      if (/^pages-\d+\.img$/.test(f)) return false;
      // skip our own logs / parent symlink (worker manages those)
      if (f === "parent" || f === "dump.log" || f === "page-server.log") return false;
      const st = fs.statSync(path.join(localDir, f));
      return st.isFile();
    });
  let total = 0;
  for (const f of files) {
    total += await uploadFile(
      target,
      migrationId,
      snapshotIndex,
      path.join(localDir, f),
      f,
    );
  }
  return { files: files.length, bytes: total };
}

/**
 * Run criu pre-dump (or final dump) streaming pages to the remote page-server.
 *
 * @param {{
 *   pid: number,
 *   localDir: string,
 *   prevDir?: string,
 *   pageHost: string,
 *   pagePort: number,
 *   final?: boolean,
 *   leaveStopped?: boolean,
 *   extraArgs?: string[],
 * }} opts
 */
async function runDumpToPageServer(opts) {
  fs.mkdirSync(opts.localDir, { recursive: true });
  const logFile = path.join(opts.localDir, opts.final ? "dump.log" : "predump.log");
  const args = [
    opts.final ? "dump" : "pre-dump",
    "-t",
    String(opts.pid),
    "-D",
    opts.localDir,
    "--page-server",
    "--address",
    opts.pageHost,
    "--port",
    String(opts.pagePort),
    "--shell-job",
    "--log-file",
    path.basename(logFile),
    "-v4",
  ];
  if (!opts.final) args.push("--track-mem");
  if (opts.prevDir) {
    args.push("--prev-images-dir", path.relative(opts.localDir, opts.prevDir));
  }
  if (opts.final && opts.leaveStopped) {
    // safer for restore on remote side; default is to kill task on dump
    args.push("--leave-stopped");
  }
  if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs);

  const t0 = Date.now();
  try {
    await execFileAsync(config.CRIU_BIN, args, {
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    let extra = "";
    try {
      extra = fs.readFileSync(logFile, "utf8").slice(-4000);
    } catch {
      /* */
    }
    throw new Error(
      `${args[0]} failed: ${err.message || err}\n--- log ---\n${extra}`,
    );
  }
  return { durationMs: Date.now() - t0, dir: opts.localDir, logFile };
}

/**
 * Drive a full pre-copy migration:
 *   N-1 pre-dump rounds streaming dirty pages to the remote page-server
 *   1 final dump streaming the delta
 *   metadata upload after each round
 *   restore on the remote
 *
 * @param {PreCopyOpts} opts
 */
export async function preCopyMigrate(opts) {
  const {
    pid,
    migrationId,
    target,
    iterations = 2,
    onProgress = () => {},
  } = opts;
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error("pid required");
  }
  if (!migrationId) throw new Error("migrationId required");
  if (!target?.workerUrl) throw new Error("target.workerUrl required");

  const localRoot =
    opts.localRoot ||
    path.join(config.CHECKPOINT_DIR, "migrations", migrationId);
  fs.mkdirSync(localRoot, { recursive: true });

  const totalSnapshots = Math.max(1, iterations);
  /** @type {Array<{ snapshot: number, durationMs: number, metadata: any, final: boolean }>} */
  const stats = [];

  let prevDir = "";

  for (let i = 0; i < totalSnapshots; i++) {
    const final = i === totalSnapshots - 1;
    const snapDir = path.join(localRoot, String(i));
    fs.mkdirSync(snapDir, { recursive: true });

    onProgress({
      phase: "prepare-remote",
      snapshot: i,
      final,
    });
    await workerCall(target, "/api/worker/migration/prepare", {
      migrationId,
      snapshotIndex: i,
    });

    onProgress({ phase: "page-server-start", snapshot: i, final });
    await workerCall(target, "/api/worker/migration/page-server/start", {
      migrationId,
      snapshotIndex: i,
      port: target.pagePort,
    });

    onProgress({
      phase: final ? "dump" : "pre-dump",
      snapshot: i,
      final,
    });
    let dumpRes;
    try {
      dumpRes = await runDumpToPageServer({
        pid,
        localDir: snapDir,
        prevDir: prevDir || undefined,
        pageHost: target.pageHost,
        pagePort: target.pagePort,
        final,
        leaveStopped: false,
        extraArgs: opts.extraDumpArgs,
      });
    } catch (e) {
      try {
        await workerCall(target, "/api/worker/migration/page-server/stop", {
          port: target.pagePort,
        });
      } catch {
        /* */
      }
      throw e;
    }

    // page-server exits naturally once dump connection closes
    onProgress({ phase: "page-server-wait", snapshot: i, final });
    await workerCall(target, "/api/worker/migration/page-server/wait", {
      port: target.pagePort,
      timeoutMs: 60_000,
    }).catch(() => {
      /* may have already exited */
    });

    onProgress({ phase: "metadata-sync", snapshot: i, final });
    const meta = await syncMetadata(target, migrationId, i, snapDir);

    stats.push({
      snapshot: i,
      durationMs: dumpRes.durationMs,
      metadata: meta,
      final,
    });
    onProgress({
      phase: "snapshot-done",
      snapshot: i,
      final,
      durationMs: dumpRes.durationMs,
      metadata: meta,
    });

    prevDir = snapDir;
  }

  onProgress({ phase: "restore", snapshot: totalSnapshots - 1 });
  const restore = await workerCall(target, "/api/worker/migration/restore", {
    migrationId,
    snapshotIndex: totalSnapshots - 1,
  });

  onProgress({
    phase: "complete",
    snapshot: totalSnapshots - 1,
    restoredPid: restore.pid,
  });

  return {
    ok: true,
    migrationId,
    iterations: totalSnapshots,
    snapshots: stats,
    restore,
    localRoot,
  };
}

/**
 * Fallback path: full local dump, tar, upload, restore on remote.
 *
 * @param {{
 *   pid: number,
 *   migrationId: string,
 *   target: MigrationTarget,
 *   localRoot?: string,
 *   onProgress?: (e: any) => void,
 * }} opts
 */
export async function fallbackTarMigrate(opts) {
  const { pid, migrationId, target, onProgress = () => {} } = opts;
  const localRoot =
    opts.localRoot ||
    path.join(config.CHECKPOINT_DIR, "migrations", migrationId);
  const snapDir = path.join(localRoot, "0");
  fs.mkdirSync(snapDir, { recursive: true });

  onProgress({ phase: "dump-local", snapshot: 0 });
  await execFileAsync(
    config.CRIU_BIN,
    [
      "dump",
      "-t",
      String(pid),
      "-D",
      snapDir,
      "--shell-job",
      "--log-file",
      "dump.log",
    ],
    { timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
  );

  onProgress({ phase: "tar", snapshot: 0 });
  const tarPath = path.join(snapDir, "dump.tar");
  await execFileAsync("tar", ["-cf", tarPath, "-C", snapDir, "."], {
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
  });

  onProgress({ phase: "prepare-remote", snapshot: 0 });
  await workerCall(target, "/api/worker/migration/prepare", {
    migrationId,
    snapshotIndex: 0,
  });

  onProgress({ phase: "upload-tar", snapshot: 0 });
  await uploadFile(target, migrationId, 0, tarPath, "dump.tar");

  onProgress({ phase: "extract-remote", snapshot: 0 });
  await workerCall(target, "/api/worker/migration/extract", {
    migrationId,
    snapshotIndex: 0,
    tarName: "dump.tar",
  });

  onProgress({ phase: "restore", snapshot: 0 });
  const restore = await workerCall(target, "/api/worker/migration/restore", {
    migrationId,
    snapshotIndex: 0,
  });

  onProgress({ phase: "complete", restoredPid: restore.pid });
  return { ok: true, migrationId, restore, fallback: true };
}
