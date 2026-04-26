import * as state from "../state.js";
import * as api from "../api.js";
import * as mock from "../mock.js";
import { escapeHtml, formatUptimeSeconds, memBarClass } from "../util.js";

function cardClass(s) {
  const h = s.health || "ok";
  if (h === "danger" || s.status === "hung") return "danger";
  if (h === "warn" || s.status === "migrating" || s.status === "paused")
    return "warn";
  return "ok";
}

function pillClass(status) {
  if (status === "hung") return "hung";
  if (status === "migrating") return "migrating";
  if (status === "paused") return "paused";
  return "running";
}

function pillText(s) {
  if (s.status === "hung") return "hung";
  if (s.status === "migrating") return "migrating";
  if (s.status === "paused") return "paused";
  if (s.status === "exited") return "exited";
  return "running";
}

export function mountSessions() {
  const root = document.getElementById("sessionsRoot");
  if (!root) return;

  const render = (s) => {
    const ids = Object.keys(s.sessions || {});
    if (ids.length === 0) {
      root.innerHTML =
        '<p class="empty-hint" style="color: var(--muted); font-family: var(--mono); font-size:0.8rem; padding: 1rem 0">No active sessions. Launch an app or enable mock data.</p>';
      return;
    }
    const html = [];
    for (const id of ids) {
      const se = s.sessions[id];
      if (!se) continue;
      const memPct = se.memoryPercent ?? 0;
      const cpu = se.cpuPercent != null ? `${se.cpuPercent.toFixed(0)}% cpu` : "";
      const selected = s.selectedSessionId === id ? " session-card--selected" : "";
      const showRescue = se.status === "hung";

      html.push(`
        <div class="session-card ${escapeHtml(cardClass(se))} ${selected}" data-session-id="${escapeHtml(id)}" role="button" tabindex="0" aria-label="Session ${escapeHtml(se.name || id)}">
          <div class="session-icon">${escapeHtml(se.icon || "📦")}</div>
          <div>
            <div class="session-name">${escapeHtml(se.name || id)}</div>
            <div class="session-meta">
              <div class="session-pid">pid ${se.pid != null ? escapeHtml(String(se.pid)) : "—"}</div>
              <div class="session-time">${escapeHtml(formatUptimeSeconds(se.uptimeSec))}</div>
              ${cpu ? `<div class="session-pid">${escapeHtml(cpu)}</div>` : ""}
              <div class="session-pid">${escapeHtml(id)}</div>
            </div>
          </div>
          <div class="session-right">
            <div class="pill ${escapeHtml(pillClass(se.status))}">${escapeHtml(pillText(se))}</div>
            <div class="mem-bar">
              <div class="bar-track">
                <div class="bar-fill ${escapeHtml(memBarClass(memPct))}" style="width: ${memPct}%"></div>
              </div>
              <span>${escapeHtml(se.memoryLabel || "—")}</span>
            </div>
            <div style="display: flex; gap: 0.4rem; flex-wrap: wrap; justify-content: flex-end">
              <button class="action-btn${showRescue ? " alert" : ""}" type="button" data-action="migrate" data-id="${escapeHtml(id)}">
                ${showRescue ? "rescue →" : "migrate"}
              </button>
              <button class="action-btn" type="button" data-action="checkpoint" data-id="${escapeHtml(id)}">checkpoint</button>
              <button class="action-btn" type="button" data-action="inspect" data-id="${escapeHtml(id)}">inspect</button>
            </div>
          </div>
        </div>
      `);
    }
    root.innerHTML = html.join("");

    root.querySelectorAll("[data-action]").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = b.getAttribute("data-id");
        const act = b.getAttribute("data-action");
        if (!id) return;
        if (s.useMock) {
          if (act === "migrate") mock.mockMigrate(id, s.settings?.defaultTarget);
          else if (act === "checkpoint") mock.mockCheckpoint(id);
        } else {
          if (act === "migrate") api.emitMigrate(id);
          else if (act === "checkpoint") api.emitCheckpoint(id);
        }
        if (act === "inspect") {
          state.setSelectedSessionId(id);
        }
      });
    });

    root.querySelectorAll(".session-card[data-session-id]").forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        const id = card.getAttribute("data-session-id");
        if (id) state.setSelectedSessionId(id);
      });
    });
  };

  return state.subscribe(render);
}
