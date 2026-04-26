import * as state from "../state.js";
import * as api from "../api.js";
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
    const cluster = s.solanaCluster || "devnet";
    root.innerHTML = `
      <div class="history-table">
        <div class="history-row history-head">
          <span>session</span>
          <span>started</span>
          <span>duration</span>
          <span>status</span>
          <span>transport</span>
          <span>cost (SOL)</span>
          <span>dcp</span>
          <span>solana tx</span>
        </div>
        ${rows
          .map((r) => {
            const dur =
              r.startedAt && r.endedAt
                ? `${Math.round((r.endedAt - r.startedAt) / 1000)}s`
                : "—";
            const ok = r.success !== false;
            const sig = r.solanaSignature;
            const explorer =
              r.solanaExplorerTx ||
              (sig
                ? `https://explorer.solana.com/tx/${encodeURIComponent(sig)}?cluster=${encodeURIComponent(cluster)}`
                : "");
            const txCell = sig
              ? `<a href="${escapeHtml(explorer)}" target="_blank" rel="noopener noreferrer" class="history-mono">${escapeHtml(sig.slice(0, 10))}…</a>`
              : `<span class="history-mono">${escapeHtml(r.paymentPending ? "pending" : "—")}</span>`;
            const transport = r.transportKind || "ssh";
            const dcp =
              transport === "dcp"
                ? `${r.dcpStatus || "pending"}${r.dcpJobId ? ` (${String(r.dcpJobId).slice(0, 10)}…)` : ""}`
                : "—";
            const dcpActions =
              transport === "dcp"
                ? `<div class="history-actions">
                    <button class="action-btn" type="button" data-hact="dcp-status" data-mid="${escapeHtml(r.id || r.migrationId || "")}">status</button>
                    <button class="action-btn" type="button" data-hact="dcp-cancel" data-mid="${escapeHtml(r.id || r.migrationId || "")}">cancel</button>
                    <button class="action-btn" type="button" data-hact="dcp-retry" data-mid="${escapeHtml(r.id || r.migrationId || "")}">retry</button>
                  </div>`
                : "";
            return `<div class="history-row">
            <span class="history-mono">${escapeHtml(r.sessionId || r.id || "—")}</span>
            <span class="history-mono">${escapeHtml(fmtTs(r.startedAt))}</span>
            <span class="history-mono">${escapeHtml(dur)}</span>
            <span class="history-mono" style="color: ${ok ? "var(--secondary)" : "var(--danger)"}">${ok ? "ok" : "fail"}</span>
            <span class="history-mono">${escapeHtml(transport)}</span>
            <span class="history-mono">${escapeHtml(r.cost != null ? String(r.cost) : "—")}</span>
            <span class="history-mono">${escapeHtml(dcp)}${dcpActions}</span>
            <span>${txCell}</span>
          </div>`;
          })
          .join("")}
      </div>
    `;

    root.querySelectorAll("[data-hact]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const act = btn.getAttribute("data-hact");
        const mid = btn.getAttribute("data-mid");
        if (!mid) return;
        try {
          if (act === "dcp-status") {
            const j = await api.fetchMigrationDcpStatus(mid);
            state.appendLog(`dcp status ${mid}: ${j.status || "unknown"}`, "info");
          } else if (act === "dcp-cancel") {
            const j = await api.cancelMigrationDcp(mid);
            state.appendLog(`dcp cancel ${mid}: ${j.ok ? "ok" : "failed"}`, j.ok ? "ok" : "warn");
          } else if (act === "dcp-retry") {
            const j = await api.retryMigrationDcp(mid);
            state.appendLog(
              `dcp retry ${mid}: ${j.retrying ? "started" : "not-started"}`,
              j.retrying ? "ok" : "warn",
            );
          }
        } catch (e) {
          state.appendLog(`history action ${act || "?"}: ${e.message || e}`, "err");
        }
      });
    });
  };

  return state.subscribe(render);
}
