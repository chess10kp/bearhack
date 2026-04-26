import { PublicKey } from "@solana/web3.js";

/**
 * Verify a parsed transaction contains a system transfer matching treasury and lamports.
 * @param {import("@solana/web3.js").Connection} connection
 * @param {string} signature
 * @param {{ treasuryBase58: string, lamports: number }} expected
 * @returns {Promise<{ ok: true, payerPubkey: string } | { ok: false, error: string }>}
 */
export async function verifyTransferSignature(connection, signature, expected) {
  let treasury;
  try {
    treasury = new PublicKey(expected.treasuryBase58);
  } catch {
    return { ok: false, error: "invalid treasury in config" };
  }
  const want = BigInt(expected.lamports);
  const tx = await connection.getParsedTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) {
    return { ok: false, error: "transaction not found" };
  }
  if (tx.meta?.err) {
    return { ok: false, error: "transaction failed on-chain" };
  }
  const ixList = tx.transaction.message.instructions;
  for (const ix of ixList) {
    if (
      "parsed" in ix &&
      ix.program === "system" &&
      ix.parsed &&
      typeof ix.parsed === "object" &&
      "type" in ix.parsed &&
      ix.parsed.type === "transfer" &&
      "info" in ix.parsed &&
      ix.parsed.info &&
      typeof ix.parsed.info === "object"
    ) {
      const info = ix.parsed.info;
      const dest = info.destination;
      const src = info.source;
      const lamports = info.lamports;
      if (
        typeof dest === "string" &&
        dest === treasury.toBase58() &&
        BigInt(lamports) === want &&
        typeof src === "string"
      ) {
        return { ok: true, payerPubkey: src };
      }
    }
  }
  return { ok: false, error: "no matching system transfer to treasury" };
}
