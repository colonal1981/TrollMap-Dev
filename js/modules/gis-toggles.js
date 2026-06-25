import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { setBanner } from '../core/map-init.js';

let BANK_LAYER = null;
let BANK_VISIBLE = false;

let PADDLE_LAYER = null;
let PADDLE_VISIBLE = false;

let ATTRACTOR_LAYER = null;
let ATTRACTOR_VISIBLE = false;

let TRISTATE_MASTER_BANK_PIER = null;
let TRISTATE_MASTER_PADDLE = null;
let TRISTATE_MASTER_HOTSPOTS = null;

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

function buildPopup(name, type, lat, lon, icon, color) {
  const safeName = esc(name || 'Unnamed').replace(/'/g, "\\'");
  const repositionBtn = window.enableSpotRepositioning
    ? `<button onclick="window.enableSpotRepositioning(this, '${safeName}')" class="small warn" style="margin-top:8px">✥ Re-Position This Spot</button>`
    : '';

  return `
    <div style="font-family:system-ui,sans-serif;font-size:13px;color:#111;min-width:210px">
      <b>${icon} ${esc(name || 'Unnamed')}</b><br>
      <span style="font-family:monospace;font-size:11px">${lat.toFixed(5)}, ${lon.toFixed(5)}</span>
      <div style="color:${color};font-size:12px;margin-top:4px">${esc(type || '')}</div>
      ${repositionBtn}
    </div>
  `;
}

// ── 1. Bank / Pier ────────────────────────────────────────────────────────
async function buildBankLayer() {
  if (BANK_LAYER) return BANK_LAYER;

  TRISTATE_MASTER_BANK_PIER = window.TrollMapData
    ? await window.TrollMapData.loadBankPier()
    : (TRISTATE_MASTER_BANK_PIER || []);

  BANK_LAYER = L.layerGroup();

  (TRISTATE_MASTER_BANK_PIER || []).forEach((b) => {
    const ll = getLatLng(b);
    if (!ll) return;

    const [lat, lon] = ll;
    const isPier = String(b.type || '').toUpperCase().includes('PIER');
    const ico = isPier ? '🎣' : '🌲';
    const bgCol = isPier ? '#0e7c7b' : '#2e7d32';

    const marker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: 'custom-gis-marker',
        html: `<div style="background:${bgCol};color:#fff;font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;border:1px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);white-space:nowrap;display:inline-block;cursor:pointer">${ico} ${esc(b.name || 'Bank/Pier').split(' (')[0]}</div>`,
        iconAnchor: [0, 8],
      }),
    });

    marker.bindPopup(
      buildPopup(b.name || 'Bank/Pier', b.type || '', lat, lon, ico, '#aed581')
    );

    BANK_LAYER.addLayer(marker);
  });

  setBanner(`Loaded ${(TRISTATE_MASTER_BANK_PIER || []).length} bank/pier spots`);
  setTimeout(() => setBanner(''), 1800);

  return BANK_LAYER;
}

// ── 2. Kayak / Paddle ─────────────────────────────────────────────────────
async function buildPaddleLayer() {
  if (PADDLE_LAYER) return PADDLE_LAYER;

  TRISTATE_MASTER_PADDLE = window.TrollMapData
    ? await window.TrollMapData.loadPaddle()
    : (TRISTATE_MASTER_PADDLE || []);

  PADDLE_LAYER = L.layerGroup();

  (TRISTATE_MASTER_PADDLE || []).forEach((p) => {
    const ll = getLatLng(p);
    if (!ll) return;

    const [lat, lon] = ll;

    const marker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: 'custom-gis-marker',
        html: `<div style="background:#ffb703;color:#000;font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;border:1px solid #b06a00;box-shadow:0 1px 4px rgba(0,0,0,.5);white-space:nowrap;display:inline-block;cursor:pointer">🛶 ${esc(p.name || 'Paddle Launch').split(' (')[0]}</div>`,
        iconAnchor: [0, 8],
      }),
    });

    marker.bindPopup(
      buildPopup(p.name || 'Paddle Launch', p.type || '', lat, lon, '🛶', '#ffb703')
    );

    PADDLE_LAYER.addLayer(marker);
  });

  setBanner(`Loaded ${(TRISTATE_MASTER_PADDLE || []).length} kayak/paddle spots`);
  setTimeout(() => setBanner(''), 1800);

  return PADDLE_LAYER;
}

