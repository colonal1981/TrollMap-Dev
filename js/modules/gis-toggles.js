import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';

let BANK_LAYER = null;
let BANK_VISIBLE = false;

let PADDLE_LAYER = null;
let PADDLE_VISIBLE = false;

let ATTRACTOR_LAYER = null;
let ATTRACTOR_VISIBLE = false;

let _bankData = null;
let _paddleData = null;
let _attractorData = null;

function getMap() {
  return state?.MAP || window.MAP || null;
}

function mapReady() {
  return !!(state?.MAP_OK && getMap());
}

function normalizeList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.rows)) return value.rows;
  if (Array.isArray(value?.data)) return value.data;

  if (Array.isArray(value?.features)) {
    return value.features.map((f) => {
      const p = f?.properties || {};
      const coords = f?.geometry?.coordinates || [];
      return {
        ...p,
        latitude:
          p.latitude ?? p.lat ?? p.LATITUDE ?? p.LAT ??
          f?.latitude ?? f?.lat ??
          coords[1],
        longitude:
          p.longitude ?? p.lon ?? p.lng ?? p.LONGITUDE ?? p.LON ?? p.LNG ??
          f?.longitude ?? f?.lon ?? f?.lng ??
          coords[0],
        name: p.name ?? p.Name ?? p.NAME ?? 'Unnamed',
        type: p.type ?? p.Type ?? p.TYPE ?? '',
      };
    });
  }

  return [];
}

function getLatLng(rec) {
  const lat =
    rec?.latitude ?? rec?.lat ?? rec?.Latitude ?? rec?.LATITUDE ?? rec?.LAT ?? rec?.y;
  const lon =
    rec?.longitude ?? rec?.lon ?? rec?.lng ??
    rec?.Longitude ?? rec?.LONGITUDE ?? rec?.LON ?? rec?.LNG ?? rec?.x;

  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
  return [Number(lat), Number(lon)];
}

function buildPopup(name, type, lat, lon, icon, accentColor) {
  const safeName = esc(name || 'Unnamed').replace(/'/g, "\\'");
  const typeHtml = type
    ? `<div style="color:${accentColor};font-size:12px;margin-top:4px">${esc(type)}</div>`
    : '';

  const repositionBtn = window.enableSpotRepositioning
    ? `<button onclick="window.enableSpotRepositioning(this, '${safeName}')" class="small warn" style="margin-top:8px">✥ Re-Position This Spot</button>`
    : '';

  return `
    <div style="font-family:system-ui,sans-serif;font-size:13px;color:#111;min-width:210px">
      <b>${icon} ${esc(name || 'Unnamed')}</b><br>
      <span style="font-family:monospace;font-size:11px">${lat.toFixed(5)}, ${lon.toFixed(5)}</span>
      ${typeHtml}
      ${repositionBtn}
    </div>
  `;
}

async function loadBankPier() {
  if (_bankData) return _bankData;
  if (window.TrollMapData?.loadBankPier) {
    _bankData = normalizeList(await window.TrollMapData.loadBankPier());
  } else {
    _bankData = normalizeList(window.TRISTATE_MASTER_BANK_PIER);
  }
  return _bankData;
}

async function loadPaddle() {
  if (_paddleData) return _paddleData;
  if (window.TrollMapData?.loadPaddle) {
    _paddleData = normalizeList(await window.TrollMapData.loadPaddle());
  } else {
    _paddleData = normalizeList(window.TRISTATE_MASTER_PADDLE);
  }
  return _paddleData;
}

async function loadHotspots() {
  if (_attractorData) return _attractorData;
  if (window.TrollMapData?.loadHotspots) {
    _attractorData = normalizeList(await window.TrollMapData.loadHotspots());
  } else {
    _attractorData = normalizeList(window.TRISTATE_MASTER_HOTSPOTS);
  }
  return _attractorData;
}

// ── Bank / Pier ───────────────────────────────────────────────────────────

async function buildBankLayer() {
  if (BANK_LAYER) return BANK_LAYER;

  BANK_LAYER = L.layerGroup();
  const data = await loadBankPier();

  if (!data.length) {
    alert('Bank/Pier data loaded as 0 records.');
    return BANK_LAYER;
  }

  data.forEach((b) => {
    const ll = getLatLng(b);
    if (!ll) return;

    const [lat, lon] = ll;
    const type = b.type || b.TYPE || '';
    const isPier = String(type).toUpperCase().includes('PIER');
    const icon = isPier ? '🎣' : '🌲';
    const bgCol = isPier ? '#0e7c7b' : '#2e7d32';
    const label = esc(b.name || b.NAME || 'Bank/Pier').split(' (')[0];

    const marker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: 'custom-gis-marker',
        html: `<div style="background:${bgCol};color:#fff;font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;border:1px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);white-space:nowrap;display:inline-block;cursor:pointer">${icon} ${label}</div>`,
        iconAnchor: [0, 8],
      }),
    });

    marker.bindPopup(
      buildPopup(
        b.name || b.NAME || 'Bank/Pier',
        type,
        lat,
        lon,
        icon,
        '#aed581'
      )
    );

    BANK_LAYER.addLayer(marker);
  });

  return BANK_LAYER;
}

