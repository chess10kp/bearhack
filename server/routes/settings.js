import { Router } from "express";
import * as db from "../db.js";

export function createSettingsRouter() {
  const r = Router();

  r.get("/", (_req, res) => {
    res.json(db.getAllSettings());
  });

  r.put("/", (req, res) => {
    const b = req.body;
    if (!b || typeof b !== "object") {
      res.status(400).json({ error: "object body required" });
      return;
    }
    db.setSettingsMap(b);
    res.json(db.getAllSettings());
  });

  return r;
}
