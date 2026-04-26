/* eslint-disable no-undef */
/**
 * DCP work function package for GridLock checkpoint orchestration.
 *
 * IMPORTANT: this work function is control-plane only for now.
 * It validates payload contract and returns orchestration metadata.
 */

async function checkpointOrchestrationWork(input) {
  progress(0.15);
  if (!input || typeof input !== "object") {
    throw new Error("invalid input payload");
  }
  if (!input.migrationId || !input.sessionId || !input.targetMachineId) {
    throw new Error("missing required identifiers");
  }
  progress(0.5);
  const manifest = input.checkpointManifest || {};
  const out = {
    ok: true,
    migrationId: String(input.migrationId),
    sessionId: String(input.sessionId),
    targetMachineId: String(input.targetMachineId),
    phase: String(input.phase || "checkpoint-created"),
    checkpointSummary: {
      fileCount: Number(manifest.fileCount || 0),
      sizeBytes: Number(manifest.sizeBytes || 0),
      digest: String(manifest.digest || ""),
    },
    workerTimestamp: Date.now(),
  };
  progress(1);
  return out;
}

if (typeof module !== "undefined") {
  module.exports = { checkpointOrchestrationWork };
}
