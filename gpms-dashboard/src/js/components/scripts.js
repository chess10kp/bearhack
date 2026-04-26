import * as state from "../state.js";

export function mountScripts() {
  const startBtn = document.getElementById("scriptStartBtn");
  const watchBtn = document.getElementById("scriptWatchBtn");
  const suspendBtn = document.getElementById("scriptSuspendBtn");
  const resumeBtn = document.getElementById("scriptResumeBtn");
  const output = document.getElementById("scriptOutput");

  if (!startBtn || !watchBtn || !suspendBtn || !resumeBtn) return;

  async function runScript(name, invokeFn) {
    if (output) {
      output.textContent = `Running ${name}...`;
      output.classList.add("visible");
    }
    state.appendLog(`script ${name} started`, "info");
    try {
      const result = await invokeFn();
      if (output) {
        output.textContent = result || `${name} completed`;
      }
      state.appendLog(`script ${name} completed`, "ok");
    } catch (err) {
      if (output) {
        output.textContent = `Error: ${err}`;
      }
      state.appendLog(`script ${name} failed: ${err}`, "err");
    }
  }

  startBtn.addEventListener("click", () => {
    runScript("start", () => window.__TAURI__.core.invoke("script_start"));
  });

  watchBtn.addEventListener("click", () => {
    runScript("watch", () => window.__TAURI__.core.invoke("script_watch"));
  });

  suspendBtn.addEventListener("click", () => {
    runScript("suspend", () => window.__TAURI__.core.invoke("script_suspend"));
  });

  resumeBtn.addEventListener("click", () => {
    runScript("resume", () => window.__TAURI__.core.invoke("script_resume"));
  });
}
