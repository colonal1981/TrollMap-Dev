/**
 * Boat-ramp layer (1,288+ concrete ramps across SC/NC/GA).
 *
 * Combines:
 *   - LAKE_DB.ramps (curated per-lake ramps with notes)
 *   - TRISTATE_MASTER_RAMPS (consolidated SCDNR + GA + NC GIS data)
 * into a single Leaflet layerGroup, deduped by spatial proximity and
 * name. Each marker gets a popup with the ramp name, lake, lat/lon,
 * and a "Verify on OpenStreetMap" deep link so you can confirm the
 * spot before launching.
 *
 * Module-level state (RAMP_LAYER, RAMPS_VISIBLE) lives in module
 * scope — it's only relevant when the toggle button is visible.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { LAKE_DB } from '../data/lakes.js';
import { TRISTATE_MASTER_RAMPS } from '../data/ramps.js';
import { dedupeLaunchesList } from '../utils/dedupe.js';

let RAMP_LAYER = null;
let RAMPS_VISIBLE = false;

/**
 * Build the ramp layer (idempotent). Combines LAKE_DB ramps and
 * the tri-state GIS archive, dedupes by name + proximity, then
 * creates one Leaflet marker per ramp.
 *
 * Each marker shows ⛵ + ramp name in a cyan pill, and on click
 * shows the lake, coordinates, OSM verify link, and a
 * "Re-Position Launch Spot" button that calls the global
 * enableSpotRepositioning helper.
 */
export function buildRampLayer() {
  if (RAMP_LAYER) return;
  RAMP_LAYER = L.layerGroup();

  // Collect ramps from both sources into one flat dict, namespaced
  // by lake so the deduper can keep cross-lake duplicates with the
  // same ramp name (e.g. "Broad River" in SC vs. coastal SC).
  const merged = {};

  // 1. LAKE_DB baseline — curated per-lake ramps with editorial notes
  for (const [lk, data] of Object.entries(LAKE_DB || {})) {
    if (!data?.ramps) continue;
    for (const [rName, c] of Object.entries(data.ramps)) {
      merged[`${rName} [ ${lk} ]`] = c;
    }
  }

  // 2. TRISTATE_MASTER_RAMPS — the comprehensive GIS archive
  for (const st of ['SC', 'NC', 'GA']) {
    const stateRamps = TRISTATE_MASTER_RAMPS?.[st] || {};
    for (const [lk, rObj] of Object.entries(stateRamps)) {
      for (const [rName, c] of Object.entries(rObj || {})) {
        merged[`${rName} [ ${lk} ]`] = c;
      }
    }
  }

  const deduped = dedupeLaunchesList(merged);

  for (const [key, coords] of Object.entries(deduped)) {
    const rampName = key.split(' [ ')[0];
    const lakeName = (key.split(' [ ')[1] || '').replace(' ]', '') || '';
    const [lat, lon] = coords;
    if (isNaN(lat) || isNaN(lon)) continue;

    const osmUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}&zoom=17`;

    const marker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: 'custom-gis-marker',
        html: `
          <div style="
            background:#00e5ff;color:#062d00;font-size:11px;font-weight:700;
            padding:2px 6px;border-radius:4px;border:2px solid #007a8a;
            white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.5);cursor:pointer;
          ">⛵ ${esc(rampName)}</div>`,
        iconAnchor: [0, 8],
      }),
    });

    marker.bindPopup(`
      <b>${esc(rampName)}</b><br>
      <span style="color:#aed581;font-size:12px">${esc(lakeName)} (Verified Boating Access)</span><br>
      <span style="font-family:monospace;font-size:11px">${lat.toFixed(5)}, ${lon.toFixed(5)}</span><br>
      <a href="${osmUrl}" target="_blank" style="font-size:12px;display:block;margin-top:4px">🗺 Verify on OpenStreetMap ↗</a>
      <button onclick="window.enableSpotRepositioning(this, '${esc(rampName).replace(/'/g, "\\'")}')" class="small warn" style="margin-top:8px">✥ Re-Position Launch Spot</button>
    `);

    RAMP_LAYER.addLayer(marker);
  }
}

/** Show or hide the ramp layer on the map. Toggles button highlight. */
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
    if (btn) { btn.style.background = 'var(--accent)'; btn.style.color = '#000'; }
  }
}

/** Show or hide the chart-layers popup panel. Toggles button highlight. */
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

/** Wire the ⛵ Ramps toggle button and the 📐 Chart-layers popup toggle. */
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
