import { Connection } from "@solana/web3.js";

/**
 * @param {string} rpcUrl
 */
export function createSolanaConnection(rpcUrl) {
  return new Connection(rpcUrl, "confirmed");
}
