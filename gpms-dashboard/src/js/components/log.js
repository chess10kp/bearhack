import * as state from "../state.js";
import { escapeHtml } from "../util.js";

const CLS_MAP = { ok: "ok", warn: "warn", err: "err", error: "err", info: "info" };

export function mountLog() {
  const panel = document.getElementById("logPanel");
  if (!panel) return;

  const render = (s) => {
    const lines = s.log || [];
    if (lines.length === 0) {
      panel.innerHTML =
        '<div class="log-line"><span class="log-ts">—</span><span class="log-msg info">(empty)</span></div>';
      return;
    }
    panel.innerHTML = lines
      .map((line) => {
        const c = CLS_MAP[line.cls] || "info";
        return `<div class="log-line">
        <span class="log-ts">${escapeHtml(line.ts || "")}</span>
        <span class="log-msg ${escapeHtml(c)}">${escapeHtml(line.message || "")}</span>
      </div>`;
      })
      .join("");
    panel.scrollTop = panel.scrollHeight;
  };

  return state.subscribe(render);
}
