/**
 * route-debug.js
 * Floating debug panel that captures spine data from route-builder
 * and displays it in a scrollable overlay — no console needed.
 * 
 * Add to main.js: import './modules/route-debug.js';
 */

// Global debug store
window._routeDebug = [];

window.logSpineDebug = function logSpineDebug(phase, rawSpine, preparedSpine) {
  const entry = {
    phase,
    rawPts: rawSpine?.length || 0,
    rawStart: rawSpine?.[0],
    rawEnd: rawSpine?.[rawSpine?.length - 1],
    prepPts: preparedSpine?.length || 0,
    prepStart: preparedSpine?.[0],
    prepEnd: preparedSpine?.[preparedSpine?.length - 1],
    // Check for reversals in prepared spine
    reversals: countReversals(preparedSpine),
    // First 20 points of prepared spine
    prepSample: preparedSpine?.slice(0, 20),
  };
  window._routeDebug.push(entry);
  renderDebugPanel();
}

function countReversals(pts) {
  if (!pts || pts.length < 3) return 0;
  let reversals = 0;
  const bearings = [];
  for (let i = 1; i < pts.length; i++) {
    const dlat = pts[i][0] - pts[i-1][0];
    const dlon = pts[i][1] - pts[i-1][1];
    if (Math.abs(dlat) > 0.00001 || Math.abs(dlon) > 0.00001) {
      bearings.push(Math.atan2(dlon, dlat) * 180 / Math.PI);
    }
  }
  for (let i = 1; i < bearings.length; i++) {
    let diff = Math.abs(bearings[i] - bearings[i-1]);
    if (diff > 180) diff = 360 - diff;
    if (diff > 120) reversals++;
  }
  return reversals;
}

function renderDebugPanel() {
  let panel = document.getElementById('_routeDebugPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = '_routeDebugPanel';
    Object.assign(panel.style, {
      position: 'fixed', bottom: '70px', left: '80px', right: '20px',
      maxHeight: '300px', overflowY: 'auto',
      background: 'rgba(11,22,35,0.97)', border: '2px solid #00e5ff',
      borderRadius: '10px', padding: '10px', zIndex: '9999',
      fontFamily: 'monospace', fontSize: '11px', color: '#e7eef6',
      display: 'none'
    });
    
    const header = document.createElement('div');
    Object.assign(header.style, { display: 'flex', justifyContent: 'space-between', marginBottom: '6px' });
    header.innerHTML = '<b style="color:#00e5ff">🔍 Route Spine Debug</b><div><button id="_routeDebugClear" style="margin-right:6px;padding:2px 8px;font-size:10px;cursor:pointer">Clear</button><button id="_routeDebugClose" style="padding:2px 8px;font-size:10px;cursor:pointer">✕</button></div>';
    panel.appendChild(header);
    
    const content = document.createElement('div');
    content.id = '_routeDebugContent';
    panel.appendChild(content);
    
    document.body.appendChild(panel);
    
    document.getElementById('_routeDebugClear').onclick = () => { window._routeDebug = []; renderDebugPanel(); };
    document.getElementById('_routeDebugClose').onclick = () => { panel.style.display = 'none'; };
  }
  
  panel.style.display = 'block';
  const content = document.getElementById('_routeDebugContent');
  
  content.innerHTML = window._routeDebug.map((e, i) => {
    const rawS = e.rawStart ? `(${e.rawStart[0]?.toFixed(5)},${e.rawStart[1]?.toFixed(5)})` : '?';
    const rawE = e.rawEnd   ? `(${e.rawEnd[0]?.toFixed(5)},${e.rawEnd[1]?.toFixed(5)})` : '?';
    const prepS = e.prepStart ? `(${e.prepStart[0]?.toFixed(5)},${e.prepStart[1]?.toFixed(5)})` : '?';
    const prepE = e.prepEnd   ? `(${e.prepEnd[0]?.toFixed(5)},${e.prepEnd[1]?.toFixed(5)})` : '?';
    const revColor = e.reversals > 0 ? '#ff5252' : '#76ff03';
    
    const sampleRows = (e.prepSample || []).map((p, j) => 
      `<tr><td style="color:#8aa3bd">${j}</td><td>${p[0]?.toFixed(5)}</td><td>${p[1]?.toFixed(5)}</td></tr>`
    ).join('');
    
    return `
      <div style="border:1px solid #1e3a5f;border-radius:6px;padding:8px;margin-bottom:8px">
        <div style="color:#00e5ff;font-weight:700;margin-bottom:4px">Phase ${e.phase} — ${e.rawPts} raw pts → ${e.prepPts} prepared pts — <span style="color:${revColor}">${e.reversals} reversals</span></div>
        <div style="color:#ffb703">Start ref: (${e.sLat?.toFixed(5)}, ${e.sLon?.toFixed(5)})</div>
        <div>Raw:  ${rawS} → ${rawE}</div>
        <div>Prep: ${prepS} → ${prepE}</div>
        ${e.candidateScores ? '<div style="color:#8aa3bd;font-size:10px">' + e.candidateScores.join('<br>') + '</div>' : ''}
        <details style="margin-top:4px">
          <summary style="cursor:pointer;color:#8aa3bd">First 20 prepared points</summary>
          <table style="width:100%;border-collapse:collapse;margin-top:4px">
            <tr style="color:#00e5ff"><th>#</th><th>Lat</th><th>Lon</th></tr>
            ${sampleRows}
          </table>
        </details>
      </div>`;
  }).join('');
}

// Add toggle button to toolbar
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const toolbar = document.querySelector('.map-toolbar');
    if (toolbar) {
      const btn = document.createElement('button');
      btn.textContent = '🔍 Spine Debug';
      btn.title = 'Show route spine debug panel';
      btn.onclick = () => {
        const panel = document.getElementById('_routeDebugPanel');
        if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      };
      toolbar.appendChild(btn);
    }
  }, 2000);
});

console.log('[route-debug] Spine debug panel ready');