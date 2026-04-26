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
  port: num(process.env.WORKER_PORT, 3400),
  host: process.env.WORKER_HOST || "0.0.0.0",
  token: process.env.WORKER_TOKEN || "",
  criuBin: process.env.CRIU_BIN || "/usr/sbin/criu",
  checkpointBaseDir: process.env.CHECKPOINT_BASE_DIR || "/tmp/gpms-checkpoints",
  xpraBin: process.env.XPRA_BIN || "/usr/bin/xpra",
};
