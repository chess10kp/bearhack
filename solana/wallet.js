import fs from "node:fs";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createSolanaConnection } from "./connection.js";
import { lamportsToSolDisplay } from "./pricing.js";

/**
 * @param {string} jsonPath Path to Solana CLI keypair JSON (byte array).
 * @returns {import("@solana/web3.js").Keypair}
 */
export function loadKeypairFromFile(jsonPath) {
  const raw = fs.readFileSync(jsonPath, "utf8");
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) {
    throw new Error("keypair file must be a JSON array of numbers");
  }
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

/**
 * @param {{ rpcUrl: string, keypair: import("@solana/web3.js").Keypair, treasuryBase58: string, lamports: number }} opts
 * @returns {Promise<string>} transaction signature
 */
export async function transferToTreasury(opts) {
  const { rpcUrl, keypair, treasuryBase58, lamports } = opts;
  if (!Number.isFinite(lamports) || lamports <= 0) {
    throw new Error("lamports must be positive");
  }
  const conn = createSolanaConnection(rpcUrl);
  const treasury = new PublicKey(treasuryBase58);
  const ix = SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey: treasury,
    lamports,
  });
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [keypair], {
    commitment: "confirmed",
  });
  return sig;
}

export { lamportsToSolDisplay as lamportsToSolString };
