import fs from "node:fs";
import os from "node:os";

const hertz = os.constants?.CLK_TCK || 100;

/**
 * @param {number} pid
 */
export function readStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trimEnd();
    const l = raw.lastIndexOf(")");
    const i = raw.indexOf("(");
    if (i < 0 || l < 0) return null;
    const pid0 = parseInt(raw.slice(0, i - 1).trim(), 10);
    const comm = raw.slice(i + 1, l);
    const tail = raw.slice(l + 2);
    if (!tail) return null;
    const p = tail.split(" ");
    const state = p[0] || "?";
    const ppid = parseInt(p[1] || "0", 10);
    const utime = parseInt(p[11] || "0", 10);
    const stime = parseInt(p[12] || "0", 10);
    const numThreads = parseInt(p[17] || "0", 10);
    const starttime = parseInt(p[19] || "0", 10);
    const vsize = parseInt(p[20] || "0", 10);
    const rssPages = parseInt(p[21] || "0", 10);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    return {
      pid: Number.isFinite(pid0) ? pid0 : pid,
      comm: comm || "",
      state,
      ppid,
      utime,
      stime,
      numThreads,
      starttime,
      vsize,
      rss: rssPages,
      rssBytes: rssPages * (os.pageSize || 4096),
    };
  } catch {
    return null;
  }
}

/**
 * @param {number} pid
 * @returns {{ vmRSS: number, vmSize: number, threads: number, state: string, raw: Record<string, string|number> } | null}
 */
export function readStatus(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const map = /** @type {Record<string, string|number>} */ ({});
    for (const line of raw.split("\n")) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const k = line.slice(0, idx).trim();
      let v = line.slice(idx + 1).trim();
      if (k === "VmRSS" || k === "VmSize" || k === "RssAnon" || k === "RssFile") {
        const m = v.match(/(\d+)\s*kB/);
        if (m) map[k] = parseInt(m[1], 10);
        else map[k] = v;
      } else if (k === "Threads") {
        map[k] = parseInt(v, 10);
      } else {
        map[k] = v;
      }
    }
    const st = readStat(pid);
    return {
      vmRSS: Number(map.VmRSS) || 0,
      vmSize: Number(map.VmSize) || 0,
      threads: Number(map.Threads) || 0,
      state: (st && st.state) || String(map.State || "?"),
      raw: map,
    };
  } catch {
    return null;
  }
}

/**
 * @param {number} pid
 */
export function readCmdline(pid) {
  try {
    const buf = fs.readFileSync(`/proc/${pid}/cmdline`);
    if (buf.length === 0) return "";
    const parts = buf.toString("utf8").split("\0");
    return parts.filter(Boolean).join(" ");
  } catch {
    return "";
  }
}

/**
 * @returns {Map<number, number[]>}
 */
function buildPpidToChildren() {
  const map = new Map();
  let ents;
  try {
    ents = fs.readdirSync("/proc", { withFileTypes: true });
  } catch {
    return map;
  }
  for (const e of ents) {
    if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue;
    const cpid = parseInt(e.name, 10);
    const st = readStat(cpid);
    if (st) {
      const pp = st.ppid;
      if (!map.has(pp)) map.set(pp, []);
      map.get(pp).push(cpid);
    }
  }
  return map;
}

/**
 * @param {number} rootPid
 * @returns {Array<{ pid: number, ppid: number, name: string, state: string }>}
 */
export function getProcessTree(rootPid) {
  const st0 = readStat(rootPid);
  if (!st0) return [];
  const children = buildPpidToChildren();
  const out = /** @type {Array<{ pid: number, ppid: number, name: string, state: string }>} */ (
    []
  );
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const st = readStat(pid);
    if (!st) continue;
    out.push({
      pid: st.pid,
      ppid: st.ppid,
      name: st.comm,
      state: st.state,
    });
    const ch = children.get(pid);
    if (ch) for (const c of ch) if (!seen.has(c)) stack.push(c);
  }
  return out;
}

/**
 * @param {number} pid
 */
export function isAlive(pid) {
  try {
    fs.accessSync(`/proc/${pid}`, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {{ cores: number, totalMemoryKB: number, pageSize: number, hertz: number }}
 */
export function getCPUInfo() {
  let totalMemoryKB = 0;
  try {
    const mi = fs.readFileSync("/proc/meminfo", "utf8");
    const m = mi.match(/MemTotal:\s+(\d+)\s+kB/);
    if (m) totalMemoryKB = parseInt(m[1], 10);
  } catch {
    totalMemoryKB = 0;
  }
  if (!Number.isFinite(totalMemoryKB) || totalMemoryKB <= 0) {
    totalMemoryKB = Math.floor((os.totalmem() || 0) / 1024);
  }
  const cores = Math.max(1, os.cpus().length);
  return {
    cores,
    totalMemoryKB,
    pageSize: os.pageSize || 4096,
    hertz,
  };
}

/**
 * @returns {number} seconds
 */
export function getUptime() {
  try {
    const s = fs.readFileSync("/proc/uptime", "utf8");
    const t = parseFloat(s.split(" ")[0] || "0");
    return Number.isFinite(t) ? t : 0;
  } catch {
    return os.uptime();
  }
}

export { hertz };
