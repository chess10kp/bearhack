import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);
const defaultTimeout = 120_000;

/**
 * @param {number} pid
 * @param {string} checkpointDir
 * @param {{ timeout?: number, leaveRunning?: boolean, onStderr?: (s: string) => void, criuBin?: string }} [opts]
 */
export function checkpoint(pid, checkpointDir, opts = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(checkpointDir, { recursive: true });
    const bin = opts.criuBin || config.criuBin;
    const args = [
      "dump",
      "-t",
      String(pid),
      "-D",
      checkpointDir,
      "--shell-job",
    ];
    if (opts.leaveRunning !== false) {
      args.push("--leave-running");
    }
    execFile(
      bin,
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: opts.timeout ?? defaultTimeout },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `criu dump: ${(stderr && String(stderr)) || err.message}`,
            ),
          );
          return;
        }
        if (opts.onStderr && stderr) opts.onStderr(String(stderr));
        const size = getCheckpointSize(checkpointDir);
        resolve({ success: true, outputPath: checkpointDir, sizeBytes: size });
      },
    );
  });
}

export function restore(checkpointDir, opts = {}) {
  return new Promise((resolve, reject) => {
    const bin = opts.criuBin || config.criuBin;
    const args = ["restore", "-D", checkpointDir, "--shell-job"];
    execFile(
      bin,
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: opts.timeout ?? defaultTimeout },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `criu restore: ${(stderr && String(stderr)) || err.message}`,
            ),
          );
          return;
        }
        if (opts.onStderr && stderr) opts.onStderr(String(stderr));
        const blob = (stderr + stdout).toString();
        const pidM = blob.match(/Restored .*(?:pid|PID)[:=]\s*(\d+)/i);
        const pidM2 = blob.match(/pid\s*=\s*(\d+)/i);
        const p =
          pidM || pidM2
            ? parseInt((pidM || pidM2)[1], 10)
            : 0;
        resolve({ success: true, pid: p || 0 });
      },
    );
  });
}

export async function check(criuBin) {
  const bin = criuBin || config.criuBin;
  let version = "unknown";
  let installed = false;
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], { maxBuffer: 65536 });
    installed = true;
    version = String(stdout).split("\n")[0].trim();
  } catch {
    /* none */
  }
  let supported = false;
  try {
    if (fs.existsSync("/proc/config.gz")) {
      const { execFileSync } = await import("node:child_process");
      try {
        const o = execFileSync("zgrep", ["CHECKPOINT", "/proc/config.gz"], {
          encoding: "utf8",
        });
        supported = /y|1/i.test(o);
      } catch {
        /* none */
      }
    }
  } catch {
    /* none */
  }
  return { installed, version, supported };
}

function walkSize(dir) {
  let total = 0;
  function w(d) {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p, { throwIfNoEntry: false });
      if (st) {
        if (st.isDirectory()) w(p);
        else total += st.size;
      }
    }
  }
  w(dir);
  return total;
}

export function getCheckpointSize(checkpointDir) {
  if (!fs.existsSync(checkpointDir)) return 0;
  try {
    const o = execFileSync("du", ["-sb", checkpointDir], { encoding: "utf8" });
    const n = parseInt(String(o).trim().split(/\s/)[0], 10);
    return Number.isFinite(n) ? n : walkSize(checkpointDir);
  } catch {
    return walkSize(checkpointDir);
  }
}
