import fs from "node:fs";
import bs58 from "bs58";
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
  return keypairFromSecretBytes(Uint8Array.from(arr));
}

/**
 * @param {Uint8Array} u8
 * @returns {import("@solana/web3.js").Keypair}
 */
function keypairFromSecretBytes(u8) {
  if (u8.length === 64) {
    return Keypair.fromSecretKey(u8);
  }
  if (u8.length === 32) {
    return Keypair.fromSeed(u8);
  }
  throw new Error("secret key must be 32 bytes (seed) or 64 bytes (full)");
}

/**
 * Base58, hex (64 or 128 hex chars), or JSON array of numbers (Solana keypair file as string).
 * @param {string} s
 * @returns {import("@solana/web3.js").Keypair}
 */
export function keypairFromSecretString(s) {
  const t = s.trim();
  if (!t) {
    throw new Error("empty private key");
  }
  if (t.startsWith("[")) {
    const arr = JSON.parse(t);
    if (!Array.isArray(arr)) {
      throw new Error("private key JSON must be an array of numbers");
    }
    return keypairFromSecretBytes(Uint8Array.from(arr));
  }
  const hex = t.replace(/^0x/i, "");
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    return keypairFromSecretBytes(Uint8Array.from(Buffer.from(hex, "hex")));
  }
  if (/^[0-9a-fA-F]{128}$/.test(hex)) {
    return keypairFromSecretBytes(Uint8Array.from(Buffer.from(hex, "hex")));
  }
  let raw;
  try {
    raw = bs58.decode(t);
  } catch {
    throw new Error("private key: invalid base58");
  }
  return keypairFromSecretBytes(Uint8Array.from(raw));
}

/**
 * @param {{ privateKey?: string, keypairPath?: string, address?: string }} opts
 * `privateKey` (env) takes precedence over `keypairPath` (file). If `address` is set, it must match the keypair public key.
 * @returns {import("@solana/web3.js").Keypair}
 */
export function loadPayerKeypair(opts) {
  const pk = (opts.privateKey && opts.privateKey.trim()) || "";
  const path = (opts.keypairPath && opts.keypairPath.trim()) || "";
  const exp = (opts.address && opts.address.trim()) || "";

  let keypair;
  if (pk) {
    keypair = keypairFromSecretString(pk);
  } else if (path) {
    keypair = loadKeypairFromFile(path);
  } else {
    throw new Error(
      "set GRIDLOCK_WALLET_PRIVATE_KEY or GRIDLOCK_WALLET_KEYPAIR in .env",
    );
  }
  if (exp && keypair.publicKey.toBase58() !== exp) {
    throw new Error(
      "GRIDLOCK_WALLET_ADDRESS does not match the loaded private key",
    );
  }
  return keypair;
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
