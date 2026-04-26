/* eslint-disable no-undef */
/**
 * Proof-of-Work challenge for GridLock DCP migration verification.
 *
 * Before migrating a live process to a remote DCP compute node, the server
 * issues a PoW challenge. The DCP worker must solve it within a time budget,
 * proving the node actually has the CPU capacity it claims. This prevents
 * migrating to a node that will stall or drop the checkpoint mid-transfer.
 *
 * Challenge: find a nonce such that SHA-256(challenge || nonce) has at least
 * `difficulty` leading zero bits.
 */

async function powWorkFunction(input) {
  progress(0);

  var challenge = input.challenge;
  var difficulty = input.difficulty || 16;
  var requiredMs = input.requiredMs || 500;
  var migrationId = input.migrationId;
  var targetMachineId = input.targetMachineId;

  if (!challenge) throw new Error("missing challenge");

  progress(0.05);

  var startedAt = Date.now();

  var sha256;
  if (typeof crypto !== "undefined" && crypto.subtle) {
    sha256 = function (buf) {
      return crypto.subtle.digest("SHA-256", buf).then(function (arr) {
        return new Uint8Array(arr);
      });
    };
  } else {
    sha256 = function () {
      throw new Error("no SHA-256 available");
    };
  }

  var encoder = new TextEncoder();
  var prefix = encoder.encode(challenge);
  var nonce = 0;
  var found = false;
  var hashHex = "";
  var targetPrefix = "";
  for (var i = 0; i < difficulty; i++) targetPrefix += "0";

  var batchSize = 256;
  var iterations = 0;

  async function tryBatch() {
    for (var b = 0; b < batchSize && !found; b++) {
      nonce++;
      iterations++;
      var nonceBytes = encoder.encode(String(nonce));
      var combined = new Uint8Array(prefix.length + nonceBytes.length);
      combined.set(prefix, 0);
      combined.set(nonceBytes, prefix.length);
      var hash = await sha256(combined);
      hashHex = "";
      for (var h = 0; h < hash.length; h++) {
        hashHex += ("0" + hash[h].toString(16)).slice(-2);
      }
      if (hashHex.slice(0, difficulty) === targetPrefix) {
        found = true;
      }
    }
  }

  while (!found) {
    await tryBatch();
    var pct = Math.min(0.9, iterations / 500000);
    progress(pct);
  }

  var elapsedMs = Date.now() - startedAt;

  var benchStart = Date.now();
  var benchOps = 0;
  for (var j = 0; j < 500; j++) {
    var benchBuf = new Uint8Array(64);
    benchBuf.set(prefix, 0);
    await sha256(benchBuf);
    benchOps++;
  }
  var benchElapsed = Date.now() - benchStart;
  var hashesPerSec = benchElapsed > 0 ? Math.round((benchOps / benchElapsed) * 1000) : 0;

  progress(1);

  return {
    ok: true,
    migrationId: migrationId,
    targetMachineId: targetMachineId,
    challenge: challenge,
    nonce: nonce,
    hash: hashHex,
    difficulty: difficulty,
    elapsedMs: elapsedMs,
    hashesPerSec: hashesPerSec,
    passed: elapsedMs <= requiredMs * 4,
    iterations: iterations,
    workerTimestamp: Date.now(),
  };
}

if (typeof module !== "undefined") {
  module.exports = { powWorkFunction };
}
