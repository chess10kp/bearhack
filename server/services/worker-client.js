import { config } from "../config.js";

function timeoutSignal(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, done: () => clearTimeout(t) };
}

/**
 * @param {object} machine
 */
export function hasWorker(machine) {
  return Boolean(machine && machine.worker_url);
}

function workerBaseUrl(machine) {
  return String(machine.worker_url || "").replace(/\/+$/, "");
}

/**
 * @param {object} machine
 */
function workerHeaders(machine) {
  const h = { "Content-Type": "application/json" };
  if (machine.worker_token) {
    h.Authorization = `Bearer ${machine.worker_token}`;
  }
  return h;
}

/**
 * @param {object} machine
 * @param {string} endpoint
 * @param {object} [body]
 */
async function request(machine, endpoint, body) {
  if (!hasWorker(machine)) {
    throw new Error(`machine ${machine?.id || "unknown"} has no worker_url`);
  }
  const url = `${workerBaseUrl(machine)}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
  const { signal, done } = timeoutSignal(config.workerRequestTimeoutMs);
  try {
    const r = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: workerHeaders(machine),
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const text = await r.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    if (!r.ok) {
      const msg = payload?.error || payload?.message || text || `HTTP ${r.status}`;
      throw new Error(`worker request failed: ${msg}`);
    }
    return payload || {};
  } finally {
    done();
  }
}

/**
 * @param {object} machine
 */
export async function health(machine) {
  return request(machine, "/health");
}

/**
 * @param {object} machine
 * @param {string} dir
 */
export async function ensureCheckpointDir(machine, dir) {
  return request(machine, "/api/worker/checkpoint-dir", { dir });
}

/**
 * @param {object} machine
 * @param {string} checkpointDir
 */
export async function criuRestore(machine, checkpointDir) {
  return request(machine, "/api/worker/criu/restore", { checkpointDir });
}

/**
 * @param {object} machine
 * @param {number} pid
 */
export async function processAlive(machine, pid) {
  return request(machine, "/api/worker/process/alive", { pid });
}

/**
 * @param {object} machine
 * @param {number} pid
 */
export async function processKill(machine, pid) {
  return request(machine, "/api/worker/process/kill", { pid, signal: "SIGKILL" });
}

/**
 * @param {object} machine
 * @param {string} display
 * @param {number} port
 */
export async function xpraStart(machine, display, port) {
  return request(machine, "/api/worker/xpra/start", { display, port });
}

/**
 * @param {object} machine
 * @param {string} display
 */
export async function xpraStop(machine, display) {
  return request(machine, "/api/worker/xpra/stop", { display });
}

/**
 * @param {object} machine
 */
export async function xpraList(machine) {
  return request(machine, "/api/worker/xpra/list");
}
