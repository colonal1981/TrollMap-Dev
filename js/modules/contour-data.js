/**
 * contour-data.js — Contour dataset registry and lazy loader.
 *
 * Manages the list of available contour datasets from R2, handles
 * smart/raw toggling per dataset, and lazy-loads GeoJSON geometry
 * only when a dataset is toggled on. Metadata persists in IndexedDB;
 * geometry lives in R2 and is fetched on demand.
 *
 * Replaces: cloud-chartpacks.js (tile import) — contour data flow only.
 * The old tile import for chart overlays stays in chart-import.js.
 *
 * Exports:
 *   getActiveContour()     — { smart, raw } GeoJSON or nulls
 *   onContourChange(fn)    — subscribe to contour dataset changes
 *   loadContourDataset(key, type) — force load a specific dataset
 */

import { state, CF_WORKER_URL } from '../core/state.js';

// ── Internal state ────────────────────────────────────────────────────────────

const CB = () => `?v=${Date.now()}`;
let changeListeners = [];
let datasetCache = {};   // key -> { smart: GeoJSON|null, raw: GeoJSON|null }

// ── Public API ────────────────────────────────────────────────────────────────

export function getActiveContour() {
  return state.ACTIVE_CONTOUR || { smart: null, raw: null };
}

export function onContourChange(fn) {
  changeListeners.push(fn);
}

function notifyChange() {
  changeListeners.forEach(fn => { try { fn(state.ACTIVE_CONTOUR); } catch (_) {} });
  // Expose globally for pinch-point-finder.js compatibility
  window._smartRouteGeoJSON = state.ACTIVE_CONTOUR?.smart || state.ACTIVE_CONTOUR?.raw || null;
}

// ── Dataset list ──────────────────────────────────────────────────────────────

