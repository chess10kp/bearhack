import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import * as transfer from "./transfer.js";
import * as worker from "./worker-client.js";

const execFileAsync = promisify(execFile);

function displayNum(disp) {
  const s = String(disp).replace(/^:/, "");
  return parseInt(s, 10) || 0;
}

export function xpraPortForDisplay(display) {
  const d = String(display).startsWith(":") ? String(display) : `:${display}`;
  return config.xpraBasePort + displayNum(d);
}

export async function findFreeDisplay() {
  const start = config.displayStart;
  for (let n = start; n < start + 200; n++) {
    const sock = `/tmp/.X11-unix/X${n}`;
    if (!fs.existsSync(sock)) {
      return `:${n}`;
    }
  }
  return `:${start}`;
}

function xpraPerfFlags() {
  return [
    "--webcam=no",
    "--mdns=no",
    "--pulseaudio=no",
    "--notifications=no",
    "--printing=no",
    "--file-transfer=no",
    "--dbus=no",
  ];
}

function xpraHtmlFlag() {
  if (config.xpraHtmlEnabled === false) return [];
  return ["--html=on"];
}

export function cleanupDisplayPaths(display) {
  const num = displayNum(display);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const userRun = `/run/user/${uid}/xpra`;
  const homeXpra = path.join(os.homedir(), ".xpra");
  for (const dir of [homeXpra, userRun]) {
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (entry.includes(`-${num}`)) {
          try { fs.unlinkSync(path.join(dir, entry)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
  try {
    const dispDir = path.join(userRun, String(num));
    fs.rmSync(dispDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

export async function info(display) {
  const disp = display.startsWith(":") ? display : `:${display}`;
  const { stdout } = await execFileAsync(config.xpraBin, ["info", disp], {
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
  });
  const map = {};
  for (const line of String(stdout).split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      map[line.slice(0, idx)] = line.slice(idx + 1);
    }
  }
  return map;
}

const READY_POLL_MS = 500;
const READY_TIMEOUT_MS = 30_000;

export async function waitForReady(display, { timeoutMs = READY_TIMEOUT_MS } = {}) {
  const disp = display.startsWith(":") ? display : `:${display}`;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const map = await info(disp);
      const windows = parseInt(map["state.windows"], 10);
      if (Number.isFinite(windows) && windows > 0) return true;
      const hasCommand = Object.entries(map).some(
        ([k, v]) => /^command\.\d+\.dead$/.test(k) && v === "False",
      );
      if (hasCommand) return true;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  return false;
}

export async function startSession(display, opts = {}) {
  const disp = display.startsWith(":") ? display : `:${display}`;
  const port = opts.port ?? xpraPortForDisplay(disp);
  const bindAddr = config.xpraBindAddr || "0.0.0.0";
  const xpra = config.xpraBin;

  try { await stop(disp); } catch { /* ignore stale */ }
  cleanupDisplayPaths(disp);

  const args = [
    "start",
    disp,
    "--daemon=yes",
    `--bind-tcp=${bindAddr}:${port}`,
    ...xpraHtmlFlag(),
    ...xpraPerfFlags(),
  ];
  await new Promise((resolve, reject) => {
    const c = execFile(
      xpra,
      args,
      { maxBuffer: 2 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              (stderr && String(stderr)) || (err && err.message) || "xpra start failed",
            ),
          );
          return;
        }
        resolve();
      },
    );
    c.on("error", reject);
  });
  const ready = await waitForReady(disp);
  if (!ready) {
    console.warn(`[xpra] session ${disp} did not report ready within ${READY_TIMEOUT_MS / 1000}s (continuing)`);
  }
  const list = await list();
  const row = list.find((e) => e.display === disp);
  return { display: disp, pid: row?.pid ?? null, port };
}

export async function stop(display) {
  const disp = display.startsWith(":") ? display : `:${display}`;
  await execFileAsync(config.xpraBin, ["stop", disp], { maxBuffer: 4 * 1024 * 1024 });
  cleanupDisplayPaths(disp);
}

export async function attach(display) {
  const disp = display.startsWith(":") ? display : `:${display}`;
  await execFileAsync(config.xpraBin, ["attach", disp], { maxBuffer: 4 * 1024 * 1024 });
}

/**
 * @returns {Promise<Array<{ display: string, state: string, pid: number | null }>>}
 */
/**
 * @param {string} text
 * @returns {Array<{ display: string, state: string, pid: number | null }>}
 */
function parseXpraListText(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const m = line.match(/(:[\d.]+)\s+\(/);
    if (!m) continue;
    const display = m[1];
    const pm = line.match(/(\d{3,6})\s*$/);
    const pid = pm ? parseInt(pm[1], 10) : null;
    const state = /LIVE|live/.test(line) ? "LIVE" : "UNKNOWN";
    if (!out.some((e) => e.display === display)) {
      out.push({ display, state, pid });
    }
  }
  return out;
}

export async function list() {
  const { stdout, stderr } = await execFileAsync(
    config.xpraBin,
    ["list"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return parseXpraListText((stdout || "") + (stderr || ""));
}

/**
 * @param {object} machine – machines table row
 */
export async function listRemote(machine) {
  if (worker.hasWorker(machine)) {
    const out = await worker.xpraList(machine);
    return parseXpraListText(String(out.output || ""));
  }
  const u = transfer.sshUserAtHost(machine);
  const xpra = config.xpraBin;
  const args = [
    ...transfer.sshBaseArgs(machine),
    u,
    `${xpra.replace(/'/g, "'\\''")} list 2>&1`,
  ];
  const { stdout, stderr } = await execFileAsync("ssh", args, {
    maxBuffer: 4 * 1024 * 1024,
  });
  return parseXpraListText((stdout || "") + (stderr || ""));
}

const INIT_WAIT_MS = 800;
const DEFAULT_LIVE_WAIT_MS = 5000;

/**
 * Start Xpra on a remote host over SSH.
 * @param {object} machine — machines table row
 * @param {string} display e.g. ":10" or "10"
 */
export async function startRemote(machine, display) {
  const disp = display.startsWith(":") ? display : `:${display}`;
  const port = xpraPortForDisplay(disp);
  const perfArgs = xpraPerfFlags().join(" ");
  const htmlArgs = xpraHtmlFlag().join(" ");
  if (worker.hasWorker(machine)) {
    await worker.xpraStart(machine, disp, port);
    await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
    return { display: disp, port };
  }
  const u = transfer.sshUserAtHost(machine);
  const xpra = config.xpraBin;
  const inner = `${xpra.replace(/'/g, "'\\''")} start ${disp} --daemon=yes --bind-tcp=0.0.0.0:${port} ${htmlArgs} ${perfArgs} 2>&1`;
  const args = [...transfer.sshBaseArgs(machine), u, inner];
  await new Promise((resolve, reject) => {
    const c = execFile("ssh", args, { maxBuffer: 2 * 1024 * 1024 }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
    c.on("error", reject);
  });
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  return { display: disp, port };
}

/**
 * Poll `xpra list` on the remote until the display is LIVE or timeout.
 * @returns {boolean} true if LIVE seen within the window
 */
export async function waitRemoteDisplayLive(
  machine,
  display,
  { timeoutMs = DEFAULT_LIVE_WAIT_MS } = {},
) {
  const disp = display.startsWith(":") ? display : `:${display}`;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const entries = await listRemote(machine);
      const row = entries.find((e) => e.display === disp);
      if (row && row.state === "LIVE") {
        return true;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

export function htmlUrl(display, host) {
  const d = String(display).startsWith(":") ? String(display) : `:${display}`;
  const port = xpraPortForDisplay(d);
  const h = host || "127.0.0.1";
  return `http://${h}:${port}/`;
}

/**
 * @returns {{ pid: number | null, child: import("node:child_process").ChildProcess | null }}
 */
export function startTunnel(machine, { localPort, remotePort }) {
  const u = transfer.sshUserAtHost(machine);
  const c = spawn(
    "ssh",
    [
      ...transfer.sshBaseArgs(machine),
      "-N",
      "-L",
      `${localPort}:127.0.0.1:${remotePort}`,
      u,
    ],
    { detached: true, stdio: "ignore" },
  );
  c.unref();
  return { pid: c.pid != null ? c.pid : null, child: c };
}

/**
 * Auto-attach the local Xpra client to a tunneled port (spawns, does not block).
 * @param {object} _machine — reserved for future use
 * @param {string} display
 */
export function attachTunnel(_machine, display) {
  const d = String(display).startsWith(":") ? String(display) : `:${display}`;
  const localPort = xpraPortForDisplay(d);
  const c = spawn(
    config.xpraBin,
    ["attach", `tcp:127.0.0.1:${localPort}`],
    { detached: true, stdio: "ignore" },
  );
  c.unref();
  return c.pid;
}

/**
 * @param {object} machine
 * @param {string} display
 */
export async function stopRemote(machine, display) {
  const disp = display.startsWith(":") ? display : `:${display}`;
  if (worker.hasWorker(machine)) {
    await worker.xpraStop(machine, disp).catch(() => {});
    return;
  }
  const u = transfer.sshUserAtHost(machine);
  const xpra = config.xpraBin;
  const inner = `${xpra.replace(/'/g, "'\\''")} stop ${disp} 2>&1`;
  const args = [...transfer.sshBaseArgs(machine), u, inner];
  try {
    await execFileAsync("ssh", args, { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
  } catch {
    /* best-effort */
  }
}

export async function screenshot(display, outputPath) {
  const disp = display.startsWith(":") ? display : `:${display}`;
  await execFileAsync(
    config.xpraBin,
    ["screenshot", disp, path.resolve(String(outputPath))],
    { maxBuffer: 4 * 1024 * 1024 },
  );
}
