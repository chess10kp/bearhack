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
    xpra_html_enabled: document.getElementById("setXpraHtml")?.checked ? "true" : "false",
    xpra_webcam: document.getElementById("setXpraWebcam")?.checked ? "on" : "off",
    xpra_pulseaudio: document.getElementById("setXpraAudio")?.checked ? "on" : "off",
    xpra_notifications: document.getElementById("setXpraNotif")?.checked ? "on" : "off",
    gemma_mock: document.getElementById("setGemmaMock")?.checked ? "true" : "false",
    gemma_api_key: document.getElementById("setGemmaKey")?.value || "",
    gemma_model: document.getElementById("setGemmaModel")?.value || "gemma-3-27b-it",
    gemma_timeout_ms: String(Number(document.getElementById("setGemmaTimeout")?.value || 10000)),
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
    const xpraHtml = st.xpra_html_enabled !== "false" && st.xpra_html_enabled !== false;
    const xpraWebcam = st.xpra_webcam !== "on" && st.xpra_webcam !== true;
    const xpraAudio = st.xpra_pulseaudio === "on" || st.xpra_pulseaudio === true;
    const xpraNotif = st.xpra_notifications === "on" || st.xpra_notifications === true;
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
      <div class="settings-section-title">Xpra Display</div>
      <label class="settings-field settings-row">
        <input type="checkbox" id="setXpraHtml" ${xpraHtml ? "checked" : ""} />
        <span>HTML5 client (browser display)</span>
      </label>
      <label class="settings-field settings-row">
        <input type="checkbox" id="setXpraWebcam" ${xpraWebcam ? "checked" : ""} />
        <span>Webcam forwarding</span>
      </label>
      <label class="settings-field settings-row">
        <input type="checkbox" id="setXpraAudio" ${xpraAudio ? "checked" : ""} />
        <span>Pulseaudio forwarding</span>
      </label>
      <label class="settings-field settings-row">
        <input type="checkbox" id="setXpraNotif" ${xpraNotif ? "checked" : ""} />
        <span>Desktop notifications</span>
      </label>
      <div class="settings-section-title">Gemma AI Decision Engine</div>
      <label class="settings-field settings-row">
        <input type="checkbox" id="setGemmaMock" ${st.gemma_mock !== "false" ? "checked" : ""} />
        <span>Mock mode (canned responses)</span>
      </label>
      <label class="settings-field">
        <span>Gemma API key</span>
        <input type="password" id="setGemmaKey" placeholder="AIza..." value="${escapeHtml(st.gemma_api_key || "")}" />
      </label>
      <label class="settings-field">
        <span>Gemma model</span>
        <input type="text" id="setGemmaModel" value="${escapeHtml(st.gemma_model || "gemma-3-27b-it")}" />
      </label>
      <label class="settings-field">
        <span>API timeout (ms)</span>
        <input type="number" id="setGemmaTimeout" min="2000" max="60000" value="${escapeHtml(String(st.gemma_timeout_ms || 10000))}" />
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
  document.getElementById("sidenavConfig")?.addEventListener("click", (e) => {
    e.preventDefault();
    open();
  });
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