async function fetchDatasetList() {
  try {
    const r = await fetch(`${CF_WORKER_URL}/chartpacks/list${CB()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    return (data.chartpacks || []);
  } catch (e) {
    console.warn('[contour-data] fetch list failed:', e);
    return [];
  }
}

async function fetchContourGeoJSON(key, type) {
  // type = 'smart' -> contours.smart.geojson, 'raw' -> contours.geojson
  const filename = type === 'smart' ? 'contours.smart.geojson' : 'contours.geojson';
  const url = `${CF_WORKER_URL}/chartpacks/${key}/${filename}${CB()}`;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

// ── Contour layer rendering ───────────────────────────────────────────────────

const DEPTH_COLORS = [
  { max: 10,  color: '#e63946' },  // red    0-10ft
  { max: 20,  color: '#f4a261' },  // orange 10-20ft
  { max: 28,  color: '#e9c46a' },  // yellow 20-28ft
  { max: 36,  color: '#2a9d8f' },  // green  28-36ft
  { max: 45,  color: '#00e5ff' },  // cyan   36-45ft
  { max: 55,  color: '#0077b6' },  // blue   45-55ft
  { max: 65,  color: '#7b2d8b' },  // purple 55-65ft
  { max: Infinity, color: '#ffffff' }, // white 65ft+
];

function depthColor(ft) {
  for (const band of DEPTH_COLORS) {
    if (ft <= band.max) return band.color;
  }
  return '#ffffff';
}

export function renderContourLayer(showSmart = true, showRaw = false) {
  if (!state.MAP_OK) return;
  if (state.CONTOUR_LAYER) state.MAP.removeLayer(state.CONTOUR_LAYER);
  state.CONTOUR_LAYER = L.layerGroup().addTo(state.MAP);

  const contour = state.ACTIVE_CONTOUR;
  if (!contour) return;

  const layers = [];
  if (showSmart && contour.smart) layers.push({ gj: contour.smart, dashed: false });
  if (showRaw   && contour.raw)   layers.push({ gj: contour.raw,   dashed: true  });

  for (const { gj, dashed } of layers) {
    if (!gj?.features?.length) continue;
    L.geoJSON(gj, {
      style(feat) {
        const depth = feat.properties?.depth_ft || 0;
        return {
          color: depthColor(depth),
          weight: 1.5,
          opacity: 0.85,
          dashArray: dashed ? '4,4' : null,
        };
      },
      onEachFeature(feat, layer) {
        const d = feat.properties?.depth_ft;
        if (d != null) layer.bindTooltip(`${d} ft`, { sticky: true });
      },
    }).addTo(state.CONTOUR_LAYER);
  }
}

// ── Auto-load all known datasets on startup ──────────────────────────────────
// Fetches the dataset list and merges every available contour GeoJSON into one
// combined FeatureCollection so the whole map shows depth data immediately on
// open, with no manual "load this lake" step.

export async function loadAllContoursOnStartup() {
  try {
    const datasets = await fetchDatasetList();
    if (!datasets.length) {
      console.warn('[contour-data] no datasets found for auto-load');
      return;
    }
    console.log(`[contour-data] auto-loading ${datasets.length} dataset(s)...`);

    const allFeatures = [];
    const loadedKeys = [];
    for (const ds of datasets) {
      const key = ds.name;
      if (!datasetCache[key]) datasetCache[key] = { smart: null, raw: null };
      const cache = datasetCache[key];

      // NOTE: PBF pipeline replaced the smart post-processor. Only load raw contours.geojson
      let gj = await fetchContourGeoJSON(key, 'raw');
      if (!gj?.features?.length) {
        console.warn(`[contour-data] no features for ${key}, skipping`);
        continue;
      }
      cache.smart = cache.smart || gj;
      allFeatures.push(...gj.features);
      loadedKeys.push(key);
    }

    if (!allFeatures.length) {
      console.warn('[contour-data] auto-load found no features across any dataset');
      return;
    }

    // Tag each feature with its source lake so later filtering/UI can split
    // them back out if needed, without re-fetching.
    const combined = { type: 'FeatureCollection', features: allFeatures };

    state.ACTIVE_CONTOUR = { smart: combined, raw: null };
    state.ACTIVE_CONTOUR_KEY = `all_lakes (${loadedKeys.length})`;
    state.ACTIVE_CONTOUR_LAKES = loadedKeys;

    notifyChange();
    renderContourLayer(true, false);
    console.log(`[contour-data] auto-loaded ${allFeatures.length} features across ${loadedKeys.length} lake(s): ${loadedKeys.join(', ')}`);
  } catch (e) {
    console.warn('[contour-data] auto-load failed:', e);
  }
}

// ── Load a dataset ────────────────────────────────────────────────────────────

export async function loadContourDataset(key, preferSmart = true, loadRaw = false) {
  if (!key) return;

  // Use cache if available
  if (!datasetCache[key]) datasetCache[key] = { smart: null, raw: null };
  const cache = datasetCache[key];

  let changed = false;

  if (preferSmart && !cache.smart) {
    const gj = await fetchContourGeoJSON(key, 'smart');
    cache.smart = gj;
    changed = true;
    // If smart not available, auto-fall back to raw
    if (!gj && !cache.raw) {
      console.log('[contour-data] smart not found, falling back to raw');
      const rawGj = await fetchContourGeoJSON(key, 'raw');
      cache.raw = rawGj;
    }
  }
  if (loadRaw && !cache.raw) {
    const gj = await fetchContourGeoJSON(key, 'raw');
    cache.raw = gj;
    changed = true;
  }

  // Use smart if available, fall back to raw
  const activeSmart = preferSmart ? cache.smart : null;
  const activeRaw = loadRaw ? cache.raw : (!cache.smart ? cache.raw : null);

  state.ACTIVE_CONTOUR = {
    smart: activeSmart,
    raw:   activeRaw,
  };
  state.ACTIVE_CONTOUR_KEY = key;

  notifyChange();
  return state.ACTIVE_CONTOUR;
}

// ── Panel UI ──────────────────────────────────────────────────────────────────

export function buildContourDataPanel(container) {
  container.innerHTML = `
    <div style="margin-bottom:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Loaded lakes</div>
      <div id="cdActiveInfo" style="font-size:11px;color:var(--muted);background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:8px">No data loaded</div>
      <button id="cdReloadAll" style="margin-top:6px;width:100%;height:28px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;cursor:pointer">↻ Reload all lakes</button>
    </div>

    <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Individual lakes</div>
      <div id="cdDatasetList" style="font-size:11px;color:var(--muted)">Loading...</div>
    </div>

    <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
      <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text)">
        <input type="checkbox" id="cdShowContourLayer" checked> Show contours on map
      </label>
    </div>

    <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Load local file</div>
      <label style="display:block;width:100%;cursor:pointer">
        <div style="width:100%;height:28px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;display:flex;align-items:center;justify-content:center;cursor:pointer;box-sizing:border-box">
          📂 Load local contours.geojson
        </div>
        <input type="file" id="cdLocalFile" accept=".geojson,.json" style="display:none">
      </label>
    </div>
  `;

  // Wire events
  document.getElementById('cdReloadAll')?.addEventListener('click', async () => {
    const btn = document.getElementById('cdReloadAll');
    btn.textContent = 'Reloading...';
    btn.disabled = true;
    await loadAllContoursOnStartup();
    updateActiveInfo();
    refreshDatasetList(container);
    btn.textContent = '↻ Reload all lakes';
    btn.disabled = false;
  });

  document.getElementById('cdLocalFile')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const gj = JSON.parse(await file.text());
      state.ACTIVE_CONTOUR = { smart: gj, raw: null };
      state.ACTIVE_CONTOUR_KEY = file.name;
      notifyChange();
      updateActiveInfo();
      redrawIfVisible();
    } catch (err) {
      alert('Could not parse GeoJSON: ' + err.message);
    }
    e.target.value = '';
  });

  document.getElementById('cdShowContourLayer')?.addEventListener('change', redrawIfVisible);

  refreshDatasetList(container);
  updateActiveInfo();
}

function redrawIfVisible() {
  const showLayer = document.getElementById('cdShowContourLayer')?.checked !== false;
  if (showLayer) {
    renderContourLayer(true, false);
  } else if (state.CONTOUR_LAYER) {
    state.MAP?.removeLayer(state.CONTOUR_LAYER);
  }
}

function updateActiveInfo() {
  const el = document.getElementById('cdActiveInfo');
  if (!el) return;
  const c = state.ACTIVE_CONTOUR;
  const lakes = state.ACTIVE_CONTOUR_LAKES;
  const featureCount = c?.smart?.features?.length || c?.raw?.features?.length || 0;

  if (!featureCount) {
    el.innerHTML = '<div style="color:var(--muted)">No contour data loaded</div>';
    return;
  }

  if (Array.isArray(lakes) && lakes.length) {
    const lakeNames = lakes.map(l => l.replace(/^lake_/, '').replace(/_/g, ' ')).join(', ');
    el.innerHTML = `
      <div style="color:var(--accent);font-weight:600;margin-bottom:3px">${lakes.length} lake(s) loaded</div>
      <div>${lakeNames}</div>
      <div style="color:var(--muted);margin-top:3px">${featureCount.toLocaleString()} total features</div>
    `;
  } else {
    el.innerHTML = `
      <div style="color:var(--accent);font-weight:600;margin-bottom:3px">${state.ACTIVE_CONTOUR_KEY || 'Local file'}</div>
      <div>${featureCount.toLocaleString()} features</div>
    `;
  }
}

async function refreshDatasetList(container) {
  const listEl = document.getElementById('cdDatasetList');
  if (!listEl) return;
  listEl.textContent = 'Loading...';

  const datasets = await fetchDatasetList();
  if (!datasets.length) {
    listEl.textContent = 'No datasets found in cloud library.';
    return;
  }

  listEl.innerHTML = datasets.map(ds => {
    const isActive = ds.name === state.ACTIVE_CONTOUR_KEY;
    return `
      <div style="display:flex;align-items:center;gap:6px;padding:6px 8px;margin-bottom:4px;border:1px solid ${isActive ? 'var(--accent)' : 'var(--line)'};border-radius:6px;background:${isActive ? 'rgba(0,229,255,.08)' : 'var(--panel2)'}">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${isActive ? 'var(--accent)' : 'var(--text)'}">${ds.name}</span>
        <button data-key="${ds.name}" class="cd-load-btn" style="height:24px;padding:0 8px;font-size:10px;font-weight:700;border:none;border-radius:4px;background:${isActive ? 'var(--accent)' : 'var(--accent2)'};color:#000;cursor:pointer;flex-shrink:0">
          ${isActive ? 'Active' : 'Load'}
        </button>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.cd-load-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.key;
      btn.textContent = '...';
      btn.disabled = true;
      await loadContourDataset(key, true, false);
      updateActiveInfo();
      redrawIfVisible();
      refreshDatasetList(container);
      notifyChange();
    });
  });
}

// Subscribe to contour changes to keep active info in sync
onContourChange(() => {
  updateActiveInfo();
  redrawIfVisible();
});

console.log('[contour-data] module ready');
