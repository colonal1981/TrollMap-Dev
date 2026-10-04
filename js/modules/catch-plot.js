/**
 * Plot Catches on Map — toggle catch markers on the map. Markers
 * are styled differently for "trophy" catches (≥30 inches).
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * ONLY WHERE A FISH COULD HAVE BEEN. Ryan, 2026-10-04, on Wyboo Creek: "i am seeing fish on land in
 * this area still", and the rule he set for it: "if it is showing off water it should be filtered
 * from the app... fish with either no position or incorrect position should not make it into the
 * app". A catch filed under the water the map has loaded, whose pin is on neither that water's depth
 * chart nor inside its boundary, is not drawn; each fish photographed more than once is drawn once
 * (js/utils/catch-pins.js). The journal keeps every row -- the Catch Center lists them all.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { describeCatchDepth } from '../utils/catch-depth.js';
import { registerLayer, wireButton, isVisible, replaceLayer } from '../core/layer-registry.js';
import { hasPosition, oneFishEach, pinOffItsWater } from '../utils/catch-pins.js';
import { getActiveLakeKey, getDepthAreaGeoJSON, getLakeBoundaryGeoJSON } from './supplemental-layers.js';
import { depthSampler } from './plan-water-index.js';
import { waterTest } from './river-drifts.js';
import { resolveR2Key } from '../data/lake-keys.js';

// Catch markers are derived from state.CATCHES, which grows as you log fish, so this is a
// `rebuild: true` layer -- it re-derives on every show instead of caching the first draw.
let _mapped = 0;
let _offWater = 0;
let _drawn = [];

// One sampler per depth chart, kept: a big lake's chart is tens of thousands of polygons, and the
// layer is rebuilt on every show.
let _water = { key: null, da: null, bd: null, depthAt: null, inside: null };
function loadedWater() {
  const key = getActiveLakeKey();
  if (!key) return null;
  const da = getDepthAreaGeoJSON(), bd = getLakeBoundaryGeoJSON();
  if (_water.key !== key || _water.da !== da || _water.bd !== bd) {
    _water = {
      key, da, bd,
      depthAt: da && Array.isArray(da.features) && da.features.length ? depthSampler(da.features) : null,
      inside: bd ? waterTest(bd) : null,
    };
  }
  return { key, keyOf: resolveR2Key, depthAt: _water.depthAt, inside: _water.inside };
}

/** The catches the map draws, and how many it left off for a pin off their water. */
function catchesToDraw(catches, water) {
  const drawn = [];
  let offWater = 0;
  for (const c of oneFishEach(catches || [])) {
    if (!hasPosition(c)) continue;
    if (pinOffItsWater(c, water)) { offWater++; continue; }
    drawn.push(c);
  }
  return { drawn, offWater };
}

/**
 * THE WATER AND THE WEATHER HE CAUGHT IT IN, on the pin: his unit's water temperature at the bite, and
 * the air, sky, wind, pressure and moon at that hour (the journal's `weather`, from the archive). The
 * journal gathered both and only the review queue showed the weather (Ryan, 10/4: "everything in this
 * app is either supposed to be shown to me to help me plan or shown to smartplan to help it plan").
 */
export function weatherThen(c) {
  const w = c && c.weather;
  const bits = [];
  if (c && c.waterTempF != null && c.waterTempF !== '') bits.push(`water ${esc(c.waterTempF)} °F`);
  if (w) {
    if (w.tempF != null) bits.push(`air ${esc(w.tempF)} °F`);
    if (w.cloudPct != null) bits.push(`${esc(w.cloudPct)}% cloud`);
    if (w.windMph != null) bits.push(`wind ${esc(w.windMph)} mph`);
    if (w.pressureHpa != null) bits.push(`${esc(w.pressureHpa)} hPa`);
    if (w.moonPhase) bits.push(esc(w.moonPhase));
  }
  return bits.length ? `<b>Then:</b> ${bits.join(' · ')}<br>` : '';
}

function buildCatchLayer() {
  const CATCH_LAYER = L.layerGroup();
  const { drawn, offWater } = catchesToDraw(state.CATCHES, loadedWater());
  for (const c of drawn) {
    const lat = parseFloat(c.lat), lon = parseFloat(c.lon);
    const isTrophy = c.length && parseFloat(c.length) >= 30;
    const ico = isTrophy ? '🏆' : '🐟';
    const bg  = isTrophy ? '#b06a00' : '#007a8a';
    const bdr = isTrophy ? '#ffb703' : '#00e5ff';

    const marker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: '',
        html: `<div style="background:${bg};color:#fff;font-size:12px;font-weight:700;font-family:system-ui,sans-serif;padding:3px 7px;border-radius:6px;border:2px solid ${bdr};white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.6);cursor:pointer">${ico} ${esc(c.species || 'Fish')} ${c.length ? c.length + '"' : ''}</div>`,
        iconAnchor: [12, 12],
      }),
    });
    marker.bindPopup(`
      <b style="font-size:15px;color:#0d4f8b">${ico} ${esc(c.species || 'Fish')} ${c.length ? c.length + '"' : ''}</b><br>
      <b>Lure:</b> ${esc(c.lure || '—')}<br>
      <b>Depth:</b> ${esc(describeCatchDepth(c).text)} · <b>Lead:</b> ${esc(c.lead || '—')} ft<br>
      <b>Time:</b> ${esc(c.time || '—')} · ${esc(c.date || '—')}<br>
      ${weatherThen(c)}
      <div style="background:#f0f4f8;padding:6px;border-radius:4px;margin-top:6px;font-size:12px">${esc(c.notes || 'No notes.')}</div>
    `);
    CATCH_LAYER.addLayer(marker);
  }
  _mapped = drawn.length;
  _offWater = offWater;
  _drawn = drawn;
  if (offWater) {
    console.log(`[catches] ${drawn.length} drawn; ${offWater} filed under ${_water.key} with a pin off its water left off`);
  }
  return CATCH_LAYER;
}

registerLayer({
  id: 'catches',
  button: 'btnShowCatches',
  rebuild: true,
  enabled: () => !!state.MAP_OK,
  activeBg: 'var(--accent2)',
  activeColor: '#062d00',
  label: (on) => (on ? `\u{1F41F} Hide (${_mapped})` : '\u{1F41F} Catches'),
  build: () => {
    const layer = buildCatchLayer();
    if (!_mapped) {
      alert('No catches with GPS coordinates yet.\nMake sure GPS is active when logging catches.');
      return null;
    }
    return layer;
  },
  // Framing the map on the catches and jumping to the map tab are things that happen when
  // the layer GOES ON, not part of drawing it.
  onShow: () => {
    const pts = _drawn.map((c) => [parseFloat(c.lat), parseFloat(c.lon)]);
    if (pts.length) state.MAP.fitBounds(pts, { padding: [40, 40] });
    document.querySelector('#bottomNav button[data-tab="map"]')?.click();
  },
});

// A NEW WATER ON THE MAP is a new test for the pins: redraw in place, without moving the map.
if (typeof window !== 'undefined') {
  window.addEventListener('trollmap:waterLoaded', () => {
    if (isVisible('catches')) replaceLayer('catches', buildCatchLayer());
  });
}

wireButton('catches');
