import { createHmac, randomBytes } from "node:crypto";
import * as dcp from "./dcp-client.js";

const DEFAULT_DIFFICULTY = 16;
const DEFAULT_REQUIRED_MS = 2000;

export function generateChallenge(migrationId) {
  const nonce = randomBytes(32).toString("hex");
  return `gridlock-pow-${migrationId}-${nonce}`;
}

export function verifyPow(challenge, nonce, hash, difficulty) {
  const expected = createHmac("sha256", "")
    .update(challenge + String(nonce))
    .digest("hex");
  const prefix = "0".repeat(difficulty);
  return hash.startsWith(prefix);
}

export async function submitPowChallenge({
  migrationId,
  targetMachineId,
  difficulty,
  requiredMs,
  onStatus,
}) {
  const challenge = generateChallenge(migrationId);
  const diff = difficulty || DEFAULT_DIFFICULTY;
  const reqMs = requiredMs || DEFAULT_REQUIRED_MS;

  const result = await dcp.submitOrchestrationJob({
    migrationId,
    targetMachineId,
    phase: "pow-challenge",
    powChallenge: {
      challenge,
      difficulty: diff,
      requiredMs: reqMs,
      targetMachineId,
      migrationId,
    },
    onStatus,
  });

  const proof = result?.result;
  if (!proof || !proof.ok) {
    return {
      passed: false,
      reason: "PoW job returned no result",
      challenge,
      proof: null,
    };
  }

  const hashValid = verifyPow(
    proof.challenge,
    proof.nonce,
    proof.hash,
    diff,
  );
  const withinBudget = proof.elapsedMs <= reqMs * 4;
  const passed = hashValid && withinBudget && proof.passed;

  return {
    passed,
    reason: !hashValid
      ? "hash verification failed"
      : !withinBudget
        ? `too slow: ${proof.elapsedMs}ms (budget ${reqMs * 4}ms)`
        : passed
          ? "node has sufficient compute"
          : "proof-of-work failed",
    challenge,
    proof,
    hashesPerSec: proof.hashesPerSec || 0,
    elapsedMs: proof.elapsedMs || 0,
  };
}
