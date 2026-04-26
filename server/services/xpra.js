import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

function displayNum(disp) {
  const s = String(disp).replace(/^:/, "");
  return parseInt(s, 10) || 0;
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
  const n = displayNum(display);
  return config.xpraBasePort + n;
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
export async function list() {
  const { stdout, stderr } = await execFileAsync(
    config.xpraBin,
    ["list"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const text = stdout + stderr;
  const out = [];
  for (const line of text.split("\n")) {
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

export async function screenshot(display, outputPath) {
  const disp = display.startsWith(":") ? display : `:${display}`;
  await execFileAsync(
    config.xpraBin,
    ["screenshot", disp, path.resolve(String(outputPath))],
    { maxBuffer: 4 * 1024 * 1024 },
  );
}
