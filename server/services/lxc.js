import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { insertLog } from "../db.js";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

function assertContainerName(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-_.]{0,63}$/.test(String(name))) {
    throw new Error(`invalid container name: ${name}`);
  }
}

async function exists(name) {
  try {
    await execFileAsync(config.lxcInfoBin, ["-n", name], {
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {number} [timeout]
 */
async function run(bin, args, timeout = 45_000) {
  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  return `${stdout || ""}${stderr || ""}`.trim();
}

/**
 * @param {string} name
 * @param {{ rootfs?: string }} [opts]
 * @returns {Promise<{ name: string, rootfs: string, createdAt: number }>}
 */
export async function createContainer(name, opts = {}) {
  assertContainerName(name);
  const rootfs = opts.rootfs || `/var/lib/lxc/${name}/rootfs`;
  if (await exists(name)) {
    insertLog({
      level: "warn",
      message: `container ${name} already exists (idempotent)`,
    });
    return { name, rootfs, createdAt: Date.now() };
  }
  await run(config.lxcBin, [
    "-n",
    name,
    "-t",
    "none",
    "-B",
    "dir",
    "--dir",
    rootfs,
  ]);
  insertLog({ level: "info", message: `container ${name} created` });
  return { name, rootfs, createdAt: Date.now() };
}

/**
 * @param {string} name
 * @param {{ initCommand?: string[], foreground?: boolean }} [opts]
 */
export async function startContainer(name, opts = {}) {
  assertContainerName(name);
  const args = ["-n", name];
  if (opts.foreground) {
    args.push("-F");
  } else {
    args.push("-d");
  }
  if (Array.isArray(opts.initCommand) && opts.initCommand.length > 0) {
    args.push("--", ...opts.initCommand);
  }
  await run(config.lxcStartBin, args);
  insertLog({ level: "info", message: `container ${name} started` });
}

/**
 * @param {string} name
 */
export async function stopContainer(name) {
  assertContainerName(name);
  try {
    await run(config.lxcStopBin, ["-n", name, "-k"], 20_000);
    insertLog({ level: "info", message: `container ${name} stopped` });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    insertLog({
      level: "warn",
      message: `container ${name} stop failed: ${msg}`,
    });
  }
}

/**
 * @param {string} name
 */
export async function destroyContainer(name) {
  assertContainerName(name);
  try {
    await run(config.lxcDestroyBin, ["-n", name], 20_000);
    insertLog({ level: "info", message: `container ${name} destroyed` });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    insertLog({
      level: "warn",
      message: `container ${name} destroy failed: ${msg}`,
    });
  }
}

/**
 * Spawn a command inside a running container. Caller owns process lifecycle.
 * @param {string} name
 * @param {string} command
 * @param {{ env?: Record<string, string> }} [opts]
 */
export function runInContainer(name, command, opts = {}) {
  assertContainerName(name);
  const env = { ...process.env, ...(opts.env || {}) };
  const args = ["-n", name, "--clear-env"];
  if (env.DISPLAY) {
    args.push("--keep-var", "DISPLAY");
  }
  args.push("--", "sh", "-lc", command);
  return spawn(config.lxcAttachBin, args, {
    env,
    detached: false,
    stdio: "ignore",
  });
}

/**
 * @returns {Promise<Array<{ name: string, state: string }>>}
 */
export async function list() {
  const out = await run(config.lxcInfoBin, ["--list"]);
  const names = out
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const rows = [];
  for (const n of names) {
    try {
      const detail = await run(config.lxcInfoBin, ["-n", n]);
      const m = detail.match(/State:\s+([A-Z]+)/);
      rows.push({ name: n, state: m ? m[1] : "UNKNOWN" });
    } catch {
      rows.push({ name: n, state: "UNKNOWN" });
    }
  }
  return rows;
}
