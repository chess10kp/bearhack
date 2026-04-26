const MAX_LOG = 500;

const defaultSettings = {
  hangTimeoutSec: 30,
  autoMigrate: true,
  defaultTarget: "machine-b",
  sshKeyPath: "",
};

const initial = {
  connection: "connecting", // 'connecting' | 'connected' | 'disconnected'
  serverUrl: "http://localhost:3000",
  /** @type {Record<string, Session>} */
  sessions: {},
  /** @type {Record<string, Machine>} */
  machines: {},
  /** @type {LogLine[]} */
  log: [],
  /** @type {Record<string, ActiveMigration>} */
  migrationBySession: {},
  /** @type {MigrationRecord[]} */
  migrationHistory: [],
  settings: { ...defaultSettings },
  /** @type {SessionDetail | null} */
  sessionDetail: null,
  selectedSessionId: null,
  inspectorOpen: false,
  inspectorLoading: false,
  migrationsToday: 0,
  useMock: false,
  gemmaDecision: null,
  gemmaStatus: null,
  /** @type {string} */
  solanaCluster: "devnet",
};

let state = structuredClone(initial);

const subs = new Set();

/** @param {(s: typeof state) => void} fn */
export function subscribe(fn) {
  subs.add(fn);
  fn(state);
  return () => subs.delete(fn);
}

function notify() {
  for (const f of subs) f(state);
}

export function getState() {
  return state;
}

export function resetToInitial() {
  state = structuredClone(initial);
  notify();
}

export function setServerMeta({ serverUrl, useMock } = {}) {
  state = {
    ...state,
    ...(serverUrl != null ? { serverUrl } : {}),
    ...(useMock != null ? { useMock } : {}),
  };
  notify();
}

export function setConnection(c) {
  state = { ...state, connection: c };
  notify();
}

export function setUseMock(m) {
  state = { ...state, useMock: m };
  notify();
}

/**
 * @param {Partial<Session> & { id: string }} data
 */
export function upsertSession(data) {
  if (!data || !data.id) return;
  const prev = state.sessions[data.id] || {};
  state = {
    ...state,
    sessions: {
      ...state.sessions,
      [data.id]: { ...prev, ...data, id: data.id },
    },
  };
  notify();
}

/** @param {string} id */
export function removeSession(id) {
  if (!id || !state.sessions[id]) return;
  const { [id]: _removed, ...rest } = state.sessions;
  const migrationBySession = { ...state.migrationBySession };
  delete migrationBySession[id];
  let selectedSessionId = state.selectedSessionId;
  if (selectedSessionId === id) {
    selectedSessionId = null;
  }
  state = {
    ...state,
    sessions: rest,
    migrationBySession,
    selectedSessionId,
    sessionDetail:
      state.selectedSessionId === id ? null : state.sessionDetail,
  };
  notify();
}

/**
 * @param {string} message
 * @param {'ok'|'warn'|'err'|'info'} cls
 */
export function appendLog(message, cls = "info") {
  const line = { ts: logTs(), message, cls };
  const log = [...state.log, line].slice(-MAX_LOG);
  state = { ...state, log };
  notify();
  return line;
}

