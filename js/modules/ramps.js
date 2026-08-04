/**
 * Boat-ramp layer (concrete ramps across SC/NC/GA/TN, live from state DNR feeds).
 * Uses bounds-based filtering to only render ramps visible on screen.
 */

import { state } from '../core/state.js';
import { registerLayer, wireButton, toggle, show, isVisible } from '../core/layer-registry.js';
import { esc } from '../utils/escape.js';
import { TRISTATE_MASTER_RAMPS } from '../data/ramps-loader.js';
import { dedupeLaunchesList } from '../utils/dedupe.js';

// Layer handle and visibility live in core/layer-registry.js.
let RAMP_DATA = null;

function prepareRampData() {
  if (RAMP_DATA) return RAMP_DATA;
  
  const merged = {};

  // NOTE: LAKE_DB hardcoded ramps have been removed to prevent duplicate/ghost pins.
  // The map now exclusively relies on the live, official State DNR coordinates.
  //
  // The `import { LAKE_DB }` that sat at the top of this file went with them on 2026-08-02 --
  // it had outlived the code it fed and was the last thing in the app still reading
  // data/lakes.js, which is what was keeping that file alive.

  for (const st of ['SC', 'NC', 'GA', 'TN']) {
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

function updateRampMarkers(RAMP_LAYER) {
  if (!state.MAP_OK || !RAMP_LAYER || !isVisible('ramps')) return;
  
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

registerLayer({
  id: 'ramps',
  button: 'btnRamps',
  enabled: () => !!state.MAP_OK,
  build: () => {
    const group = L.layerGroup();
    prepareRampData();
    // Refresh on pan/zoom. Bound once at build, as before.
    if (state.MAP_OK) state.MAP.on('moveend', () => updateRampMarkers(group));
    return group;
  },
  onShow: (group) => { updateRampMarkers(group); announce(true); },
  onHide: () => announce(false),
});

/**
 * Tell supplemental-layers.js whether the ramp pills are up.
 *
 * These pills already carry the ramp NAME, and supplemental-layers.js also writes ramp names
 * as chart text. Without this flag, turning the layer on prints every name twice offset by a
 * few pixels -- which reads as a rendering bug rather than as two layers agreeing.
 */
function announce(visible) {
  window.__rampsLayerVisible = visible;
  window.dispatchEvent(new CustomEvent('trollmap:rampsToggled'));
}

/** Kept as an export: it was public API before the registry and callers may still exist. */
export function toggleRampLayer() { return toggle('ramps'); }
export function buildRampLayer() { return show('ramps'); }

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
  wireButton('ramps');
  document.getElementById('btnChartLayers')?.addEventListener('click', toggleChartLayersPanel);
  document.getElementById('closeChartLayersBtn')?.addEventListener('click', () => {
    const wrap = document.getElementById('chartLayersWrap');
    const btn = document.getElementById('btnChartLayers');
    if (wrap) wrap.style.display = 'none';
    if (btn) { btn.style.background = ''; btn.style.color = ''; }
  });
}

wireButtons();
