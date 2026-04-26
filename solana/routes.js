import { Router } from "express";
import { getSolanaConfig, isSettlementEnabled, rpcUrlHost } from "./config.js";
import { createSolanaConnection } from "./connection.js";
import { verifyTransferSignature } from "./settlement.js";
import { txExplorerUrl } from "./explore.js";
import { S } from "../server/socket/events.js";

/**
 * @param {{ db: typeof import("../server/db.js"), getIo: () => import("socket.io").Server | null }} deps
 */
export function createSolanaRouter(deps) {
  const { db, getIo } = deps;
  const r = Router();

  r.get("/config", (_req, res) => {
    const cfg = getSolanaConfig();
    res.json({
      cluster: cfg.cluster,
      treasury: cfg.treasury || null,
      settlementEnabled: isSettlementEnabled(cfg),
      rpcUrlHost: rpcUrlHost(cfg.rpcUrl),
    });
  });

  r.get("/pending", (_req, res) => {
    const cfg = getSolanaConfig();
    if (!isSettlementEnabled(cfg)) {
      res.json([]);
      return;
    }
    res.json(db.listPendingSolanaPayments());
  });

  r.post("/confirm", async (req, res) => {
    const migrationId = req.body?.migrationId;
    const signature = req.body?.signature;
    if (!migrationId || typeof migrationId !== "string") {
      res.status(400).json({ error: "migrationId required" });
      return;
    }
    if (!signature || typeof signature !== "string") {
      res.status(400).json({ error: "signature required" });
      return;
    }
    const cfg = getSolanaConfig();
    if (!isSettlementEnabled(cfg)) {
      res.status(400).json({ error: "settlement not configured" });
      return;
    }
    const mig = db.getMigration(migrationId);
    if (!mig) {
      res.status(404).json({ error: "migration not found" });
      return;
    }
    if (mig.status !== "completed") {
      res.status(400).json({ error: "migration not completed" });
      return;
    }
    if (mig.payment_status === "confirmed") {
      res.json({
        ok: true,
        already: true,
        signature: mig.payment_signature,
        explorerUrl: mig.payment_signature
          ? txExplorerUrl(cfg.cluster, mig.payment_signature)
          : null,
      });
      return;
    }
    const lamports = Number(mig.payment_lamports);
    if (!Number.isFinite(lamports) || lamports <= 0) {
      res.status(400).json({ error: "migration has no payment due" });
      return;
    }
    const conn = createSolanaConnection(cfg.rpcUrl);
    const verified = await verifyTransferSignature(conn, signature, {
      treasuryBase58: cfg.treasury,
      lamports,
    });
    if (!verified.ok) {
      db.updateMigration(migrationId, {
        payment_status: "failed",
        payment_error: verified.error,
      });
      res.status(400).json({ error: verified.error });
      return;
    }
    db.updateMigration(migrationId, {
      payment_signature: signature,
      payment_status: "confirmed",
      payer_pubkey: verified.payerPubkey,
      payment_error: null,
    });
    const explorerUrl = txExplorerUrl(cfg.cluster, signature);
    const io = getIo();
    if (io) {
      const payload = {
        migrationId,
        sessionId: mig.session_id,
        signature,
        explorerUrl,
        cluster: cfg.cluster,
      };
      io.emit(S.solanaPaymentConfirmed, payload);
      io.of("/client").emit(S.solanaPaymentConfirmed, payload);
    }
    res.json({ ok: true, signature, explorerUrl });
  });

  return r;
}
