import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { setBanner } from '../core/map-init.js';

let BANK_LAYER = null;
let BANK_VISIBLE = false;

let PADDLE_LAYER = null;
let PADDLE_VISIBLE = false;

let ATTRACTOR_LAYER = null;
let ATTRACTOR_VISIBLE = false;

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

async function loadBankPier() {
  if (BANK_DATA) return BANK_DATA;
  BANK_DATA = window.TrollMapData?.loadBankPier
    ? normalizeRows(await window.TrollMapData.loadBankPier())
    : normalizeRows(window.TRISTATE_MASTER_BANK_PIER);
  console.log('[gis] bank/pier rows:', BANK_DATA.length, BANK_DATA[0]);
  return BANK_DATA;
}

async function loadPaddle() {
  if (PADDLE_DATA) return PADDLE_DATA;
  PADDLE_DATA = window.TrollMapData?.loadPaddle
    ? normalizeRows(await window.TrollMapData.loadPaddle())
    : normalizeRows(window.TRISTATE_MASTER_PADDLE);
  console.log('[gis] paddle rows:', PADDLE_DATA.length, PADDLE_DATA[0]);
  return PADDLE_DATA;
}

async function loadHotspots() {
  if (ATTRACTOR_DATA) return ATTRACTOR_DATA;
  ATTRACTOR_DATA = window.TrollMapData?.loadHotspots
    ? normalizeRows(await window.TrollMapData.loadHotspots())
    : normalizeRows(window.TRISTATE_MASTER_HOTSPOTS);
  console.log('[gis] attractor rows:', ATTRACTOR_DATA.length, ATTRACTOR_DATA[0]);
  return ATTRACTOR_DATA;
}

async function buildBankLayer() {
  if (BANK_LAYER) return BANK_LAYER;

  const data = await loadBankPier();
  BANK_LAYER = L.layerGroup();

  if (!data.length) {
    setBanner('No Bank/Pier records were returned from the data file.');
    setTimeout(() => setBanner(''), 2500);
    return BANK_LAYER;
  }

  data.forEach((b) => {
    const ll = getLatLng(b);
    if (!ll) return;

    const [lat, lon] = ll;
    const type = b.type || '';
    const isPier = String(type).toUpperCase().includes('PIER');
    const ico = isPier ? '🎣' : '🌲';
    const bgCol = isPier ? '#0e7c7b' : '#2e7d32';

    const marker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: 'custom-gis-marker',
        html: `<div style="background:${bgCol};color:#fff;font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;border:1px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);white-space:nowrap;display:inline-block;cursor:pointer">${ico} ${esc(b.name || 'Bank/Pier').split(' (')[0]}</div>`,
        iconAnchor: [0, 8],
      }),
    });

    marker.bindPopup(buildPopup(b.name || 'Bank/Pier', type, lat, lon, ico, '#aed581'));
    BANK_LAYER.addLayer(marker);
  });

  setBanner(`Loaded ${data.length} bank/pier spots`);
  setTimeout(() => setBanner(''), 1800);
  return BANK_LAYER;
}

async function buildPaddleLayer() {
  if (PADDLE_LAYER) return PADDLE_LAYER;

  const data = await loadPaddle();
  PADDLE_LAYER = L.layerGroup();

  if (!data.length) {
    setBanner('No Kayak/Paddle records were returned from the data file.');
    setTimeout(() => setBanner(''), 2500);
    return PADDLE_LAYER;
  }

  data.forEach((p) => {
    const ll = getLatLng(p);
    if (!ll) return;

    const [lat, lon] = ll;
    const type = p.type || '';

    const marker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: 'custom-gis-marker',
        html: `<div style="background:#ffb703;color:#000;font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;border:1px solid #b06a00;box-shadow:0 1px 4px rgba(0,0,0,.5);white-space:nowrap;display:inline-block;cursor:pointer">🛶 ${esc(p.name || 'Paddle Launch').split(' (')[0]}</div>`,
        iconAnchor: [0, 8],
      }),
    });

    marker.bindPopup(buildPopup(p.name || 'Paddle Launch', type, lat, lon, '🛶', '#ffb703'));
    PADDLE_LAYER.addLayer(marker);
  });

  setBanner(`Loaded ${data.length} kayak/paddle spots`);
  setTimeout(() => setBanner(''), 1800);
  return PADDLE_LAYER;
}

async function buildAttractorLayer() {
  if (ATTRACTOR_LAYER) return ATTRACTOR_LAYER;

  const data = await loadHotspots();
  ATTRACTOR_LAYER = L.layerGroup();

  if (!data.length) {
    setBanner('No fish attractor records were returned from the data file.');
    setTimeout(() => setBanner(''), 2500);
    return ATTRACTOR_LAYER;
  }

  data.forEach((h) => {
    const ll = getLatLng(h);
    if (!ll) return;

    const [lat, lon] = ll;
    const type = h.type || 'Hardwood Brush Pile / Sunk PVC Tree Habitat';
    const isTree = /PVC|TREE/i.test(String(type));
    const ico = isTree ? '🎯' : '📍';
    const color = isTree ? '#00e5ff' : '#ef5350';

    const marker = L.circleMarker([lat, lon], {
      radius: isTree ? 6 : 5,
      color: '#ffffff',
      weight: 1.5,
      fillColor: color,
      fillOpacity: 0.95,
    });

    marker.bindTooltip(`${ico} ${esc(h.name || 'Attractor')}`, {
      sticky: true,
      direction: 'top',
      opacity: 0.95,
    });

    marker.bindPopup(buildPopup(h.name || 'Attractor', type, lat, lon, ico, color));
    ATTRACTOR_LAYER.addLayer(marker);
  });

  setBanner(`Loaded ${data.length} fish attractors`);
  setTimeout(() => setBanner(''), 1800);
  return ATTRACTOR_LAYER;
}

function wireToggleButton(btn, getVisible, setVisible, buildFn, activeBg = 'var(--accent)', activeColor = '#000') {
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
      btn.style.background = activeBg;
      btn.style.color = activeColor;
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

  wireToggleButton(btnBank, () => BANK_VISIBLE, (v) => { BANK_VISIBLE = v; }, buildBankLayer);
  wireToggleButton(btnPad, () => PADDLE_VISIBLE, (v) => { PADDLE_VISIBLE = v; }, buildPaddleLayer);
  wireToggleButton(btnAttr, () => ATTRACTOR_VISIBLE, (v) => { ATTRACTOR_VISIBLE = v; }, buildAttractorLayer);

  console.log('✓ GIS toggles module armed');
}

init();
