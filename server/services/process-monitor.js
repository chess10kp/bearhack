import fs from "node:fs";
import os from "node:os";
import * as db from "../db.js";
import { getIo } from "../context.js";
import { S } from "../socket/events.js";
import { onMonitorTick } from "./hang-detector.js";

const intervals = new Map();
const hertz = os.constants?.CLK_TCK || 100;
let memTotalKb = 0;
try {
  const mi = fs.readFileSync("/proc/meminfo", "utf8");
  const m = mi.match(/MemTotal:\s+(\d+)\s+kB/);
  if (m) memTotalKb = parseInt(m[1], 10);
} catch {
  memTotalKb = 8 * 1024 * 1024;
}
const nCpus = Math.max(1, os.cpus().length);

/* After comm: state ppid pgrp ... utime(12) stime(13) in fields split after "pid (comm) " */
function parseStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const j = raw.lastIndexOf(")");
    if (j < 0) return null;
    const tail = raw.slice(j + 2);
    const p = tail.split(" ");
    const state = p[0];
    const utime = parseInt(p[12], 10);
    const stime = parseInt(p[13], 10);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    return { state, utime, stime };
  } catch {
    return null;
  }
}

function parseStatusVmRSS(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const m = raw.match(/VmRSS:\s+(\d+)\s+kB/);
    if (m) return parseInt(m[1], 10);
  } catch {
    /* ignore */
  }
  return 0;
}

/**
 * @param {string} sessionId
 * @param {number} pid
 * @param {number} intervalMs
 */
export function startPolling(sessionId, pid, intervalMs) {
  if (intervals.has(sessionId)) {
    clearInterval(intervals.get(sessionId));
  }
  const iv = Math.max(500, intervalMs);
  const tick = { utime: 0, stime: 0, t: Date.now(), inited: false };
  const tmr = setInterval(() => {
    const st0 = parseStat(pid);
    if (!st0) {
      return;
    }
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
    let cpuNorm = 0;
    if (dUt + dSt >= 0) {
      cpuNorm = (100 * (dUt + dSt)) / hertz / dt / nCpus;
      if (!Number.isFinite(cpuNorm)) cpuNorm = 0;
    }
    const vmRssKb = parseStatusVmRSS(pid);
    const memMb = vmRssKb / 1024;
    let memPercent = 0;
    if (memTotalKb > 0) {
      memPercent = (100 * vmRssKb) / memTotalKb;
    }
    db.updateSession(sessionId, {
      cpu_percent: cpuNorm,
      memory_mb: memMb,
      memory_percent: memPercent,
    });
    const sess = db.getSession(sessionId);
    if (!sess) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const st = sess.started_at || nowSec;
    const pay = {
      id: sess.id,
      name: sess.app_name || sess.id,
      app: sess.app_name,
      label: sess.app_name,
      icon: "📦",
      pid: sess.pid,
      cpuPercent: cpuNorm,
      cpu: cpuNorm,
      memoryPercent: memPercent,
      memPct: memPercent,
      memoryLabel: `${Math.round(memMb)} MB`,
      mem: `${Math.round(memMb)} MB`,
      status: sess.status,
      uptimeSec: nowSec - st,
      uptime: nowSec - st,
    };
    const io = getIo();
    if (io) {
      io.emit(S.sessionUpdated, pay);
    }
    onMonitorTick(sessionId, {
      cpuNorm,
      procState: st0.state,
      memMb,
    });
  }, iv);
  intervals.set(sessionId, tmr);
}

export function stopPolling(sessionId) {
  const t = intervals.get(sessionId);
  if (t) {
    clearInterval(t);
    intervals.delete(sessionId);
  }
}

export function isResponsive(pid) {
  const st0 = parseStat(pid);
  if (!st0) return false;
  if (st0.state === "D") return false;
  return true;
}
