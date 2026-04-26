import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../config.js";

/**
 * Tracks a running CRIU page-server child process.
 * Only one instance per port is tracked; restart per snapshot.
 *
 * @typedef {Object} PageServerHandle
 * @property {import('node:child_process').ChildProcess} proc
 * @property {number} port
 * @property {string} dir
 * @property {string} logFile
 * @property {number} startedAt
 */

/** @type {Map<number, PageServerHandle>} */
const running = new Map();

/**
 * Start `criu page-server` listening on a port, writing pages images into `dir`.
 *
 * @param {{ port: number, dir: string }} opts
 * @returns {Promise<{ ok: true, port: number, dir: string, pid: number, logFile: string }>}
 */
export function start({ port, dir }) {
  return new Promise((resolve, reject) => {
    if (running.has(port)) {
      reject(new Error(`page-server already running on port ${port}`));
      return;
    }
    const outDir = path.resolve(dir);
    fs.mkdirSync(outDir, { recursive: true });
    const logFile = path.join(outDir, "page-server.log");
    // truncate log so each snapshot starts fresh
    fs.writeFileSync(logFile, "");
    const args = [
      "page-server",
      "--port",
      String(port),
      "--address",
      "0.0.0.0",
      "-D",
      outDir,
      "--log-file",
      "page-server.log",
      "-v4",
    ];
    const proc = spawn(config.criuBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    let stderrBuf = "";
    let resolved = false;
    proc.stdout?.on("data", (b) => {
      try {
        fs.appendFileSync(logFile, b);
      } catch {
        /* */
      }
    });
    proc.stderr?.on("data", (b) => {
      stderrBuf += b.toString();
      try {
        fs.appendFileSync(logFile, b);
      } catch {
        /* */
      }
    });
    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
    proc.on("exit", (code, signal) => {
      running.delete(port);
      if (!resolved) {
        resolved = true;
        reject(
          new Error(
            `page-server exited early code=${code} signal=${signal}: ${stderrBuf.slice(0, 800)}`,
          ),
        );
      }
    });
    // CRIU page-server stays in foreground until the dump connection finishes.
    // Give it a brief moment to bind; if it didn't crash within 300ms assume bound.
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      const handle = {
        proc,
        port,
        dir: outDir,
        logFile,
        startedAt: Date.now(),
      };
      running.set(port, handle);
      resolve({ ok: true, port, dir: outDir, pid: proc.pid || 0, logFile });
    }, 300);
  });
}

/**
 * Wait for the page-server on the given port to exit (after a dump connection
 * completes the page-server terminates by itself).
 *
 * @param {number} port
 * @param {number} [timeoutMs]
 */
export function waitExit(port, timeoutMs = 600_000) {
  const h = running.get(port);
  if (!h) return Promise.resolve({ ok: true, alreadyExited: true });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`page-server on ${port} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    h.proc.once("exit", (code, signal) => {
      clearTimeout(t);
      running.delete(port);
      resolve({ ok: true, code, signal: signal ? String(signal) : null });
    });
  });
}

/**
 * Force stop a running page-server (used on abort / cleanup).
 *
 * @param {number} port
 */
export function stop(port) {
  const h = running.get(port);
  if (!h) return { ok: true, running: false };
  try {
    h.proc.kill("SIGTERM");
  } catch {
    /* */
  }
  running.delete(port);
  return { ok: true, running: true };
}

export function status(port) {
  const h = running.get(port);
  if (!h) return { running: false };
  return {
    running: true,
    port: h.port,
    dir: h.dir,
    pid: h.proc.pid || 0,
    uptimeMs: Date.now() - h.startedAt,
  };
}

export function list() {
  return Array.from(running.values()).map((h) => ({
    port: h.port,
    dir: h.dir,
    pid: h.proc.pid || 0,
    uptimeMs: Date.now() - h.startedAt,
  }));
}
