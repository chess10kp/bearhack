-- GPMS schema — applied when database is first created

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS machines (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  hostname     TEXT,
  is_local     INTEGER DEFAULT 0,
  ip           TEXT,
  ssh_user     TEXT,
  ssh_key_path TEXT,
  kernel       TEXT,
  cpu_cores    INTEGER,
  ram_gb       REAL,
  gpu          TEXT,
  worker_url   TEXT,
  worker_token TEXT,
  status       TEXT DEFAULT 'offline',
  last_seen    INTEGER,
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  machine_id    TEXT NOT NULL DEFAULT 'machine-a',
  command       TEXT NOT NULL,
  app_name      TEXT,
  pid           INTEGER,
  xpra_display  TEXT,
  container_id  TEXT,
  status        TEXT DEFAULT 'starting',
  cpu_percent   REAL DEFAULT 0,
  memory_mb     REAL DEFAULT 0,
  memory_percent REAL DEFAULT 0,
  started_at    INTEGER,
  ended_at      INTEGER,
  xpra_tunnel_pid INTEGER,
  FOREIGN KEY (machine_id) REFERENCES machines(id)
);

CREATE TABLE IF NOT EXISTS migrations (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  from_machine_id    TEXT NOT NULL,
  to_machine_id      TEXT NOT NULL,
  transport_kind     TEXT DEFAULT 'ssh',
  status             TEXT DEFAULT 'pending',
  dcp_job_id         TEXT,
  dcp_scheduler_url  TEXT,
  dcp_status         TEXT,
  dcp_error          TEXT,
  dcp_result_json    TEXT,
  checkpoint_size_mb REAL,
  transfer_seconds   REAL,
  total_seconds      REAL,
  error              TEXT,
  started_at         INTEGER,
  completed_at       INTEGER,
  payment_lamports   INTEGER,
  payment_signature  TEXT,
  payer_pubkey       TEXT,
  payment_status     TEXT DEFAULT 'none',
  payment_error      TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (from_machine_id) REFERENCES machines(id),
  FOREIGN KEY (to_machine_id) REFERENCES machines(id)
);

CREATE TABLE IF NOT EXISTS log_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  INTEGER DEFAULT (strftime('%s','now')),
  level      TEXT DEFAULT 'info',
  session_id TEXT,
  message    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER DEFAULT (strftime('%s','now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('hang_threshold_seconds', '30'),
  ('auto_migrate', 'false'),
  ('migration_transport', 'ssh'),
  ('default_remote', 'machine-b'),
  ('checkpoint_dir', './checkpoints'),
  ('poll_interval_ms', '2000'),
  ('criu_bin', '/usr/sbin/criu'),
  ('xpra_bin', '/usr/bin/xpra'),
  ('lxc_bin', '/usr/bin/lxc-create'),
  ('xpra_html_enabled', 'true'),
  ('xpra_webcam', 'off'),
  ('xpra_pulseaudio', 'off'),
  ('xpra_notifications', 'off'),
  ('xpra_printing', 'off'),
  ('xpra_file_transfer', 'off'),
  ('xpra_dbus', 'off'),
  ('xpra_mdns', 'off'),
  ('gemma_mock', 'true'),
  ('gemma_model', 'gemma-3-27b-it'),
  ('gemma_timeout_ms', '10000'),
  ('gemma_api_key', '');
