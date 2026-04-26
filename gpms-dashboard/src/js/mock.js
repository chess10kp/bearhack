import * as state from "./state.js";

const STEP_LABELS = [
  "criu checkpoint (freeze)",
  "transfer memory image",
  "restore in target lxc",
  "reattach xpra display",
];

const timers = [];

function track(t) {
  timers.push(t);
  return t;
}

export function stopMock() {
  for (const t of timers) {
    if (typeof t === "number") {
      clearInterval(t);
      clearTimeout(t);
    } else if (t && t.close) t.close();
    else if (t && t.dispose) t.dispose();
  }
  timers.length = 0;
}

let seq = 4;

function seed() {
  state.upsertSession({
    id: "session-001",
    name: "Blender 4.1",
    icon: "🎨",
    pid: 38291,
    memoryPercent: 42,
    memoryLabel: "3.4 GB",
    cpuPercent: 12,
    uptimeSec: 2 * 3600 + 14 * 60,
    status: "running",
    health: "ok",
  });
  state.upsertSession({
    id: "session-002",
    name: "Inkscape 1.3",
    icon: "✏️",
    pid: 41007,
    memoryPercent: 91,
    memoryLabel: "7.3 GB",
    cpuPercent: 0,
    uptimeSec: 45 * 60,
    status: "hung",
    health: "danger",
  });
  state.upsertSession({
    id: "session-003",
    name: "VS Code",
    icon: "💻",
    pid: 29183,
    memoryPercent: 61,
    memoryLabel: "4.9 GB",
    cpuPercent: 4,
    uptimeSec: 5 * 3600 + 2 * 60,
    status: "running",
    health: "ok",
  });

  state.upsertMachine({
    id: "machine-a",
    name: "Machine A",
    specs: "8c / 32GB / local",
    online: true,
    load: 0.4,
  });
  state.upsertMachine({
    id: "machine-b",
    name: "Machine B",
    specs: "16c / 64GB / rack",
    online: true,
    load: 0.62,
  });
  state.upsertMachine({
    id: "vultr-sjc",
    name: "Vultr SJC",
    specs: "4c / 8GB / cloud",
    online: true,
    load: 0.2,
  });

  state.setMigrationsToday(2);
  state.setMigrationHistory([
    {
      id: "mig-1",
      sessionId: "session-000",
      startedAt: Date.now() - 86400000,
      endedAt: Date.now() - 86400000 + 120000,
      success: true,
      cost: "—",
    },
  ]);

  state.appendLog("session-001 · blender started in xpra session :10", "ok");
  state.appendLog("lxc container gpms-001 ready", "info");
  state.appendLog("session-002 · unresponsive — hang detected", "warn");
}

/**
 * @param {string} cmd
 */
export function mockLaunch(cmd) {
  const id = `session-${String(++seq).padStart(3, "0")}`;
  const name = cmd.replace(/^gpms\s+run\s+/i, "").slice(0, 32) || "app";
  state.upsertSession({
    id,
    name,
    icon: "📦",
    pid: 30000 + Math.floor(Math.random() * 10000),
    memoryPercent: 20 + Math.floor(Math.random() * 30),
    memoryLabel: "—",
    cpuPercent: 1,
    uptimeSec: 0,
    status: "running",
    health: "ok",
  });
  state.appendLog(`${id} · started (${cmd})`, "ok");
}

let pulseHandle = 0;
function startMetricsPulse() {
  pulseHandle = setInterval(() => {
    const s = state.getState().sessions;
    for (const id of Object.keys(s)) {
      const se = s[id];
      if (se.status === "migrating") continue;
      const mem = Math.min(
        99,
        (se.memoryPercent || 30) + (Math.random() > 0.5 ? 1 : -1),
      );
      const cpu = Math.max(
        0,
        Math.min(100, (se.cpuPercent || 0) + (Math.random() * 4 - 2)),
      );
      const uptimeSec = (se.uptimeSec || 0) + 2;
      state.upsertSession({
        ...se,
        id,
        memoryPercent: mem,
        cpuPercent: cpu,
        uptimeSec,
        memoryLabel: mem > 0 ? `~${(mem / 20).toFixed(1)} GB` : se.memoryLabel,
      });
    }
  }, 2000);
  track(pulseHandle);
}

