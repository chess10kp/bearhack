/**
 * Solana settlement config (devnet-first). Loaded from process.env after dotenv.
 */

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function getSolanaConfig(env = process.env) {
  return {
    rpcUrl:
      env.SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com",
    cluster: (env.SOLANA_CLUSTER || "devnet").trim().toLowerCase(),
    treasury: (env.SOLANA_TREASURY || "").trim(),
    baseLamports: num(env.SOLANA_BASE_LAMPORTS, 1_000),
    lamportsPerSecond: num(env.SOLANA_LAMPORTS_PER_SECOND, 50_000),
  };
}

/**
 * @param {ReturnType<typeof getSolanaConfig>} cfg
 */
export function isSettlementEnabled(cfg) {
  return cfg.treasury.length > 0;
}

/**
 * @param {string} rpcUrl
 */
export function rpcUrlHost(rpcUrl) {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return "";
  }
}
