import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import dotenv from "dotenv";

dotenv.config();

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function str(v, d) {
  return v != null && String(v).trim() !== "" ? String(v).trim() : d;
}

export const config = {
  SERVER_URL: str(process.env.SERVER_URL, "http://localhost:3000").replace(
    /\/$/,
    "",
  ),
  XPRA_DISPLAY_BASE: num(process.env.XPRA_DISPLAY_BASE, 10),
  POLL_INTERVAL_MS: num(process.env.POLL_INTERVAL_MS, 2000),
  HANG_THRESHOLD_SECONDS: num(process.env.HANG_THRESHOLD_SECONDS, 30),
  CRIU_BIN: str(process.env.CRIU_BIN, "/usr/sbin/criu"),
  CHECKPOINT_DIR: str(process.env.CHECKPOINT_DIR, "/tmp/gpms-checkpoints"),
  LOG_LEVEL: str(process.env.LOG_LEVEL, "info").toLowerCase(),
  LOCAL_MACHINE_ID: str(process.env.LOCAL_MACHINE_ID, "machine-a"),
  /**
   * Payer private key: base58, 32/64-byte hex, or JSON keypair array (string).
   * Takes precedence over GRIDLOCK_WALLET_KEYPAIR when set.
   */
  GRIDLOCK_WALLET_PRIVATE_KEY: str(process.env.GRIDLOCK_WALLET_PRIVATE_KEY, ""),
  /** If set, must match the public key of the loaded key; catches wrong key/addr pairs. */
  GRIDLOCK_WALLET_ADDRESS: str(process.env.GRIDLOCK_WALLET_ADDRESS, ""),
  /** Path to Solana CLI-style JSON keypair (payer) when private key is not in env. */
  GRIDLOCK_WALLET_KEYPAIR: str(process.env.GRIDLOCK_WALLET_KEYPAIR, ""),
  /** Optional; defaults to payment payload from server. */
  SOLANA_RPC_URL: str(process.env.SOLANA_RPC_URL, ""),
};

/** Whether the client can sign Solana settlement (file or env private key). */
export function hasPayerKeypairConfig() {
  return Boolean(
    (config.GRIDLOCK_WALLET_PRIVATE_KEY && config.GRIDLOCK_WALLET_PRIVATE_KEY.trim()) ||
      (config.GRIDLOCK_WALLET_KEYPAIR && config.GRIDLOCK_WALLET_KEYPAIR.trim()),
  );
}

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

export function shouldLog(level) {
  return (LEVELS[level] ?? 1) >= (LEVELS[config.LOG_LEVEL] ?? 1);
}

/**
 * Startup checks: Linux /proc, optional CRIU version, checkpoint dir writable, root warning.
 * @param {{ skipCriu?: boolean }} opts
 */
export function runStartupChecks(opts = {}) {
  if (process.platform !== "linux") {
    throw new Error("GPMS client requires Linux (/proc, CRIU).");
  }
  if (!fs.existsSync("/proc/self")) {
    throw new Error("/proc not available.");
  }
  if (process.geteuid?.() !== 0) {
    console.warn(
      "[GPMS] Running as non-root: CRIU and some signals may fail; use sudo for production.",
    );
  }
  const dir = config.CHECKPOINT_DIR;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
  } catch (e) {
    throw new Error(`CHECKPOINT_DIR not usable: ${dir} — ${e.message}`);
  }
  if (!opts.skipCriu) {
    try {
      execFileSync(config.CRIU_BIN, ["--version"], {
        encoding: "utf8",
        timeout: 10000,
      });
    } catch (e) {
      throw new Error(
        `CRIU not accessible at ${config.CRIU_BIN}. Install criu or set CRIU_BIN. ${e.message}`,
      );
    }
  }
  return true;
}

export function getKernelVersion() {
  try {
    return fs.readFileSync("/proc/sys/kernel/osrelease", "utf8").trim();
  } catch {
    return os.release();
  }
}
