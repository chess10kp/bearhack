import * as state from "../state.js";
import { escapeHtml } from "../util.js";

const SPEC_LABELS = {
  gpu: "🖥 GPU",
  tallram: "💾 High RAM",
  highcpu: "⚡ High CPU",
};

const DECISION_CLASSES = {
  MIGRATE: "decision-migrate",
  NOT_NEEDED: "decision-skip",
  KILL: "decision-kill",
};

export function mountGemmaCard() {
  const slot = document.getElementById("gemmaCardSlot");
  if (!slot) return;

  const render = (s) => {
    const d = s.gemmaDecision;
    if (!d) {
      slot.innerHTML = "";
      return;
    }

    const decision = d.decision || "MIGRATE";
    const reason = d.reason || "";
    const targetSpec = d.target_spec || "highcpu";
    const priority = d.priority || 7;
    const source = d.source || "unknown";
    const estTime = d.estimated_time_sec || 45;
    const sessionId = d.sessionId || "";
    const status = s.gemmaStatus?.status || "";

    const cls = DECISION_CLASSES[decision] || "decision-migrate";
    const specLabel = SPEC_LABELS[targetSpec] || targetSpec;
    const priorityBar = Array.from({ length: 10 }, (_, i) =>
      `<span class="priority-cell ${i < priority ? "filled" : ""}"></span>`
    ).join("");

    const statusBadge = status === "classifying"
      ? `<span class="gemma-status-badge classifying">classifying…</span>`
      : "";

    slot.innerHTML = `
      <div class="gemma-card ${cls}">
        <div class="gemma-card-header">
          <span class="gemma-label">gemma decision</span>
          <span class="gemma-source">${escapeHtml(source)}</span>
          ${statusBadge}
        </div>
        <div class="gemma-card-body">
          <div class="gemma-decision-row">
            <span class="gemma-decision-tag ${cls}">${escapeHtml(decision)}</span>
            <span class="gemma-spec">${specLabel}</span>
          </div>
          <div class="gemma-reason">${escapeHtml(reason)}</div>
          <div class="gemma-meta">
            <div class="gemma-meta-row">
              <span class="gemma-meta-label">priority</span>
              <div class="priority-bar">${priorityBar}</div>
            </div>
            <div class="gemma-meta-row">
              <span class="gemma-meta-label">est. time</span>
              <span class="gemma-meta-value">~${estTime}s</span>
            </div>
            ${sessionId ? `<div class="gemma-meta-row"><span class="gemma-meta-label">session</span><span class="gemma-meta-value">${escapeHtml(sessionId.slice(0, 16))}…</span></div>` : ""}
          </div>
        </div>
      </div>
    `;
  };

  return state.subscribe(render);
}