// ── 3. Submerged Attractors ───────────────────────────────────────────────
async function buildAttractorLayer() {
  if (ATTRACTOR_LAYER) return ATTRACTOR_LAYER;

  TRISTATE_MASTER_HOTSPOTS = window.TrollMapData
    ? await window.TrollMapData.loadHotspots()
    : (TRISTATE_MASTER_HOTSPOTS || []);

  ATTRACTOR_LAYER = L.layerGroup();

  (TRISTATE_MASTER_HOTSPOTS || []).forEach((h) => {
    const ll = getLatLng(h);
    if (!ll) return;

    const [lat, lon] = ll;
    const isTree =
      String(h.type || '').toUpperCase().includes('PVC') ||
      String(h.type || '').toUpperCase().includes('TREE');

    const ico = isTree ? '🎯' : '📍';
    const bgCol = isTree ? '#00e5ff' : '#ef5350';
    const fgCol = isTree ? '#000' : '#fff';
    const notesStr = h.type || 'Hardwood Brush Pile / Sunk PVC Tree Habitat';

    const marker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: 'custom-gis-marker',
        html: `<div style="background:${bgCol};color:${fgCol};font-size:11px;font-weight:800;padding:2px 6px;border-radius:4px;border:1px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.6);white-space:nowrap;display:inline-block;cursor:pointer">${ico} ${esc(h.name || 'Attractor').split(' (')[0]}</div>`,
        iconAnchor: [0, 8],
      }),
    });

    marker.bindPopup(
      buildPopup(h.name || 'Attractor', notesStr, lat, lon, ico, 'var(--accent2)')
    );

    ATTRACTOR_LAYER.addLayer(marker);
  });

  setBanner(`Loaded ${(TRISTATE_MASTER_HOTSPOTS || []).length} attractors`);
  setTimeout(() => setBanner(''), 1800);

  return ATTRACTOR_LAYER;
}

// ── Toggle wiring ─────────────────────────────────────────────────────────
function wireToggleButton(btn, getLayer, getVisible, setVisible, buildFn) {
  btn?.addEventListener('click', async () => {
    if (!mapReady()) return;

    const map = getMap();
    const layer = await buildFn();
    if (!layer) return;

    if (getVisible()) {
      if (map.hasLayer(layer)) map.removeLayer(layer);
      setVisible(false);
      btn.style.background = '';
      btn.style.color = '';
    } else {
      layer.addTo(map);
      setVisible(true);
      btn.style.background = 'var(--accent)';
      btn.style.color = '#000';
    }
  });
}

function init() {
  const btnBank = document.getElementById('btnBankPier');
  const btnPad = document.getElementById('btnPaddle');
  const btnAttr = document.getElementById('btnAttractors');

  if (!btnBank || !btnPad || !btnAttr) {
    setTimeout(init, 250);
    return;
  }

  wireToggleButton(
    btnBank,
    () => BANK_LAYER,
    () => BANK_VISIBLE,
    (v) => { BANK_VISIBLE = v; },
    buildBankLayer
  );

  wireToggleButton(
    btnPad,
    () => PADDLE_LAYER,
    () => PADDLE_VISIBLE,
    (v) => { PADDLE_VISIBLE = v; },
    buildPaddleLayer
  );

  wireToggleButton(
    btnAttr,
    () => ATTRACTOR_LAYER,
    () => ATTRACTOR_VISIBLE,
    (v) => { ATTRACTOR_VISIBLE = v; },
    buildAttractorLayer
  );

  console.log('✓ GIS toggles module armed');
}

init();