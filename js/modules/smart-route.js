/**
 * Smart Route Generator — auto-generates trolling passes along
 * vectorized depth contours loaded from the cloud or local GeoJSON.
 *
 * Workflow:
 *   1. User opens Smart Route panel, picks a target depth range
 *   2. Module loads contours.geojson from R2 (or local file)
 *   3. Turf.js filters contour lines matching the depth range
 *   4. Lines are clipped to the user-drawn polygon (if any)
 *   5. Parallel offset passes generated at the configured spacing
 *   6. Result committed to state.DATA.tracks and exported as GPX
 *
 * Requires Turf.js loaded in the page (CDN or bundled).
 * turf is available at window.turf from the Leaflet CDN block.
 */

import { state, CF_WORKER_URL } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { setBanner } from '../core/map-init.js';
import { LAKE_DB as IMPORTED_LAKE_DB } from '../data/lakes.js';

// ── State ─────────────────────────────────────────────────────────────────────

let smartRouteLayer   = null;   // Leaflet layer showing generated routes
let contourPreviewLayer = null; // Leaflet layer showing loaded contours
let activeGeoJSON     = null;   // loaded FeatureCollection
let drawingClipPoly   = null;   // L.Draw polygon for clip area
let clipPolygon       = null;   // GeoJSON polygon for clipping

// ── Panel HTML ────────────────────────────────────────────────────────────────

