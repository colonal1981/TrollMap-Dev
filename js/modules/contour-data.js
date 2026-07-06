/**
 * contour-data.js — Contour dataset lazy loader + lake selector integration.
 *
 * Behavior:
 *   - On startup: nothing loaded, no network calls
 *   - When lake selected in Plan tab: auto-load that lake's contours from R2
 *   - Chain lakes: selecting either member loads the combined chain file
 *   - IndexedDB cache: 24hr TTL, avoids re-fetching large files on repeat visits
 *   - Panel: status display + local file loader (for QDC files / pipeline testing)
 *
 * R2 key format: {lake_key}/contours.geojson
 * Fetched via: GET /chartpacks/{lake_key}/contours.geojson
 */

import { state, CF_WORKER_URL } from '../core/state.js';

// ── Display name → R2 key mapping ────────────────────────────────────────────
// Maps LAKE_DB display names to the R2 key (split_output2 filename stem).
// Chain entries map both member lakes to the same combined file.

const LAKE_NAME_TO_R2_KEY = {
  // SC Lakes
  'Lake Marion, SC':               'lake_marion',
  'Lake Moultrie, SC':             'lake_moultrie',
  'Lake Murray, SC':               'lake_murray',
  'Lake Wateree, SC':              'lake_wateree_fishing_creek',
  'Fishing Creek Reservoir, SC':   'lake_wateree_fishing_creek',
  'Lake Wylie, SC/NC':             'lake_wylie',
  'Lake Hartwell, SC/GA':          'lake_hartwell',
  'Lake Greenwood, SC':            'lake_greenwood_secession',
  'Lake Secession, SC':            'lake_greenwood_secession',
  'Lake Keowee, SC':               'lake_keowee',
  'Lake Jocassee, SC/NC':          'lake_jocassee',
  'Lake Russell, SC/GA':           'lake_thurmond_russell',
  'Clarks Hill / Thurmond, SC/GA': 'lake_thurmond_russell',
  'Lake Monticello, SC':           'lake_monticello_parr',
  'Parr Reservoir, SC':            'lake_monticello_parr',
  'Lake Robinson, SC':             'north_saluda_reservoir',
  'Lake Bowen, SC':                'lake_bowen',
  'Lake Blalock, SC':              'lake_blalock',

  // NC Lakes
  'Lake Norman, NC':               'lake_norman_mountain_island',
  'Mountain Island Lake, NC':      'lake_norman_mountain_island',
  'Lake Hickory, NC':              'lake_hickory_rhodhiss',
  'Lake Rhodhiss, NC':             'lake_hickory_rhodhiss',
  'Lake James, NC':                'lake_james',
  'Lake Lure, NC':                 'lake_lure',
  'High Rock Lake, NC':            'yadkin_river_chain',
  'Badin Lake, NC':                'yadkin_river_chain',
  'Lake Tillery, NC':              'yadkin_river_chain',
  'Blewett Falls Lake, NC':        'yadkin_river_chain',
  'Jordan Lake, NC':               'jordan_lake',
  'Falls Lake, NC':                'falls_lake',
  'Kerr Lake / Buggs Island, NC/VA': 'kerr_lake',
  'Lake Gaston, NC/VA':            'lake_gaston',
  'W. Kerr Scott Reservoir, NC':   'w_kerr_scott_reservoir',

  // GA Lakes
  'Lake Oconee, GA':               'lake_oconee',
  'Lake Sinclair, GA':             'lake_sinclair',
  'Lake Lanier, GA':               'lake_lanier',
  'Lake Jackson, GA':              'lake_juliette_high_falls',
  'Lake Blackshear, GA':           'lake_blackshear',
  'West Point Lake, GA/AL':        'west_point_lake',

  // TN/NC Mountain
  'Fontana Lake, NC':              'fontana_lake',
  'Norris Lake, TN':               'norris_lake',
  'Douglas Lake, TN':              'douglas_lake',
  'Cherokee Lake, TN':             'cherokee_lake',
  'Fort Loudoun Lake, TN':         'fort_loudoun_lake',
  'Tellico Lake, TN':              'tellico_lake',
  'Watts Bar Lake, TN':            'watts_bar_lake',
  'Chickamauga Lake, TN':          'chickamauga_lake',
  'Melton Hill Lake, TN':          'melton_hill_lake',
  'Boone Lake, TN':                'boone_lake',
  'South Holston Lake, TN':        'south_holston_lake',
  'Watauga Lake, TN':              'watauga_lake',
  'Hiwassee Lake, NC':             'hiwassee_lake',
  'Nantahala Lake, NC':            'nantahala_lake',
  'Lake Santeetlah, NC':           'lake_santeetlah',
  'Lake Glenville, NC':            'lake_glenville',
  'Lake Chatuge, GA/NC':           'lake_chatuge',
  'Lake Blue Ridge, GA':           'lake_blue_ridge',
  'Lake Nottely, GA':              'lake_nottely',
  'Lake Burton, GA':               'lake_burton',
  'Parksville Lake, TN':           'parksville_lake',

  // SC Coastal
  'ACE Basin / Edisto, SC':        'sc_ga_coastal',
  'Charleston Harbor, SC':         'sc_ga_coastal',
  'Winyah Bay / Georgetown, SC':   'sc_ga_coastal',
  'Beaufort / Port Royal Sound, SC': 'sc_ga_coastal',
  'St. Helena Sound, SC':          'sc_ga_coastal',
  'Hilton Head / Calibogue Sound, SC': 'sc_ga_coastal',
  'Santee River Delta / North Inlet, SC': 'sc_ga_coastal',
  'Savannah River / Savannah, GA': 'sc_ga_coastal',
};

