import * as state from "../state.js";
import { escapeHtml } from "../util.js";

export function mountHero() {
  const el = document.getElementById("heroStats");
  if (!el) return;

  const render = (s) => {
    const list = Object.values(s.sessions || {});
    const active = list.filter(
      (x) => x.status && x.status !== "exited",
    ).length;
    const attention = list.filter(
      (x) => x.status === "hung" || x.health === "danger",
    ).length;
    const mig = s.migrationsToday ?? 0;
    el.innerHTML = `
      <div class="stat">
        <div class="stat-val" style="color: var(--accent)">${escapeHtml(String(active))}</div>
        <div class="stat-label">active sessions</div>
      </div>
      <div class="stat">
        <div class="stat-val" style="color: var(--warn)">${escapeHtml(String(attention))}</div>
        <div class="stat-label">needs attention</div>
      </div>
      <div class="stat">
        <div class="stat-val">${escapeHtml(String(mig))}</div>
        <div class="stat-label">migrations today</div>
      </div>
    `;
  };

  return state.subscribe(render);
}
