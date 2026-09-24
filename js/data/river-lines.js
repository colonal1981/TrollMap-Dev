/**
 * river-lines.js -- each river's outline, thinned for a zoomed-out map.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS EXISTS. Ryan, 2026-09-24: "the zoom doesn't work on all of them sometimes you have to
 * actually pan the map to find the river". 30 of the 57 rivers land at zoom 8-10 when picked, and
 * nothing of a river draws below zoom 11 -- contour-data.js hides the linework there, and a river
 * 30-100 m wide is inside one pixel of basemap at zoom 9. The frame was right; the water in it was
 * invisible.
 *
 * registry/river_lines.json is every river's registry outline, outer rings only, thinned to one
 * pixel of ground at the highest zoom it is drawn at. Built by Scripts/build_river_lines.py, which
 * says why it is the OUTLINE and not the pack centreline: 22 of 57 rivers have launches off the
 * centreline's box, broad_river 18 of its 23.
 *
 * Pure: no Leaflet, no DOM. js/modules/river-line-layer.js draws it.
 */
import { registryLoader } from './registry-loader.js';

export const RIVER_LINES_PATH = '/chartpacks/_registry/river_lines.json';

const _lines = registryLoader(RIVER_LINES_PATH,
  (p) => p && p.waters && typeof p.waters === 'object' && p.waters);

export const primeRiverLines = (opts) => _lines.prime(opts);
export const riverLinesPrimed = () => _lines.primed();
/** Tests only. */
export const _resetRiverLines = () => _lines.reset();

/**
 * The river's rings as Leaflet latlng arrays, `[[[lat, lon], ...], ...]`, or null.
 *
 * Null for a water the file does not carry (a lake, a coastal zone, a river built after the file
 * was) and for a file that did not load. Null draws nothing, which is what the map did before.
 *
 * @param {string} slug
 * @param {object} [payload]  the parsed file; defaults to the loaded one (tests pass their own)
 */
export function riverLatLngs(slug, payload = _lines.get()) {
  const w = payload && payload.waters && slug ? payload.waters[slug] : null;
  if (!w || !Array.isArray(w.lines)) return null;
  const out = [];
  for (const line of w.lines) {
    if (!Array.isArray(line) || line.length < 2) continue;
    const ll = [];
    for (const p of line) {
      // The file is [lon, lat], the order every geometry in this app is stored in; Leaflet is
      // [lat, lon]. Converted here once, the same rule lake-registry.js keeps for centroids.
      if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) ll.push([p[1], p[0]]);
    }
    if (ll.length >= 2) out.push(ll);
  }
  return out.length ? out : null;
}

/**
 * Draw the outline at this zoom? Only where the river's own linework does not draw.
 *
 * `floor` is CONTOUR_MIN_ZOOM, passed in by the caller from contour-data.js -- the file's own
 * `drawn_below_zoom` records what it was THINNED for, and the app's constant is what decides
 * what is on screen. At and above the floor the contours and depth areas show the river, and a
 * bright stroke on top of them would hide the channel they are drawing.
 */
export function drawRiverLineAt(zoom, floor) {
  return Number.isFinite(zoom) && Number.isFinite(floor) && zoom < floor;
}
