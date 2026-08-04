import { state, CF_WORKER_URL } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { setBanner } from '../core/map-init.js';
import { registerLayer, isVisible, wireAll } from '../core/layer-registry.js';

// This file used to carry THREE verbatim copies of the same state machine -- BANK_LAYER /
// BANK_VISIBLE / BANK_DATA, then PADDLE_*, then ATTRACTOR_* -- plus three near-identical
// build functions and a seven-argument wireToggleButton() that took getter and setter
// closures because the caller still owned the flag.
//
// The layer handle and the visible flag now live in core/layer-registry.js. What stays here
// is what is actually specific to this module: how to FETCH each dataset and how to DRAW it.
// LAYERS below is the whole difference between the three.
let BANK_DATA = null;
let PADDLE_DATA = null;
let ATTRACTOR_DATA = null;

function getMap() {
  return state?.MAP || window.MAP || null;
}

function mapReady() {
  return !!(state?.MAP_OK && getMap());
}

function getLatLng(rec) {
  const lat = rec?.lat ?? rec?.latitude ?? rec?.LAT ?? rec?.LATITUDE;
  const lon = rec?.lon ?? rec?.lng ?? rec?.longitude ?? rec?.LON ?? rec?.LNG ?? rec?.LONGITUDE;
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
  return [Number(lat), Number(lon)];
}

