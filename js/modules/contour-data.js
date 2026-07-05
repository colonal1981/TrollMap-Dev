/**
 * contour-data.js — Contour dataset registry and layer manager.
 *
 * All contour sources (R2 cloud lakes, local GeoJSON files) coexist as
 * independent named layers — none replace or clear any other.
 *
 * Architecture:
 *   CONTOUR_REGISTRY  map of name → { geo, leafletLayer, source, visible }
 *   state.CONTOUR_LAYER  single parent L.layerGroup containing all children
 *   state.ACTIVE_CONTOUR merged view of all visible layers (for catch-journal,
 *                        route-builder, pinch-point-finder compatibility)
 *
 * Storage:
 *   R2 GeoJSONs cached in IndexedDB (24hr TTL). Startup reads cache first
 *   → renders immediately → refreshes from R2 in background silently.
 *   Local files persisted to IndexedDB permanently (no TTL).
 *
 * Exports:
 *   getActiveContour()            → merged { smart, raw } of all visible layers
 *   onContourChange(fn)           → subscribe to registry changes
 *   loadContourDataset(key)       → force-load/toggle a specific R2 lake
 *   loadAllContoursOnStartup()    → called from main.js boot
 *   buildContourDataPanel(el)     → renders the panel UI
 *   renderContourLayer()          → re-renders all visible layers on map
 */

import { state, CF_WORKER_URL } from '../core/state.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const IDB_STORE      = 'contour_cache';
const IDB_LOCAL      = 'contour_local';
const CACHE_TTL_MS   = 24 * 60 * 60 * 1000; // 24 hours
const CB             = () => `?v=${Date.now()}`;

// ── Registry ──────────────────────────────────────────────────────────────────
// name → { geo, layer: L.geoJSON|null, source: 'r2'|'local', visible, cachedAt? }

const CONTOUR_REGISTRY = {};
let changeListeners = [];

// ── Depth colors (unchanged) ──────────────────────────────────────────────────

const DEPTH_COLORS = [
  { max: 10,  color: '#e63946' },
  { max: 20,  color: '#f4a261' },
  { max: 28,  color: '#e9c46a' },
  { max: 36,  color: '#2a9d8f' },
  { max: 45,  color: '#00e5ff' },
  { max: 55,  color: '#0077b6' },
  { max: 65,  color: '#7b2d8b' },
  { max: Infinity, color: '#ffffff' },
];

function depthColor(ft) {
  for (const band of DEPTH_COLORS) {
    if (ft <= band.max) return band.color;
  }
  return '#ffffff';
}

// ── IDB helpers ───────────────────────────────────────────────────────────────

async function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('TrollMapContours', 2);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      if (!db.objectStoreNames.contains(IDB_LOCAL)) db.createObjectStore(IDB_LOCAL);
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbGet(store, key) {
  try {
    const db = await idbOpen();
    return new Promise(resolve => {
      const tx = db.transaction(store, 'readonly');
      const r  = tx.objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror   = () => resolve(null);
    });
  } catch { return null; }
}

async function idbPut(store, key, value) {
  try {
    const db = await idbOpen();
    return new Promise(resolve => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror    = () => resolve(false);
    });
  } catch { return false; }
}

async function idbDel(store, key) {
  try {
    const db = await idbOpen();
    return new Promise(resolve => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror    = () => resolve(false);
    });
  } catch { return false; }
}

async function idbGetAll(store) {
  try {
    const db = await idbOpen();
    return new Promise(resolve => {
      const results = [];
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).openCursor();
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) { results.push({ key: cursor.key, value: cursor.value }); cursor.continue(); }
        else resolve(results);
      };
      req.onerror = () => resolve([]);
    });
  } catch { return []; }
}

// ── Registry management ───────────────────────────────────────────────────────

