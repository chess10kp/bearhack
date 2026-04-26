/**
 * Socket.IO + REST client. Live session truth comes from the server on port 3000.
 * Canonical launch path: emit session:launch; server should emit session:created.
 */
import { io } from "https://esm.sh/socket.io-client@4.8.1";
import * as state from "./state.js";
import { getApiBase } from "./util.js";

/** @type {import("socket.io-client").Socket | null} */
let socket = null;

function baseUrl() {
  return getApiBase();
}

function rest(path, opts = {}) {
  const u = `${baseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  return fetch(u, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
}

function wireSocketHandlers(s) {
  s.on("connect", () => {
    state.setConnection("connected");
  });
  s.on("connect_error", () => {
    state.setConnection("disconnected");
  });
  s.on("disconnect", () => {
    state.setConnection("disconnected");
  });

  s.on("session:created", (p) => {
    if (p && p.id) state.upsertSession(normalizeSession(p));
  });
  s.on("session:list", (list) => {
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item && item.id) state.upsertSession(normalizeSession(item));
      }
    }
  });
  s.on("session:updated", (p) => {
    if (p && p.id) state.upsertSession(normalizeSession(p));
  });
  s.on("session:hung", (p) => {
    if (p && p.id) {
      state.upsertSession(
        normalizeSession({ ...p, status: "hung", health: "danger" }),
      );
      state.appendLog(`session ${p.id} · hang detected`, "warn");
    }
  });
  s.on("session:ended", (p) => {
    const id = p && (p.id || p.sessionId);
    if (id) state.removeSession(String(id));
  });

  s.on("migration:started", (p) => {
    const sid = p && (p.sessionId || p.id);
    if (!sid) return;
    state.setActiveMigration(String(sid), {
      sessionId: String(sid),
      target: p.target,
      stepIndex: 0,
      percent: 0,
      stepLabels: defaultStepLabels(),
    });
    const sess = state.getState().sessions[String(sid)];
    if (sess) {
      state.upsertSession({ ...sess, status: "migrating", health: "warn" });
    }
  });
  s.on("migration:progress", (p) => {
    const sid = p && (p.sessionId || p.id);
    if (!sid) return;
    const cur = state.getState().migrationBySession[String(sid)] || {
      sessionId: String(sid),
    };
    state.setActiveMigration(String(sid), {
      ...cur,
      stepIndex:
        p.stepIndex != null ? Number(p.stepIndex) : cur.stepIndex ?? 0,
      percent: p.percent != null ? Number(p.percent) : cur.percent ?? 0,
      target: p.target || cur.target,
      stepLabels: p.stepLabels || cur.stepLabels || defaultStepLabels(),
    });
  });
  s.on("migration:dcp-submitted", (p) => {
    const sid = p && (p.sessionId || p.id);
    if (!sid) return;
    const cur = state.getState().migrationBySession[String(sid)] || {
      sessionId: String(sid),
    };
    state.setActiveMigration(String(sid), {
      ...cur,
      transportKind: "dcp",
      dcpJobId: p.jobId || cur.dcpJobId,
      dcpSchedulerUrl: p.schedulerUrl || cur.dcpSchedulerUrl,
    });
  });
  s.on("migration:dcp-status", (p) => {
    const sid = p && (p.sessionId || p.id);
    if (!sid) return;
    const cur = state.getState().migrationBySession[String(sid)] || {
      sessionId: String(sid),
    };
    state.setActiveMigration(String(sid), {
      ...cur,
      transportKind: "dcp",
      dcpStatus: p.status || cur.dcpStatus,
      dcpJobId: p.jobId || cur.dcpJobId,
    });
  });
  s.on("migration:completed", (p) => {
    const sid = p && (p.sessionId || p.id);
    if (sid) {
      state.clearActiveMigration(String(sid));
      const sess = state.getState().sessions[String(sid)];
      if (sess) {
        state.upsertSession({ ...sess, status: "running", health: "ok" });
      }
      const mid = p.migrationId || `mig-${Date.now()}`;
      state.addMigrationRecord({
        id: mid,
        migrationId: p.migrationId || mid,
        sessionId: String(sid),
        startedAt: p.startedAt,
        endedAt: p.endedAt || Date.now(),
        success: true,
        cost: p.cost,
        message: p.message,
        solanaSignature: p.solanaSignature || undefined,
        solanaExplorerTx: p.solanaExplorerTx || undefined,
        paymentPending: p.paymentPending,
      });
      const n = (state.getState().migrationsToday || 0) + 1;
      state.setMigrationsToday(n);
    }
  });
  s.on("solana:payment-confirmed", (p) => {
    if (p && p.migrationId) {
      state.patchMigrationRecordByMigrationId(String(p.migrationId), {
        solanaSignature: p.signature,
        solanaExplorerTx: p.explorerUrl,
        paymentPending: false,
      });
      const short = p.signature ? String(p.signature).slice(0, 16) : "";
      state.appendLog(
        short ? `solana payment confirmed · ${short}…` : "solana payment confirmed",
        "ok",
      );
    }
  });
  s.on("migration:failed", (p) => {
    const sid = p && (p.sessionId || p.id);
    if (sid) {
      state.clearActiveMigration(String(sid));
      const sess = state.getState().sessions[String(sid)];
      if (sess) {
        state.upsertSession({ ...sess, status: "hung", health: "danger" });
      }
      state.addMigrationRecord({
        id: `mig-${Date.now()}`,
        sessionId: sid ? String(sid) : "",
        success: false,
        message: p.message || p.error || "migration failed",
      });
    }
    state.appendLog(
      `migration failed · ${p && (p.message || p.error) ? p.message || p.error : "unknown"}`,
      "err",
    );
  });

  s.on("machine:list", (list) => {
    if (Array.isArray(list)) state.setMachinesList(list);
  });
  s.on("machine:updated", (m) => {
    if (m && m.id) state.upsertMachine(m);
  });

  s.on("log:entry", (entry) => {
    if (typeof entry === "string") {
      state.appendLog(entry, "info");
    } else if (entry && entry.message) {
      const lv = String(entry.level || "info").toLowerCase();
      const cls =
        lv === "error" || lv === "err"
          ? "err"
          : lv === "warn"
            ? "warn"
            : lv === "ok" || lv === "success"
              ? "ok"
              : "info";
      state.appendLog(entry.message, /** @type {'ok'|'warn'|'err'|'info'} */ (cls));
    }
  });
}

function defaultStepLabels() {
  return [
    "criu checkpoint (freeze)",
    "transfer memory image",
    "restore in target lxc",
    "reattach xpra display",
  ];
}

function normalizeSession(p) {
  const health =
    p.health ||
    (p.status === "hung" || p.status === "exited"
      ? "danger"
      : p.status === "migrating" || p.status === "paused"
        ? "warn"
        : "ok");
  return {
    id: String(p.id),
    name: p.name || p.app || p.label || p.id,
    icon: p.icon || "📦",
    pid: p.pid,
    memoryPercent: p.memoryPercent ?? p.memPct,
    memoryLabel: p.memoryLabel || p.mem,
    cpuPercent: p.cpuPercent ?? p.cpu,
    uptimeSec: p.uptimeSec ?? p.uptime,
    status: p.status || "running",
    health,
    xpraDisplay: p.xpraDisplay || null,
    xpraPort: p.xpraPort ?? null,
    xpraHtmlUrl: p.xpraHtmlUrl || null,
  };
}

export function connectSocket() {
  if (socket?.connected) return socket;
  state.setConnection("connecting");
  const s = io(baseUrl(), {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
  });
  socket = s;
  wireSocketHandlers(s);
  return s;
}

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  state.setConnection("disconnected");
}

export function getSocket() {
  return socket;
}

/** Emit session:launch — server creates LXC+Xpra session and emits session:created */
export function emitLaunch(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return;
  if (!socket?.connected) {
    state.appendLog("not connected — cannot launch", "err");
    return;
  }
  socket.emit("session:launch", { command: cmd });
}

export function emitMigrate(sessionId) {
  if (!socket?.connected) {
    state.appendLog("not connected — cannot migrate", "err");
    return;
  }
  socket.emit("session:migrate", { sessionId });
}

export function emitMigrateDcp(sessionId) {
  if (!socket?.connected) {
    state.appendLog("not connected — cannot migrate", "err");
    return;
  }
  socket.emit("session:migrate", { sessionId, transportKind: "dcp" });
}

export function emitCheckpoint(sessionId) {
  if (!socket?.connected) return;
  socket.emit("session:checkpoint", { sessionId });
}

export function emitKill(sessionId) {
  if (!socket?.connected) return;
  socket.emit("session:kill", { sessionId });
}

export async function postSessionCreate(command) {
  const r = await rest("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ command }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function postSessionMigrate(sessionId) {
  const r = await rest(`/api/sessions/${encodeURIComponent(sessionId)}/migrate`, {
    method: "POST",
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function fetchSessionDetail(sessionId) {
  const r = await rest(`/api/sessions/${encodeURIComponent(sessionId)}/detail`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function fetchMigrations() {
  const r = await rest("/api/migrations");
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function fetchMigrationDcpStatus(migrationId) {
  const r = await rest(`/api/migrations/${encodeURIComponent(migrationId)}/dcp`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function cancelMigrationDcp(migrationId) {
  const r = await rest(`/api/migrations/${encodeURIComponent(migrationId)}/dcp/cancel`, {
    method: "POST",
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function retryMigrationDcp(migrationId) {
  const r = await rest(`/api/migrations/${encodeURIComponent(migrationId)}/dcp/retry`, {
    method: "POST",
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function fetchSettings() {
  const r = await rest("/api/settings");
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function putSettings(body) {
  const r = await rest("/api/settings", {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function migrationRowToRecord(row) {
  if (!row || !row.id) return null;
  const started =
    row.started_at != null ? Number(row.started_at) * 1000 : undefined;
  const ended =
    row.completed_at != null ? Number(row.completed_at) * 1000 : undefined;
  const cost =
    row.payment_lamports != null
      ? (Number(row.payment_lamports) / 1e9).toFixed(6)
      : undefined;
  return {
    id: row.id,
    migrationId: row.id,
    sessionId: row.session_id,
    startedAt: started,
    endedAt: ended,
    success: row.status === "completed",
    cost: cost || undefined,
    message: row.error || undefined,
    solanaSignature: row.payment_signature || undefined,
    paymentPending: row.payment_status === "pending",
    transportKind: row.transport_kind || "ssh",
    dcpJobId: row.dcp_job_id || undefined,
    dcpStatus: row.dcp_status || undefined,
    dcpError: row.dcp_error || undefined,
  };
}

export async function prefetchAfterConnect() {
  try {
    const st = await fetchSettings();
    if (st && typeof st === "object") state.setSettings(st);
  } catch {
    /* server may not implement yet */
  }
  try {
    const sc = await rest("/api/solana/config");
    if (sc.ok) {
      const j = await sc.json();
      if (j && j.cluster) state.setSolanaCluster(j.cluster);
    }
  } catch {
    /* optional */
  }
  try {
    const h = await fetchMigrations();
    if (Array.isArray(h)) {
      const recs = h.map(migrationRowToRecord).filter(Boolean);
      state.setMigrationHistory(recs);
    }
  } catch {
    /* optional */
  }
}
