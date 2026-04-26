import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

function parseRestorePid(blob) {
  const m =
    blob.match(/Restored.*pid\s*[=:]\s*(\d+)/i) ||
    blob.match(/pid\s*=\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * @param {string} checkpointDir
 */
export async function restore(checkpointDir) {
  const { stdout, stderr } = await execFileAsync(
    config.criuBin,
    ["restore", "-D", checkpointDir, "--shell-job"],
    { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
  );
  const output = `${stdout || ""}${stderr || ""}`;
  return { output, pid: parseRestorePid(output) };
}