function buildPanel() {
  const existing = document.getElementById('smartRoutePanel');
  if (existing) return existing;

  const panel = document.createElement('div');
  panel.id = 'smartRoutePanel';
  panel.style.cssText = `
    display:none;position:absolute;top:60px;right:8px;z-index:650;
    background:rgba(11,22,35,.96);border:1px solid var(--accent2);
    border-radius:10px;padding:12px 14px;font-size:12px;width:300px;
    box-shadow:0 4px 20px rgba(0,0,0,.7);max-height:80vh;overflow-y:auto;
  `;
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <span style="color:var(--accent2);font-weight:700;font-size:13px">🧠 Smart Route Generator</span>
      <button id="srClose" style="background:none;border:none;color:var(--muted);font-size:15px;cursor:pointer">✕</button>
    </div>

    <!-- Load contours -->
    <div style="margin-bottom:10px">
      <label style="color:var(--muted);font-size:10px;display:block;margin-bottom:3px">CONTOUR SOURCE</label>
      <div style="display:flex;gap:4px">
        <select id="srLakeSelect" style="flex:1;background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:4px;font-size:11px">
          <option value="">-- pick cloud contour dataset --</option>
        </select>
        <button id="srLoadCloud" class="small primary" style="white-space:nowrap">☁️ Load</button>
      </div>
      <label id="srLoadFile" style="display:block;margin-top:4px;cursor:pointer;padding:3px 8px;border:1px dashed var(--line);border-radius:4px;text-align:center;color:var(--muted);font-size:10px">
        📂 Or load local contours.geojson
        <input id="srFileInput" type="file" accept=".geojson,.json" style="display:none">
      </label>
    </div>

    <!-- Status -->
    <div id="srStatus" style="font-size:11px;color:var(--muted);margin-bottom:8px;min-height:16px"></div>

    <!-- Depth range -->
    <div style="margin-bottom:8px">
      <label style="color:var(--muted);font-size:10px;display:block;margin-bottom:3px">TARGET DEPTH RANGE (ft)</label>
      <div style="display:flex;gap:6px;align-items:center">
        <input id="srDepthMin" type="number" value="18" min="1" max="200" style="width:60px;background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:4px;font-size:12px">
        <span style="color:var(--muted)">to</span>
        <input id="srDepthMax" type="number" value="28" min="1" max="200" style="width:60px;background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:4px;font-size:12px">
        <span style="color:var(--muted);font-size:10px">ft</span>
      </div>
    </div>

    <!-- Pass spacing -->
    <div style="margin-bottom:8px">
      <label style="color:var(--muted);font-size:10px;display:block;margin-bottom:3px">PASS SPACING (ft)</label>
      <input id="srSpacing" type="number" value="150" min="50" max="500" step="25"
        style="width:80px;background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:4px;font-size:12px">
    </div>

    <!-- Pattern -->
    <div style="margin-bottom:8px">
      <label style="color:var(--muted);font-size:10px;display:block;margin-bottom:3px">PATTERN</label>
      <select id="srPattern" style="width:100%;background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:4px;font-size:11px">
        <option value="follow">Follow contour (trace the depth line)</option>
        <option value="parallel">Parallel passes across contour</option>
        <option value="scurve">S-curve along contour</option>
      </select>
    </div>

    <!-- Clip polygon -->
    <div style="margin-bottom:10px">
      <label style="color:var(--muted);font-size:10px;display:block;margin-bottom:3px">AREA FILTER (optional)</label>
      <div style="display:flex;gap:4px">
        <button id="srDrawClip" class="small" style="flex:1">✏️ Draw area</button>
        <button id="srClearClip" class="small" style="color:var(--bad);border-color:var(--bad)">✕ Clear</button>
      </div>
      <div id="srClipStatus" style="font-size:10px;color:var(--muted);margin-top:3px"></div>
    </div>

    <!-- Preview contours toggle -->
    <div style="margin-bottom:10px">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--text);font-size:11px">
        <input type="checkbox" id="srShowContours" checked>
        Show depth contours on map
      </label>
    </div>

    <!-- Generate -->
    <div style="display:flex;gap:6px">
      <button id="srGenerate" class="small primary" style="flex:1;background:var(--accent2);color:#000;font-weight:700">⚡ Generate Routes</button>
      <button id="srCommit" class="small primary" style="flex:1;display:none">✅ Commit to Plan</button>
    </div>
    <div id="srResult" style="margin-top:8px;font-size:11px;color:var(--accent2)"></div>
  `;
  document.getElementById('panel-map')?.appendChild(panel);
  return panel;
}

// ── Load contours ─────────────────────────────────────────────────────────────

function setStatus(msg, isErr = false) {
  const el = document.getElementById('srStatus');
  if (el) { el.textContent = msg; el.style.color = isErr ? 'var(--bad)' : 'var(--muted)'; }
}

function normalizeContourSlug(name = '') {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function lakeWorkerKeyFromName(lakeName = '') {
  const normalized = String(lakeName)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const aliases = {
    wateree: 'wateree',
    murray: 'murray',
    marion: 'marion',
    moultrie: 'moultrie',
    keowee: 'keowee',
    jocassee: 'jocassee',
    hartwell: 'hartwell',
    thurmond: 'thurmond',
    'clarks hill': 'thurmond',
    'clark hill': 'thurmond',
    russell: 'russell',
    wylie: 'wylie',
    norman: 'norman',
  };

  for (const [frag, key] of Object.entries(aliases)) {
    if (normalized.includes(frag)) return key;
  }

  return normalizeContourSlug(normalized.split(' ')[0] || '');
}

function buildContourLookupCandidates({ key = '', displayName = '' } = {}) {
  const raw = String(displayName || '').trim();
  const noState = raw.replace(/,\s*[A-Z]{2}$/i, '').trim();
  const noLakePrefix = noState.replace(/^lake\s+/i, '').trim();
  const candidates = new Set();

  if (key) candidates.add(normalizeContourSlug(key));
  if (raw) candidates.add(normalizeContourSlug(raw));
  if (noState) candidates.add(normalizeContourSlug(noState));
  if (noLakePrefix) candidates.add(normalizeContourSlug(noLakePrefix));
  const derived = lakeWorkerKeyFromName(raw || key);
  if (derived) candidates.add(derived);

  return [...candidates].filter(Boolean);
}

async function loadContoursFromCloud(lakeRef) {
  const displayName = typeof lakeRef === 'string' ? lakeRef : (lakeRef?.displayName || lakeRef?.key || 'selected lake');
  setStatus(`Loading contours for ${displayName}...`);

  const tried = [];
  const candidates = buildContourLookupCandidates(
    typeof lakeRef === 'string' ? { displayName: lakeRef } : lakeRef,
  );

  for (const key of candidates) {
    const urls = [
      `${CF_WORKER_URL}/chartpacks/${encodeURIComponent(key)}/contours.geojson?v=${Date.now()}`,
      `${CF_WORKER_URL}/contours/${encodeURIComponent(key)}/geojson?v=${Date.now()}`,
    ];

    for (const url of urls) {
      tried.push(url);
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) return r.json();
      if (r.status !== 404) {
        throw new Error(`Worker returned ${r.status} while loading contours for ${displayName}`);
      }
    }
  }

  throw new Error(`No contour file found for ${displayName}. Tried keys: ${candidates.join(', ')}`);
}

async function fetchCloudContourDatasets() {
  const r = await fetch(`${CF_WORKER_URL}/chartpacks/list?v=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Worker returned ${r.status} while listing chartpacks`);
  const data = await r.json();
  return (data.chartpacks || [])
    .filter((cp) => (cp.files || []).some((f) => f === 'vectors/contours.geojson' || f === 'contours.geojson'))
    .map((cp) => {
      const tileCount = (cp.files || []).filter((f) => /_contours\.png$/i.test(f)).length;
      const hasLegacyVector = (cp.files || []).includes('vectors/contours.geojson');
      const hasRootVector = (cp.files || []).includes('contours.geojson');
      return {
        key: cp.name,
        label: cp.name.replace(/_/g, ' '),
        tileCount,
        hasLegacyVector,
        hasRootVector,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function loadContoursFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try { resolve(JSON.parse(e.target.result)); }
      catch (err) { reject(new Error('Invalid GeoJSON: ' + err.message)); }
    };
    reader.onerror = () => reject(new Error('File read failed'));
    reader.readAsText(file);
  });
}

function applyGeoJSON(geojson) {
  activeGeoJSON = geojson;
  const count = geojson.features?.length || 0;
  const depths = [...new Set(geojson.features?.map(f => f.properties?.depth_ft).filter(Boolean))].sort((a,b)=>a-b);
  setStatus(`✅ ${count} contour lines loaded. Depths: ${depths.join(', ')} ft`);
  if (document.getElementById('srShowContours')?.checked) renderContourPreview();
}

// ── Contour preview on map ────────────────────────────────────────────────────

const DEPTH_COLORS_CSS = {
  5: '#ef5350', 10: '#f57c00', 15: '#fbc02d', 20: '#c6d400',
  25: '#66bb6a', 30: '#388e3c', 36: '#1b5e20', 45: '#0288d1',
  55: '#1565c0', 65: '#6a1b9a', 80: '#4a148c',
};

function renderContourPreview() {
  if (!state.MAP_OK || !activeGeoJSON) return;
  if (contourPreviewLayer) state.MAP.removeLayer(contourPreviewLayer);

  contourPreviewLayer = L.geoJSON(activeGeoJSON, {
    style: (feat) => {
      const d = feat.properties?.depth_ft;
      const color = DEPTH_COLORS_CSS[d] || '#ffffff';
      return { color, weight: 1.5, opacity: 0.7, dashArray: null };
    },
    onEachFeature: (feat, layer) => {
      const d = feat.properties?.depth_ft;
      const src = feat.properties?.source;
      layer.bindTooltip(`${d}ft ${src === 'ocr_confirmed' ? '✓ OCR' : '(color)'}`, { sticky: true });
    },
  }).addTo(state.MAP);
}

// ── Turf.js helpers ───────────────────────────────────────────────────────────

function turf() {
  if (!window.turf) throw new Error('Turf.js not loaded — add <script src="https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js"></script>');
  return window.turf;
}

function filterByDepth(geojson, minFt, maxFt) {
  return {
    type: 'FeatureCollection',
    features: geojson.features.filter(f => {
      const d = f.properties?.depth_ft;
      return d != null && d >= minFt && d <= maxFt;
    }),
  };
}

function clipToPolygon(geojson, clipPoly) {
  if (!clipPoly) return geojson;
  const T = turf();
  const clipped = [];
  for (const feat of geojson.features) {
    try {
      const c = T.lineIntersect ? T.booleanWithin(feat, clipPoly) ? feat : null : feat;
      if (c) clipped.push(c);
    } catch (_) {
      clipped.push(feat); // keep if clip fails
    }
  }
  return { type: 'FeatureCollection', features: clipped };
}

function metersToLatDeg(m) { return m / 111320; }
function metersToLonDeg(m, lat) { return m / (111320 * Math.cos(lat * Math.PI / 180)); }
function ftToMeters(ft) { return ft * 0.3048; }

/**
 * Generate parallel offset passes along a set of contour lines.
 * For each contour line: create N offset copies at spacing intervals
 * perpendicular to the line direction.
 */
function generateParallelPasses(filteredGeoJSON, spacingFt, numPasses = 3) {
  const T = turf();
  const spacingM = ftToMeters(spacingFt);
  const tracks = [];

  for (const feat of filteredGeoJSON.features) {
    const coords = feat.geometry.coordinates;
    if (coords.length < 2) continue;

    // Original line
    tracks.push({
      name: `SR_${feat.properties.depth_ft}ft_C0`,
      pts: coords.map(([lon, lat]) => [lat, lon]),
      depth_ft: feat.properties.depth_ft,
    });

    // Offset copies
    for (let i = 1; i <= numPasses; i++) {
      for (const dir of [-1, 1]) {
        try {
          const offsetLine = T.lineOffset(feat, (spacingM * i * dir) / 1000, { units: 'kilometers' });
          if (offsetLine?.geometry?.coordinates?.length >= 2) {
            tracks.push({
              name: `SR_${feat.properties.depth_ft}ft_C${dir > 0 ? '+' : '-'}${i}`,
              pts: offsetLine.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
              depth_ft: feat.properties.depth_ft,
            });
          }
        } catch (_) {}
      }
    }
  }

  return tracks;
}

/**
 * Generate S-curve passes along contour lines.
 */
function generateSCurvePasses(filteredGeoJSON, spacingFt, ampFt = 30, waveFt = 300) {
  const T = turf();
  const spacingM = ftToMeters(spacingFt);
  const tracks = [];

  for (const feat of filteredGeoJSON.features) {
    const coords = feat.geometry.coordinates;
    if (coords.length < 3) continue;
    const depth = feat.properties.depth_ft;

    // Generate sine-wave offset along the line
    const n = Math.max(8, coords.length * 3);
    const ampM = ftToMeters(ampFt);
    const waveM = ftToMeters(waveFt);
    const wavePts = [];

    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const idx = Math.min(Math.floor(t * (coords.length - 1)), coords.length - 2);
      const frac = t * (coords.length - 1) - idx;
      const a = coords[idx], b = coords[idx + 1];
      const lon = a[0] + (b[0] - a[0]) * frac;
      const lat = a[1] + (b[1] - a[1]) * frac;

      // Perpendicular offset
      const dlat = (b[1] - a[1]);
      const dlon = (b[0] - a[0]);
      const len  = Math.sqrt(dlat*dlat + dlon*dlon) || 1;
      const px = -dlat / len;
      const py =  dlon / len;

      const traveled = t * coords.length * 0.0001 * 111320; // approx
      const off = Math.sin((2 * Math.PI * traveled) / Math.max(10, waveM)) * ampM;

      const newLat = lat + metersToLatDeg(off * px);
      const newLon = lon + metersToLonDeg(off * py, lat);
      wavePts.push([newLat, newLon]);
    }

    if (wavePts.length >= 2) {
      tracks.push({ name: `SR_${depth}ft_scurve`, pts: wavePts, depth_ft: depth });
    }
  }

  return tracks;
}

// ── Main generation ───────────────────────────────────────────────────────────

let pendingTracks = [];

function generateSmartRoutes() {
  if (!activeGeoJSON) { setStatus('Load contours first', true); return; }

  const minFt = parseInt(document.getElementById('srDepthMin')?.value) || 18;
  const maxFt = parseInt(document.getElementById('srDepthMax')?.value) || 28;
  const spacingFt = parseInt(document.getElementById('srSpacing')?.value) || 150;
  const pattern = document.getElementById('srPattern')?.value || 'follow';

  setStatus(`Generating ${pattern} passes for ${minFt}-${maxFt}ft...`);

  try {
    let filtered = filterByDepth(activeGeoJSON, minFt, maxFt);
    if (clipPolygon) filtered = clipToPolygon(filtered, clipPolygon);

    if (!filtered.features.length) {
      setStatus(`No contour lines found in ${minFt}-${maxFt}ft range`, true);
      return;
    }

    let tracks = [];
    if (pattern === 'follow') {
      tracks = filtered.features
        .filter(f => f.geometry.coordinates.length >= 2)
        .map(f => ({
          name: `SR_${f.properties.depth_ft}ft`,
          pts: f.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
          depth_ft: f.properties.depth_ft,
        }));
    } else if (pattern === 'parallel') {
      tracks = generateParallelPasses(filtered, spacingFt, 2);
    } else if (pattern === 'scurve') {
      tracks = generateSCurvePasses(filtered, spacingFt, 30, 300);
    }

    if (!tracks.length) {
      setStatus('No routes generated — try widening the depth range', true);
      return;
    }

    // Show preview on map
    if (smartRouteLayer) state.MAP?.removeLayer(smartRouteLayer);
    smartRouteLayer = L.layerGroup();
    tracks.forEach((t, i) => {
      const depth = t.depth_ft || minFt;
      const color = DEPTH_COLORS_CSS[depth] || '#76ff03';
      L.polyline(t.pts, { color, weight: 2.5, dashArray: '8 4', opacity: 0.9 })
        .bindTooltip(`${t.name} (${depth}ft)`, { sticky: true })
        .addTo(smartRouteLayer);
    });
    smartRouteLayer.addTo(state.MAP);

    pendingTracks = tracks;
    const resultEl = document.getElementById('srResult');
    if (resultEl) resultEl.textContent = `✅ ${tracks.length} route(s) generated across ${filtered.features.length} contour line(s)`;
    const commitBtn = document.getElementById('srCommit');
    if (commitBtn) commitBtn.style.display = '';
    setStatus('Preview shown — click Commit to add to plan');

  } catch (e) {
    setStatus(`Generation failed: ${e.message}`, true);
    console.error('[smart-route]', e);
  }
}

function commitRoutes() {
  if (!pendingTracks.length) return;
  pendingTracks.forEach(t => state.DATA.tracks.push({ name: t.name, pts: t.pts }));
  window.renderAll?.();
  const resultEl = document.getElementById('srResult');
  if (resultEl) resultEl.textContent = `✅ ${pendingTracks.length} routes added to plan. Export GPX when ready.`;
  const commitBtn = document.getElementById('srCommit');
  if (commitBtn) commitBtn.style.display = 'none';
  setBanner(`✅ Smart routes committed — ${pendingTracks.length} tracks added`);
  pendingTracks = [];
}

// ── Clip polygon drawing ──────────────────────────────────────────────────────

function startDrawClip() {
  if (!state.MAP_OK) return;
  setBanner('Draw clip area — double-click or click first point to close');
  const drawHandler = new L.Draw.Polygon(state.MAP, {
    shapeOptions: { color: '#ffb703', dashArray: '6 3', fillOpacity: 0.1 },
  });
  drawHandler.enable();
  state.MAP.once(L.Draw.Event.CREATED, (e) => {
    drawingClipPoly = e.layer;
    drawingClipPoly.addTo(state.MAP);
    const latlngs = e.layer.getLatLngs()[0];
    const coords = latlngs.map(p => [p.lng, p.lat]);
    coords.push(coords[0]);
    clipPolygon = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] } };
    const el = document.getElementById('srClipStatus');
    if (el) el.textContent = `✅ Area set (${latlngs.length} points)`;
    setBanner('');
  });
}

function clearClip() {
  if (drawingClipPoly) { state.MAP?.removeLayer(drawingClipPoly); drawingClipPoly = null; }
  clipPolygon = null;
  const el = document.getElementById('srClipStatus');
  if (el) el.textContent = 'No area filter';
}

// ── Populate lake dropdown ────────────────────────────────────────────────────

async function populateLakeDropdown() {
  const sel = document.getElementById('srLakeSelect');
  if (!sel) return;

  sel.innerHTML = '<option value="">Loading cloud contour datasets...</option>';

  try {
    const datasets = await fetchCloudContourDatasets();
    sel.innerHTML = '<option value="">-- pick cloud contour dataset --</option>';

    if (!datasets.length) {
      sel.innerHTML = '<option value="">-- no cloud contour datasets found --</option>';
      setStatus('No uploaded cloud contour datasets with vector GeoJSON were found.', true);
      return;
    }

    datasets.forEach((ds) => {
      const opt = document.createElement('option');
      opt.value = ds.key;
      opt.textContent = `${ds.label} (${ds.tileCount} tiles)`;
      opt.dataset.displayName = ds.label;
      opt.dataset.contourKey = ds.key;
      opt.dataset.vectorLayout = ds.hasRootVector ? 'root' : (ds.hasLegacyVector ? 'legacy' : 'unknown');
      sel.appendChild(opt);
    });

    setStatus(`Loaded ${datasets.length} cloud contour dataset${datasets.length === 1 ? '' : 's'}.`);
  } catch (e) {
    console.warn('[smart-route] cloud contour dataset list failed', e);
    sel.innerHTML = '<option value="">-- cloud list unavailable; use local file --</option>';
    setStatus(`Could not list cloud contour datasets: ${e.message}`, true);
  }
}

// ── Wire everything ───────────────────────────────────────────────────────────

function init() {
  const panel = buildPanel();
  populateLakeDropdown();

  document.getElementById('btnSmartRoute')?.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    if (panel.style.display === 'block') populateLakeDropdown();
  });
  document.getElementById('srClose')?.addEventListener('click', () => {
    panel.style.display = 'none';
  });

  document.getElementById('srLoadCloud')?.addEventListener('click', async () => {
    const sel = document.getElementById('srLakeSelect');
    const selected = sel?.options?.[sel.selectedIndex];
    const contourKey = selected?.dataset?.contourKey || sel?.value;
    const displayName = selected?.dataset?.displayName || selected?.textContent || sel?.value;
    if (!contourKey) { setStatus('Select a lake first', true); return; }
    try {
      const geojson = await loadContoursFromCloud({ key: contourKey, displayName });
      applyGeoJSON(geojson);
    } catch (e) {
      setStatus(e.message, true);
    }
  });

  document.getElementById('srFileInput')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const geojson = await loadContoursFromFile(file);
      applyGeoJSON(geojson);
    } catch (e) {
      setStatus(e.message, true);
    }
  });

  document.getElementById('srShowContours')?.addEventListener('change', (e) => {
    if (e.target.checked) {
      renderContourPreview();
    } else {
      if (contourPreviewLayer) { state.MAP?.removeLayer(contourPreviewLayer); contourPreviewLayer = null; }
    }
  });

  document.getElementById('srGenerate')?.addEventListener('click', generateSmartRoutes);
  document.getElementById('srCommit')?.addEventListener('click', commitRoutes);
  document.getElementById('srDrawClip')?.addEventListener('click', startDrawClip);
  document.getElementById('srClearClip')?.addEventListener('click', clearClip);
}

// Defer init until map is ready
setTimeout(init, 1500);

console.log('✓ Smart Route Generator armed');
