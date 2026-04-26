import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import { config } from "./config.js";
import * as criu from "./services/criu.js";
import * as pageServer from "./services/page-server.js";
import * as migration from "./services/migration.js";

const execFileAsync = promisify(execFile);

function migrationRoot(migrationId) {
  if (!migrationId || !/^[A-Za-z0-9_.\-]+$/.test(String(migrationId))) {
    throw new Error("invalid migrationId");
  }
  const base = path.resolve(config.checkpointBaseDir);
  const root = path.resolve(base, "migrations", String(migrationId));
  if (!root.startsWith(`${base}${path.sep}`)) {
    throw new Error("path escape");
  }
  return root;
}

function snapshotDir(migrationId, snapshotIndex) {
  const root = migrationRoot(migrationId);
  const idx = Number(snapshotIndex);
  if (!Number.isFinite(idx) || idx < 0) throw new Error("invalid snapshotIndex");
  return { root, dir: path.join(root, String(idx)), index: idx };
}

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
        [
          "start",
          display,
          "--daemon=yes",
          `--bind-tcp=0.0.0.0:${port}`,
          "--html=on",
          "--webcam=no",
          "--mdns=no",
          "--pulseaudio=no",
          "--notifications=no",
          "--printing=no",
          "--file-transfer=no",
          "--dbus=no",
        ],
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

  // ---- live migration (CRIU page-server pre-copy) ----

  app.post("/api/worker/migration/prepare", (req, res) => {
    try {
      const migrationId = String(req.body?.migrationId || "");
      const snapshotIndex = Number(req.body?.snapshotIndex);
      const root = migrationRoot(migrationId);
      const r = migration.prepareSnapshot({
        migrationId,
        snapshotIndex,
        root,
      });
      res.json({ ok: true, root: r.root, dir: r.dir, snapshotIndex });
    } catch (err) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  app.post("/api/worker/migration/page-server/start", async (req, res) => {
    try {
      const migrationId = String(req.body?.migrationId || "");
      const snapshotIndex = Number(req.body?.snapshotIndex);
      const port = Number(req.body?.port);
      if (!Number.isFinite(port) || port <= 0) {
        throw new Error("port required");
      }
      const { dir } = snapshotDir(migrationId, snapshotIndex);
      fs.mkdirSync(dir, { recursive: true });
      const r = await pageServer.start({ port, dir });
      res.json({
        ok: true,
        port: r.port,
        dir: r.dir,
        pid: r.pid,
        logFile: r.logFile,
      });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.post("/api/worker/migration/page-server/wait", async (req, res) => {
    try {
      const port = Number(req.body?.port);
      const timeoutMs = Number(req.body?.timeoutMs) || 600_000;
      const r = await pageServer.waitExit(port, timeoutMs);
      res.json(r);
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.post("/api/worker/migration/page-server/stop", (req, res) => {
    const port = Number(req.body?.port);
    res.json(pageServer.stop(port));
  });

  app.get("/api/worker/migration/page-server/list", (_req, res) => {
    res.json({ ok: true, servers: pageServer.list() });
  });

  // Raw upload of one metadata image file into a snapshot dir.
  // Body is the raw file bytes; ?name= is the filename (no slashes).
  app.put(
    "/api/worker/migration/file",
    express.raw({ type: "*/*", limit: "256mb" }),
    (req, res) => {
      try {
        const migrationId = String(req.query.migrationId || "");
        const snapshotIndex = Number(req.query.snapshotIndex);
        const name = String(req.query.name || "");
        if (!name || /[\\/\0]/.test(name) || name === "." || name === "..") {
          throw new Error("invalid name");
        }
        const { dir } = snapshotDir(migrationId, snapshotIndex);
        fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, name);
        fs.writeFileSync(target, req.body || Buffer.alloc(0));
        res.json({ ok: true, path: target, bytes: (req.body || []).length });
      } catch (err) {
        res.status(400).json({ error: err.message || String(err) });
      }
    },
  );

  app.post("/api/worker/migration/restore", async (req, res) => {
    try {
      const migrationId = String(req.body?.migrationId || "");
      const snapshotIndex = Number(req.body?.snapshotIndex);
      const root = migrationRoot(migrationId);
      const r = await migration.restoreFromSnapshot({
        root,
        snapshotIndex,
        shellJob: req.body?.shellJob !== false,
        extraArgs: Array.isArray(req.body?.extraArgs)
          ? req.body.extraArgs.map(String)
          : [],
      });
      res.json(r);
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // Fallback: extract a tarball of a complete dump dir uploaded via PUT /file.
  app.post("/api/worker/migration/extract", async (req, res) => {
    try {
      const migrationId = String(req.body?.migrationId || "");
      const snapshotIndex = Number(req.body?.snapshotIndex);
      const tarName = String(req.body?.tarName || "dump.tar");
      const { dir } = snapshotDir(migrationId, snapshotIndex);
      const tarPath = path.join(dir, tarName);
      const r = await migration.extractDumpTar({ tarPath, destDir: dir });
      res.json(r);
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

  app.get("/api/worker/xpra/info", async (req, res) => {
    const display = String(req.query.display || "");
    if (!display) {
      res.status(400).json({ error: "display query param required" });
      return;
    }
    try {
      const { stdout } = await execFileAsync(config.xpraBin, ["info", display], {
        maxBuffer: 4 * 1024 * 1024,
        timeout: 10_000,
      });
      const map = {};
      for (const line of String(stdout).split("\n")) {
        const idx = line.indexOf("=");
        if (idx > 0) {
          map[line.slice(0, idx)] = line.slice(idx + 1);
        }
      }
      res.json({ ok: true, display, info: map });
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
