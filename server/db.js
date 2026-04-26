import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "gridlock.db");
const schemaPath = path.join(__dirname, "schema.sql");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function tableExists(name) {
  const r = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
    )
    .get(name);
  return !!r;
}

if (!tableExists("sessions")) {
  const schema = fs.readFileSync(schemaPath, "utf8");
  db.exec(schema);
}

function migrationColumnNames() {
  return db.prepare("PRAGMA table_info(migrations)").all().map((r) => r.name);
}

function ensureMigrationColumn(name, ddl) {
  if (!tableExists("migrations")) return;
  const cols = migrationColumnNames();
  if (cols.includes(name)) return;
  db.exec(`ALTER TABLE migrations ADD COLUMN ${name} ${ddl}`);
}

function migrateMigrationsSolanaColumns() {
  ensureMigrationColumn("payment_lamports", "INTEGER");
  ensureMigrationColumn("payment_signature", "TEXT");
  ensureMigrationColumn("payer_pubkey", "TEXT");
  ensureMigrationColumn("payment_status", "TEXT DEFAULT 'none'");
  ensureMigrationColumn("payment_error", "TEXT");
  ensureMigrationColumn("transport_kind", "TEXT DEFAULT 'ssh'");
  ensureMigrationColumn("dcp_job_id", "TEXT");
  ensureMigrationColumn("dcp_scheduler_url", "TEXT");
  ensureMigrationColumn("dcp_status", "TEXT");
  ensureMigrationColumn("dcp_error", "TEXT");
  ensureMigrationColumn("dcp_result_json", "TEXT");
}

migrateMigrationsSolanaColumns();

function ensureSettingDefault(key, value) {
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))",
  ).run(key, String(value));
}

ensureSettingDefault("migration_transport", "ssh");

function sessionColumnNames() {
  return db.prepare("PRAGMA table_info(sessions)").all().map((r) => r.name);
}

function ensureSessionColumn(name, ddl) {
  if (!tableExists("sessions")) return;
  const cols = sessionColumnNames();
  if (cols.includes(name)) return;
  db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${ddl}`);
}

ensureSessionColumn("xpra_tunnel_pid", "INTEGER");

function machineColumnNames() {
  return db.prepare("PRAGMA table_info(machines)").all().map((r) => r.name);
}

function ensureMachineColumn(name, ddl) {
  if (!tableExists("machines")) return;
  const cols = machineColumnNames();
  if (cols.includes(name)) return;
  db.exec(`ALTER TABLE machines ADD COLUMN ${name} ${ddl}`);
}

ensureMachineColumn("worker_url", "TEXT");
ensureMachineColumn("worker_token", "TEXT");

/* ——— Sessions ——— */

export function getSession(id) {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
}

export function listSessions({ status, limit = 200 } = {}) {
  if (status && status !== "all") {
    return db
      .prepare(
        "SELECT * FROM sessions WHERE status = ? ORDER BY COALESCE(started_at, 0) DESC LIMIT ?",
      )
      .all(status, limit);
  }
  return db
    .prepare(
      "SELECT * FROM sessions ORDER BY COALESCE(started_at, 0) DESC LIMIT ?",
    )
    .all(limit);
}

export function listSessionsAll(limit = 200) {
  return listSessions({ limit });
}

export function insertSession(row) {
  const stmt = db.prepare(`
    INSERT INTO sessions (id, machine_id, command, app_name, pid, xpra_display, container_id, status, started_at)
    VALUES (@id, @machine_id, @command, @app_name, @pid, @xpra_display, @container_id, @status, @started_at)
  `);
  stmt.run({
    id: row.id,
    machine_id: row.machine_id || config.localMachineId,
    command: row.command,
    app_name: row.app_name ?? null,
    pid: row.pid ?? null,
    xpra_display: row.xpra_display ?? null,
    container_id: row.container_id ?? null,
    status: row.status || "starting",
    started_at: row.started_at ?? Math.floor(Date.now() / 1000),
  });
}

export function updateSession(id, fields) {
  const keys = Object.keys(fields).filter((k) => k !== "id");
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE sessions SET ${set} WHERE id = @id`).run({
    id,
    ...fields,
  });
}

export function updateSessionStatus(id, status, extra = {}) {
  updateSession(id, { status, ...extra });
}

