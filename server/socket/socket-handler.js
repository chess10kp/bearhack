import { S } from "./events.js";
import * as db from "../db.js";
import * as sessions from "../services/sessions.js";
import * as migration from "../services/migration.js";
import { config } from "../config.js";

/**
 * @param {import("socket.io").Server} io
 */
export function registerSocketHandlers(io) {
  io.on("connection", (socket) => {
    const list = db.listSessionsAll(500).map((row) => sessions.sessionToPayload(row));
    socket.emit(S.sessionList, list);
    socket.emit(S.machineList, db.listMachines());
    for (const e of db.getLogTail(80)) {
      socket.emit(S.logEntry, {
        level: e.level,
        message: e.message,
        session_id: e.session_id,
      });
    }

    socket.on(S.sessionLaunch, async (payload) => {
      const cmd = payload && payload.command;
      if (!cmd || typeof cmd !== "string" || !cmd.trim()) {
        return;
      }
      try {
        await sessions.launchSession(cmd.trim());
      } catch (e) {
        db.insertLog({ level: "error", message: `session:launch ${e.message}` });
        socket.emit(S.logEntry, { level: "error", message: String(e.message) });
      }
    });

    socket.on(S.sessionMigrate, (payload) => {
      const sid = payload && (payload.sessionId || payload.id);
      if (!sid) return;
      if (migration.isLocked()) {
        socket.emit(S.logEntry, {
          level: "warn",
          message: "migration already in progress",
        });
        return;
      }
      const target =
        (payload && payload.targetMachineId) ||
        db.getSetting("default_remote") ||
        config.defaultRemote;
      const transportKind =
        payload && typeof payload.transportKind === "string"
          ? payload.transportKind
          : undefined;
      if (!target) {
        socket.emit(S.logEntry, { level: "error", message: "no default_remote" });
        return;
      }
      migration.execute(String(sid), String(target), { transportKind }).catch((e) => {
        console.error(e);
      });
    });

    socket.on(S.sessionKill, (payload) => {
      const sid = payload && (payload.sessionId || payload.id);
      if (!sid) return;
      sessions.killSession(String(sid));
    });

    socket.on(S.sessionCheckpoint, async (payload) => {
      const sid = payload && (payload.sessionId || payload.id);
      if (!sid) return;
      try {
        await sessions.manualCheckpoint(String(sid));
        io.emit(S.logEntry, {
          level: "ok",
          message: `checkpoint ok for ${sid}`,
        });
      } catch (e) {
        io.emit(S.logEntry, {
          level: "error",
          message: `checkpoint failed: ${e.message}`,
        });
      }
    });
  });
}
