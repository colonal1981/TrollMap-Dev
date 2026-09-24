/**
 * river-line-layer.js -- the picked river, drawn where the map is too far out to show it.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-09-24: "the zoom doesn't work on all of them sometimes you have to actually pan the
 * map to find the river". Picking a river frames its registry box, and for 30 of the 57 that box
 * lands at zoom 8-10, where nothing of the river draws: contour-data.js hides its linework below
 * CONTOUR_MIN_ZOOM and the basemap cannot resolve a 60 m channel at 250 m a pixel. This strokes
 * the river's own outline (js/data/river-lines.js) at a fixed screen width below that zoom and
 * takes it away at and above it, where the contours take over.
 *
 * ONE WATER AT A TIME. A new pick replaces the line, a lake or a coastal zone clears it, and a
 * pick that lands while the file is still loading is dropped rather than drawn over its successor.
 */
import { state, CF_WORKER_URL } from '../core/state.js';
import { CONTOUR_MIN_ZOOM } from './contour-data.js';
import { primeRiverLines, riverLatLngs, drawRiverLineAt } from '../data/river-lines.js';

let _group = null;
let _slug = null;
let _wired = false;
let _pick = 0;

/** The app's own accent, read off the page so a theme change reaches the map too. */
function accent() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    return v || '#00e5ff';
  } catch (_) {
    return '#00e5ff';
  }
}

function render() {
  if (!state.MAP_OK || !state.MAP) return;
  if (_group) { state.MAP.removeLayer(_group); _group = null; }
  if (!_slug || !drawRiverLineAt(state.MAP.getZoom(), CONTOUR_MIN_ZOOM)) return;
  const rings = riverLatLngs(_slug);
  if (!rings) return;
  // Cased the way map-init.js cases a track: a dark stroke under the colour, so the line reads
  // over a light basemap and a dark one alike. Not interactive -- it is there to be seen, and a
  // click on it must still reach the launch marker or the map beneath.
  _group = L.layerGroup([
    L.polyline(rings, { color: '#000', weight: 6, opacity: 0.45, interactive: false }),
    L.polyline(rings, { color: accent(), weight: 3, opacity: 0.95, interactive: false }),
  ]).addTo(state.MAP);
}

/**
 * Show this river's outline (or clear it, for a falsy slug or a water that is not a river).
 * @param {string|null} slug  the registry slug of the picked water
 */
export async function showRiverLine(slug) {
  const pick = ++_pick;
  _slug = slug || null;
  if (!_wired && state.MAP_OK && state.MAP) {
    state.MAP.on('zoomend', render);
    _wired = true;
  }
  if (!_slug) { render(); return; }
  await primeRiverLines({ worker: CF_WORKER_URL });
  if (pick !== _pick) return;          // another water was picked while the file loaded
  render();
}

export function clearRiverLine() {
  return showRiverLine(null);
}
