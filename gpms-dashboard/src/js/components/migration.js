import * as state from "../state.js";
import { escapeHtml } from "../util.js";

const DEFAULT_STEPS = [
  "criu checkpoint (freeze)",
  "transfer memory image",
  "restore in target lxc",
  "reattach xpra display",
];

function stepClass(index, activeIndex, pct) {
  if (pct >= 100) return "done";
  if (index < activeIndex) return "done";
  if (index === activeIndex) return "active";
  return "pending";
}

export function mountMigration() {
  const slot = document.getElementById("migrationPanelSlot");
  if (!slot) return;

  const render = (s) => {
    const entries = Object.values(s.migrationBySession || {});
    if (entries.length === 0) {
      slot.innerHTML = "";
      return;
    }
    const m = entries[0];
    const labels = m.stepLabels?.length ? m.stepLabels : DEFAULT_STEPS;
    const pct = Math.min(100, Math.max(0, m.percent ?? 0));
    const stepIndex = Math.min(
      labels.length - 1,
      Math.max(0, m.stepIndex ?? Math.floor((pct / 100) * labels.length)),
    );

    const stepsHtml = labels
      .map((label, i) => {
        const cls = stepClass(i, stepIndex, pct);
        return `<div class="step ${cls}"><span class="step-dot"></span>${escapeHtml(label)}</div>`;
      })
      .join("");

    slot.innerHTML = `
      <div class="migration-panel" data-migration-for="${escapeHtml(m.sessionId || "")}">
        <div class="migration-title">live migration · ${escapeHtml(m.sessionId || "—")} ${m.target ? "→ " + escapeHtml(m.target) : ""}</div>
        ${m.transportKind === "dcp" ? `<div class="migration-dcp-meta">dcp ${escapeHtml(m.dcpStatus || "pending")} ${m.dcpJobId ? `· job ${escapeHtml(String(m.dcpJobId))}` : ""}</div>` : ""}
        ${m.powStatus ? `<div class="migration-pow-meta">PoW <span class="pow-badge pow-${m.powStatus === "passed" ? "ok" : m.powStatus === "failed" ? "fail" : "pending"}">${escapeHtml(m.powStatus)}${m.powHashesPerSec ? ` · ${m.powHashesPerSec} H/s` : ""}</span></div>` : ""}
        <div class="migration-steps">${stepsHtml}</div>
        <div class="progress-wrap">
          <div class="progress-label">
            <span>progress</span>
            <span id="migration-pct-label">${Math.round(pct)}%</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" id="migration-progress-bar" style="width: ${pct}%"></div>
          </div>
        </div>
      </div>
    `;
  };

  return state.subscribe(render);
}
