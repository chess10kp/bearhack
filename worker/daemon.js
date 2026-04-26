import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import { config } from "./config.js";
import * as criu from "./services/criu.js";

const execFileAsync = promisify(execFile);

function auth(req, res, next) {
  if (!config.token) return next();
  const authz = String(req.headers.authorization || "");
  const token = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
  if (token !== config.token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

function safeCheckpointPath(inputDir) {
  const p = path.resolve(String(inputDir || ""));
  const base = path.resolve(config.checkpointBaseDir);
  if (!(p === base || p.startsWith(`${base}${path.sep}`))) {
    throw new Error(`checkpoint path must be under ${base}`);
  }
  return p;
}

function signalName(signal) {
  const s = String(signal || "SIGKILL").toUpperCase();
  return s.startsWith("SIG") ? s : `SIG${s}`;
}

function hasProc(pid) {
  return fs.existsSync(`/proc/${pid}`);
}

export async function runDaemon() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "gpms-worker" });
  });

  app.use("/api/worker", auth);

  app.post("/api/worker/checkpoint-dir", (req, res) => {
    try {
      const dir = safeCheckpointPath(req.body?.dir);
      fs.mkdirSync(dir, { recursive: true });
      res.json({ ok: true, dir });
    } catch (err) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  app.post("/api/worker/criu/restore", async (req, res) => {
    try {
      const checkpointDir = safeCheckpointPath(req.body?.checkpointDir);
      const out = await criu.restore(checkpointDir);
      res.json({ ok: true, output: out.output, pid: out.pid || 0 });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.post("/api/worker/process/alive", (req, res) => {
    const pid = Number(req.body?.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      res.status(400).json({ error: "invalid pid" });
      return;
    }
    res.json({ ok: true, alive: hasProc(pid) });
  });

  app.post("/api/worker/process/kill", (req, res) => {
    const pid = Number(req.body?.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      res.status(400).json({ error: "invalid pid" });
      return;
    }
    const sig = signalName(req.body?.signal);
    try {
      process.kill(pid, sig);
      res.json({ ok: true });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (/ESRCH/.test(msg)) {
        res.json({ ok: true });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/worker/xpra/start", async (req, res) => {
    const display = String(req.body?.display || "");
    const port = Number(req.body?.port);
    if (!display) {
      res.status(400).json({ error: "display required" });
      return;
    }
    if (!Number.isFinite(port) || port <= 0) {
      res.status(400).json({ error: "port required" });
      return;
    }
    try {
      await execFileAsync(
        config.xpraBin,
        ["start", display, "--daemon=yes", `--bind-tcp=0.0.0.0:${port}`],
        { maxBuffer: 2 * 1024 * 1024, timeout: 30_000 },
      );
      res.json({ ok: true, display, port });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.post("/api/worker/xpra/stop", async (req, res) => {
    const display = String(req.body?.display || "");
    if (!display) {
      res.status(400).json({ error: "display required" });
      return;
    }
    try {
      await execFileAsync(config.xpraBin, ["stop", display], {
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.get("/api/worker/xpra/list", async (_req, res) => {
    try {
      const { stdout, stderr } = await execFileAsync(config.xpraBin, ["list"], {
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
      });
      const text = `${stdout || ""}${stderr || ""}`;
      res.json({ ok: true, output: text });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  return new Promise((resolve) => {
    const server = app.listen(config.port, config.host, () => {
      resolve(server);
    });
  });
}
