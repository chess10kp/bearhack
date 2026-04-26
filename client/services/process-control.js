import fs from "node:fs";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import * as procfs from "../utils/procfs.js";

/**
 * @param {number} rootPid
 * @param {Set<number>} [seen]
 * @returns {number[]}
 */
function collectDescendantPids(rootPid, seen = new Set()) {
  const out = /** @type {number[]} */ ([]);
  const byPpid = new Map();
  let ents;
  try {
    ents = fs.readdirSync("/proc", { withFileTypes: true });
  } catch {
    return [rootPid].filter((p) => p > 0);
  }
  for (const e of ents) {
    if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue;
    const cpid = parseInt(e.name, 10);
    const st = procfs.readStat(cpid);
    if (st) {
      if (!byPpid.has(st.ppid)) byPpid.set(st.ppid, []);
      byPpid.get(st.ppid).push(cpid);
    }
  }
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop();
    if (p == null || p <= 0 || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    const ch = byPpid.get(p);
    if (ch) for (const c of ch) if (!seen.has(c)) stack.push(c);
  }
  return out;
}

/**
 * PIDs in order: parent first, then BFS so children after ancestors (good for SIGSTOP on tree).
 * @param {number} rootPid
 */
export function getTreePids(rootPid) {
  return collectDescendantPids(rootPid);
}

/**
 * @param {number} rootPid
 * @param {string} [sessionId]
 * @param {(e: { sessionId?: string, state: string, pid: number }) => void} [onState]
 */
export async function freeze(rootPid, sessionId, onState) {
  const pids = getTreePids(rootPid);
  for (const p of pids) {
    try {
      process.kill(p, "SIGSTOP");
    } catch {
      /* ESRCH */
    }
  }
  if (onState) {
    onState({ sessionId, state: "frozen", pid: rootPid });
  }
}

/**
 * @param {number} rootPid
 */
export async function resume(rootPid) {
  const pids = getTreePids(rootPid);
  for (const p of pids.slice().reverse()) {
    try {
      process.kill(p, "SIGCONT");
    } catch {
      /* ESRCH */
    }
  }
}

/**
 * SIGTERM, wait 5s, then SIGKILL on whole tree
 * @param {number} rootPid
 */
export async function kill(rootPid) {
  const pids = getTreePids(rootPid);
  for (const p of pids) {
    try {
      process.kill(p, "SIGTERM");
    } catch {
      /* ESRCH */
    }
  }
  await delay(5000);
  for (const p of pids) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      /* ESRCH */
    }
  }
}
