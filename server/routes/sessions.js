import { Router } from "express";
import * as db from "../db.js";
import * as sessions from "../services/sessions.js";
import * as migration from "../services/migration.js";
import * as xpra from "../services/xpra.js";
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

  r.get("/:id/detail", async (req, res) => {
    const row = db.getSession(req.params.id);
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const logs = db
      .getLogTail(200)
      .filter((l) => l.session_id === row.id)
      .slice(-50);
    let xpraInfoMap = null;
    if (row.xpra_display) {
      try {
        xpraInfoMap = await xpra.info(row.xpra_display);
      } catch { /* session may not be running */ }
    }
    res.json({
      session: row,
      payload: sessions.sessionToPayload(row),
      logs,
      xpraDisplay: row.xpra_display || null,
      xpraPort: row.xpra_display ? xpra.xpraPortForDisplay(row.xpra_display) : null,
      xpraHtmlUrl: row.xpra_display ? xpra.htmlUrl(row.xpra_display) : null,
      xpraInfo: xpraInfoMap,
    });
  });

  r.get("/:id/xpra-info", async (req, res) => {
    const row = db.getSession(req.params.id);
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (!row.xpra_display) {
      res.status(404).json({ error: "session has no xpra display" });
      return;
    }
    try {
      const map = await xpra.info(row.xpra_display);
      res.json({
        ok: true,
        display: row.xpra_display,
        port: xpra.xpraPortForDisplay(row.xpra_display),
        htmlUrl: xpra.htmlUrl(row.xpra_display),
        info: map,
      });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
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
    const session = db.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    if (session.status !== "running" && session.status !== "hung") {
      res.status(409).json({ error: "session not eligible for migration" });
      return;
    }
    const target =
      (req.body && req.body.targetMachineId) ||
      db.getSetting("default_remote") ||
      config.defaultRemote;
    const transportKind =
      req.body && typeof req.body.transportKind === "string"
        ? req.body.transportKind
        : undefined;
    if (!target) {
      res.status(400).json({ error: "no target machine" });
      return;
    }
    const machine = db.getMachine(String(target));
    if (!machine) {
      res.status(404).json({ error: "target machine not found" });
      return;
    }
    if (machine.is_local) {
      res.status(400).json({ error: "target is local; pick a remote machine" });
      return;
    }
    res.status(202).json({
      ok: true,
      targetMachineId: target,
      transportKind:
        transportKind || db.getSetting("migration_transport") || config.migrationTransport,
    });
    setImmediate(() => {
      migration.execute(req.params.id, String(target), { transportKind }).catch((e) => {
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