export function deleteSession(id) {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

/* ——— Machines ——— */

export function getMachine(id) {
  return db.prepare("SELECT * FROM machines WHERE id = ?").get(id);
}

export function listMachines() {
  return db.prepare("SELECT * FROM machines ORDER BY is_local DESC, id").all();
}

export function upsertMachine(m) {
  const existing = getMachine(m.id);
  if (existing) {
    const keys = [
      "label",
      "hostname",
      "is_local",
      "ip",
      "ssh_user",
      "ssh_key_path",
      "kernel",
      "cpu_cores",
      "ram_gb",
      "gpu",
      "worker_url",
      "worker_token",
      "status",
      "last_seen",
    ];
    const updates = [];
    const params = { id: m.id };
    for (const k of keys) {
      if (m[k] !== undefined) {
        updates.push(`${k} = @${k}`);
        params[k] = m[k];
      }
    }
    if (updates.length) {
      db.prepare(`UPDATE machines SET ${updates.join(", ")} WHERE id = @id`).run(
        params,
      );
    }
    return;
  }
  db.prepare(`
    INSERT INTO machines (id, label, hostname, is_local, ip, ssh_user, ssh_key_path, kernel, cpu_cores, ram_gb, gpu, worker_url, worker_token, status, last_seen)
    VALUES (@id, @label, @hostname, @is_local, @ip, @ssh_user, @ssh_key_path, @kernel, @cpu_cores, @ram_gb, @gpu, @worker_url, @worker_token, @status, @last_seen)
  `).run({
    id: m.id,
    label: m.label || m.id,
    hostname: m.hostname ?? null,
    is_local: m.is_local ? 1 : 0,
    ip: m.ip ?? null,
    ssh_user: m.ssh_user ?? null,
    ssh_key_path: m.ssh_key_path ?? null,
    kernel: m.kernel ?? null,
    cpu_cores: m.cpu_cores ?? null,
    ram_gb: m.ram_gb ?? null,
    gpu: m.gpu ?? null,
    worker_url: m.worker_url ?? null,
    worker_token: m.worker_token ?? null,
    status: m.status || "offline",
    last_seen: m.last_seen ?? null,
  });
}

export function deleteMachine(id) {
  return db.prepare("DELETE FROM machines WHERE id = ?").run(id);
}

/* ——— Migrations ——— */

export function getMigration(id) {
  return db.prepare("SELECT * FROM migrations WHERE id = ?").get(id);
}

export function listMigrations(limit = 100) {
  return db
    .prepare(
      "SELECT * FROM migrations ORDER BY COALESCE(started_at, 0) DESC LIMIT ?",
    )
    .all(limit);
}

export function insertMigration(row) {
  db.prepare(`
    INSERT INTO migrations (id, session_id, from_machine_id, to_machine_id, transport_kind, status, started_at)
    VALUES (@id, @session_id, @from_machine_id, @to_machine_id, @transport_kind, @status, @started_at)
  `).run({
    id: row.id,
    session_id: row.session_id,
    from_machine_id: row.from_machine_id,
    to_machine_id: row.to_machine_id,
    transport_kind: row.transport_kind || "ssh",
    status: row.status || "pending",
    started_at: row.started_at ?? Math.floor(Date.now() / 1000),
  });
}

export function updateMigration(id, fields) {
  const keys = Object.keys(fields).filter((k) => k !== "id");
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE migrations SET ${set} WHERE id = @id`).run({
    id,
    ...fields,
  });
}

export function listPendingSolanaPayments() {
  return db
    .prepare(
      `SELECT * FROM migrations
       WHERE status = 'completed'
         AND COALESCE(payment_status, 'none') = 'pending'
         AND COALESCE(payment_lamports, 0) > 0
       ORDER BY COALESCE(completed_at, 0) DESC`,
    )
    .all();
}

/* ——— Log ——— */

export function insertLog({ level, session_id, message, timestamp } = {}) {
  db.prepare(
    "INSERT INTO log_entries (level, session_id, message, timestamp) VALUES (?, ?, ?, ?)",
  ).run(
    level || "info",
    session_id ?? null,
    message,
    timestamp ?? Math.floor(Date.now() / 1000),
  );
  return db.prepare("SELECT last_insert_rowid() as id").get().id;
}

export function getLogTail(n = 200) {
  return db
    .prepare(
      "SELECT id, timestamp, level, session_id, message FROM log_entries ORDER BY id DESC LIMIT ?",
    )
    .all(n)
    .reverse();
}

/* ——— Settings ——— */

export function getSetting(key) {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return r ? r.value : null;
}

export function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')",
  ).run(key, String(value));
}

export function getAllSettings() {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const o = {};
  for (const r of rows) o[r.key] = r.value;
  return o;
}

export function setSettingsMap(obj) {
  const run = db.transaction(() => {
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) setSetting(k, v);
    }
  });
  run();
}

export { db, dbPath };