function logTs() {
  return new Date().toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * @param {string} sessionId
 * @param {Partial<ActiveMigration>} data
 */
export function setActiveMigration(sessionId, data) {
  if (!sessionId) return;
  const prev = state.migrationBySession[sessionId] || {};
  state = {
    ...state,
    migrationBySession: {
      ...state.migrationBySession,
      [sessionId]: { ...prev, ...data, sessionId },
    },
  };
  notify();
}

/** @param {string} sessionId */
export function clearActiveMigration(sessionId) {
  if (!state.migrationBySession[sessionId]) return;
  const { [sessionId]: _m, ...rest } = state.migrationBySession;
  state = { ...state, migrationBySession: rest };
  notify();
}

/** @param {MigrationRecord} rec */
export function addMigrationRecord(rec) {
  state = {
    ...state,
    migrationHistory: [rec, ...state.migrationHistory].slice(0, 200),
  };
  notify();
}

/**
 * @param {string} migrationId
 * @param {Partial<MigrationRecord>} patch
 */
export function patchMigrationRecordByMigrationId(migrationId, patch) {
  if (!migrationId) return;
  const migrationHistory = state.migrationHistory.map((r) => {
    if (r.migrationId === migrationId || r.id === migrationId) {
      return { ...r, ...patch };
    }
    return r;
  });
  state = { ...state, migrationHistory };
  notify();
}

/** @param {string} cluster */
export function setSolanaCluster(cluster) {
  if (!cluster) return;
  state = { ...state, solanaCluster: String(cluster) };
  notify();
}

export function setMigrationHistory(list) {
  state = { ...state, migrationHistory: Array.isArray(list) ? list : [] };
  notify();
}

export function setMachinesList(list) {
  const machines = { ...state.machines };
  for (const m of list || []) {
    if (m && m.id) machines[m.id] = { ...machines[m.id], ...m, id: m.id };
  }
  state = { ...state, machines };
  notify();
}

/** @param {Machine} m */
export function upsertMachine(m) {
  if (!m || !m.id) return;
  const prev = state.machines[m.id] || {};
  state = {
    ...state,
    machines: { ...state.machines, [m.id]: { ...prev, ...m, id: m.id } },
  };
  notify();
}

export function setMigrationsToday(n) {
  const migrationsToday = Number(n) || 0;
  state = { ...state, migrationsToday };
  notify();
}

export function setGemmaDecision(decision) {
  state = { ...state, gemmaDecision: decision };
  notify();
}

export function setGemmaStatus(status) {
  state = { ...state, gemmaStatus: status };
  notify();
}

export function clearGemmaDecision() {
  state = { ...state, gemmaDecision: null, gemmaStatus: null };
  notify();
}

/**
 * @param {SessionDetail | null} detail
 * @param {boolean} [loading]
 */
export function setSessionDetail(detail, loading = false) {
  state = {
    ...state,
    sessionDetail: detail,
    inspectorLoading: loading,
  };
  notify();
}

export function setSelectedSessionId(id) {
  state = {
    ...state,
    selectedSessionId: id,
    inspectorOpen: id != null,
  };
  if (!id) {
    state = { ...state, sessionDetail: null, inspectorOpen: false };
  }
  notify();
}

export function setSettings(s) {
  state = { ...state, settings: { ...state.settings, ...s } };
  notify();
}

// JSDoc types (referenced above)
/**
 * @typedef {object} Session
 * @property {string} id
 * @property {string} [name]
 * @property {string} [icon]
 * @property {number} [pid]
 * @property {number} [memoryPercent]
 * @property {string} [memoryLabel]
 * @property {number} [cpuPercent]
 * @property {number} [uptimeSec]
 * @property {'running'|'hung'|'migrating'|'paused'|'exited'|string} [status]
 * @property {string} [health] ok|warn|danger
 * @property {string} [xpraDisplay]
 * @property {number} [xpraPort]
 * @property {string} [xpraHtmlUrl]
 */

/**
 * @typedef {object} Machine
 * @property {string} id
 * @property {string} [name]
 * @property {string} [specs]
 * @property {boolean} [online]
 * @property {number} [load]
 */

/**
 * @typedef {object} LogLine
 * @property {string} ts
 * @property {string} message
 * @property {string} cls
 */

/**
 * @typedef {object} ActiveMigration
 * @property {string} sessionId
 * @property {string} [target]
 * @property {number} [stepIndex]
 * @property {number} [percent]
 * @property {string[]} [stepLabels]
 * @property {string} [transportKind]
 * @property {string} [dcpStatus]
 * @property {string} [dcpJobId]
 * @property {string} [dcpSchedulerUrl]
 */

/**
 * @typedef {object} MigrationRecord
 * @property {string} id
 * @property {string} [sessionId]
 * @property {number} [startedAt]
 * @property {number} [endedAt]
 * @property {boolean} [success]
 * @property {string} [cost]
 * @property {string} [message]
 * @property {string} [migrationId]
 * @property {string} [solanaSignature]
 * @property {string} [solanaExplorerTx]
 * @property {string} [transportKind]
 * @property {string} [dcpJobId]
 * @property {string} [dcpStatus]
 * @property {string} [dcpError]
 */

/**
 * @typedef {object} SessionDetail
 * @property {string} sessionId
 * @property {object[]} [processTree]
 * @property {number[]} [memoryHistory]
 * @property {object} [container]
 * @property {string} [xpraDisplay]
 * @property {number} [xpraPort]
 * @property {string} [xpraHtmlUrl]
 * @property {object} [payload]
 */
