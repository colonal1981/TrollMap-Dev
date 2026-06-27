/**
 * capture-panel.js — Contour capture workflow panel.
 *
 * Replaces: contour-job-export.js
 *
 * Handles: draw polygon → set lake/area/zoom → queue jobs → run capture
 * server → auto-import result into contour-data.js.
 */

import { state, CF_WORKER_URL } from '../core/state.js';
import { setBanner } from '../core/map-init.js';
import { loadContourDataset } from './contour-data.js';

const LOCAL_SERVER = 'http://127.0.0.1:8765';
const IBOATING_BASE = 'https://fishing-app.gpsnauticalcharts.com/i-boating-fishing-web-app/fishing-marine-charts-navigation.html';

let captureQueue = [];
let contourLayer = null;
let drawingMode = false;
let serverPollTimer = null;
let currentJobId = null;

function slugify(s) {
  return (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function polygonCentroid(latlngs) {
  const lat = latlngs.reduce((a, p) => a + p.lat, 0) / latlngs.length;
  const lon = latlngs.reduce((a, p) => a + p.lng, 0) / latlngs.length;
  return [lat, lon];
}

export function buildCapturePanel(container) {
  container.innerHTML = `
    <!-- Lake / Area / Zoom -->
    <div style="margin-bottom:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">New capture</div>
      <label style="font-size:10px;color:var(--muted);display:block;margin-bottom:2px">Lake</label>
      <select id="cpLake" style="width:100%;padding:5px 7px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:12px;margin-bottom:6px">
        <option value="">Select lake…</option>
      </select>
      <label style="font-size:10px;color:var(--muted);display:block;margin-bottom:2px">Area name</label>
      <input id="cpArea" placeholder="e.g. Clearwater Cove 1" style="width:100%;padding:5px 7px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:12px;margin-bottom:6px;box-sizing:border-box">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <label style="font-size:10px;color:var(--muted);white-space:nowrap">Capture zoom</label>
        <input id="cpZoom" type="number" min="15" max="22" step="0.5" value="18" style="width:65px;padding:4px 6px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:12px;text-align:center">
        <span style="font-size:10px;color:var(--muted)">18 = recommended</span>
      </div>
    </div>

    <!-- Draw area -->
    <div id="cpPolyInfo" style="font-size:11px;color:var(--muted);margin-bottom:8px;min-height:16px"></div>
    <div style="display:flex;gap:6px;margin-bottom:10px">
      <button id="cpDraw" style="flex:1;height:30px;font-size:11px;border:1px solid #76ff03;background:transparent;color:#76ff03;border-radius:5px;cursor:pointer">✏️ Draw area</button>
      <button id="cpSaveJson" style="flex:1;height:30px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;cursor:pointer">💾 Save JSON</button>
      <button id="cpAddQueue" style="flex:1;height:30px;font-size:11px;border:1px solid var(--accent2);background:transparent;color:var(--accent2);border-radius:5px;cursor:pointer">➕ Queue</button>
      <button id="cpDiscard" style="height:30px;padding:0 10px;font-size:13px;border:1px solid var(--bad);background:transparent;color:var(--bad);border-radius:5px;cursor:pointer">🗑</button>
    </div>

    <!-- Server status -->
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:11px">
      <span id="cpServerDot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#888;flex-shrink:0"></span>
      <span id="cpServerStatus" style="color:var(--muted)">Checking server…</span>
    </div>

    <!-- Run controls -->
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <button id="cpRun" style="flex:1;height:32px;font-size:12px;font-weight:700;border:none;border-radius:6px;background:var(--accent2);color:#000;cursor:pointer">🚀 Run capture</button>
      <button id="cpCancel" style="height:32px;padding:0 12px;font-size:11px;border:1px solid var(--bad);background:transparent;color:var(--bad);border-radius:5px;cursor:pointer;display:none">✕ Cancel</button>
    </div>
    <div id="cpJobStatus" style="display:none;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:6px 8px;margin-bottom:8px;font-size:11px;line-height:1.5"></div>
    <div id="cpImportRow" style="display:none;margin-bottom:8px">
      <button id="cpImport" style="width:100%;height:30px;font-size:11px;font-weight:700;border:none;border-radius:6px;background:var(--accent2);color:#000;cursor:pointer">📥 Load into Contour Data</button>
    </div>

    <!-- Queue -->
    <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:4px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <span style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Job queue</span>
        <label style="cursor:pointer;padding:2px 8px;border:1px solid var(--accent);border-radius:4px;font-size:10px;color:var(--accent)">
          📂 Load JSONs<input id="cpQueueFile" type="file" accept=".json" multiple style="display:none">
        </label>
      </div>
      <div id="cpQueueList" style="font-size:11px;color:var(--muted);min-height:20px">Queue empty</div>
      <div style="display:flex;gap:6px;margin-top:6px">
        <button id="cpRunQueue" style="flex:1;height:28px;font-size:11px;font-weight:700;border:none;border-radius:5px;background:var(--accent2);color:#000;cursor:pointer;display:none">▶ Run queue</button>
        <button id="cpClearQueue" style="height:28px;padding:0 10px;font-size:11px;border:1px solid var(--bad);background:transparent;color:var(--bad);border-radius:5px;cursor:pointer;display:none">🗑 Clear</button>
      </div>
    </div>
  `;

  populateLakeDropdown();
  wireCapturePanel();
  checkServer();
  setInterval(checkServer, 10000);
}

function populateLakeDropdown() {
  const sel = document.getElementById('cpLake');
  if (!sel) return;
  const names = window.getUniversalLakeNames
    ? window.getUniversalLakeNames()
    : ['Lake Wateree', 'Lake Murray', 'Lake Marion', 'Lake Moultrie', 'Lake Monticello'];
  names.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  });
}

