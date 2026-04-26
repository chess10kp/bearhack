/**
 * @param {string} cluster e.g. devnet, mainnet-beta
 * @param {string} signature
 */
export function txExplorerUrl(cluster, signature) {
  const c =
    cluster === "mainnet-beta" || cluster === "mainnet"
      ? ""
      : `?cluster=${encodeURIComponent(cluster)}`;
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}${c}`;
}
