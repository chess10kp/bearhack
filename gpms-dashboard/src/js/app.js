/**
 * GPMS Dashboard — app bootstrap.
 * Populated in subsequent steps with state, api, and components.
 */
function boot() {
  // placeholder until state + components land
  const el = document.getElementById("logPanel");
  if (el && !el.querySelector(".log-line")) {
    el.innerHTML =
      '<div class="log-line"><span class="log-ts">—</span><span class="log-msg info">initializing…</span></div>';
  }
}

document.addEventListener("DOMContentLoaded", boot);
