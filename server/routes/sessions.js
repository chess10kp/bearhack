import { Router } from "express";
import * as db from "../db.js";
import * as sessions from "../services/sessions.js";
import * as migration from "../services/migration.js";
import { config } from "../config.js";
import { markHungManually } from "../services/hang-detector.js";

export function createSessionsRouter() {
  const r = Router();

  r.post("/", async (req, res) => {
    const cmd = req.body && req.body.command;
    if (!cmd || typeof cmd !== "string" || !cmd.trim()) {
      res.status(400).json({ error: "command required" });
      return;
    }
    try {
      const row = await sessions.launchSession(cmd.trim());
      res.json(sessions.sessionToPayload(row));
    } catch (e) {
      db.insertLog({ level: "error", message: `launch: ${e.message}` });
      res.status(500).json({ error: e.message });
    }
  });

  r.get("/", (req, res) => {
    const status = req.query.status;
    const list = db.listSessions({
      status: status ? String(status) : undefined,
    });
    res.json(list.map((row) => sessions.sessionToPayload(row)));
  });

  r.get("/:id", (req, res) => {
    const row = db.getSession(req.params.id);
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(sessions.sessionToPayload(row));
  });

  r.get("/:id/detail", (req, res) => {
    const row = db.getSession(req.params.id);
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const logs = db
      .getLogTail(200)
      .filter((l) => l.session_id === row.id)
      .slice(-50);
    res.json({
      session: row,
      payload: sessions.sessionToPayload(row),
      logs,
    });
  });

  r.delete("/:id", (req, res) => {
    const out = sessions.killSession(req.params.id);
    if (!out.ok) {
      res.status(404).json(out);
      return;
    }
    res.json({ ok: true });
  });

  r.post("/:id/checkpoint", async (req, res) => {
    try {
      const result = await sessions.manualCheckpoint(req.params.id);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post("/:id/migrate", (req, res) => {
    if (migration.isLocked()) {
      res.status(409).json({ error: "Migration already in progress" });
      return;
    }
    const target =
      (req.body && req.body.targetMachineId) ||
      db.getSetting("default_remote") ||
      config.defaultRemote;
    if (!target) {
      res.status(400).json({ error: "no target machine" });
      return;
    }
    res.status(202).json({ ok: true, targetMachineId: target });
    setImmediate(() => {
      migration.execute(req.params.id, String(target)).catch((e) => {
        console.error("migrate", e);
      });
    });
  });

  r.post("/:id/hang", (req, res) => {
    const s = db.getSession(req.params.id);
    if (!s) {
      res.status(404).json({ error: "not found" });
      return;
    }
    markHungManually(req.params.id);
    res.json({ ok: true });
  });

  return r;
}