async function checkServer() {
  const dot = document.getElementById('cpServerDot');
  const status = document.getElementById('cpServerStatus');
  try {
    const r = await fetch(`${LOCAL_SERVER}/status`, { signal: AbortSignal.timeout(2000) });
    const data = await r.json();
    if (dot) dot.style.background = '#76ff03';
    if (status) status.textContent = `Server ready${data.job ? ' — job running' : ''}`;
  } catch (_) {
    if (dot) dot.style.background = '#e63946';
    if (status) status.textContent = 'Server offline — start trollmap_capture_server.py';
  }
}

function buildJob(latlngs) {
  const lake = document.getElementById('cpLake')?.value || '';
  const area = document.getElementById('cpArea')?.value || '';
  const zoom = parseFloat(document.getElementById('cpZoom')?.value || '18');
  const lakeSlug = slugify(lake);
  const areaSlug = slugify(area) || `capture_${new Date().toISOString().slice(0,10).replace(/-/g,'')}`;
  const [cLat, cLon] = polygonCentroid(latlngs);
  const bounds = L.latLngBounds(latlngs);
  const polygon = latlngs.map(p => [+p.lng.toFixed(7), +p.lat.toFixed(7)]);
  if (polygon.length && (polygon[0][0] !== polygon[polygon.length-1][0] || polygon[0][1] !== polygon[polygon.length-1][1])) {
    polygon.push(polygon[0]);
  }
  return {
    name: areaSlug,
    lake_name: lake,
    area_name: area,
    source_url: `${IBOATING_BASE}#${zoom.toFixed(1)}/${cLat.toFixed(7)}/${cLon.toFixed(7)}`,
    polygon,
    bbox: { north: bounds.getNorth(), south: bounds.getSouth(), west: bounds.getWest(), east: bounds.getEast() },
    zoom,
    viewport: [2400, 1400],
    overlap: 0.25,
    wait: 12.0,
    retries: 4,
  };
}

function setJobStatus(msg, show = true) {
  const el = document.getElementById('cpJobStatus');
  if (el) { el.style.display = show ? 'block' : 'none'; el.textContent = msg; }
}

