/**
 * @param {number} totalSeconds
 * @param {{ baseLamports: number, lamportsPerSecond: number }} cfg
 * @param {(key: string) => string | null | undefined} [getSetting]
 */
export function computeLamports(totalSeconds, cfg, getSetting) {
  const baseRaw = getSetting?.("solana_base_lamports");
  const perSecRaw = getSetting?.("solana_lamports_per_second");
  const base =
    baseRaw != null && baseRaw !== ""
      ? Number(baseRaw)
      : cfg.baseLamports;
  const perSec =
    perSecRaw != null && perSecRaw !== ""
      ? Number(perSecRaw)
      : cfg.lamportsPerSecond;
  const b = Number.isFinite(base) ? base : cfg.baseLamports;
  const p = Number.isFinite(perSec) ? perSec : cfg.lamportsPerSecond;
  const sec = Number.isFinite(totalSeconds) ? Math.max(0, totalSeconds) : 0;
  return Math.max(0, Math.floor(b + p * sec));
}

/** @param {number} lamports */
export function lamportsToSolDisplay(lamports) {
  return (Number(lamports) / 1e9).toFixed(6);
}
