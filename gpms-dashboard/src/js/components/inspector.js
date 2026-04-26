import * as state from "../state.js";
import * as api from "../api.js";
import * as mock from "../mock.js";
import { escapeHtml } from "../util.js";

function renderSparkline(values) {
  if (!values?.length) return "—";
  const max = Math.max(...values, 1);
  const w = 120;
  const h = 32;
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const dPath = values
    .map((v, i) => {
      const x = i * step;
      const y = h - (v / max) * (h - 4) - 2;
      return `${i === 0 ? "M" : "L"}${x} ${y}`;
    })
    .join(" ");
  return `<svg class="memory-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-label="Memory history">
    <path d="${escapeHtml(dPath)}" fill="none" stroke="var(--accent)" stroke-width="1.2"/>
  </svg>`;
}

function renderDisplayViewer(htmlUrl) {
  if (!htmlUrl) {
    return `<div class="inspector-block">
      <div class="inspector-label">App Display</div>
      <p class="inspector-meta" style="color: var(--muted); font-family: var(--mono); font-size:0.7rem">No xpra display available for this session.</p>
    </div>`;
  }
  return `<div class="inspector-block">
    <div class="inspector-label">App Display <a class="xpra-open-link" href="${escapeHtml(htmlUrl)}" target="_blank" rel="noopener" title="Open in new tab">&#x2197;</a></div>
    <div class="xpra-viewer">
      <div class="xpra-viewer-loading" id="xpraViewerLoading">Connecting to display…</div>
      <iframe
        class="xpra-iframe"
        id="xpraViewerFrame"
        src="${escapeHtml(htmlUrl)}"
        sandbox="allow-scripts allow-same-origin allow-popups"
        allow="clipboard-read; clipboard-write"
        loading="lazy"
        onload="document.getElementById('xpraViewerLoading').style.display='none'"
      ></iframe>
    </div>
  </div>`;
}

export function mountInspector() {
  const root = document.getElementById("inspectorRoot");
  if (!root) return;

  const loadDetail = (sessionId) => {
    if (!sessionId) {
      state.setSessionDetail(null, false);
      return;
    }
    const s = state.getState();
    state.setSessionDetail(null, true);
    const done = (detail) => {
      state.setSessionDetail(detail, false);
    };
    if (s.useMock) {
      mock
        .mockFetchSessionDetail(sessionId)
        .then(done)
        .catch(() => done(null));
    } else {
      api
        .fetchSessionDetail(sessionId)
        .then(done)
        .catch((e) => {
          state.appendLog(`detail: ${e.message || e}`, "err");
          done(null);
        });
    }
  };

  const render = (s) => {
    if (!s.selectedSessionId) {
      root.innerHTML = "";
      return;
    }
    const id = s.selectedSessionId;
    if (s.inspectorLoading) {
      root.innerHTML = `<div class="inspector-panel"><p class="inspector-loading" style="color: var(--muted); font-family: var(--mono)">Loading…</p></div>`;
      return;
    }
    const d = s.sessionDetail;
    if (!d) {
      root.innerHTML = `<div class="inspector-panel">
        <div class="inspector-header">
          <span>Session ${escapeHtml(id)}</span>
          <button type="button" class="action-btn" id="inspectorClose">close</button>
        </div>
        <p style="color: var(--muted); font-size:0.8rem; font-family: var(--mono)">No detail from server yet.</p>
      </div>`;
      document.getElementById("inspectorClose")?.addEventListener("click", () => {
        state.setSelectedSessionId(null);
      });
      return;
    }
    const tree = JSON.stringify(d.processTree || [], null, 2);
    const htmlUrl = d.xpraHtmlUrl || (d.payload && d.payload.xpraHtmlUrl) || null;
    root.innerHTML = `
      <div class="inspector-panel">
        <div class="inspector-header">
          <span>Inspect · ${escapeHtml(d.sessionId || id)}</span>
          <button type="button" class="action-btn" id="inspectorClose2">close</button>
        </div>
        ${renderDisplayViewer(htmlUrl)}
        <div class="inspector-block">
          <div class="inspector-label">Process tree</div>
          <pre class="inspector-pre">${escapeHtml(tree)}</pre>
        </div>
        <div class="inspector-block">
          <div class="inspector-label">Memory history</div>
          <div class="inspector-chart">${renderSparkline(d.memoryHistory || [])}</div>
        </div>
        <div class="inspector-block">
          <div class="inspector-label">Container</div>
          <p class="inspector-meta" style="font-family: var(--mono); font-size:0.7rem; word-break: break-all">${escapeHtml(
            JSON.stringify(d.container || {}),
          )}</p>
        </div>
      </div>
    `;
    document.getElementById("inspectorClose2")?.addEventListener("click", () => {
      state.setSelectedSessionId(null);
    });
  };

  let prevSel = null;
  return state.subscribe((s) => {
    const id = s.selectedSessionId;
    if (id && id !== prevSel) {
      prevSel = id;
      loadDetail(id);
    } else if (!id) {
      prevSel = null;
    }
    render(s);
  });
}