let currentLatLngs = null;

function wireCapturePanel() {
  // Draw button
  document.getElementById('cpDraw')?.addEventListener('click', () => {
    if (!state.MAP_OK) return;
    drawingMode = !drawingMode;
    const btn = document.getElementById('cpDraw');
    if (drawingMode) {
      setBanner('Click to add polygon points. Double-click to finish.');
      btn.textContent = '⏹ Stop drawing';
      btn.style.background = 'rgba(118,255,3,.15)';
      // Simple click-to-draw using Leaflet
      const pts = [];
      let previewLayer = null;
      const clickHandler = (e) => {
        pts.push(e.latlng);
        if (previewLayer) state.MAP.removeLayer(previewLayer);
        if (pts.length > 1) {
          previewLayer = L.polygon(pts, { color: '#76ff03', weight: 2, fillOpacity: 0.1 }).addTo(state.MAP);
        }
      };
      const dblHandler = (e) => {
        state.MAP.off('click', clickHandler);
        state.MAP.off('dblclick', dblHandler);
        drawingMode = false;
        btn.textContent = '✏️ Draw area';
        btn.style.background = '';
        setBanner('');
        if (pts.length >= 3) {
          currentLatLngs = pts;
          if (contourLayer) state.MAP.removeLayer(contourLayer);
          contourLayer = L.polygon(pts, { color: '#76ff03', weight: 2, fillOpacity: 0.1 }).addTo(state.MAP);
          const [cLat, cLon] = polygonCentroid(pts);
          const info = document.getElementById('cpPolyInfo');
          if (info) info.textContent = `${pts.length} points · centroid ${cLat.toFixed(4)}, ${cLon.toFixed(4)}`;
        }
      };
      state.MAP.on('click', clickHandler);
      state.MAP.on('dblclick', dblHandler);
    } else {
      btn.textContent = '✏️ Draw area';
      btn.style.background = '';
      setBanner('');
    }
  });

  // Save JSON
  document.getElementById('cpSaveJson')?.addEventListener('click', () => {
    if (!currentLatLngs) { alert('Draw a polygon first'); return; }
    const job = buildJob(currentLatLngs);
    const lake = document.getElementById('cpLake')?.value || 'lake';
    const blob = new Blob([JSON.stringify(job, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${slugify(lake)}_${job.name}.json`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // Add to queue
  document.getElementById('cpAddQueue')?.addEventListener('click', () => {
    if (!currentLatLngs) { alert('Draw a polygon first'); return; }
    const job = buildJob(currentLatLngs);
    captureQueue.push(job);
    renderQueue();
    if (contourLayer) { state.MAP.removeLayer(contourLayer); contourLayer = null; }
    currentLatLngs = null;
    const info = document.getElementById('cpPolyInfo');
    if (info) info.textContent = '';
    const area = document.getElementById('cpArea');
    if (area) area.value = '';
  });

  // Discard
  document.getElementById('cpDiscard')?.addEventListener('click', () => {
    if (contourLayer) { state.MAP.removeLayer(contourLayer); contourLayer = null; }
    currentLatLngs = null;
    const info = document.getElementById('cpPolyInfo');
    if (info) info.textContent = '';
  });

  // Run single job
  document.getElementById('cpRun')?.addEventListener('click', async () => {
    if (!currentLatLngs && !captureQueue.length) { alert('Draw a polygon or load a job JSON first'); return; }
    const job = currentLatLngs ? buildJob(currentLatLngs) : captureQueue[0];
    await runJob(job);
  });

  // Run queue
  document.getElementById('cpRunQueue')?.addEventListener('click', async () => {
    for (const job of [...captureQueue]) {
      await runJob(job);
      captureQueue.shift();
      renderQueue();
    }
  });

  // Clear queue
  document.getElementById('cpClearQueue')?.addEventListener('click', () => {
    captureQueue = [];
    renderQueue();
  });

  // Load JSON files
  document.getElementById('cpQueueFile')?.addEventListener('change', async (e) => {
    for (const f of Array.from(e.target.files)) {
      try {
        const job = JSON.parse(await f.text());
        if (!job.name) job.name = f.name.replace(/\.json$/i, '');
        captureQueue.push(job);
      } catch (err) { console.warn('Bad job JSON:', f.name, err); }
    }
    renderQueue();
    e.target.value = '';
  });

  // Import after capture
  document.getElementById('cpImport')?.addEventListener('click', async () => {
    if (!currentJobId) return;
    await loadContourDataset(currentJobId, true, false);
    document.getElementById('cpImportRow').style.display = 'none';
    setJobStatus('Loaded into Contour Data tab ✓');
  });
}

async function runJob(job) {
  const runBtn = document.getElementById('cpRun');
  const cancelBtn = document.getElementById('cpCancel');
  if (runBtn) runBtn.style.display = 'none';
  if (cancelBtn) cancelBtn.style.display = '';
  setJobStatus('Starting capture…');
  document.getElementById('cpImportRow').style.display = 'none';

  try {
    const r = await fetch(`${LOCAL_SERVER}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
    });
    if (!r.ok) throw new Error(`Server error: HTTP ${r.status}`);
    const { job_id } = await r.json();
    currentJobId = job_id;
    pollJobStatus(job_id);
  } catch (err) {
    setJobStatus(`Error: ${err.message}`);
    if (runBtn) runBtn.style.display = '';
    if (cancelBtn) cancelBtn.style.display = 'none';
  }
}

function pollJobStatus(jobId) {
  if (serverPollTimer) clearInterval(serverPollTimer);
  serverPollTimer = setInterval(async () => {
    try {
      const r = await fetch(`${LOCAL_SERVER}/status`);
      const data = await r.json();
      if (!data.job || data.job.job_id !== jobId) {
        clearInterval(serverPollTimer);
        setJobStatus('✅ Capture complete!');
        document.getElementById('cpRun').style.display = '';
        document.getElementById('cpCancel').style.display = 'none';
        document.getElementById('cpImportRow').style.display = 'block';
        return;
      }
      setJobStatus(`${data.job.stage || 'Running'} — ${data.job.progress || ''}%`);
    } catch (_) {
      clearInterval(serverPollTimer);
      setJobStatus('Lost connection to server');
      document.getElementById('cpRun').style.display = '';
      document.getElementById('cpCancel').style.display = 'none';
    }
  }, 2000);
}

function renderQueue() {
  const list = document.getElementById('cpQueueList');
  const runBtn = document.getElementById('cpRunQueue');
  const clearBtn = document.getElementById('cpClearQueue');
  if (!captureQueue.length) {
    if (list) list.innerHTML = '<span style="color:var(--muted)">Queue empty</span>';
    if (runBtn) runBtn.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'none';
    return;
  }
  if (list) {
    list.innerHTML = captureQueue.map((j, i) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.05)">
        <span style="color:var(--text);font-size:11px">${i+1}. ${j.lake_name ? j.lake_name + ' — ' : ''}${j.area_name || j.name}</span>
        <button data-qi="${i}" style="background:none;border:none;color:var(--bad);cursor:pointer;font-size:12px">✕</button>
      </div>
    `).join('');
    list.querySelectorAll('[data-qi]').forEach(btn => {
      btn.addEventListener('click', () => {
        captureQueue.splice(parseInt(btn.dataset.qi), 1);
        renderQueue();
      });
    });
  }
  if (runBtn) runBtn.style.display = '';
  if (clearBtn) clearBtn.style.display = '';
}

// Wire the old btnDrawContour button to open the routes panel on capture tab
document.getElementById('btnDrawContour')?.addEventListener('click', () => {
  document.getElementById('btnContourRoutes')?.click();
});

console.log('[capture-panel] module ready');