// Human-readable chain descriptions shown in status panel
const CHAIN_DESCRIPTIONS = {
  'lake_thurmond_russell':      'Clarks Hill / Thurmond + Russell Chain',
  'lake_greenwood_secession':   'Lake Greenwood + Secession Chain',
  'lake_monticello_parr':       'Lake Monticello + Parr Reservoir',
  'lake_wateree_fishing_creek': 'Lake Wateree + Fishing Creek',
  'lake_hickory_rhodhiss':      'Lake Hickory + Rhodhiss Chain',
  'lake_norman_mountain_island':'Lake Norman + Mountain Island Chain',
  'yadkin_river_chain':         'Yadkin River Chain (High Rock → Blewett Falls)',
};

// ── IndexedDB cache ───────────────────────────────────────────────────────────
const IDB_NAME    = 'trollmap_contours';
const IDB_STORE   = 'geojson';
const CACHE_TTL   = 24 * 60 * 60 * 1000; // 24 hours

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
    const db  = await openDB();
    const tx  = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ key, value, ts: Date.now() });
  } catch (_) {}
}

// ── Internal state ────────────────────────────────────────────────────────────
let changeListeners = [];
let _loadingKey     = null; // debounce concurrent loads

// ── Public API ────────────────────────────────────────────────────────────────
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

// ── Fetch from R2 via worker ──────────────────────────────────────────────────
async function fetchFromR2(r2Key) {
  const url = `${CF_WORKER_URL}/chartpacks/${r2Key}/contours.geojson?v=${Date.now()}`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── Load contours for a given R2 key (with IDB cache) ────────────────────────
export async function loadContourByR2Key(r2Key) {
  if (!r2Key) return;
  if (_loadingKey === r2Key) return; // already in flight
  _loadingKey = r2Key;

  updateStatusPanel('loading', r2Key);

  try {
    // Check IDB cache first
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

    // Fetch from R2
    console.log(`[contour-data] fetching from R2: ${r2Key}`);
    const gj = await fetchFromR2(r2Key);
    if (!gj?.features?.length) throw new Error('empty response');

    // Save to IDB
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

// ── Load contours by lake display name (called from plan-builder on change) ──
export async function loadContourForLake(displayName) {
  if (!displayName || displayName.startsWith('river:')) return;
  const r2Key = LAKE_NAME_TO_R2_KEY[displayName];
  if (!r2Key) {
    console.warn(`[contour-data] no R2 key for lake: "${displayName}"`);
    updateStatusPanel('none', displayName);
    return;
  }
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
        return { color: depthColor(depth), weight: 1.5, opacity: 0.85, dashArray: dashed ? '4,4' : null };
      },
      onEachFeature(feat, layer) {
        const d = feat.properties?.depth_ft;
        if (d != null) layer.bindTooltip(`${d} ft`, { sticky: true });
      },
    }).addTo(state.CONTOUR_LAYER);
  }
}

// ── Status panel helpers ──────────────────────────────────────────────────────
function updateStatusPanel(status, key, count = 0, errMsg = '') {
  const el = document.getElementById('cdActiveInfo');
  if (!el) return;
  const label = CHAIN_DESCRIPTIONS[key] || key?.replace(/_/g, ' ') || key || '—';
  if (status === 'loading') {
    el.innerHTML = `<div style="color:var(--accent)">⏳ Loading ${label}...</div>`;
  } else if (status === 'loaded') {
    el.innerHTML = `
      <div style="color:var(--accent2);font-weight:600;margin-bottom:3px">✅ ${label}</div>
      <div style="color:var(--muted)">${count.toLocaleString()} contour features</div>
    `;
  } else if (status === 'error') {
    el.innerHTML = `
      <div style="color:var(--warn);font-weight:600">❌ Failed to load ${label}</div>
      <div style="color:var(--muted);font-size:10px">${errMsg}</div>
      <div style="color:var(--muted);font-size:10px">Check R2 upload or try local file</div>
    `;
  } else if (status === 'none') {
    el.innerHTML = `<div style="color:var(--muted)">No contour data for ${label}</div>`;
  } else {
    el.innerHTML = `<div style="color:var(--muted)">No contour data loaded</div>`;
  }
}

