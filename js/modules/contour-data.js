/**
 * contour-data.js — Contour dataset lazy loader + lake selector integration.
 */

import { LAKE_NAME_TO_R2_KEY, resolveR2Key } from '../data/lake-keys.js';

export { LAKE_NAME_TO_R2_KEY, resolveR2Key };

import { state, CF_WORKER_URL } from '../core/state.js';

const CHAIN_DESCRIPTIONS = {
  'lake_thurmond_russell':      'Clarks Hill / Thurmond + Russell Chain',
  'lake_greenwood_secession':   'Lake Greenwood + Secession Chain',
  'lake_monticello_parr':       'Lake Monticello + Parr Reservoir',
  'lake_wateree_fishing_creek': 'Lake Wateree + Fishing Creek',
  'lake_hickory_rhodhiss':      'Lake Hickory + Rhodhiss Chain',
  'lake_norman_mountain_island':'Lake Norman + Mountain Island Chain',
  'yadkin_river_chain':         'Yadkin River Chain (High Rock → Blewett Falls)',
  'watauga_boone_chain':        'Watauga / Boone Lake Chain',
  'sc_ga_coastal':              'SC / GA Coastal Waters',
};

// ── IndexedDB cache ───────────────────────────────────────────────────────────
const IDB_NAME  = 'trollmap_contours';
const IDB_STORE = 'geojson';
const CACHE_TTL = 24 * 60 * 60 * 1000;

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE, { keyPath: 'key' });
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function idbGet(key) {
  try {
    const db  = await openDB();
    const tx  = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    return await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => rej(req.error);
    });
  } catch (_) { return null; }
}

async function idbSet(key, value) {
  try {
    const db = await openDB();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ key, value, ts: Date.now() });
  } catch (_) {}
}

let changeListeners = [];
let _loadingKey     = null;

export function getActiveContour() {
  return state.ACTIVE_CONTOUR || { smart: null, raw: null };
}

export function onContourChange(fn) {
  changeListeners.push(fn);
}

function notifyChange() {
  changeListeners.forEach(fn => { try { fn(state.ACTIVE_CONTOUR); } catch (_) {} });
  window._smartRouteGeoJSON = state.ACTIVE_CONTOUR?.smart || state.ACTIVE_CONTOUR?.raw || null;
}

