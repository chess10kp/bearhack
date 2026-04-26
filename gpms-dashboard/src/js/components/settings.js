import * as state from "../state.js";
import * as api from "../api.js";
import { escapeHtml } from "../util.js";

function readForm() {
  return {
    hangTimeoutSec: Number(
      document.getElementById("setHang")?.value || 30,
    ),
    autoMigrate: document.getElementById("setAuto")?.checked ?? true,
    defaultTarget: document.getElementById("setTarget")?.value || "machine-b",
    sshKeyPath: document.getElementById("setSsh")?.value || "",
  };
}

export function mountSettings() {
  const backdrop = document.getElementById("settingsBackdrop");
  const modal = document.getElementById("settingsModal");
  const root = document.getElementById("settingsRoot");
  if (!backdrop || !modal || !root) return;

  const close = () => {
    backdrop.style.display = "none";
    modal.style.display = "none";
    backdrop.setAttribute("aria-hidden", "true");
  };

  const open = () => {
    const s = state.getState();
    const st = s.settings || {};
    backdrop.style.display = "block";
    modal.style.display = "block";
    backdrop.setAttribute("aria-hidden", "false");
    root.innerHTML = `
      <div class="settings-header">
        <h2 class="settings-title">Settings</h2>
        <button type="button" class="action-btn" id="settingsClose">close</button>
      </div>
      <label class="settings-field">
        <span>Hang timeout (seconds)</span>
        <input type="number" id="setHang" min="5" max="600" value="${escapeHtml(String(st.hangTimeoutSec ?? 30))}" />
      </label>
      <label class="settings-field settings-row">
        <input type="checkbox" id="setAuto" ${st.autoMigrate !== false ? "checked" : ""} />
        <span>Auto-migrate on hang</span>
      </label>
      <label class="settings-field">
        <span>Default migration target</span>
        <input type="text" id="setTarget" value="${escapeHtml(st.defaultTarget || "machine-b")}" />
      </label>
      <label class="settings-field">
        <span>SSH key path</span>
        <input type="text" id="setSsh" placeholder="~/.ssh/id_ed25519" value="${escapeHtml(st.sshKeyPath || "")}" />
      </label>
      <div class="settings-actions">
        <button type="button" class="action-btn primary" id="settingsSave">Save</button>
      </div>
    `;
    document.getElementById("settingsClose")?.addEventListener("click", close);
    document.getElementById("settingsSave")?.addEventListener("click", async () => {
      const body = readForm();
      state.setSettings(body);
      try {
        localStorage.setItem("gpms_settings", JSON.stringify(body));
      } catch {
        /* ignore */
      }
      if (!state.getState().useMock) {
        try {
          await api.putSettings(body);
        } catch (e) {
          state.appendLog(`settings: ${e.message || e}`, "warn");
        }
      }
      close();
    });
  };

  window.addEventListener("gpms:open-settings", open);
  backdrop.addEventListener("click", close);

  const run = async () => {
    if (state.getState().useMock) {
      try {
        const raw = localStorage.getItem("gpms_settings");
        if (raw) state.setSettings(JSON.parse(raw));
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      const st = await api.fetchSettings();
      if (st && typeof st === "object") state.setSettings(st);
    } catch {
      try {
        const raw = localStorage.getItem("gpms_settings");
        if (raw) state.setSettings(JSON.parse(raw));
      } catch {
        /* ignore */
      }
    }
  };
  run();

  return () => {
    window.removeEventListener("gpms:open-settings", open);
  };
}
