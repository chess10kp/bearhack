export async function sendSolana(fromPriv: string, toPub: string, amt: number) {
  const senderKeys = getKeyPair(fromPriv);
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: senderKeys.publicKey,
      toPubkey: new PublicKey(toPub),
      lamports: Math.floor(amt * LAMPORTS_PER_SOL),
    }),
  );
  const signature = await sendAndConfirmTransaction(conn, transaction, [senderKeys]);
  return signature;
}
