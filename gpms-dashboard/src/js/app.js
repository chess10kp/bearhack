import * as state from "./state.js";
import * as api from "./api.js";
import { startMock, stopMock } from "./mock.js";
import { isMockFromQuery, getApiBase } from "./util.js";
import { mountTopbar } from "./components/topbar.js";
import { mountHero } from "./components/hero.js";
import { mountLaunch } from "./components/launch.js";
import { mountSessions } from "./components/sessions.js";
import { mountMigration } from "./components/migration.js";
import { mountLog } from "./components/log.js";
import { mountMachines } from "./components/machines.js";
import { mountInspector } from "./components/inspector.js";
import { mountSettings } from "./components/settings.js";
import { mountHistory } from "./components/history.js";

function mount() {
  mountTopbar();
  mountHero();
  mountLaunch();
  mountSessions();
  mountMigration();
  mountLog();
  mountMachines();
  mountInspector();
  mountSettings();
  mountHistory();
}

function wireDataSource() {
  state.setServerMeta({ serverUrl: getApiBase() });
  const sock = api.connectSocket();
  const fall = setTimeout(() => {
    if (state.getState().connection !== "connected") {
      api.disconnectSocket();
      stopMock();
      startMock();
      state.appendLog(
        `using mock — could not connect to ${getApiBase()}`,
        "warn",
      );
    }
  }, 2200);
  sock?.once("connect", () => {
    clearTimeout(fall);
    api.prefetchAfterConnect();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  state.setServerMeta({ serverUrl: getApiBase() });
  if (isMockFromQuery()) {
    stopMock();
    startMock();
  }
  mount();
  if (!isMockFromQuery()) {
    wireDataSource();
  }
});
