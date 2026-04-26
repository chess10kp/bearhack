import { Router } from "express";
import * as db from "../db.js";
import * as dcp from "../services/dcp-client.js";
import * as migration from "../services/migration.js";

export function createMigrateRouter() {
  const r = Router();

  r.get("/", (_req, res) => {
    res.json(db.listMigrations(200));
  });

  r.get("/:id", (req, res) => {
    const m = db.getMigration(req.params.id);
    if (!m) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(m);
  });

  r.get("/:id/dcp", async (req, res) => {
    const m = db.getMigration(req.params.id);
    if (!m) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (!m.dcp_job_id) {
      res.json({
        ok: true,
        migrationId: m.id,
        transportKind: m.transport_kind || "ssh",
        status: m.dcp_status || null,
        jobId: null,
        schedulerUrl: m.dcp_scheduler_url || null,
      });
      return;
    }
    try {
      const st = await dcp.getJobStatus(m.dcp_job_id);
      db.updateMigration(m.id, { dcp_status: st.runStatus || m.dcp_status || "unknown" });
      res.json({
        ok: true,
        migrationId: m.id,
        transportKind: m.transport_kind || "ssh",
        status: st.runStatus,
        jobId: m.dcp_job_id,
        schedulerUrl: m.dcp_scheduler_url || null,
        details: st,
      });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  r.post("/:id/dcp/cancel", async (req, res) => {
    const m = db.getMigration(req.params.id);
    if (!m) {
      res.status(404).json({ error: "not found" });
      return;
    }
    try {
      const out = await dcp.cancelJob({
        migrationId: m.id,
        jobId: m.dcp_job_id || undefined,
      });
      if (out.ok) {
        db.updateMigration(m.id, {
          dcp_status: "cancelled",
          dcp_error: null,
        });
      }
      res.json({ ok: out.ok, migrationId: m.id, ...out });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      db.updateMigration(m.id, {
        dcp_status: "cancel_failed",
        dcp_error: msg,
      });
      res.status(500).json({ error: msg });
    }
  });

  r.post("/:id/dcp/retry", (req, res) => {
    const m = db.getMigration(req.params.id);
    if (!m) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (migration.isLocked()) {
      res.status(409).json({ error: "Migration already in progress" });
      return;
    }
    const sid = m.session_id;
    const target = m.to_machine_id;
    if (!sid || !target) {
      res.status(400).json({ error: "migration row missing session/target" });
      return;
    }
    res.status(202).json({
      ok: true,
      retrying: true,
      sessionId: sid,
      targetMachineId: target,
      transportKind: "dcp",
    });
    setImmediate(() => {
      migration.execute(String(sid), String(target), { transportKind: "dcp" }).catch((e) => {
        console.error("dcp retry", e);
      });
    });
  });

  return r;
}
