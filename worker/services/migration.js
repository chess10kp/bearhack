import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

/**
 * @param {string} dir
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Set up parent symlink chain so CRIU restore knows the snapshot lineage.
 *
 *   <root>/0  (oldest pre-dump)
 *   <root>/1 -> parent -> ../0
 *   <root>/2 -> parent -> ../1
 *   <root>/N -> parent -> ../N-1   (final dump)
 *
 * @param {string} root
 * @param {number} snapshotIndex
 */
function ensureParentLink(root, snapshotIndex) {
  if (snapshotIndex <= 0) return;
  const cur = path.join(root, String(snapshotIndex));
  ensureDir(cur);
  const link = path.join(cur, "parent");
  try {
    fs.unlinkSync(link);
  } catch {
    /* */
  }
  fs.symlinkSync(`../${snapshotIndex - 1}`, link);
}

/**
 * Prepare a snapshot directory for an upcoming pre-dump or final dump.
 *
 * @param {{ migrationId: string, snapshotIndex: number, root: string }} opts
 */
export function prepareSnapshot({ migrationId, snapshotIndex, root }) {
  if (!migrationId) throw new Error("migrationId required");
  if (!Number.isFinite(snapshotIndex) || snapshotIndex < 0) {
    throw new Error("snapshotIndex must be >= 0");
  }
  const r = path.resolve(root);
  ensureDir(r);
  const snap = ensureDir(path.join(r, String(snapshotIndex)));
  ensureParentLink(r, snapshotIndex);
  return { ok: true, dir: snap, root: r };
}

/**
 * Run criu restore from the final snapshot dir.
 *
 * @param {{ root: string, snapshotIndex: number, shellJob?: boolean, extraArgs?: string[] }} opts
 */
export async function restoreFromSnapshot(opts) {
  const r = path.resolve(opts.root);
  const snap = path.join(r, String(opts.snapshotIndex));
  if (!fs.existsSync(snap)) {
    throw new Error(`snapshot dir not found: ${snap}`);
  }
  const logFile = path.join(snap, "restore.log");
  const args = ["restore", "-D", snap, "--log-file", "restore.log", "-v4"];
  if (opts.shellJob !== false) args.push("--shell-job");
  if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs);

  // detached so the restored process can outlive this HTTP request
  const child = spawn(config.criuBin, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Poll for restore.log completion ("Restored ... pid")
  const started = Date.now();
  const timeoutMs = 120_000;
  let restoredPid = 0;
  let lastLog = "";
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      lastLog = fs.readFileSync(logFile, "utf8");
    } catch {
      continue;
    }
    const m =
      lastLog.match(/Restored\s+\w+\s+with pid\s+(\d+)/) ||
      lastLog.match(/Forking task with (\d+) pid/);
    if (m) {
      restoredPid = parseInt(m[1], 10);
      break;
    }
    if (/Error|error \(criu\/|FATAL/.test(lastLog)) {
      throw new Error(
        `criu restore failed:\n${lastLog.slice(-2000)}`,
      );
    }
  }
  if (!restoredPid) {
    throw new Error(
      `criu restore timed out:\n${lastLog.slice(-2000)}`,
    );
  }
  return { ok: true, pid: restoredPid, dir: snap, logFile };
}

/**
 * Fallback path: extract a tarball of a complete dump dir (rsync alternative).
 *
 * @param {{ tarPath: string, destDir: string }} opts
 */
export async function extractDumpTar({ tarPath, destDir }) {
  const dest = ensureDir(path.resolve(destDir));
  await execFileAsync("tar", ["-xf", tarPath, "-C", dest], {
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { ok: true, dir: dest };
}
