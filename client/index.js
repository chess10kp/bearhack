#!/usr/bin/env node
import { spawn } from "node:child_process";
import { Command, Option } from "commander";
import dotenv from "dotenv";
import { config, runStartupChecks, hasPayerKeypairConfig } from "./config.js";
import { runDaemon } from "./daemon.js";
import * as criu from "./services/criu.js";
import { loadPayerKeypair, transferToTreasury } from "../solana/wallet.js";
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

/**
 * @param {string} display e.g. :10
 * @returns {number}
 */
function xpraTcpPortFromDisplay(display) {
  const s = String(display).replace(/^:/, "");
  const n = parseInt(s, 10) || 0;
  const base = Number(process.env.XPRA_BASE_PORT);
  return (Number.isFinite(base) ? base : 10_000) + n;
}

/**
 * @param {string} [d]
 * @returns {string | null}
 */
function normalizeDisplay(d) {
  if (d == null || d === "") return null;
  const s = String(d).trim();
  if (s.startsWith(":")) return s;
  if (/^\d+$/.test(s)) return `:${s}`;
  return s.startsWith(":") ? s : `:${s}`;
}

/**
 * @param {number} status
 * @param {string} body
 */
function httpErrorBodyText(status, body) {
  try {
    const j = JSON.parse(body);
    if (j && typeof j.error === "string") return j.error;
  } catch {
    /* ignore */
  }
  return (body && body.trim()) || `HTTP ${status}`;
}

/**
 * @param {string} display
 * @param {string} xpraBin
 * @returns {Promise<void>}
 */
function attachXpraWithSignalForward(display, xpraBin) {
  return new Promise((_resolve, reject) => {
    const child = spawn(xpraBin, ["attach", display], { stdio: "inherit" });
    const forward = (/** @type {NodeJS.Signals} */ sig) => {
      try {
        if (!child.killed) child.kill(sig);
      } catch {
        /* ignore */
      }
    };
    const onInt = () => {
      off();
      forward("SIGINT");
    };
    const onTerm = () => {
      off();
      forward("SIGTERM");
    };
    function off() {
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
    }
    function onStart() {
      process.on("SIGINT", onInt);
      process.on("SIGTERM", onTerm);
    }
    onStart();
    child.on("error", (err) => {
      off();
      reject(err);
    });
    child.on("close", (code, signal) => {
      off();
      if (signal) {
        process.exit(0);
        return;
      }
      process.exit(code ?? 0);
    });
  });
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
  .command("run <args...>")
  .description(
    "Launch a session on the server (POST /api/sessions; does not start the daemon or use CRIU).",
  )
  .addOption(
    new Option("-a, --attach", "run xpra attach after launch").default(true),
  )
  .addOption(new Option("--no-attach", "do not run xpra attach"))
  .option(
    "-d, --display <n>",
    "Xpra display number or :N (default: from server; used for xpra attach)",
  )
  .allowUnknownOption(true)
  .action(async (argParts, opts) => {
    const command = argParts.join(" ").trim();
    if (!command) {
      process.stderr.write(
        "gpms run: command required (e.g. a program name, or a quoted string)\n",
      );
      process.exit(1);
    }
    const xpraBin = process.env.XPRA_BIN || "/usr/bin/xpra";
    let r;
    try {
      r = await rest("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ command }),
      });
    } catch (e) {
      console.error((e && e.message) || e);
      process.exit(1);
    }
    const t = await r.text();
    if (!r.ok) {
      process.stderr.write(
        `HTTP ${r.status}: ${httpErrorBodyText(r.status, t)}\n`,
      );
      process.exit(1);
    }
    let payload;
    try {
      payload = JSON.parse(t);
    } catch {
      console.log(t);
      return;
    }
    const sid = String(payload.id || "");
    let displayFromServer = null;
    if (sid) {
      try {
        const dr = await rest(
          `/api/sessions/${encodeURIComponent(sid)}/detail`,
        );
        if (dr.ok) {
          const d = await dr.json();
          if (d.session && d.session.xpra_display) {
            displayFromServer = d.session.xpra_display;
          }
        }
      } catch {
        /* best-effort */
      }
    }
    const hasDisplayArg =
      opts.display != null && String(opts.display).trim() !== "";
    const display = hasDisplayArg
      ? normalizeDisplay(/** @type {string} */ (opts.display))
      : normalizeDisplay(displayFromServer);
    const xpraPort = display != null ? xpraTcpPortFromDisplay(display) : null;
    const out = {
      ...payload,
      display: display ?? displayFromServer ?? null,
      xpraPort,
    };
    console.log(JSON.stringify(out, null, 2));
    if (opts.attach) {
      if (!display) {
        process.stderr.write(
          "gpms run: xpra attach requested but no display. GET /api/sessions/.../detail had no xpra_display; pass -d, or use --no-attach.\n",
        );
        process.exit(1);
      }
      try {
        await attachXpraWithSignalForward(display, xpraBin);
      } catch (e) {
        console.error("xpra attach:", (e && e.message) || e);
        process.exit(1);
      }
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
  if (!hasPayerKeypairConfig()) {
    throw new Error(
      "set GRIDLOCK_WALLET_PRIVATE_KEY or GRIDLOCK_WALLET_KEYPAIR in .env",
    );
  }
  const keypair = loadPayerKeypair({
    privateKey: config.GRIDLOCK_WALLET_PRIVATE_KEY,
    keypairPath: config.GRIDLOCK_WALLET_KEYPAIR,
    address: config.GRIDLOCK_WALLET_ADDRESS,
  });
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

program
  .command("migrate-live")
  .description(
    "Live-migrate a process tree to a remote worker via CRIU page-server pre-copy",
  )
  .requiredOption("--pid <pid>", "root pid to migrate", (v) => parseInt(v, 10))
  .requiredOption(
    "--worker <url>",
    "worker base url, e.g. http://machine-b:3400",
  )
  .requiredOption("--page-host <host>", "page-server host reachable from this machine")
  .option("--page-port <port>", "page-server tcp port", (v) => parseInt(v, 10), 1234)
  .option("--migration-id <id>", "migration id (defaults to mig-<ts>)")
  .option("--iterations <n>", "pre-copy rounds incl. final dump", (v) => parseInt(v, 10), 3)
  .option("--token <token>", "worker bearer token")
  .option("--fallback", "skip page-server, use local dump + tar upload")
  .action(async (opts) => {
    const { preCopyMigrate, fallbackTarMigrate } = await import(
      "./services/precopy.js"
    );
    const target = {
      workerUrl: String(opts.worker).replace(/\/$/, ""),
      pageHost: String(opts.pageHost),
      pagePort: Number(opts.pagePort),
      token: opts.token ? String(opts.token) : "",
    };
    const migrationId = String(opts.migrationId || `mig-${Date.now()}`);
    const onProgress = (e) =>
      process.stderr.write(`[migrate-live] ${JSON.stringify(e)}\n`);
    try {
      const r = opts.fallback
        ? await fallbackTarMigrate({
            pid: opts.pid,
            migrationId,
            target,
            onProgress,
          })
        : await preCopyMigrate({
            pid: opts.pid,
            migrationId,
            target,
            iterations: opts.iterations,
            onProgress,
          });
      console.log(JSON.stringify(r, null, 2));
    } catch (e) {
      console.error((e && e.message) || e);
      process.exit(1);
    }
  });

program
  .parseAsync()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
