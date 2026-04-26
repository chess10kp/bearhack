import * as procfs from "../utils/procfs.js";

const intervals = new Map();
/** @type {Map<string, { last: any }>} */
const lastMetrics = new Map();
const lastState = new Map();

const nCpus = Math.max(1, procfs.getCPUInfo().cores);
const hertz = procfs.hertz;
let memTotalKb = procfs.getCPUInfo().totalMemoryKB;
try {
  if (memTotalKb <= 0) memTotalKb = 8 * 1024 * 1024;
} catch {
  memTotalKb = 8 * 1024 * 1024;
}

/**
 * @typedef {Object} PollingCtx
 * @property {(e: { sessionId: string, pid: number, cpuPercent: number, memoryMB: number, memoryPercent: number, state: string, threads: number, timestamp: number }) => void} [onMetrics]
 * @property {(e: { sessionId: string, oldState: string, newState: string, pid: number, reason: string }) => void} [onStateChange]
 */

/**
 * @param {string} sessionId
 * @param {number} pid
 * @param {number} intervalMs
 * @param {PollingCtx} [ctx]
 */
export function startPolling(sessionId, pid, intervalMs, ctx = {}) {
  if (intervals.has(sessionId)) {
    clearInterval(/** @type {NodeJS.Timeout} */ (intervals.get(sessionId)));
  }
  const iv = Math.max(200, intervalMs);
  const tick = {
    utime: 0,
    stime: 0,
    t: Date.now(),
    inited: false,
  };
  const onMetrics = ctx.onMetrics || (() => {});
  const onStateChange = ctx.onStateChange || (() => {});

  function emitStaticSample() {
    const st0 = procfs.readStat(pid);
    const status = procfs.readStatus(pid);
    if (!st0) return;
    const now = Date.now();
    const vmRssKb = status?.vmRSS ?? 0;
    const memMb = vmRssKb / 1024;
    let memoryPercent = 0;
    if (memTotalKb > 0) {
      memoryPercent = (100 * vmRssKb) / memTotalKb;
    }
    const payload = {
      sessionId,
      pid,
      cpuPercent: 0,
      memoryMB: memMb,
      memoryPercent,
      state: st0.state,
      threads: Number(status?.threads ?? st0.numThreads) || 0,
      timestamp: now,
    };
    lastMetrics.set(sessionId, payload);
    onMetrics(payload);
  }
  emitStaticSample();

  const tmr = setInterval(() => {
    const st0 = procfs.readStat(pid);
    const status = procfs.readStatus(pid);
    if (!st0) {
      const prevS = lastState.get(sessionId) || "R";
      if (prevS !== "gone") {
        onStateChange({
          sessionId,
          oldState: prevS,
          newState: "gone",
          pid,
          reason: "process exit",
        });
        lastState.set(sessionId, "gone");
      }
      return;
    }
    const stateNow = st0.state;
    const had = lastState.has(sessionId);
    const prev = had ? lastState.get(sessionId) : stateNow;
    if (had && stateNow !== String(prev)) {
      onStateChange({
        sessionId,
        oldState: String(prev),
        newState: stateNow,
        pid,
        reason: "proc state",
      });
    }
    lastState.set(sessionId, stateNow);

    const now = Date.now();
    const dt = (now - tick.t) / 1000;
    if (dt <= 0) return;

    let dUt = st0.utime - tick.utime;
    let dSt = st0.stime - tick.stime;
    if (!tick.inited) {
      tick.utime = st0.utime;
      tick.stime = st0.stime;
      tick.t = now;
      tick.inited = true;
      return;
    }
    tick.utime = st0.utime;
    tick.stime = st0.stime;
    tick.t = now;

    let cpuPercent = 0;
    if (dUt + dSt >= 0) {
      cpuPercent = (100 * (dUt + dSt)) / hertz / dt / nCpus;
      if (!Number.isFinite(cpuPercent)) cpuPercent = 0;
    }

    const vmRssKb = status?.vmRSS ?? 0;
    const memMb = vmRssKb / 1024;
    let memoryPercent = 0;
    if (memTotalKb > 0) {
      memoryPercent = (100 * vmRssKb) / memTotalKb;
    }
    const threads = status?.threads ?? st0.numThreads;
    const payload = {
      sessionId,
      pid,
      cpuPercent,
      memoryMB: memMb,
      memoryPercent,
      state: st0.state,
      threads: Number(threads) || 0,
      timestamp: now,
    };
    lastMetrics.set(sessionId, payload);
    onMetrics(payload);
  }, iv);
  intervals.set(sessionId, tmr);
}

/**
 * @param {string} sessionId
 */
export function stopPolling(sessionId) {
  const t = intervals.get(sessionId);
  if (t) {
    clearInterval(/** @type {NodeJS.Timeout} */ (t));
    intervals.delete(sessionId);
  }
  lastMetrics.delete(sessionId);
  lastState.delete(sessionId);
}

/**
 * @param {string} sessionId
 */
export function getMetrics(sessionId) {
  return lastMetrics.get(sessionId) || null;
}

/**
 * @param {number} pid
 */
export function isResponsive(pid) {
  const st0 = procfs.readStat(pid);
  if (!st0) return false;
  if (st0.state === "D" || st0.state === "Z") return false;
  return st0.state === "R" || st0.state === "S" || st0.state === "I";
}
