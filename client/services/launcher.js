const BLOCKED_PREFIXES = [
  "/etc/",
  "/root/",
  "/sys/",
  "/proc/",
  "/dev/",
];

/**
 * @param {string} command
 */
export function prepare(command) {
  const raw = String(command || "").trim();
  if (!raw) {
    return { app: "", args: /** @type {string[]} */ ([]), valid: false };
  }
  if (/[;&|`$<>]/.test(raw)) {
    return { app: "", args: [], valid: false };
  }
  const parts = raw.split(/\s+/);
  const app = parts[0] || "";
  const args = parts.slice(1);
  if (app.startsWith("/")) {
    for (const pre of BLOCKED_PREFIXES) {
      if (app.startsWith(pre)) {
        return { app, args, valid: false };
      }
    }
  }
  return { app, args, valid: true };
}

/**
 * @param {string} sessionId
 * @param {number} pid
 * @param {(sid: string, p: number, iv: number) => void} startMonitor
 * @param {number} [intervalMs]
 */
export function acknowledge(sessionId, pid, startMonitor, intervalMs) {
  startMonitor(sessionId, pid, intervalMs);
}