function buildPopup(name, type, lat, lon, icon, accentColor) {
  const safeName = esc(name || 'Unnamed').replace(/'/g, "\\'");
  const repositionBtn = window.enableSpotRepositioning
    ? `<button onclick="window.enableSpotRepositioning(this, '${safeName}')" class="small warn" style="margin-top:8px">✥ Re-Position This Spot</button>`
    : '';

  return `
    <div style="font-family:system-ui,sans-serif;font-size:13px;color:#111;min-width:220px">
      <b>${icon} ${esc(name || 'Unnamed')}</b><br>
      <span style="font-family:monospace;font-size:11px">${lat.toFixed(5)}, ${lon.toFixed(5)}</span>
      <div style="color:${accentColor};font-size:12px;margin-top:4px">${esc(type || '')}</div>
      ${repositionBtn}
    </div>
  `;
}

function normalizeRows(value) {
  return Array.isArray(value) ? value : [];
}

function getWorkerBase() {
  return String(window.TROLLMAP_WORKER_URL || window.TROLLMAP_WORKER_BASE || window.WORKER_URL || window.API_BASE || CF_WORKER_URL || 'https://trollmap-worker.colonal1981.workers.dev').replace(/\/$/, '');
}

// GIS toggles historically use preloaded static tri-state arrays. Those arrays
// do not include TN, so append the live TWRA worker feed before a layer is
// built. The worker response is grouped by waterbody; flatten it into the
// shape this renderer already consumes.
async function loadTnWorkerRows(path, type) {
  const res = await fetch(`${getWorkerBase()}${path}?state=TN`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path}?state=TN returned HTTP ${res.status}`);
  const payload = await res.json();
  const rows = [];
  for (const [waterbody, items] of Object.entries(payload?.waterbodies || {})) {
    for (const item of normalizeRows(items)) {
      const lat = Number(item.lat);
      const lon = Number(item.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      rows.push({
        ...item,
        lat,
        lon,
        name: item.name || `${waterbody} ${type}`,
        type: item.type || type,
        waterbody,
        state: 'TN',
        source: 'TWRA'
      });
    }
  }
  return rows;
}

function appendUniqueRows(base, additions) {
  const out = [...normalizeRows(base)];
  const seen = new Set(out.map(row => `${Number(row.lat).toFixed(5)},${Number(row.lon).toFixed(5)}|${String(row.name || '').toLowerCase()}`));
  for (const row of normalizeRows(additions)) {
    const key = `${Number(row.lat).toFixed(5)},${Number(row.lon).toFixed(5)}|${String(row.name || '').toLowerCase()}`;
    if (!seen.has(key)) { seen.add(key); out.push(row); }
  }
  return out;
}

async function loadLayerRows(existingLoader, staticRows, workerPath, type) {
  const base = existingLoader ? normalizeRows(await existingLoader()) : normalizeRows(staticRows);
  try {
    const tnRows = await loadTnWorkerRows(workerPath, type);
    console.log(`[gis-toggles] Added ${tnRows.length} live TWRA ${type} records.`);
    return appendUniqueRows(base, tnRows);
  } catch (err) {
    // Preserve existing SC/NC/GA functionality if a worker deployment is
    // temporarily unavailable; TN will become available as soon as it is up.
    console.warn(`[gis-toggles] TN ${type} feed unavailable:`, err.message);
    return base;
  }
}

async function loadBankPier() {
  if (BANK_DATA) return BANK_DATA;
  BANK_DATA = await loadLayerRows(window.TrollMapData?.loadBankPier, window.TRISTATE_MASTER_BANK_PIER, '/bank-pier', 'Bank / pier access');
  return BANK_DATA;
}

async function loadPaddle() {
  if (PADDLE_DATA) return PADDLE_DATA;
  PADDLE_DATA = await loadLayerRows(window.TrollMapData?.loadPaddle, window.TRISTATE_MASTER_PADDLE, '/paddle', 'Paddle launch');
  return PADDLE_DATA;
}

async function loadHotspots() {
  if (ATTRACTOR_DATA) return ATTRACTOR_DATA;
  ATTRACTOR_DATA = await loadLayerRows(window.TrollMapData?.loadHotspots, window.TRISTATE_MASTER_HOTSPOTS, '/attractors', 'Fish attractor');
  return ATTRACTOR_DATA;
}

// ── drawing ────────────────────────────────────────────────────────────────────────
//
// Each layer differs in exactly two ways: where its rows come from, and what marker one row
// becomes. Everything else -- the visibility guard, clearLayers, the padded-bounds filter,
// the moveend redraw -- was pasted three times. It is written once here.

const LAYERS = [
  {
    id: 'bankPier', button: 'btnBankPier',
    load: loadBankPier, rows: () => BANK_DATA,
    marker: (b, lat, lon) => {
      const type = b.type || '';
      const isPier = String(type).toUpperCase().includes('PIER');
      const ico = isPier ? '\u{1F3A3}' : '\u{1F332}';
      const bgCol = isPier ? '#0e7c7b' : '#2e7d32';
      const m = L.marker([lat, lon], {
        icon: L.divIcon({
          className: 'custom-gis-marker',
          html: `<div style="background:${bgCol};color:#fff;font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;border:1px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);white-space:nowrap;display:inline-block;cursor:pointer">${ico} ${esc(b.name || 'Bank/Pier').split(' (')[0]}</div>`,
          iconAnchor: [0, 8],
        }),
      });
      m.bindPopup(buildPopup(b.name || 'Bank/Pier', type, lat, lon, ico, '#aed581'));
      return m;
    },
  },
  {
    id: 'paddle', button: 'btnPaddle',
    load: loadPaddle, rows: () => PADDLE_DATA,
    marker: (p, lat, lon) => {
      const type = p.type || '';
      const m = L.marker([lat, lon], {
        icon: L.divIcon({
          className: 'custom-gis-marker',
          html: `<div style="background:#ffb703;color:#000;font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;border:1px solid #b06a00;box-shadow:0 1px 4px rgba(0,0,0,.5);white-space:nowrap;display:inline-block;cursor:pointer">\u{1F6F6} ${esc(p.name || 'Paddle Launch').split(' (')[0]}</div>`,
          iconAnchor: [0, 8],
        }),
      });
      m.bindPopup(buildPopup(p.name || 'Paddle Launch', type, lat, lon, '\u{1F6F6}', '#ffb703'));
      return m;
    },
  },
  {
    id: 'attractors', button: 'btnAttractors',
    load: loadHotspots, rows: () => ATTRACTOR_DATA,
    marker: (h, lat, lon) => {
      const type = h.type || 'Hardwood Brush Pile / Sunk PVC Tree Habitat';
      const isTree = /PVC|TREE/i.test(String(type));
      const ico = isTree ? '\u{1F3AF}' : '\u{1F4CD}';
      const color = isTree ? '#00e5ff' : '#ef5350';
      const m = L.circleMarker([lat, lon], {
        radius: isTree ? 6 : 5, color: '#ffffff', weight: 1.5,
        fillColor: color, fillOpacity: 0.95,
      });
      m.bindTooltip(`${ico} ${esc(h.name || 'Attractor')}`, { sticky: true, direction: 'top', opacity: 0.95 });
      m.bindPopup(buildPopup(h.name || 'Attractor', type, lat, lon, ico, color));
      return m;
    },
  },
];

/** Redraw one layer's markers for the current viewport. */
function redraw(spec, group) {
  if (!mapReady() || !group || !isVisible(spec.id)) return;
  const rows = spec.rows();
  if (!rows) return;
  group.clearLayers();
  const bounds = getMap().getBounds().pad(0.5);
  rows.forEach((row) => {
    const ll = getLatLng(row);
    if (!ll || !bounds.contains(ll)) return;
    group.addLayer(spec.marker(row, ll[0], ll[1]));
  });
}

function init() {
  for (const spec of LAYERS) {
    registerLayer({
      id: spec.id,
      button: spec.button,
      enabled: mapReady,
      build: async () => {
        await spec.load();
        const group = L.layerGroup();
        // Bind moveend ONCE, at build time, exactly as the three build*Layer functions did.
        getMap().on('moveend', () => redraw(spec, group));
        return group;
      },
      // Draw immediately on show; the old code called updateFn() right after addTo.
      onShow: (group) => redraw(spec, group),
    });
  }

  // One retry loop for all three buttons, replacing this file's setTimeout(init, 250).
  wireAll();
  console.log('\u2713 GIS toggles module armed (Bounds-Filtered)');
}

init();
