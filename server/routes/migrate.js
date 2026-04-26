import { Router } from "express";
import * as db from "../db.js";

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

  return r;
}