let logHandle = 0;
function startRandomLog() {
  logHandle = setInterval(() => {
    if (Math.random() < 0.2) {
      state.appendLog("health check · all sessions accounted for", "info");
    }
  }, 8000);
  track(logHandle);
}

/**
 * @param {string} sessionId
 * @param {string} [target]
 */
export function mockMigrate(sessionId, target = "machine-b") {
  const s = state.getState().sessions[sessionId];
  if (!s) return;
  state.upsertSession({ ...s, id: sessionId, status: "migrating", health: "warn" });
  state.setActiveMigration(sessionId, {
    sessionId,
    target,
    stepIndex: 0,
    percent: 0,
    stepLabels: [...STEP_LABELS],
  });
  state.appendLog(`${sessionId} · migration started → ${target}`, "warn");

  let pct = 0;
  const tick = setInterval(() => {
    pct += 8 + Math.floor(Math.random() * 4);
    if (pct > 100) pct = 100;
    const stepIndex = Math.min(Math.floor((pct / 100) * 4), 3);
    state.setActiveMigration(sessionId, {
      sessionId,
      target,
      stepIndex: pct >= 100 ? 3 : stepIndex,
      percent: pct,
      stepLabels: [...STEP_LABELS],
    });
    if (pct >= 100) {
      clearInterval(tick);
      const idx = timers.indexOf(tick);
      if (idx >= 0) timers.splice(idx, 1);
      state.clearActiveMigration(sessionId);
      state.upsertSession({
        ...s,
        id: sessionId,
        status: "running",
        health: "ok",
        memoryPercent: Math.max(10, (s.memoryPercent || 50) - 5),
      });
      state.addMigrationRecord({
        id: `mig-mock-${Date.now()}`,
        sessionId,
        startedAt: Date.now() - 15000,
        endedAt: Date.now(),
        success: true,
        cost: "—",
        message: `restored on ${target}`,
      });
      state.setMigrationsToday((state.getState().migrationsToday || 0) + 1);
      state.appendLog(`${sessionId} · migration complete on ${target}`, "ok");
    }
  }, 200);
  track(tick);
}

/**
 * @param {string} sessionId
 */
export function mockCheckpoint(sessionId) {
  state.appendLog(`checkpoint · ${sessionId} (mock)`, "info");
}

/**
 * @param {string} sessionId
 */
export function mockKill(sessionId) {
  state.removeSession(sessionId);
  state.appendLog(`session ${sessionId} · killed (mock)`, "warn");
}

/**
 * @param {string} sessionId
 */
export function mockFetchSessionDetail(sessionId) {
  return Promise.resolve({
    sessionId,
    processTree: [
      { name: "systemd", pid: 1, children: [{ name: "xpra", pid: 1200 }] },
      {
        name: "blender",
        pid: 38291,
        children: [],
      },
    ],
    memoryHistory: [20, 22, 25, 30, 35, 40, 42, 44, 42],
    container: { name: "gpms-box", id: "lxc-001" },
  });
}

/**
 * @param {string} [sessionId]
 */
export function mockSessionHung(sessionId = "session-002") {
  const s = state.getState().sessions[sessionId];
  if (s) {
    state.upsertSession({ ...s, id: sessionId, status: "hung", health: "danger" });
    state.appendLog(`${sessionId} · hang detector triggered (mock)`, "warn");
  }
}

export function startMock() {
  stopMock();
  state.resetToInitial();
  state.setUseMock(true);
  state.setConnection("connected");
  state.setServerMeta({ useMock: true });
  seed();
  startMetricsPulse();
  startRandomLog();
  track(
    setTimeout(() => {
      if (state.getState().sessions["session-002"]?.status === "hung") {
        state.appendLog("session-002 · auto-migrate available", "info");
      }
    }, 4000),
  );
}
