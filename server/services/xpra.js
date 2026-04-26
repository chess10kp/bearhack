import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import * as transfer from "./transfer.js";

const execFileAsync = promisify(execFile);

function displayNum(disp) {
  const s = String(disp).replace(/^:/, "");
  return parseInt(s, 10) || 0;
}

/** TCP port for Xpra (same on local and remote). */
export function xpraPortForDisplay(display) {
  const d = String(display).startsWith(":") ? String(display) : `:${display}`;
  return config.xpraBasePort + displayNum(d);
}

/**
 * Heuristic: pick lowest display from config.displayStart with no /tmp/.X11-unix/Xn socket.
 */
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

function xpraArgsPort(display) {
  return xpraPortForDisplay(display);
}

/**
 * @returns {Promise<{ display: string, pid: number | null, port: number }>}
 */
export async function startSession(display, opts = {}) {
  const disp = display.startsWith(":") ? display : `:${display}`;
  const port = opts.port ?? xpraArgsPort(disp);
  const xpra = config.xpraBin;
  const args = [
    "start",
    disp,
    "--daemon=yes",
    `--bind-tcp=0.0.0.0:${port}`,
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
  await new Promise((r) => setTimeout(r, 800));
  const list = await list();
  const row = list.find((e) => e.display === disp);
  return { display: disp, pid: row?.pid ?? null, port };
}

export async function stop(display) {
  const disp = display.startsWith(":") ? display : `:${display}`;
  await execFileAsync(config.xpraBin, ["stop", disp], { maxBuffer: 4 * 1024 * 1024 });
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
  const u = transfer.sshUserAtHost(machine);
  const xpra = config.xpraBin;
  const inner = `${xpra.replace(/'/g, "'\\''")} start ${disp} --daemon=yes --bind-tcp=0.0.0.0:${port} 2>&1`;
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
