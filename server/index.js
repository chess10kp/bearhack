import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { config, warnCriuPrivileges } from "./config.js";
import * as db from "./db.js";
import { setCtx } from "./context.js";
import { createSessionsRouter } from "./routes/sessions.js";
import { createMachinesRouter } from "./routes/machines.js";
import { createMigrateRouter } from "./routes/migrate.js";
import { createCheckpointRouter } from "./routes/checkpoint.js";
import { createSettingsRouter } from "./routes/settings.js";
import { createSolanaRouter } from "../solana/routes.js";
import { registerSocketHandlers } from "./socket/socket-handler.js";
import { getIo } from "./context.js";
import * as sessions from "./services/sessions.js";

warnCriuPrivileges();

setCtx({
  getSetting: (k) => db.getSetting(k),
});

const ck = path.join(config.serverDir, config.checkpointDir);
fs.mkdirSync(ck, { recursive: true });

function seedMachines() {
  db.upsertMachine({
    id: config.localMachineId,
    label: "Local",
    hostname: os.hostname(),
    is_local: 1,
    ip: "127.0.0.1",
    status: "online",
    last_seen: Math.floor(Date.now() / 1000),
    kernel: os.release(),
    cpu_cores: os.cpus().length,
    ram_gb: memGb(),
  });
  const dr = db.getSetting("default_remote") || config.defaultRemote;
  if (dr && !db.getMachine(dr)) {
    db.upsertMachine({
      id: dr,
      label: "Remote (default)",
      is_local: 0,
      status: "offline",
    });
  }
}

function memGb() {
  try {
    return os.totalmem() / (1024 * 1024 * 1024);
  } catch {
    return 0;
  }
}

function crashRecovery() {
  const now = Math.floor(Date.now() / 1000);
  const r = db.db.prepare(
    "UPDATE sessions SET status = 'crashed', ended_at = ? WHERE status IN ('migrating', 'checkpointing', 'restoring')",
  ).run(now);
  if (r.changes > 0) {
    db.insertLog({
      level: "warn",
      message: `Marked ${r.changes} interrupted session(s) as crashed on startup`,
    });
  }
  const running = db.listSessions({ status: "running" });
  for (const s of running) {
    sessions.startMonitorIfLocal(s.id);
  }
}

seedMachines();
crashRecovery();

const app = express();
const allowedOrigins = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

app.use(
  cors({
    origin(origin, cb) {
      if (isAllowedOrigin(origin)) {
        cb(null, true);
      } else {
        cb(new Error(`origin not allowed: ${origin}`));
      }
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "gpms-server" });
});

app.use("/api/sessions", createSessionsRouter());
app.use("/api/machines", createMachinesRouter());
app.use("/api/migrations", createMigrateRouter());
app.use("/api/checkpoints", createCheckpointRouter());
app.use("/api/settings", createSettingsRouter());
app.use("/api/solana", createSolanaRouter({ db, getIo }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin(origin, cb) {
      if (isAllowedOrigin(origin)) {
        cb(null, true);
      } else {
        cb(new Error(`origin not allowed: ${origin}`));
      }
    },
    credentials: true,
  },
});

setCtx({ io });
registerSocketHandlers(io);

server.listen(config.port, () => {
  console.log(`GPMS server running on http://localhost:${config.port}`);
});
