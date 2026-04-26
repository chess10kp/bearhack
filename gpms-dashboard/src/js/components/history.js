import * as state from "../state.js";
import { escapeHtml } from "../util.js";

function fmtTs(t) {
  if (t == null) return "—";
  try {
    return new Date(typeof t === "number" ? t : Date.parse(t)).toLocaleString();
  } catch {
    return "—";
  }
}

export function mountHistory() {
  const root = document.getElementById("migrationHistoryRoot");
  if (!root) return;

  const render = (s) => {
    const rows = s.migrationHistory || [];
    if (rows.length === 0) {
      root.innerHTML =
        '<p class="empty-hint" style="color: var(--muted); font-family: var(--mono); font-size:0.8rem">No migration history yet.</p>';
      return;
    }
    root.innerHTML = `
      <div class="history-table">
        <div class="history-row history-head">
          <span>session</span>
          <span>started</span>
          <span>duration</span>
          <span>status</span>
          <span>cost</span>
        </div>
        ${rows
          .map((r) => {
            const dur =
              r.startedAt && r.endedAt
                ? `${Math.round((r.endedAt - r.startedAt) / 1000)}s`
                : "—";
            const ok = r.success !== false;
            return `<div class="history-row">
            <span class="history-mono">${escapeHtml(r.sessionId || r.id || "—")}</span>
            <span class="history-mono">${escapeHtml(fmtTs(r.startedAt))}</span>
            <span class="history-mono">${escapeHtml(dur)}</span>
            <span class="history-mono" style="color: ${ok ? "var(--accent)" : "var(--danger)"}">${ok ? "ok" : "fail"}</span>
            <span class="history-mono">${escapeHtml(r.cost != null ? String(r.cost) : "—")}</span>
          </div>`;
          })
          .join("")}
      </div>
    `;
  };

  return state.subscribe(render);
}
