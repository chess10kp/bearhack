import { createRequire } from "node:module";
import { config } from "../config.js";

const require = createRequire(import.meta.url);

let initPromise = null;
const activeByMigrationId = new Map();
const activeByJobId = new Map();

function getDefault(x) {
  return x && x.default ? x.default : x;
}

async function loadModules() {
  const dcpClient = getDefault(require("dcp-client"));
  return { dcpClient };
}

function tryLoadCompute() {
  try {
    return getDefault(require("dcp/compute"));
  } catch {
    return null;
  }
}

function rememberActive(migrationId, rec) {
  if (!migrationId || !rec) return;
  activeByMigrationId.set(String(migrationId), rec);
  if (rec.jobId) {
    activeByJobId.set(String(rec.jobId), rec);
  }
}

function forgetActive(migrationId, jobId) {
  if (migrationId) activeByMigrationId.delete(String(migrationId));
  if (jobId) activeByJobId.delete(String(jobId));
}

function findActive({ migrationId, jobId }) {
  if (jobId && activeByJobId.has(String(jobId))) {
    return activeByJobId.get(String(jobId));
  }
  if (migrationId && activeByMigrationId.has(String(migrationId))) {
    return activeByMigrationId.get(String(migrationId));
  }
  return null;
}

async function safeComputeStatus(compute, jobOrId) {
  try {
    return await compute.status(jobOrId);
  } catch {
    return null;
  }
}

function normalizeRunStatus(raw) {
  if (!raw) return "unknown";
  if (typeof raw === "string") return raw;
  if (raw.runStatus) return String(raw.runStatus);
  if (raw.status) return String(raw.status);
  return "unknown";
}

function toStatusPayload(raw) {
  const runStatus = normalizeRunStatus(raw);
  return {
    runStatus,
    total: raw && Number.isFinite(raw.total) ? Number(raw.total) : null,
    distributed:
      raw && Number.isFinite(raw.distributed) ? Number(raw.distributed) : null,
    computed: raw && Number.isFinite(raw.computed) ? Number(raw.computed) : null,
    raw: raw || null,
  };
}

export async function getJobStatus(jobId) {
  if (!jobId) {
    throw new Error("jobId required");
  }
  await init();
  const rec = findActive({ jobId });
  const base = rec && rec.lastStatus ? rec.lastStatus : null;
  const compute = tryLoadCompute();
  const statusRaw = compute
    ? await safeComputeStatus(compute, rec?.job || String(jobId))
    : null;
  return toStatusPayload(statusRaw || base);
}

export async function cancelJob({ jobId, migrationId }) {
  await init();
  const compute = tryLoadCompute();
  const rec = findActive({ jobId, migrationId });
  const effectiveJobId = jobId || rec?.jobId;
  if (!effectiveJobId) {
    return { ok: false, message: "no active local or persisted job id" };
  }

  let cancelled = false;
  let error = "";
  try {
    if (rec?.job && typeof rec.job.cancel === "function") {
      await rec.job.cancel();
      cancelled = true;
    }
  } catch (e) {
    error = e && e.message ? e.message : String(e);
  }

  if (!cancelled) {
    if (compute && typeof compute.cancel === "function") {
      try {
        await compute.cancel(String(effectiveJobId));
        cancelled = true;
      } catch (e) {
        error = e && e.message ? e.message : String(e);
      }
    } else if (!error) {
      error = "dcp compute module unavailable in current process";
    }
  }

  if (cancelled) {
    if (rec) {
      rec.cancelled = true;
      rec.lastStatus = { runStatus: "cancelled" };
      forgetActive(rec.migrationId, rec.jobId);
    } else {
      forgetActive(migrationId, effectiveJobId);
    }
  }

  return {
    ok: cancelled,
    jobId: String(effectiveJobId),
    message: cancelled ? "cancel requested" : error || "cancel failed",
  };
}

export async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const { dcpClient } = await loadModules();
    if (typeof dcpClient?.init === "function") {
      await dcpClient.init(config.dcpSchedulerUrl);
    }
    return true;
  })();
  return initPromise;
}

/**
 * Submit a lightweight orchestration job to DCP.
 * This is control-plane integration: migration data transfer is still handled by GPMS transport.
 *
 * @param {{
 *  migrationId: string,
 *  sessionId: string,
 *  targetMachineId: string,
 *  checkpointManifest: object,
 *  phase: string,
 * }} payload
 */
export async function submitOrchestrationJob(payload) {
  await init();
  const compute = tryLoadCompute();
  if (!compute) {
    throw new Error("dcp compute module unavailable after dcp init");
  }
  const onStatus =
    payload && typeof payload.onStatus === "function" ? payload.onStatus : () => {};

  async function workFunction(input) {
    progress(0.2);
    const startedAt = Date.now();
    progress(0.6);
    const response = {
      ok: true,
      migrationId: input.migrationId,
      sessionId: input.sessionId,
      targetMachineId: input.targetMachineId,
      phase: input.phase,
      checkpointSummary: {
        fileCount: input.checkpointManifest?.fileCount || 0,
        sizeBytes: input.checkpointManifest?.sizeBytes || 0,
        digest: input.checkpointManifest?.digest || "",
      },
      workerTimestamp: Date.now(),
      executionMs: Date.now() - startedAt,
    };
    progress(1);
    return response;
  }

  const job = compute.for([payload], workFunction);
  job.public = {
    name: "gridlock-checkpoint-orchestration",
    description: "Control-plane orchestration for GPMS migration",
    link: "https://github.com/gridlock",
  };

  /** @type {{ migrationId: string, job: any, jobId: string, cancelled: boolean, lastStatus: any }} */
  const rec = {
    migrationId: String(payload.migrationId),
    job,
    jobId: "",
    cancelled: false,
    lastStatus: { runStatus: "created" },
  };
  rememberActive(payload.migrationId, rec);

  const applyStatus = (next) => {
    rec.lastStatus = next;
    onStatus(next);
  };

  applyStatus({ runStatus: "submitting" });
  job.on("accepted", () => {
    rec.jobId = String(job.id || "");
    rememberActive(payload.migrationId, rec);
    applyStatus({ runStatus: "accepted", jobId: rec.jobId });
  });
  job.on("status", (s) => {
    applyStatus(toStatusPayload(s));
  });
  job.on("error", (e) => {
    const message = e && e.message ? e.message : String(e);
    applyStatus({ runStatus: "failed", error: message });
  });

  const ticker = setInterval(async () => {
    const statusRaw = await safeComputeStatus(compute, rec.job);
    if (!statusRaw) return;
    applyStatus(toStatusPayload(statusRaw));
  }, 1500);

  try {
    const resultHandle = await job.exec();
    const values = Array.from(resultHandle.values ? resultHandle.values() : resultHandle);
    const first = values && values.length ? values[0] : null;
    applyStatus({ runStatus: "completed", jobId: String(job.id || rec.jobId || "") });
    return {
      jobId: String(job.id || rec.jobId || ""),
      schedulerUrl: config.dcpSchedulerUrl,
      result: first,
    };
  } finally {
    clearInterval(ticker);
    forgetActive(payload.migrationId, job.id || rec.jobId);
  }
}
