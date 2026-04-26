import { GoogleGenerativeAI } from "@google/generative-ai";
import { SYSTEM_PROMPT, buildUserPrompt } from "./gemma-prompt.js";

const APP_PROFILES = {
  blender: { decision: "MIGRATE", target_spec: "gpu", reason: "Blender Cycles/Eevee render — GPU-accelerated workload needs remote GPU node", priority: 9 },
  ffmpeg: { decision: "MIGRATE", target_spec: "highcpu", reason: "Video encoding — CPU-bound workload, offload to high-core remote", priority: 8 },
  handbrake: { decision: "MIGRATE", target_spec: "highcpu", reason: "Video transcoding — CPU-intensive, benefit from more cores", priority: 8 },
  gimp: { decision: "MIGRATE", target_spec: "tallram", reason: "GIMP image processing — memory-heavy on large canvases", priority: 7 },
  krita: { decision: "MIGRATE", target_spec: "tallram", reason: "Krita painting/rendering — large brush engines need RAM", priority: 7 },
  inkscape: { decision: "MIGRATE", target_spec: "highcpu", reason: "Inkscape rendering — SVG rasterization is CPU-bound", priority: 6 },
  code: { decision: "MIGRATE", target_spec: "highcpu", reason: "VS Code extension host or TypeScript compilation — CPU-bound", priority: 6 },
  chromium: { decision: "MIGRATE", target_spec: "tallram", reason: "Chromium tab process — memory-heavy, benefits from more RAM", priority: 5 },
  firefox: { decision: "MIGRATE", target_spec: "tallram", reason: "Firefox content process — memory pressure from many tabs", priority: 5 },
  java: { decision: "MIGRATE", target_spec: "tallram", reason: "JVM application — heap pressure, benefits from more RAM", priority: 6 },
  python: { decision: "MIGRATE", target_spec: "highcpu", reason: "Python compute workload — CPU-bound execution", priority: 6 },
  make: { decision: "MIGRATE", target_spec: "highcpu", reason: "Build compilation — highly parallelizable, needs more cores", priority: 7 },
  gcc: { decision: "MIGRATE", target_spec: "highcpu", reason: "C/C++ compilation — CPU-bound, parallelizable", priority: 7 },
  cmake: { decision: "MIGRATE", target_spec: "highcpu", reason: "Build system — CPU-bound compilation", priority: 6 },
};

function defaultDecision() {
  return {
    decision: "MIGRATE",
    reason: "Process unresponsive — migrating to remote host for recovery",
    target_spec: "highcpu",
    priority: 7,
    estimated_time_sec: 45,
    source: "fallback",
  };
}

function classifyMock(metrics) {
  const cmd = (metrics.appName || metrics.command || "").toLowerCase();
  for (const [key, profile] of Object.entries(APP_PROFILES)) {
    if (cmd.includes(key)) {
      return {
        ...profile,
        estimated_time_sec: 45,
        source: "mock",
      };
    }
  }
  return {
    ...defaultDecision(),
    reason: `Process "${metrics.appName || "unknown"}" unresponsive — migrating to remote host`,
    source: "mock",
  };
}

function classifyRules(metrics) {
  const cpu = metrics.cpuNorm || 0;
  const mem = metrics.memMb || 0;
  const cmd = (metrics.appName || metrics.command || "").toLowerCase();

  if (cmd.includes("blender") || cmd.includes("render")) {
    return { decision: "MIGRATE", target_spec: "gpu", reason: "Renderer detected — needs GPU", priority: 9, estimated_time_sec: 50, source: "rules" };
  }
  if (cmd.includes("ffmpeg") || cmd.includes("encode") || cmd.includes("transcode")) {
    return { decision: "MIGRATE", target_spec: "highcpu", reason: "Encoding workload — needs CPU cores", priority: 8, estimated_time_sec: 40, source: "rules" };
  }
  if (mem > 2000) {
    return { decision: "MIGRATE", target_spec: "tallram", reason: `High memory usage (${Math.round(mem)} MB) — needs more RAM`, priority: 8, estimated_time_sec: 45, source: "rules" };
  }
  if (cpu > 80) {
    return { decision: "MIGRATE", target_spec: "highcpu", reason: `High CPU usage (${cpu.toFixed(1)}%) — needs more cores`, priority: 7, estimated_time_sec: 40, source: "rules" };
  }
  return { decision: "MIGRATE", target_spec: "highcpu", reason: "Process unresponsive — migrating to remote host", priority: 6, estimated_time_sec: 45, source: "rules" };
}

function parseGeminiResponse(text) {
  try {
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      decision: parsed.decision || "MIGRATE",
      reason: parsed.reason || "AI classified migration needed",
      target_spec: parsed.target_spec || "highcpu",
      priority: typeof parsed.priority === "number" ? Math.min(10, Math.max(1, parsed.priority)) : 7,
      estimated_time_sec: parsed.estimated_time_sec || 45,
      source: "gemma",
    };
  } catch {
    return null;
  }
}

async function classifyGemini(metrics, apiKey, model, timeoutMs) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const modelObj = genAI.getGenerativeModel({ model: model || "gemma-3-27b-it" });
  const userPrompt = buildUserPrompt(metrics);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 10000);
  try {
    const result = await Promise.race([
      modelObj.generateContent([
        { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
        { role: "model", parts: [{ text: "Understood. I will respond with only valid JSON matching the specified schema." }] },
        { role: "user", parts: [{ text: userPrompt }] },
      ]),
      new Promise((_, reject) =>
        controller.signal.addEventListener("abort", () => reject(new Error("Gemma API timeout")))
      ),
    ]);
    clearTimeout(timer);
    const text = result.response?.text?.() || "";
    const parsed = parseGeminiResponse(text);
    if (parsed) return parsed;
    return { ...defaultDecision(), reason: `AI response unparseable, defaulting to MIGRATE: ${text.slice(0, 100)}`, source: "gemma-fallback" };
  } finally {
    clearTimeout(timer);
  }
}

export async function classify(metrics, opts = {}) {
  const getSetting = opts.getSetting || (() => null);
  const mock = getSetting("gemma_mock");
  if (mock === "true" || mock === true || (mock == null && !getSetting("gemma_api_key"))) {
    return classifyMock(metrics);
  }
  const apiKey = getSetting("gemma_api_key");
  if (!apiKey) {
    return classifyRules(metrics);
  }
  try {
    const model = getSetting("gemma_model") || "gemma-3-27b-it";
    const timeout = parseInt(getSetting("gemma_timeout_ms") || "10000", 10);
    return await classifyGemini(metrics, apiKey, model, timeout);
  } catch {
    return classifyRules(metrics);
  }
}

export { classifyMock, classifyRules, classifyGemini };
