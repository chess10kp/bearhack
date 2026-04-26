import { shouldLog } from "../config.js";

let emitToServer = /** @type {((e: string, p: unknown) => void) | null} */ (
  null
);

export function setLogEmitter(fn) {
  emitToServer = fn;
}

function ts() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function base(level, message, meta) {
  if (level === "debug" && !shouldLog("debug")) return;
  const line = `[${ts()}] [${level.toUpperCase()}] ${message}`;
  const out = meta != null ? `${line} ${JSON.stringify(meta)}` : line;
  if (level === "error") console.error(out);
  else if (level === "warn") console.warn(out);
  else console.log(out);
  if (emitToServer) {
    try {
      emitToServer("client:log-entry", {
        level,
        message,
        meta: meta ?? null,
        timestamp: Date.now(),
      });
    } catch {
      /* ignore */
    }
  }
}

export function debug(message, meta) {
  base("debug", message, meta);
}
export function info(message, meta) {
  base("info", message, meta);
}
export function warn(message, meta) {
  base("warn", message, meta);
}
export function error(message, meta) {
  base("error", message, meta);
}
