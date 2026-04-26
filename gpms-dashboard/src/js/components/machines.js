import * as state from "../state.js";
import { escapeHtml } from "../util.js";

export function mountMachines() {
  const root = document.getElementById("machinesRoot");
  if (!root) return;

  const render = (s) => {
    const list = Object.values(s.machines || {});
    if (list.length === 0) {
      root.innerHTML =
        '<p class="empty-hint" style="color: var(--muted); font-family: var(--mono); font-size:0.8rem">No machines in view.</p>';
      return;
    }
    root.innerHTML = list
      .map(
        (m) => `
      <div class="machine-card ${m.online ? "online" : "offline"}" data-machine-id="${escapeHtml(m.id)}">
        <div class="machine-dot" aria-hidden="true"></div>
        <div>
          <div class="machine-name">${escapeHtml(m.name || m.id)}</div>
          <div class="machine-specs">${escapeHtml(m.specs || "—")}</div>
        </div>
        <div class="machine-load">load ${escapeHtml(
          m.load != null ? m.load.toFixed(2) : "—",
        )}</div>
      </div>
    `,
      )
      .join("");
  };

  return state.subscribe(render);
}
