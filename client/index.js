#!/usr/bin/env node
import { Command } from "commander";
import dotenv from "dotenv";
import { config, runStartupChecks } from "./config.js";
import { runDaemon } from "./daemon.js";
import * as criu from "./services/criu.js";
import {
  loadKeypairFromFile,
  transferToTreasury,
} from "../solana/wallet.js";
import { getSolanaConfig } from "../solana/config.js";

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

program
  .command("history")
  .description("List migrations and Solana payment status (REST)")
  .action(async () => {
    try {
      const r = await rest("/api/migrations");
      const t = await r.text();
      if (!r.ok) {
        process.stderr.write(`HTTP ${r.status}: ${t}\n`);
        process.exit(1);
        return;
      }
      const rows = JSON.parse(t);
      if (!Array.isArray(rows) || rows.length === 0) {
        console.log("(no migrations)");
        return;
      }
      for (const m of rows) {
        const sig = m.payment_signature || "—";
        const pay = m.payment_status || "—";
        const lam = m.payment_lamports != null ? m.payment_lamports : "—";
        console.log(
          `${m.id}\t${m.session_id}\t${m.status}\t${pay}\tlamports=${lam}\t${sig}`,
        );
      }
    } catch (e) {
      console.error((e && e.message) || e);
      process.exit(1);
    }
  });

async function payMigrationById(migrationId) {
  const keyPath = config.GRIDLOCK_WALLET_KEYPAIR;
  if (!keyPath) {
    throw new Error("set GRIDLOCK_WALLET_KEYPAIR in .env");
  }
  const keypair = loadKeypairFromFile(keyPath);
  const rm = await rest(`/api/migrations/${encodeURIComponent(migrationId)}`);
  if (!rm.ok) {
    throw new Error(await rm.text());
  }
  const m = await rm.json();
  if (m.payment_status === "confirmed") {
    console.log("already confirmed", m.payment_signature);
    return;
  }
  if (m.status !== "completed" || m.payment_status !== "pending") {
    throw new Error("migration has no pending payment");
  }
  const lamports = Number(m.payment_lamports);
  if (!Number.isFinite(lamports) || lamports <= 0) {
    throw new Error("invalid payment_lamports");
  }
  const cfgR = await rest("/api/solana/config");
  if (!cfgR.ok) {
    throw new Error(await cfgR.text());
  }
  const cfg = await cfgR.json();
  if (!cfg.treasury) {
    throw new Error("server settlement not configured (SOLANA_TREASURY)");
  }
  const rpcUrl =
    (config.SOLANA_RPC_URL && config.SOLANA_RPC_URL.trim()) ||
    getSolanaConfig().rpcUrl;
  const sig = await transferToTreasury({
    rpcUrl,
    keypair,
    treasuryBase58: cfg.treasury,
    lamports,
  });
  const cr = await rest("/api/solana/confirm", {
    method: "POST",
    body: JSON.stringify({ migrationId, signature: sig }),
  });
  if (!cr.ok) {
    throw new Error(await cr.text());
  }
  console.log(JSON.stringify(await cr.json(), null, 2));
}

program
  .command("pay")
  .argument("<migrationId>", "migration id (e.g. mig-…)")
  .description("Sign and submit pending Solana payment for a migration")
  .action(async (migrationId) => {
    try {
      await payMigrationById(String(migrationId));
    } catch (e) {
      console.error((e && e.message) || e);
      process.exit(1);
    }
  });

program
  .command("pay-pending")
  .description("Pay all migrations with pending Solana settlement")
  .action(async () => {
    try {
      const r = await rest("/api/solana/pending");
      if (!r.ok) {
        process.stderr.write(await r.text());
        process.exit(1);
        return;
      }
      const pending = await r.json();
      if (!Array.isArray(pending) || pending.length === 0) {
        console.log("(no pending payments)");
        return;
      }
      for (const m of pending) {
        console.error(`paying ${m.id}…`);
        await payMigrationById(m.id);
      }
    } catch (e) {
      console.error((e && e.message) || e);
      process.exit(1);
    }
  });

program.parse();