// ── Kayak / Paddle ────────────────────────────────────────────────────────

async function buildPaddleLayer() {
  if (PADDLE_LAYER) return PADDLE_LAYER;

  PADDLE_LAYER = L.layerGroup();
  const data = await loadPaddle();

  if (!data.length) {
    alert('Kayak/Paddle data loaded as 0 records.');
    return PADDLE_LAYER;
  }

  data.forEach((p) => {
    const ll = getLatLng(p);
    if (!ll) return;

    const [lat, lon] = ll;
    const type = p.type || p.TYPE || '';
    const label = esc(p.name || p.NAME || 'Paddle Launch').split(' (')[0];

    const marker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: 'custom-gis-marker',
        html: `<div style="background:#ffb703;color:#000;font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;border:1px solid #b06a00;box-shadow:0 1px 4px rgba(0,0,0,.5);white-space:nowrap;display:inline-block;cursor:pointer">🛶 ${label}</div>`,
        iconAnchor: [0, 8],
      }),
    });

    marker.bindPopup(
      buildPopup(
        p.name || p.NAME || 'Paddle Launch',
        type,
        lat,
        lon,
        '🛶',
        '#ffb703'
      )
    );

    PADDLE_LAYER.addLayer(marker);
  });

  return PADDLE_LAYER;
}

// ── Submerged Attractors ──────────────────────────────────────────────────

async function buildAttractorLayer() {
  if (ATTRACTOR_LAYER) return ATTRACTOR_LAYER;

  ATTRACTOR_LAYER = L.layerGroup();
  const data = await loadHotspots();

  if (!data.length) {
    alert('Attractor data loaded as 0 records.');
    return ATTRACTOR_LAYER;
  }

  data.forEach((h) => {
    const ll = getLatLng(h);
    if (!ll) return;

    const [lat, lon] = ll;
    const type = h.type || h.TYPE || 'Hardwood Brush Pile / Sunk PVC Tree Habitat';
    const isTree = /PVC|TREE/i.test(String(type));
    const icon = isTree ? '🎯' : '📍';
    const bgCol = isTree ? '#00e5ff' : '#ef5350';
    const fgCol = isTree ? '#000' : '#fff';
    const label = esc(h.name || h.NAME || 'Attractor').split(' (')[0];

    const marker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: 'custom-gis-marker',
        html: `<div style="background:${bgCol};color:${fgCol};font-size:11px;font-weight:800;padding:2px 6px;border-radius:4px;border:1px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.6);white-space:nowrap;display:inline-block;cursor:pointer">${icon} ${label}</div>`,
        iconAnchor: [0, 8],
      }),
    });

    marker.bindPopup(
      buildPopup(
        h.name || h.NAME || 'Attractor',
        type,
        lat,
        lon,
        icon,
        'var(--accent2)'
      )
    );

    ATTRACTOR_LAYER.addLayer(marker);
  });

  return ATTRACTOR_LAYER;
}

// ── Generic toggle wiring ─────────────────────────────────────────────────

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
  const bankBtn = document.getElementById('btnBankPier');
  const paddleBtn = document.getElementById('btnPaddle');
  const attractorBtn = document.getElementById('btnAttractors');

  if (!bankBtn || !paddleBtn || !attractorBtn) {
    setTimeout(init, 250);
    return;
  }

  wireToggleButton(
    bankBtn,
    () => BANK_VISIBLE,
    (v) => { BANK_VISIBLE = v; },
    buildBankLayer
  );

  wireToggleButton(
    paddleBtn,
    () => PADDLE_VISIBLE,
    (v) => { PADDLE_VISIBLE = v; },
    buildPaddleLayer
  );

  wireToggleButton(
    attractorBtn,
    () => ATTRACTOR_VISIBLE,
    (v) => { ATTRACTOR_VISIBLE = v; },
    buildAttractorLayer
  );

  console.log('✓ GIS toggles module armed');
}

init();