async function fetchFromR2(r2Key) {
  const url = `${CF_WORKER_URL}/chartpacks/${r2Key}/contours.geojson?v=${Date.now()}`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function loadContourByR2Key(r2Key) {
  if (!r2Key) return;
  if (_loadingKey === r2Key) return;
  _loadingKey = r2Key;

  updateStatusPanel('loading', r2Key);

  try {
    const cached = await idbGet(r2Key);
    if (cached && cached.ts && (Date.now() - cached.ts) < CACHE_TTL && cached.value?.features?.length) {
      console.log(`[contour-data] cache hit: ${r2Key} (${cached.value.features.length} features)`);
      state.ACTIVE_CONTOUR     = { smart: cached.value, raw: null };
      state.ACTIVE_CONTOUR_KEY = r2Key;
      notifyChange();
      renderContourLayer(true, false);
      updateStatusPanel('loaded', r2Key, cached.value.features.length);
      _loadingKey = null;
      return;
    }

    console.log(`[contour-data] fetching from R2: ${r2Key}`);
    const gj = await fetchFromR2(r2Key);
    if (!gj?.features?.length) throw new Error('empty response');

    await idbSet(r2Key, gj);
    state.ACTIVE_CONTOUR     = { smart: gj, raw: null };
    state.ACTIVE_CONTOUR_KEY = r2Key;
    notifyChange();
    renderContourLayer(true, false);
    updateStatusPanel('loaded', r2Key, gj.features.length);
    console.log(`[contour-data] loaded ${gj.features.length} features for ${r2Key}`);
  } catch (e) {
    console.warn(`[contour-data] failed to load ${r2Key}:`, e.message);
    updateStatusPanel('error', r2Key, 0, e.message);
  }
  _loadingKey = null;
}

// ── Fuzzy name resolver — handles access-index name variations ────────────────

export async function loadContourForLake(displayName) {
  if (!displayName || displayName.startsWith('river:')) return;
  const r2Key = resolveR2Key(displayName);
  if (!r2Key) {
    console.warn(`[contour-data] no R2 key for lake: "${displayName}"`);
    updateStatusPanel('none', displayName);
    return;
  }
  console.log(`[contour-data] "${displayName}" → ${r2Key}`);
  await loadContourByR2Key(r2Key);
}

// ── Contour layer rendering ───────────────────────────────────────────────────
const DEPTH_COLORS = [
  { max: 10,       color: '#e63946' },
  { max: 20,       color: '#f4a261' },
  { max: 28,       color: '#e9c46a' },
  { max: 36,       color: '#2a9d8f' },
  { max: 45,       color: '#00e5ff' },
  { max: 55,       color: '#0077b6' },
  { max: 65,       color: '#7b2d8b' },
  { max: Infinity, color: '#ffffff' },
];

function depthColor(ft) {
  for (const band of DEPTH_COLORS) { if (ft <= band.max) return band.color; }
  return '#ffffff';
}

// Canvas renderer instance — shared across all contour layers for best performance
const _canvasRenderer = L.canvas({ padding: 0.5 });

// Zoom threshold below which contour lines are hidden (depth areas still show)
const CONTOUR_MIN_ZOOM = 11;

export function renderContourLayer(showSmart = true, showRaw = false) {
  if (!state.MAP_OK) return;
  if (state.CONTOUR_LAYER) state.MAP.removeLayer(state.CONTOUR_LAYER);
  state.CONTOUR_LAYER = L.layerGroup().addTo(state.MAP);

  const contour = state.ACTIVE_CONTOUR;
  if (!contour) return;

  // Below CONTOUR_MIN_ZOOM, hide contour lines — depth area polygons carry the visual at low zoom
  const zoom = state.MAP.getZoom();
  if (zoom < CONTOUR_MIN_ZOOM) return;

  const smoothFactor = zoom >= 14 ? 0.5 : zoom >= 12 ? 1.0 : 1.5;

  const layers = [];
  if (showSmart && contour.smart) layers.push({ gj: contour.smart, dashed: false });
  if (showRaw   && contour.raw)   layers.push({ gj: contour.raw,   dashed: true  });

  for (const { gj, dashed } of layers) {
    if (!gj?.features?.length) continue;
    L.geoJSON(gj, {
      renderer: _canvasRenderer,
      smoothFactor,
      style(feat) {
        const depth = feat.properties?.depth_ft || 0;
        return { color: depthColor(depth), weight: 1.5, opacity: 0.85, dashArray: dashed ? '4,4' : null };
      },
      onEachFeature(feat, layer) {
        // Use click popup instead of sticky tooltip — sticky tooltips on canvas are expensive
        const d = feat.properties?.depth_ft;
        const name = feat.properties?.name;
        const tip = name ? name : (d != null ? `${d} ft` : null);
        if (tip) layer.bindPopup(tip, { closeButton: false, className: 'contour-popup' });
      },
    }).addTo(state.CONTOUR_LAYER);
  }

  if (typeof window.bringDepthAreasToBack === 'function') window.bringDepthAreasToBack();
}

// Re-render contour lines on zoom changes so threshold gating takes effect
function _wireZoomHandler() {
  if (!state.MAP_OK || !state.MAP) { setTimeout(_wireZoomHandler, 500); return; }
  state.MAP.on('zoomend', () => {
    const showLayer = document.getElementById('cdShowContourLayer')?.checked !== false;
    if (showLayer && state.ACTIVE_CONTOUR) renderContourLayer(true, false);
  });
}
_wireZoomHandler();

function updateStatusPanel(status, key, count = 0, errMsg = '') {
  const el = document.getElementById('cdActiveInfo');
  if (!el) return;
  const label = CHAIN_DESCRIPTIONS[key] || key?.replace(/_/g, ' ') || key || '—';
  if (status === 'loading') {
    el.innerHTML = `<div style="color:var(--accent)">⏳ Loading ${label}...</div>`;
  } else if (status === 'loaded') {
    el.innerHTML = `<div style="color:var(--accent2);font-weight:600;margin-bottom:3px">✅ ${label}</div><div style="color:var(--muted)">${count.toLocaleString()} contour features</div>`;
  } else if (status === 'error') {
    el.innerHTML = `<div style="color:var(--warn);font-weight:600">❌ Failed to load ${label}</div><div style="color:var(--muted);font-size:10px">${errMsg}</div><div style="color:var(--muted);font-size:10px">Check R2 upload or try local file</div>`;
  } else if (status === 'none') {
    el.innerHTML = `<div style="color:var(--muted)">No contour data for ${label}</div>`;
  } else {
    el.innerHTML = `<div style="color:var(--muted)">No contour data loaded</div>`;
  }
}

export function buildContourDataPanel(container) {
  container.innerHTML = `
    <div style="margin-bottom:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Active contour data</div>
      <div id="cdActiveInfo" style="font-size:11px;color:var(--muted);background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:8px">Select a lake to load contours</div>
      <button id="cdClearContours" style="margin-top:6px;width:100%;height:28px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;cursor:pointer">✕ Clear contours</button>
    </div>
    <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Show on map</div>
      <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text)"><input type="checkbox" id="cdShowContourLayer" checked> Show depth contours</label>
    </div>
    <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Load local file</div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:6px">QDC exports, pipeline output, or any contours.geojson</div>
      <label style="display:block;width:100%;cursor:pointer">
        <div style="width:100%;height:28px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;display:flex;align-items:center;justify-content:center;cursor:pointer;box-sizing:border-box">📂 Load local .geojson</div>
        <input type="file" id="cdLocalFile" accept=".geojson,.json" style="display:none">
      </label>
    </div>
    <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Cache</div>
      <button id="cdClearCache" style="width:100%;height:28px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;cursor:pointer">🗑 Clear contour cache (force re-fetch)</button>
    </div>
  `;

  document.getElementById('cdClearContours')?.addEventListener('click', () => {
    state.ACTIVE_CONTOUR = null; state.ACTIVE_CONTOUR_KEY = null;
    if (state.CONTOUR_LAYER) state.MAP?.removeLayer(state.CONTOUR_LAYER);
    state.CONTOUR_LAYER = null;
    notifyChange(); updateStatusPanel('idle');
  });

  document.getElementById('cdShowContourLayer')?.addEventListener('change', e => {
    if (e.target.checked) { renderContourLayer(true, false); window.toggleDepthAreas?.(true); }
    else if (state.CONTOUR_LAYER) { state.MAP?.removeLayer(state.CONTOUR_LAYER); window.toggleDepthAreas?.(false); }
  });

  document.getElementById('cdLocalFile')?.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const gj = JSON.parse(await file.text());
      if (!gj?.features?.length) throw new Error('no features found');
      state.ACTIVE_CONTOUR = { smart: gj, raw: null };
      state.ACTIVE_CONTOUR_KEY = file.name;
      notifyChange(); renderContourLayer(true, false);
      updateStatusPanel('loaded', file.name, gj.features.length);
    } catch (err) { alert('Could not parse GeoJSON: ' + err.message); }
    e.target.value = '';
  });

  document.getElementById('cdClearCache')?.addEventListener('click', async () => {
    const btn = document.getElementById('cdClearCache');
    btn.textContent = 'Clearing...'; btn.disabled = true;
    try {
      const db = await openDB();
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).clear();
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
      btn.textContent = '✅ Cache cleared';
      setTimeout(() => { btn.textContent = '🗑 Clear contour cache (force re-fetch)'; btn.disabled = false; }, 2000);
    } catch (e) { btn.textContent = '❌ Failed'; btn.disabled = false; }
  });

  const c = state.ACTIVE_CONTOUR;
  const count = c?.smart?.features?.length || c?.raw?.features?.length || 0;
  if (count && state.ACTIVE_CONTOUR_KEY) updateStatusPanel('loaded', state.ACTIVE_CONTOUR_KEY, count);
}

onContourChange(() => {
  const c = state.ACTIVE_CONTOUR;
  const count = c?.smart?.features?.length || c?.raw?.features?.length || 0;
  if (count && state.ACTIVE_CONTOUR_KEY) updateStatusPanel('loaded', state.ACTIVE_CONTOUR_KEY, count);
  const showLayer = document.getElementById('cdShowContourLayer')?.checked !== false;
  if (showLayer) { renderContourLayer(true, false); window.toggleDepthAreas?.(true); }
});

window.loadContourForLake = loadContourForLake;

export async function loadContourDataset(key) { return loadContourByR2Key(key); }

console.log('[contour-data] module ready — 65 lakes mapped');