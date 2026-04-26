/**
 * Process-wide context set from index.js (io, config, getSetting, etc.).
 * Avoids circular imports between services and socket layer.
 */
export const ctx = {
  /** @type {import("socket.io").Server | null} */
  io: null,
  getSetting: (/** @type {string} */ _k) => null,
  log: (/** @type {string} */ _m, /** @type {any} */ _lid) => {},
};

export function setCtx(partial) {
  Object.assign(ctx, partial);
}

export function getIo() {
  return ctx.io;
}