function buildLeafletLayer(geo) {
  return L.geoJSON(geo, {
    style(feat) {
      const depth = feat.properties?.depth_ft || feat.properties?.depth || 0;
      return { color: depthColor(depth), weight: 1.5, opacity: 0.85 };
    },
    onEachFeature(feat, layer) {
      const d = feat.properties?.depth_ft || feat.properties?.depth;
      if (d != null) layer.bindTooltip(`${Math.round(d)} ft`, { sticky: true });
    },
  });
}

function addToRegistry(name, geo, source, visible = true, cachedAt = null) {
  // Remove old leaflet layer from map if replacing
  if (CONTOUR_REGISTRY[name]?.layer && state.MAP_OK) {
    state.MAP.removeLayer(CONTOUR_REGISTRY[name].layer);
  }

  const layer = buildLeafletLayer(geo);
  if (visible && state.MAP_OK) {
    ensureParentLayer();
    layer.addTo(state.CONTOUR_LAYER);
  }

  CONTOUR_REGISTRY[name] = { geo, layer, source, visible, cachedAt };
  syncStateContour();
  notifyChange();
}

function removeFromRegistry(name) {
  const entry = CONTOUR_REGISTRY[name];
  if (!entry) return;
  if (entry.layer && state.MAP_OK) state.MAP.removeLayer(entry.layer);
  delete CONTOUR_REGISTRY[name];
  syncStateContour();
  notifyChange();
}

function ensureParentLayer() {
  if (!state.MAP_OK) return;
  if (!state.CONTOUR_LAYER) {
    state.CONTOUR_LAYER = L.layerGroup().addTo(state.MAP);
  }
}

