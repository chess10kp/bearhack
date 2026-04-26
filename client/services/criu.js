import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

/**
 * @typedef {Object} CriuOpts
 * @property {boolean} [leaveRunning]
 * @property {string} [logFile]
 * @property {number} [timeout] ms
 */

/**
 * @param {string} errMsg
 * @param {string} logPath
 */
function errWithLog(errMsg, logPath) {
  let extra = "";
  try {
    if (logPath && fs.existsSync(logPath)) {
      extra = fs.readFileSync(logPath, "utf8").slice(0, 8000);
    }
  } catch {
    /* */
  }
  const e = new Error(extra ? `${errMsg}\n--- log ---\n${extra}` : errMsg);
  return e;
}

/**
 * @typedef {CriuOpts & { sessionId?: string, onProgress?: (p: { sessionId?: string, phase: string, percent?: number }) => void }} CriuCheckpointOpts
 */

/**
 * @param {number} pid
 * @param {string} checkpointDir
 * @param {CriuCheckpointOpts} [opts]
 * @returns {Promise<{ success: true, dir: string, sizeBytes: number, durationMs: number }>}
 */
export async function checkpoint(pid, checkpointDir, opts = {}) {
  const timeout = opts.timeout ?? 120_000;
  const bin = config.CRIU_BIN;
  const outDir = path.resolve(checkpointDir);
  fs.mkdirSync(outDir, { recursive: true });
  const logFile = opts.logFile || path.join(outDir, "dump.log");
  const args = [
    "dump",
    "-t",
    String(pid),
    "-D",
    outDir,
    "--shell-job",
    "--log-file",
    logFile,
  ];
  if (opts.leaveRunning) {
    args.push("--leave-running");
  }
  const t0 = Date.now();
  opts.onProgress?.({
    sessionId: opts.sessionId,
    phase: "dumping",
    percent: 0,
  });
  try {
    await new Promise((resolve, reject) => {
      const child = execFile(
        bin,
        args,
        { timeout, maxBuffer: 16 * 1024 * 1024 },
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
      if (child.stderr) {
        child.stderr.on("data", (b) => {
          if (b.toString().length && opts.onProgress) {
            opts.onProgress({
              sessionId: opts.sessionId,
              phase: "dumping",
            });
          }
        });
      }
    });
  } catch (e) {
    throw errWithLog(
      (e && e.message) || String(e),
      logFile,
    );
  }
  const durationMs = Date.now() - t0;
  const sizeBytes = getCheckpointSize(outDir);
  return { success: true, dir: outDir, sizeBytes, durationMs };
}

/**
 * @param {CriuOpts} [opts]
 * @returns {Promise<{ success: true, pid: number, durationMs: number }>}
 */
export async function restore(checkpointDir, opts = {}) {
  const timeout = opts.timeout ?? 120_000;
  const bin = config.CRIU_BIN;
  const outDir = path.resolve(checkpointDir);
  if (!fs.existsSync(outDir)) {
    throw new Error(`restore dir not found: ${outDir}`);
  }
  const logFile = path.join(outDir, "restore.log");
  const args = [
    "restore",
    "-D",
    outDir,
    "--shell-job",
    "--log-file",
    logFile,
  ];
  const t0 = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    const m =
      (stdout + stderr).match(/Restored \w+ with pid\s+(\d+)/) ||
      (stdout + stderr).match(/pid:\s*(\d+)/i);
    const newPid = m ? parseInt(m[1], 10) : 0;
    if (!newPid) {
      throw errWithLog(
        "Could not parse new PID from CRIU restore output",
        logFile,
      );
    }
    return { success: true, pid: newPid, durationMs: Date.now() - t0 };
  } catch (e) {
    throw errWithLog((e && e.message) || String(e), logFile);
  }
}

/**
 * @returns {Promise<{ installed: boolean, version: string, kernelSupport: boolean, canCheckpoint: boolean }>}
 */
export async function check() {
  const bin = config.CRIU_BIN;
  let version = "";
  let installed = false;
  try {
    const o = await execFileAsync(bin, ["--version"], { timeout: 10000 });
    version = (o.stdout + o.stderr).split("\n")[0].trim();
    installed = true;
  } catch {
    return {
      installed: false,
      version: "",
      kernelSupport: false,
      canCheckpoint: false,
    };
  }
  let kernelSupport = false;
  const paths = [
    "/proc/config.gz",
    path.join("/boot", `config-${kernelRelease()}`),
  ];
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    try {
      if (p.endsWith(".gz")) {
        const z = execFileSync("zcat", [p], {
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
        });
        kernelSupport = /CONFIG_CHECKPOINT_RESTORE=y/.test(z);
      } else {
        const c = fs.readFileSync(p, "utf8");
        kernelSupport = /CONFIG_CHECKPOINT_RESTORE=y/.test(c);
      }
      if (kernelSupport) break;
    } catch {
      /* zcat may fail on non-gz */
    }
  }
  return {
    installed,
    version,
    kernelSupport,
    canCheckpoint: installed && kernelSupport,
  };
}

function kernelRelease() {
  try {
    return fs.readFileSync("/proc/sys/kernel/osrelease", "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * @param {string} dir
 */
export function getCheckpointSize(dir) {
  try {
    const out = execFileSync("du", ["-sb", dir], { encoding: "utf8" });
    const b = parseInt(String(out).trim().split(/\s+/)[0], 10);
    return Number.isFinite(b) ? b : 0;
  } catch {
    return 0;
  }
}
