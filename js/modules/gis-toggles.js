/**
 * GIS Asset Layers — toggles for SCDNR/NC/GA bank-fishing spots,
 * kayak launches, and submerged fish attractors (brush piles,
 * PVC trees, etc.).
 *
 * Data is lazy-loaded from data/tristate-*.json via window.TrollMapData
 * (see js/lazy-data.js in the original setup). Falls back gracefully
 * if not available.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';

let BANK_LAYER = null, BANK_VISIBLE = false;
let PADDLE_LAYER = null, PADDLE_VISIBLE = false;
let ATTRACTOR_LAYER = null, ATTRACTOR_VISIBLE = false;

let _bankData = null, _paddleData = null, _attractorData = null;

async function loadBankPier() {
  if (_bankData) return _bankData;
  if (window.TrollMapData?.loadBankPier) {
    _bankData = await window.TrollMapData.loadBankPier();
  } else {
    _bankData = window.TRISTATE_MASTER_BANK_PIER || [];
  }
  return _bankData;
}

async function loadPaddle() {
  if (_paddleData) return _paddleData;
  if (window.TrollMapData?.loadPaddle) {
    _paddleData = await window.TrollMapData.loadPaddle();
  } else {
    _paddleData = window.TRISTATE_MASTER_PADDLE || [];
  }
  return _paddleData;
}

async function loadHotspots() {
  if (_attractorData) return _attractorData;
  if (window.TrollMapData?.loadHotspots) {
    _attractorData = await window.TrollMapData.loadHotspots();
  } else {
    _attractorData = window.TRISTATE_MASTER_HOTSPOTS || [];
  }
  return _attractorData;
}

// ── Bank / Pier ───────────────────────────────────────────────────────────

async function buildBankLayer() {
  if (BANK_LAYER) return;
  BANK_LAYER = L.layerGroup();
  const data = await loadBankPier();
  data.forEach((b) => {
    const isPier = (b.type || '').toUpperCase().includes('PIER');
    const ico = isPier ? '🎣' : '🌲';
    const bgCol = isPier ? '#0e7c7b' : '#2e7d32';
    const marker = L.marker([b.lat, b.lon], {
      icon: L.divIcon({
        className: 'custom-gis-marker',
        html: `<div style="background:${bgCol};color:#fff;font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;border:1px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);white-space:nowrap;display:inline-block;cursor:pointer">${ico} ${esc(b.name).split(' (')[0]}</div>`,
        iconAnchor: [0, 8],
      }),
    });
    marker.bindPopup(`<b>${ico} ${esc(b.name)}</b><br><span style="font-family:monospace;font-size:11px">${b.lat.toFixed(5)}, ${b.lon.toFixed(5)}</span><br><span style="color:#aed581;font-size:12px">${b.type}</span><br><button onclick="window.enableSpotRepositioning(this, '${esc(b.name).replace(/'/g, "\\'")}')" class="small warn" style="margin-top:8px">✥ Re-Position This Spot</button>`);
    BANK_LAYER.addLayer(marker);
  });
}

// ── Kayak / Paddle ────────────────────────────────────────────────────────

async function buildPaddleLayer() {
  if (PADDLE_LAYER) return;
  PADDLE_LAYER = L.layerGroup();
  const data = await loadPaddle();
  data.forEach((p) => {
    const marker = L.marker([p.lat, p.lon], {
      icon: L.divIcon({
        className: 'custom-gis-marker',
        html: `<div style="background:#ffb703;color:#000;font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;border:1px solid #b06a00;box-shadow:0 1px 4px rgba(0,0,0,.5);white-space:nowrap;display:inline-block;cursor:pointer">🛶 ${esc(p.name).split(' (')[0]}</div>`,
        iconAnchor: [0, 8],
      }),
    });
    marker.bindPopup(`<b>🛶 ${esc(p.name)}</b><br><span style="font-family:monospace;font-size:11px">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</span><br><span style="color:#ffb703;font-size:12px">${p.type}</span><br><button onclick="window.enableSpotRepositioning(this, '${esc(p.name).replace(/'/g, "\\'")}')" class="small warn" style="margin-top:8px">✥ Re-Position This Spot</button>`);
    PADDLE_LAYER.addLayer(marker);
  });
}

// ── Submerged Attractors (PVC trees, brush piles) ────────────────────────

async function buildAttractorLayer() {
  if (ATTRACTOR_LAYER) return;
  ATTRACTOR_LAYER = L.layerGroup();
  const data = await loadHotspots();
  data.forEach((h) => {
    const isTree = (h.type || '').toUpperCase().includes('PVC') || (h.type || '').toUpperCase().includes('TREE');
    const ico = isTree ? '🎯' : '📍';
    const bgCol = isTree ? '#00e5ff' : '#ef5350';
    const fgCol = isTree ? '#000' : '#fff';
    const marker = L.marker([h.lat, h.lon], {
      icon: L.divIcon({
        className: 'custom-gis-marker',
        html: `<div style="background:${bgCol};color:${fgCol};font-size:11px;font-weight:800;padding:2px 6px;border-radius:4px;border:1px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.6);white-space:nowrap;display:inline-block;cursor:pointer">${ico} ${esc(h.name).split(' (')[0]}</div>`,
        iconAnchor: [0, 8],
      }),
    });
    const notesStr = h.type || 'Hardwood Brush Pile / Sunk PVC Tree Habitat';
    marker.bindPopup(`<b>${ico} ${esc(h.name)}</b><br><span style="color:var(--accent2);font-size:12px;font-weight:700">${notesStr}</span><br><span style="font-family:monospace;font-size:11px;color:var(--muted)">${h.lat.toFixed(5)}, ${h.lon.toFixed(5)}</span><br><button onclick="window.enableSpotRepositioning(this, '${esc(h.name).replace(/'/g, "\\'")}')" class="small warn" style="margin-top:8px">✥ Re-Position This Spot</button>`);
    ATTRACTOR_LAYER.addLayer(marker);
  });
}

// ── Wire buttons ──────────────────────────────────────────────────────────

function wireButton(btn, layer, getVisible, setVisible, buildFn) {
  btn?.addEventListener('click', async () => {
    if (!state.MAP_OK) return;
    await buildFn();
    if (getVisible()) {
      state.MAP.removeLayer(layer);
      setVisible(false);
      btn.style.background = '';
      btn.style.color = '';
    } else {
      layer.addTo(state.MAP);
      setVisible(true);
      btn.style.background = 'var(--accent)';
      btn.style.color = '#000';
    }
  });
}

setTimeout(() => {
  wireButton(document.getElementById('btnBankPier'), BANK_LAYER, () => BANK_VISIBLE, (v) => { BANK_VISIBLE = v; }, buildBankLayer);
  wireButton(document.getElementById('btnPaddle'), PADDLE_LAYER, () => PADDLE_VISIBLE, (v) => { PADDLE_VISIBLE = v; }, buildPaddleLayer);
  wireButton(document.getElementById('btnAttractors'), ATTRACTOR_LAYER, () => ATTRACTOR_VISIBLE, (v) => { ATTRACTOR_VISIBLE = v; }, buildAttractorLayer);
}, 1000);
