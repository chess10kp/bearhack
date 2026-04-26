export function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

export function logTs(d = new Date()) {
  return d.toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatUptimeSeconds(sec) {
  if (sec == null || Number.isNaN(Number(sec))) return "—";
  const s = Math.floor(Number(sec));
  if (s < 60) return `↑ ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `↑ ${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `↑ ${h}h ${m % 60}m`;
}

export function memBarClass(percent) {
  const p = Number(percent) || 0;
  if (p >= 80) return "high";
  if (p >= 50) return "med";
  return "low";
}

export function isMockFromQuery() {
  if (typeof window === "undefined") return false;
  const p = new URLSearchParams(window.location.search);
  if (p.get("mock") === "1") return true;
  if (p.get("mock") === "0") return false;
  try {
    if (localStorage.getItem("gpms_mock") === "1") return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function getApiBase() {
  if (typeof window === "undefined") return "http://localhost:3000";
  const p = new URLSearchParams(window.location.search);
  const q = p.get("api");
  if (q) return q.replace(/\/$/, "");
  try {
    const s = localStorage.getItem("gpms_api");
    if (s) return s.replace(/\/$/, "");
  } catch {
    /* ignore */
  }
  return "http://localhost:3000";
}
