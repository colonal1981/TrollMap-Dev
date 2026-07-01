/**
 * Boat-ramp layer (1,288+ concrete ramps across SC/NC/GA).
 * Uses bounds-based filtering to only render ramps visible on screen.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { LAKE_DB } from '../data/lakes.js';
import { TRISTATE_MASTER_RAMPS } from '../data/ramps.js';
import { dedupeLaunchesList } from '../utils/dedupe.js';

let RAMP_LAYER = null;
let RAMPS_VISIBLE = false;
let RAMP_DATA = null;

function prepareRampData() {
  if (RAMP_DATA) return RAMP_DATA;
  
  const merged = {};
  for (const [lk, data] of Object.entries(LAKE_DB || {})) {
    if (!data?.ramps) continue;
    for (const [rName, c] of Object.entries(data.ramps)) {
      merged[`${rName} [ ${lk} ]`] = c;
    }
  }

  for (const st of ['SC', 'NC', 'GA']) {
    const stateRamps = TRISTATE_MASTER_RAMPS?.[st] || {};
    for (const [lk, rObj] of Object.entries(stateRamps)) {
      for (const [rName, c] of Object.entries(rObj || {})) {
        merged[`${rName} [ ${lk} ]`] = c;
      }
    }
  }

  const deduped = dedupeLaunchesList(merged);
  RAMP_DATA = [];
  
  for (const [key, coords] of Object.entries(deduped)) {
    const rampName = key.split(' [ ')[0];
    const lakeName = (key.split(' [ ')[1] || '').replace(' ]', '') || '';
    const [lat, lon] = coords;
    if (isNaN(lat) || isNaN(lon)) continue;
    RAMP_DATA.push({ name: rampName, lake: lakeName, lat, lon });
  }
  return RAMP_DATA;
}

function updateRampMarkers() {
  if (!state.MAP_OK || !RAMP_LAYER || !RAMPS_VISIBLE) return;
  
  RAMP_LAYER.clearLayers();
  const bounds = state.MAP.getBounds().pad(0.5); // Buffer slightly off-screen
  
  const data = prepareRampData();
  for (const r of data) {
    if (bounds.contains([r.lat, r.lon])) {
      const osmUrl = `https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lon}&zoom=17`;

      const marker = L.marker([r.lat, r.lon], {
        icon: L.divIcon({
          className: 'custom-gis-marker',
          html: `<div style="
              background:#00e5ff;color:#062d00;font-size:11px;font-weight:700;
              padding:2px 6px;border-radius:4px;border:2px solid #007a8a;
              white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.5);cursor:pointer;
            ">⛵ ${esc(r.name)}</div>`,
          iconAnchor: [0, 8],
        }),
      });

      marker.bindPopup(`
        <b>${esc(r.name)}</b><br>
        <span style="color:#aed581;font-size:12px">${esc(r.lake)} (Verified Boating Access)</span><br>
        <span style="font-family:monospace;font-size:11px">${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}</span><br>
        <a href="${osmUrl}" target="_blank" style="font-size:12px;display:block;margin-top:4px">🗺 Verify on OpenStreetMap ↗</a>
        <button onclick="window.enableSpotRepositioning(this, '${esc(r.name).replace(/'/g, "\\'")}')" class="small warn" style="margin-top:8px">✥ Re-Position Launch Spot</button>
      `);

      RAMP_LAYER.addLayer(marker);
    }
  }
}

export function buildRampLayer() {
  if (RAMP_LAYER) return;
  RAMP_LAYER = L.layerGroup();
  prepareRampData();
  
  // Attach the update listener so it refreshes on pan/zoom
  if (state.MAP_OK) {
    state.MAP.on('moveend', updateRampMarkers);
  }
}

export function toggleRampLayer() {
  if (!state.MAP_OK) return;
  buildRampLayer();
  
  const btn = document.getElementById('btnRamps');
  if (RAMPS_VISIBLE) {
    state.MAP.removeLayer(RAMP_LAYER);
    RAMPS_VISIBLE = false;
    if (btn) { btn.style.background = ''; btn.style.color = ''; }
  } else {
    RAMP_LAYER.addTo(state.MAP);
    RAMPS_VISIBLE = true;
    updateRampMarkers(); // Immediately populate visible area
    if (btn) { btn.style.background = 'var(--accent)'; btn.style.color = '#000'; }
  }
}

export function toggleChartLayersPanel() {
  const wrap = document.getElementById('chartLayersWrap');
  const btn = document.getElementById('btnChartLayers');
  if (!wrap) return;
  const visible = wrap.style.display !== 'none';
  wrap.style.display = visible ? 'none' : 'block';
  if (btn) {
    btn.style.background = visible ? '' : 'var(--accent)';
    btn.style.color = visible ? '' : '#000';
  }
}

function wireButtons() {
  document.getElementById('btnRamps')?.addEventListener('click', toggleRampLayer);
  document.getElementById('btnChartLayers')?.addEventListener('click', toggleChartLayersPanel);
  document.getElementById('closeChartLayersBtn')?.addEventListener('click', () => {
    const wrap = document.getElementById('chartLayersWrap');
    const btn = document.getElementById('btnChartLayers');
    if (wrap) wrap.style.display = 'none';
    if (btn) { btn.style.background = ''; btn.style.color = ''; }
  });
}

wireButtons();
