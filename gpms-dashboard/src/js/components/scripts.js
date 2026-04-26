import * as state from "../state.js";

export function mountScripts() {
  const startBtn = document.getElementById("scriptStartBtn");
  const watchBtn = document.getElementById("scriptWatchBtn");
  const suspendBtn = document.getElementById("scriptSuspendBtn");
  const resumeBtn = document.getElementById("scriptResumeBtn");
  const output = document.getElementById("scriptOutput");

  const crocPidInput = document.getElementById("crocPidInput");
  const crocIdInput = document.getElementById("crocIdInput");
  const crocSendBtn = document.getElementById("crocSendBtn");
  const crocSendRunningBtn = document.getElementById("crocSendRunningBtn");
  const crocReceiveBtn = document.getElementById("crocReceiveBtn");
  const crocOutput = document.getElementById("crocOutput");

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
    runScript("start", () => window.__TAURI__.core.invoke("script-start"));
  });

  watchBtn.addEventListener("click", () => {
    runScript("watch", () => window.__TAURI__.core.invoke("script-watch"));
  });

  suspendBtn.addEventListener("click", () => {
    runScript("suspend", () => window.__TAURI__.core.invoke("script-suspend"));
  });

  resumeBtn.addEventListener("click", () => {
    runScript("resume", () => window.__TAURI__.core.invoke("script-resume"));
  });

  if (crocSendBtn) {
    crocSendBtn.addEventListener("click", async () => {
      const pid = crocPidInput?.value?.trim();
      const id = crocIdInput?.value?.trim() || null;
      if (!pid) {
        state.appendLog("croc send requires a PID", "err");
        return;
      }
      if (crocOutput) {
        crocOutput.textContent = "Sending checkpoint via croc...";
        crocOutput.classList.add("visible");
      }
      state.appendLog(`croc send checkpoint pid=${pid}`, "info");
      try {
        const result = await window.__TAURI__.core.invoke("croc-send", { pid, migrationId: id });
        if (crocOutput) crocOutput.textContent = result || "Send complete";
        state.appendLog("croc send completed", "ok");
      } catch (err) {
        if (crocOutput) crocOutput.textContent = `Error: ${err}`;
        state.appendLog(`croc send failed: ${err}`, "err");
      }
    });
  }

  if (crocSendRunningBtn) {
    crocSendRunningBtn.addEventListener("click", async () => {
      const pid = crocPidInput?.value?.trim();
      const id = crocIdInput?.value?.trim() || null;
      if (!pid) {
        state.appendLog("croc send requires a PID", "err");
        return;
      }
      if (crocOutput) {
        crocOutput.textContent = "Sending checkpoint (leave running) via croc...";
        crocOutput.classList.add("visible");
      }
      state.appendLog(`croc send checkpoint pid=${pid} (leave running)`, "info");
      try {
        const result = await window.__TAURI__.core.invoke("croc-send-running", { pid, migrationId: id });
        if (crocOutput) crocOutput.textContent = result || "Send complete";
        state.appendLog("croc send (leave running) completed", "ok");
      } catch (err) {
        if (crocOutput) crocOutput.textContent = `Error: ${err}`;
        state.appendLog(`croc send failed: ${err}`, "err");
      }
    });
  }

  if (crocReceiveBtn) {
    crocReceiveBtn.addEventListener("click", async () => {
      const id = crocIdInput?.value?.trim() || null;
      if (crocOutput) {
        crocOutput.textContent = "Waiting to receive checkpoint via croc...";
        crocOutput.classList.add("visible");
      }
      state.appendLog("croc receive checkpoint", "info");
      try {
        const result = await window.__TAURI__.core.invoke("croc-receive", { migrationId: id });
        if (crocOutput) crocOutput.textContent = result || "Receive complete";
        state.appendLog("croc receive completed", "ok");
      } catch (err) {
        if (crocOutput) crocOutput.textContent = `Error: ${err}`;
        state.appendLog(`croc receive failed: ${err}`, "err");
      }
    });
  }
}
