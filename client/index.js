#!/usr/bin/env node
import { Command } from "commander";
import dotenv from "dotenv";
import { config, runStartupChecks } from "./config.js";
import { runDaemon } from "./daemon.js";
import * as criu from "./services/criu.js";

dotenv.config();

const program = new Command();
program.name("gpms-client").description("GPMS local agent (daemon, CRIU, /proc)").version("0.1.0");

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function rest(path, init = {}) {
  const u = `${config.SERVER_URL}${path.startsWith("/") ? path : `/${path}`}`;
  return fetch(u, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

async function printJsonOrError(r) {
  const t = await r.text();
  if (!r.ok) {
    process.stderr.write(`HTTP ${r.status}: ${t}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const j = JSON.parse(t);
    console.log(JSON.stringify(j, null, 2));
  } catch {
    console.log(t);
  }
}

program
  .command("daemon")
  .description("Start background daemon (connect to server, monitor processes)")
  .option("--no-criu-check", "skip CRIU version check (dev only)")
  .action(async (opts) => {
    try {
      await runDaemon({ skipCriuCheck: opts.criuCheck === false });
    } catch (e) {
      console.error((e && e.message) || e);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("show sessions (REST)")
  .action(async () => {
    try {
      const r = await rest("/api/sessions");
      await printJsonOrError(r);
    } catch (e) {
      console.error((e && e.message) || e);
      process.exit(1);
    }
  });

program
  .command("migrate")
  .argument("<sessionId>", "session id")
  .description("POST migrate for session (REST)")
  .action(async (sessionId) => {
    try {
      const r = await rest(`/api/sessions/${encodeURIComponent(sessionId)}/migrate`, {
        method: "POST",
      });
      await printJsonOrError(r);
    } catch (e) {
      console.error((e && e.message) || e);
      process.exit(1);
    }
  });

program
  .command("checkpoint")
  .argument("<sessionId>", "session id")
  .description("Request checkpoint (REST; server may forward to client)")
  .action(async (sessionId) => {
    try {
      const r = await rest(`/api/sessions/${encodeURIComponent(sessionId)}/checkpoint`, {
        method: "POST",
      });
      await printJsonOrError(r);
    } catch (e) {
      console.error((e && e.message) || e);
      process.exit(1);
    }
  });

program
  .command("restore")
  .argument("<checkpointDir>", "checkpoint image directory (local CRIU restore if REST fails)")
  .description("POST restore, or run criu restore locally on this host")
  .action(async (checkpointDir) => {
    let r;
    try {
      r = await rest("/api/checkpoints/restore", {
        method: "POST",
        body: JSON.stringify({ checkpointDir: String(checkpointDir) }),
      });
    } catch {
      r = null;
    }
    if (r?.ok) {
      await printJsonOrError(r);
      return;
    }
    if (r && r.status !== 404 && r.status !== 405) {
      await printJsonOrError(r);
      return;
    }
    try {
      runStartupChecks();
      const out = await criu.restore(String(checkpointDir), {});
      console.log(JSON.stringify(out, null, 2));
    } catch (e) {
      console.error((e && e.message) || e);
      process.exit(1);
    }
  });

program
  .command("list")
  .description("List sessions (same as status; for scripting)")
  .action(async () => {
    try {
      const r = await rest(
        `/api/sessions?machineId=${encodeURIComponent(config.LOCAL_MACHINE_ID)}`,
      );
      if (!r.ok) {
        const r2 = await rest("/api/sessions");
        await printJsonOrError(r2);
        return;
      }
      await printJsonOrError(r);
    } catch (e) {
      console.error((e && e.message) || e);
      process.exit(1);
    }
  });

program
  .command("criu-check")
  .description("Print CRIU capability report (no server)")
  .action(async () => {
    try {
      const rep = await criu.check();
      console.log(JSON.stringify(rep, null, 2));
    } catch (e) {
      console.error((e && e.message) || e);
      process.exit(1);
    }
  });

program.parse();
