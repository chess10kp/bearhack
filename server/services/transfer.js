import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

export function sshBaseArgs(machine) {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
  ];
  if (machine.ssh_key_path) {
    args.push("-i", machine.ssh_key_path);
  }
  return args;
}

export function sshTarget(machine) {
  return sshUserAtHost(machine);
}

/** @param {{ ip?: string, hostname?: string, ssh_user?: string }} m */
export function sshUserAtHost(m) {
  const host = m.ip || m.hostname;
  if (!host) throw new Error("machine has no ip or hostname");
  const user = m.ssh_user || "root";
  return `${user}@${host}`;
}

/**
 * @param {string} checkpointDir local directory (no trailing slash required)
 * @param {object} remoteMachine row from machines
 * @param {string} remotePath absolute path on remote
 * @param {{ onProgress?: (pct: number, line: string) => void }} [opts]
 */
export function push(checkpointDir, remoteMachine, remotePath, opts = {}) {
  const local = path.resolve(checkpointDir);
  if (!fs.existsSync(local)) {
    return Promise.reject(new Error(`local checkpoint missing: ${local}`));
  }
  const target = `${sshTarget(remoteMachine)}:${remotePath.endsWith("/") ? remotePath : remotePath + "/"}`;
  const src = local.endsWith("/") ? local : local + "/";
  const sshLine = ["ssh", ...sshBaseArgs(remoteMachine)].join(" ");
  const args = ["-az", "--info=progress2", "-e", sshLine, src, target];
  return runRsync(args, opts);
}

export function pull(remoteMachine, remotePath, localDir, opts = {}) {
  const loc = path.resolve(localDir);
  fs.mkdirSync(loc, { recursive: true });
  const src = `${sshTarget(remoteMachine)}:${remotePath.endsWith("/") ? remotePath : remotePath + "/"}`;
  const sshLine = ["ssh", ...sshBaseArgs(remoteMachine)].join(" ");
  const args = [
    "-az",
    "--info=progress2",
    "-e",
    sshLine,
    src,
    loc.endsWith("/") ? loc : loc + "/",
  ];
  return runRsync(args, opts);
}

/** rsync 3.1+ --info=progress2: "  2,097,152  100%  328.12MB/s  0:00:00  (xfr#...)" */
function parseRsyncProgress2Line(line) {
  const m = line.match(/^\s*([\d,]+)\s+(\d+(?:\.\d+)?)%/);
  if (m) {
    const bytes = parseInt(m[1].replace(/,/g, ""), 10);
    const pct = Math.min(100, Math.max(0, parseFloat(m[2])));
    if (Number.isFinite(bytes) && Number.isFinite(pct)) {
      return { bytes, percent: pct };
    }
  }
  return { bytes: null, percent: null };
}

function parseRsyncPercentLegacy(line) {
  const m = line.match(
    /^\s*(\d+(?:\.\d+)?)%\s*or\s*(\S+)\/(\S+)/i,
  ) || line.match(/(\d+(?:\.\d+)?)%/);
  if (m) {
    return Math.min(100, Math.max(0, parseFloat(m[1])));
  }
  const m2 = line.match(
    /(\d{1,3})%\s*(\S+)\s*(\S+)?/,
  );
  if (m2) return Math.min(100, Math.max(0, parseFloat(m2[1])));
  return null;
}

function parseRsyncLine(line) {
  const o = parseRsyncProgress2Line(line);
  const percent =
    o.percent != null ? o.percent : parseRsyncPercentLegacy(line);
  return { bytes: o.bytes, percent };
}

function maxBytesFromRsyncOutput(buf) {
  let max = 0;
  for (const line of String(buf).replace(/\r/g, "\n").split("\n")) {
    const o = parseRsyncProgress2Line(line);
    if (o.bytes != null) max = Math.max(max, o.bytes);
  }
  return max;
}

function runRsync(args, opts) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const c = spawn("rsync", args, { stdio: ["ignore", "pipe", "pipe"] });
    let errBuf = "";
    let maxBytes = 0;
    const onData = (chunk) => {
      const s = chunk.toString();
      errBuf += s;
      for (const line of s.replace(/\r/g, "\n").split("\n")) {
        const o = parseRsyncLine(line);
        if (o.bytes != null) maxBytes = Math.max(maxBytes, o.bytes);
        if (o.percent != null && opts.onProgress) {
          opts.onProgress(o.percent, line);
        }
      }
    };
    c.stderr.on("data", onData);
    c.stdout.on("data", onData);
    c.on("error", reject);
    c.on("close", (code) => {
      const sec = (Date.now() - t0) / 1000;
      if (code !== 0) {
        reject(new Error(`rsync exit ${code}: ${errBuf.slice(-2000)}`));
        return;
      }
      const fromBuf = maxBytesFromRsyncOutput(errBuf);
      const bytesTransferred = Math.max(maxBytes, fromBuf);
      resolve({
        bytesTransferred,
        seconds: sec,
        output: errBuf,
      });
    });
  });
}

export async function testConnection(remoteMachine) {
  const host = remoteMachine.ip || remoteMachine.hostname;
  if (!host) return false;
  const user = remoteMachine.ssh_user || "root";
  const args = [
    ...sshBaseArgs(remoteMachine),
    "-o",
    "ConnectTimeout=5",
    `${user}@${host}`,
    "echo",
    "ok",
  ];
  return new Promise((resolve) => {
    execFile("ssh", args, { timeout: 8000, maxBuffer: 65536 }, (err) => {
      resolve(!err);
    });
  });
}

export async function getRemoteSize(remotePath, remoteMachine) {
  const host = remoteMachine.ip || remoteMachine.hostname;
  if (!host) return 0;
  const user = remoteMachine.ssh_user || "root";
  const args = [
    ...sshBaseArgs(remoteMachine),
    `${user}@${host}`,
    `du -sb "${remotePath.replace(/"/g, "\\\"")}"`,
  ];
  try {
    const { stdout } = await execFileAsync("ssh", args, { maxBuffer: 65536 });
    const n = parseInt(String(stdout).trim().split(/\s/)[0], 10);
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    console.error(`[transfer] getRemoteSize ${remotePath}:`, e);
    return 0;
  }
}
