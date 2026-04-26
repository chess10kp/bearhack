import { Router } from "express";
import * as db from "../db.js";
import * as transfer from "../services/transfer.js";
import { getIo } from "../context.js";
import { S } from "../socket/events.js";

export function createMachinesRouter() {
  const r = Router();

  r.get("/", (_req, res) => {
    res.json(db.listMachines());
  });

  r.get("/:id", (req, res) => {
    const m = db.getMachine(req.params.id);
    if (!m) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(m);
  });

  r.post("/", (req, res) => {
    const b = req.body || {};
    const id = b.id || `machine-${Date.now()}`;
    db.upsertMachine({
      id,
      label: b.label || id,
      hostname: b.hostname,
      is_local: b.is_local ? 1 : 0,
      ip: b.ip,
      ssh_user: b.ssh_user,
      ssh_key_path: b.ssh_key_path,
      kernel: b.kernel,
      cpu_cores: b.cpu_cores,
      ram_gb: b.ram_gb,
      gpu: b.gpu,
      status: b.status || "online",
      last_seen: Math.floor(Date.now() / 1000),
    });
    const m = db.getMachine(id);
    if (getIo()) {
      getIo().emit(S.machineUpdated, m);
    }
    res.json(m);
  });

  r.put("/:id", (req, res) => {
    const b = req.body || {};
    const id = req.params.id;
    if (!db.getMachine(id)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    db.upsertMachine({
      id,
      label: b.label,
      hostname: b.hostname,
      is_local: b.is_local != null ? (b.is_local ? 1 : 0) : undefined,
      ip: b.ip,
      ssh_user: b.ssh_user,
      ssh_key_path: b.ssh_key_path,
      kernel: b.kernel,
      cpu_cores: b.cpu_cores,
      ram_gb: b.ram_gb,
      gpu: b.gpu,
      status: b.status,
      last_seen: b.last_seen ?? Math.floor(Date.now() / 1000),
    });
    const m = db.getMachine(id);
    if (getIo()) {
      getIo().emit(S.machineUpdated, m);
    }
    res.json(m);
  });

  r.delete("/:id", (req, res) => {
    if (!db.getMachine(req.params.id)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const id = req.params.id;
    db.deleteMachine(id);
    res.json({ ok: true });
  });

  r.post("/:id/test", async (req, res) => {
    const m = db.getMachine(req.params.id);
    if (!m) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const ok = await transfer.testConnection(m);
    const status = ok ? "online" : "offline";
    db.upsertMachine({ ...m, id: m.id, status, last_seen: Math.floor(Date.now() / 1000) });
    const m2 = db.getMachine(m.id);
    if (getIo()) {
      getIo().emit(S.machineUpdated, m2);
    }
    res.json({ ok, status: m2 });
  });

  return r;
}