// ── Panel UI (simplified — status + local file loader only) ──────────────────
export function buildContourDataPanel(container) {
  container.innerHTML = `
    <div style="margin-bottom:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Active contour data</div>
      <div id="cdActiveInfo" style="font-size:11px;color:var(--muted);background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:8px">
        Select a lake in the Plan tab to load contours
      </div>
      <button id="cdClearContours" style="margin-top:6px;width:100%;height:28px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;cursor:pointer">
        ✕ Clear contours
      </button>
    </div>

    <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Show on map</div>
      <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text)">
        <input type="checkbox" id="cdShowContourLayer" checked> Show depth contours
      </label>
    </div>

    <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Load local file</div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:6px">QDC exports, pipeline output, or any contours.geojson</div>
      <label style="display:block;width:100%;cursor:pointer">
        <div style="width:100%;height:28px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;display:flex;align-items:center;justify-content:center;cursor:pointer;box-sizing:border-box">
          📂 Load local .geojson
        </div>
        <input type="file" id="cdLocalFile" accept=".geojson,.json" style="display:none">
      </label>
    </div>

    <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Cache</div>
      <button id="cdClearCache" style="width:100%;height:28px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;cursor:pointer">
        🗑 Clear contour cache (force re-fetch)
      </button>
    </div>
  `;

  document.getElementById('cdClearContours')?.addEventListener('click', () => {
    state.ACTIVE_CONTOUR     = null;
    state.ACTIVE_CONTOUR_KEY = null;
    if (state.CONTOUR_LAYER) state.MAP?.removeLayer(state.CONTOUR_LAYER);
    state.CONTOUR_LAYER = null;
    notifyChange();
    updateStatusPanel('idle');
  });

  document.getElementById('cdShowContourLayer')?.addEventListener('change', e => {
    if (e.target.checked) {
      renderContourLayer(true, false);
    } else if (state.CONTOUR_LAYER) {
      state.MAP?.removeLayer(state.CONTOUR_LAYER);
    }
  });

  document.getElementById('cdLocalFile')?.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const gj = JSON.parse(await file.text());
      if (!gj?.features?.length) throw new Error('no features found');
      state.ACTIVE_CONTOUR     = { smart: gj, raw: null };
      state.ACTIVE_CONTOUR_KEY = file.name;
      notifyChange();
      renderContourLayer(true, false);
      updateStatusPanel('loaded', file.name, gj.features.length);
    } catch (err) {
      alert('Could not parse GeoJSON: ' + err.message);
    }
    e.target.value = '';
  });

  document.getElementById('cdClearCache')?.addEventListener('click', async () => {
    const btn = document.getElementById('cdClearCache');
    btn.textContent = 'Clearing...';
    btn.disabled = true;
    try {
      const db = await openDB();
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).clear();
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
      btn.textContent = '✅ Cache cleared';
      setTimeout(() => {
        btn.textContent = '🗑 Clear contour cache (force re-fetch)';
        btn.disabled = false;
      }, 2000);
    } catch (e) {
      btn.textContent = '❌ Failed';
      btn.disabled = false;
    }
  });

  // Reflect current state on open
  const c = state.ACTIVE_CONTOUR;
  const count = c?.smart?.features?.length || c?.raw?.features?.length || 0;
  if (count && state.ACTIVE_CONTOUR_KEY) {
    updateStatusPanel('loaded', state.ACTIVE_CONTOUR_KEY, count);
  }
}

// Subscribe to keep panel in sync
onContourChange(() => {
  const c     = state.ACTIVE_CONTOUR;
  const count = c?.smart?.features?.length || c?.raw?.features?.length || 0;
  if (count && state.ACTIVE_CONTOUR_KEY) {
    updateStatusPanel('loaded', state.ACTIVE_CONTOUR_KEY, count);
  }
  const showLayer = document.getElementById('cdShowContourLayer')?.checked !== false;
  if (showLayer) renderContourLayer(true, false);
});

// ── Hook into toolbar lake dropdown via lake-ramp-select.js ──────────────────
// loadContourForLake is called from lake-ramp-select.js onLakeChange()
// so no listener needed here — just expose the function on window as backup.
window.loadContourForLake = loadContourForLake;

// ── Backward-compat alias for capture-panel.js ───────────────────────────────
export async function loadContourDataset(key) {
  return loadContourByR2Key(key);
}

console.log('[contour-data] module ready — lazy lake-triggered loading active');
