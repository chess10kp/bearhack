import * as state from "../state.js";
import { escapeHtml } from "../util.js";

let tauriInfo = { hostname: null, kernel: null, cpu: null, totalRamMb: null };

async function loadTauriInfoOnce() {
  if (tauriInfo.hostname) return tauriInfo;
  try {
    const { invoke } = await import("https://esm.sh/@tauri-apps/api@2/core");
    const info = await invoke("get_system_info");
    tauriInfo = {
      hostname: info?.hostname || null,
      kernel: info?.kernel || null,
      cpu: info?.cpu || null,
      totalRamMb: info?.total_ram_mb ?? null,
    };
  } catch {
    tauriInfo = { hostname: null, kernel: null, cpu: null, totalRamMb: null };
  }
  return tauriInfo;
}

export function mountTopbar() {
  const root = document.getElementById("topbarRight");
  if (!root) return;

  let booted = false;
  const render = (s) => {
    const conn = s.connection;
    const isMock = s.useMock;
    const connText =
      conn === "connected"
        ? isMock
          ? "● mock"
          : "● live"
        : conn === "connecting"
          ? "● connecting"
          : "● disconnected";
    const connClass =
      conn === "connected" ? "live" : conn === "connecting" ? "connecting" : "offline";

    const host =
      tauriInfo.hostname || (isMock ? "mock" : "—");
    const kernel = tauriInfo.kernel || (isMock ? "—" : "—");

    if (!booted) {
      booted = true;
      loadTauriInfoOnce().then(() => {
        render(state.getState());
      });
    }

    root.innerHTML = `
      <button type="button" class="action-btn" id="settingsOpenBtn" title="Settings" aria-label="Open settings">⚙</button>
      <div class="badge ${escapeHtml(connClass)}" id="connectionBadge">
        ${escapeHtml(connText)}
      </div>
      <div class="badge" id="hostBadge">${escapeHtml(String(host))}</div>
      <div class="badge" id="kernelBadge">kernel ${escapeHtml(String(kernel))}</div>
    `;

    const btn = document.getElementById("settingsOpenBtn");
    if (btn) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("gpms:open-settings"));
      });
    }
  };

  return state.subscribe(render);
}
