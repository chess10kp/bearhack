import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import * as criu from "../services/criu.js";
function cpRoot() {
  return path.resolve(config.serverDir, config.checkpointDir);
}

export function createCheckpointRouter() {
  const r = Router();

  r.get("/", (_req, res) => {
    const root = cpRoot();
    if (!fs.existsSync(root)) {
      res.json([]);
      return;
    }
    const out = [];
    for (const name of fs.readdirSync(root, { withFileTypes: true })) {
      if (name.isDirectory()) {
        const p = path.join(root, name.name);
        out.push({
          id: name.name,
          path: p,
          sizeBytes: criu.getCheckpointSize(p),
        });
      }
    }
    res.json(out);
  });

  r.delete("/:id", (req, res) => {
    const p = path.join(cpRoot(), req.params.id);
    if (!p.startsWith(cpRoot()) || !fs.existsSync(p)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
      return;
    }
    res.json({ ok: true });
  });

  r.post("/:id/restore", async (req, res) => {
    const p = path.join(cpRoot(), req.params.id);
    if (!p.startsWith(cpRoot()) || !fs.existsSync(p)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const ck = path.join(p, "ckpt");
    const dir = fs.existsSync(ck) ? ck : p;
    try {
      const r0 = await criu.restore(dir);
      res.json(r0);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}
