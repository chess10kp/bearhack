import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export const config = {
  port: num(process.env.PORT, 3000),
  localMachineId: process.env.LOCAL_MACHINE_ID || "machine-a",
  checkpointDir: process.env.CHECKPOINT_DIR || "./checkpoints",
  criuBin: process.env.CRIU_BIN || "/usr/sbin/criu",
  xpraBin: process.env.XPRA_BIN || "/usr/bin/xpra",
  lxcBin: process.env.LXC_BIN || "/usr/bin/lxc-create",
  defaultRemote: process.env.DEFAULT_REMOTE || "machine-b",
  pollIntervalMs: num(process.env.POLL_INTERVAL_MS, 2000),
  hangThresholdSeconds: num(process.env.HANG_THRESHOLD_SECONDS, 30),
  autoMigrate: String(process.env.AUTO_MIGRATE || "false").toLowerCase() === "true",
  xpraBasePort: num(process.env.XPRA_BASE_PORT, 10000),
  displayStart: num(process.env.DISPLAY_START, 10),
  serverDir: __dirname,
};

/** Log warning if CRIU is unlikely to work without elevated privileges. */
export function warnCriuPrivileges() {
  try {
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      console.warn(
        "[GPMS] Running as non-root: CRIU dump/restore usually requires root or appropriate capabilities (CAP_SYS_PTRACE, CAP_SYS_ADMIN).",
      );
    }
  } catch {
    /* ignore */
  }
}