// Keep state.ACTIVE_CONTOUR as a merged view for backward compat
function syncStateContour() {
  const allFeatures = [];
  const loadedKeys  = [];
  for (const [name, entry] of Object.entries(CONTOUR_REGISTRY)) {
    if (!entry.visible) continue;
    const features = entry.geo?.features || [];
    allFeatures.push(...features);
    loadedKeys.push(name);
  }
  const combined = { type: 'FeatureCollection', features: allFeatures };
  state.ACTIVE_CONTOUR       = { smart: combined, raw: null };
  state.ACTIVE_CONTOUR_KEY   = loadedKeys.length === 1 ? loadedKeys[0] : `${loadedKeys.length} layers`;
  state.ACTIVE_CONTOUR_LAKES = loadedKeys;
  window._smartRouteGeoJSON  = combined;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getActiveContour() {
  return state.ACTIVE_CONTOUR || { smart: null, raw: null };
}

export function onContourChange(fn) {
  changeListeners.push(fn);
}

function notifyChange() {
  changeListeners.forEach(fn => { try { fn(state.ACTIVE_CONTOUR); } catch (_) {} });
  updateActiveInfo();
  refreshDatasetList();
}

// ── R2 fetch ──────────────────────────────────────────────────────────────────

async function fetchDatasetList() {
  try {
    const r = await fetch(`${CF_WORKER_URL}/chartpacks/list${CB()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const packs = data.chartpacks || [];
    const ignores = ['ramps', 'paddle', 'bankpier', 'attractors'];
    return packs.filter(p => !ignores.includes(p.key) && !ignores.includes(p.name));
  } catch (e) {
    console.warn('[contour-data] fetch list failed:', e);
    return [];
  }
}

async function fetchContourGeoJSONFromR2(key) {
  const url = `${CF_WORKER_URL}/chartpacks/${key}/contours.geojson${CB()}`;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ── Startup: load from IDB cache first, then refresh from R2 ─────────────────

export async function loadAllContoursOnStartup() {
  // 1. Restore local files first (no TTL — always valid)
  const localEntries = await idbGetAll(IDB_LOCAL);
  for (const { key, value } of localEntries) {
    if (value?.geo?.features?.length) {
      addToRegistry(key, value.geo, 'local', true, null);
      console.log(`[contour-data] restored local: ${key} (${value.geo.features.length} features)`);
    }
  }

  // 2. Get dataset list from R2
  const datasets = await fetchDatasetList();
  if (!datasets.length) {
    console.warn('[contour-data] no R2 datasets found');
    return;
  }

  const now = Date.now();

  // 3. For each lake: serve from IDB cache immediately if fresh, else fetch R2
  const freshFetches = [];

  for (const ds of datasets) {
    const key     = ds.name;
    const cached  = await idbGet(IDB_STORE, key);
    const isFresh = cached?.geo?.features?.length && cached.cachedAt && (now - cached.cachedAt) < CACHE_TTL_MS;

    if (isFresh) {
      // Render immediately from cache
      addToRegistry(key, cached.geo, 'r2', true, cached.cachedAt);
      const ageH = Math.round((now - cached.cachedAt) / 3600000);
      console.log(`[contour-data] cache hit: ${key} (${ageH}h old, ${cached.geo.features.length} features)`);

      // Background refresh if older than 20 hours
      if ((now - cached.cachedAt) > 20 * 3600000) {
        freshFetches.push({ key, background: true });
      }
    } else {
      // Need fresh fetch — collect for parallel load
      freshFetches.push({ key, background: false });
    }
  }

  // 4. Parallel fetch for stale/missing lakes
  if (freshFetches.length) {
    const foreground = freshFetches.filter(f => !f.background);
    const background = freshFetches.filter(f => f.background);

    if (foreground.length) {
      console.log(`[contour-data] fetching ${foreground.length} lake(s) from R2...`);
      const results = await Promise.allSettled(
        foreground.map(({ key }) => fetchContourGeoJSONFromR2(key).then(geo => ({ key, geo })))
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.geo?.features?.length) {
          const { key, geo } = r.value;
          addToRegistry(key, geo, 'r2', true, now);
          await idbPut(IDB_STORE, key, { geo, cachedAt: now });
          console.log(`[contour-data] loaded: ${key} (${geo.features.length} features)`);
        }
      }
    }

    // Background refreshes fire without awaiting
    if (background.length) {
      Promise.allSettled(
        background.map(({ key }) => fetchContourGeoJSONFromR2(key).then(async geo => {
          if (geo?.features?.length) {
            addToRegistry(key, geo, 'r2', CONTOUR_REGISTRY[key]?.visible ?? true, now);
            await idbPut(IDB_STORE, key, { geo, cachedAt: now });
            console.log(`[contour-data] background refresh: ${key}`);
          }
        }))
      ).catch(() => {});
    }
  }

  renderContourLayer();
}

// ── Toggle individual R2 lake ─────────────────────────────────────────────────

export async function loadContourDataset(key) {
  const existing = CONTOUR_REGISTRY[key];

  if (existing) {
    // Toggle visibility
    existing.visible = !existing.visible;
    if (existing.layer) {
      if (existing.visible) {
        ensureParentLayer();
        existing.layer.addTo(state.CONTOUR_LAYER);
      } else {
        state.MAP?.removeLayer(existing.layer);
      }
    }
    syncStateContour();
    notifyChange();
    return;
  }

  // Not loaded yet — fetch from R2 (check IDB first)
  const now    = Date.now();
  const cached = await idbGet(IDB_STORE, key);
  const isFresh = cached?.geo?.features?.length && cached.cachedAt && (now - cached.cachedAt) < CACHE_TTL_MS;

  const geo = isFresh ? cached.geo : await fetchContourGeoJSONFromR2(key);
  if (!geo?.features?.length) {
    console.warn(`[contour-data] no data for ${key}`);
    return;
  }

  if (!isFresh) await idbPut(IDB_STORE, key, { geo, cachedAt: now });
  addToRegistry(key, geo, 'r2', true, now);
  renderContourLayer();
}

// ── Local file import ─────────────────────────────────────────────────────────

export async function importLocalContourFile(file) {
  try {
    const text = await file.text();
    const geo  = JSON.parse(text);
    if (!geo?.features?.length) {
      alert('No features found in this GeoJSON file.');
      return;
    }
    const name = `📂 ${file.name.replace(/\.[^.]+$/, '')}`;
    addToRegistry(name, geo, 'local', true, null);
    await idbPut(IDB_LOCAL, name, { geo });
    renderContourLayer();
    console.log(`[contour-data] local file imported: ${name} (${geo.features.length} features)`);
  } catch (err) {
    alert(`Could not parse GeoJSON: ${err.message}`);
  }
}

async function removeLocalFile(name) {
  removeFromRegistry(name);
  await idbDel(IDB_LOCAL, name);
  renderContourLayer();
}

// ── Render ────────────────────────────────────────────────────────────────────

export function renderContourLayer() {
  if (!state.MAP_OK) return;
  ensureParentLayer();

  // Remove all children from parent, re-add visible ones
  // (simpler than tracking diffs, fast enough for this data size)
  state.CONTOUR_LAYER.clearLayers();
  for (const entry of Object.values(CONTOUR_REGISTRY)) {
    if (entry.visible && entry.layer) {
      entry.layer.addTo(state.CONTOUR_LAYER);
    }
  }
}

// ── Panel UI ──────────────────────────────────────────────────────────────────

let _panelContainer = null;

export function buildContourDataPanel(container) {
  _panelContainer = container;
  container.innerHTML = `
    <div style="margin-bottom:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Loaded Lakes</div>
      <div id="cdActiveInfo" style="font-size:11px;color:var(--muted);background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:8px">Loading...</div>
      <button id="cdReloadAll" style="margin-top:6px;width:100%;height:28px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;cursor:pointer">↻ Reload all lakes</button>
    </div>

    <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Individual Lakes</div>
      <div id="cdDatasetList" style="font-size:11px;color:var(--muted)">Loading...</div>
    </div>

    <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
      <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text)">
        <input type="checkbox" id="cdShowContourLayer" checked> Show contours on map
      </label>
    </div>

    <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Load Local File</div>
      <label style="display:block;width:100%;cursor:pointer">
        <div style="width:100%;height:28px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;display:flex;align-items:center;justify-content:center;cursor:pointer;box-sizing:border-box">
          📂 Load local contours.geojson
        </div>
        <input type="file" id="cdLocalFile" accept=".geojson,.json" multiple style="display:none">
      </label>
    </div>
  `;

  document.getElementById('cdReloadAll')?.addEventListener('click', async () => {
    const btn = document.getElementById('cdReloadAll');
    btn.textContent = 'Reloading...';
    btn.disabled = true;
    // Clear R2 cache and re-fetch
    const db = await idbOpen();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).clear();
    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
    // Remove R2 layers from registry
    for (const [name, entry] of Object.entries(CONTOUR_REGISTRY)) {
      if (entry.source === 'r2') removeFromRegistry(name);
    }
    await loadAllContoursOnStartup();
    btn.textContent = '↻ Reload all lakes';
    btn.disabled = false;
  });

  document.getElementById('cdLocalFile')?.addEventListener('change', async (e) => {
    for (const file of e.target.files) {
      await importLocalContourFile(file);
    }
    e.target.value = '';
  });

  document.getElementById('cdShowContourLayer')?.addEventListener('change', (e) => {
    if (e.target.checked) {
      renderContourLayer();
    } else if (state.CONTOUR_LAYER) {
      state.MAP?.removeLayer(state.CONTOUR_LAYER);
    }
  });

  updateActiveInfo();
  refreshDatasetList();
}

function updateActiveInfo() {
  const el = document.getElementById('cdActiveInfo');
  if (!el) return;

  const entries   = Object.entries(CONTOUR_REGISTRY);
  const visible   = entries.filter(([, e]) => e.visible);
  const totalFeat = visible.reduce((n, [, e]) => n + (e.geo?.features?.length || 0), 0);

  if (!entries.length) {
    el.innerHTML = '<div style="color:var(--muted)">No contour data loaded</div>';
    return;
  }

  const lakeNames = visible
    .map(([name]) => name.replace(/^lake_/, '').replace(/_/g, ' ').replace(/^📂 /, ''))
    .join(', ');

  el.innerHTML = `
    <div style="color:var(--accent);font-weight:600;margin-bottom:3px">${visible.length} layer${visible.length !== 1 ? 's' : ''} visible</div>
    ${lakeNames ? `<div style="font-size:10px">${lakeNames}</div>` : ''}
    <div style="color:var(--muted);margin-top:3px">${totalFeat.toLocaleString()} total features</div>
  `;
}

async function refreshDatasetList() {
  const listEl = document.getElementById('cdDatasetList');
  if (!listEl) return;

  // R2 datasets from server
  const datasets = await fetchDatasetList();
  const r2Keys   = new Set(datasets.map(d => d.name));

  // Build rows for all registry entries + unloaded R2 datasets
  const allKeys = new Set([...Object.keys(CONTOUR_REGISTRY), ...r2Keys]);

  if (!allKeys.size) {
    listEl.textContent = 'No datasets found.';
    return;
  }

  const rows = [...allKeys].sort().map(name => {
    const entry    = CONTOUR_REGISTRY[name];
    const isLocal  = entry?.source === 'local';
    const isLoaded = !!entry;
    const isVisible = entry?.visible ?? false;
    const featCount = entry?.geo?.features?.length || 0;
    const icon     = isLocal ? '📂' : '🗂';
    const label    = name.replace(/^lake_/, '').replace(/_/g, ' ').replace(/^📂 /, '');

    const btnLabel = !isLoaded ? 'Load' : (isVisible ? 'Hide' : 'Show');
    const btnBg    = !isLoaded ? 'var(--accent2)' : (isVisible ? 'var(--accent)' : 'var(--panel2)');
    const btnColor = isVisible || !isLoaded ? '#000' : 'var(--text)';
    const rowBorder = isVisible ? 'var(--accent)' : 'var(--line)';
    const rowBg    = isVisible ? 'rgba(0,229,255,.08)' : 'var(--panel2)';

    return `
      <div style="display:flex;align-items:center;gap:6px;padding:6px 8px;margin-bottom:4px;border:1px solid ${rowBorder};border-radius:6px;background:${rowBg}">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${isVisible ? 'var(--accent)' : 'var(--text)'}">
          ${icon} ${label}${featCount ? ` <span style="color:var(--muted);font-size:9px">(${featCount.toLocaleString()})</span>` : ''}
        </span>
        <button data-key="${name}" class="cd-toggle-btn" style="height:24px;padding:0 8px;font-size:10px;font-weight:700;border:none;border-radius:4px;background:${btnBg};color:${btnColor};cursor:pointer;flex-shrink:0">
          ${btnLabel}
        </button>
        ${isLocal ? `<button data-del="${name}" class="cd-del-btn" style="height:24px;padding:0 6px;font-size:10px;border:none;border-radius:4px;background:transparent;color:var(--bad);cursor:pointer;flex-shrink:0" title="Remove">✕</button>` : ''}
      </div>`;
  }).join('');

  listEl.innerHTML = rows;

  listEl.querySelectorAll('.cd-toggle-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.key;
      btn.textContent = '...';
      btn.disabled = true;
      await loadContourDataset(key);
      renderContourLayer();
      // notifyChange already called inside loadContourDataset
    });
  });

  listEl.querySelectorAll('.cd-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.del;
      if (!confirm(`Remove "${name.replace(/^📂 /, '')}" from contour layers?`)) return;
      await removeLocalFile(name);
    });
  });
}

// ── Backward-compat exports ───────────────────────────────────────────────────
// route-builder.js reads state.ACTIVE_CONTOUR_LAKES and state.ACTIVE_CONTOUR_KEY
// directly — those are kept in sync by syncStateContour() above.
// pinch-point-finder.js reads window._smartRouteGeoJSON — also kept in sync.

// Subscribe to keep UI in sync
onContourChange(() => {
  updateActiveInfo();
  refreshDatasetList();
});

console.log('[contour-data] module ready (multi-layer registry)');
