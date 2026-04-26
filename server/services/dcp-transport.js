import * as dcp from "./dcp-client.js";
import { buildManifest } from "./dcp-packaging.js";

/**
 * Submit a DCP orchestration job and return metadata.
 *
 * @param {{
 *  migrationId: string,
 *  sessionId: string,
 *  targetMachineId: string,
 *  localCheckpointDir: string,
 * }} opts
 */
export async function submitCheckpointOrchestration(opts) {
  const checkpointManifest = buildManifest(opts.localCheckpointDir);
  const out = await dcp.submitOrchestrationJob({
    migrationId: opts.migrationId,
    sessionId: opts.sessionId,
    targetMachineId: opts.targetMachineId,
    checkpointManifest,
    phase: "checkpoint-created",
    onStatus: opts.onStatus,
  });
  return {
    checkpointManifest,
    dcp: out,
  };
}
