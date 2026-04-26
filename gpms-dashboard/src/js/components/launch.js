import * as state from "../state.js";
import * as api from "../api.js";
import * as mock from "../mock.js";

function launch(command) {
  const s = state.getState();
  if (s.useMock) {
    let cmd = command.trim();
    if (cmd && !/^gpms\s/i.test(cmd)) {
      cmd = `gpms run ${cmd}`;
    }
    mock.mockLaunch(cmd || "gpms run app");
    return;
  }
  let cmd = command.trim();
  if (cmd && !/^gpms\s/i.test(cmd)) {
    cmd = `gpms run ${cmd}`;
  }
  api.emitLaunch(cmd);
}

export function mountLaunch() {
  const input = document.getElementById("launchInput");
  const btn = document.getElementById("launchBtn");
  if (!input || !btn) return;

  const run = () => {
    const v = input.value.trim();
    if (!v) return;
    launch(v);
    input.value = "";
  };
  btn.addEventListener("click", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") run();
  });
}
