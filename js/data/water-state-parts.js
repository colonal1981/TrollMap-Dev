/**
 * water-state-parts.js -- which state a launch is in, on a water that is in more than one.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS EXISTS. Ryan, 2026-09-24: "is there a way for rivers that flow through multiple states
 * to carry that information?" 28 of the 352 waters we offer touch more than one state, measured
 * from their own outlines against the Census state lines (label_water_states.py). The app had one
 * state per water, the registry row's, which 3DHP assigns from the centroid -- so a put-in in
 * Cherokee County, SC on the Broad River was checked against North Carolina's statewide book,
 * because broad_river is filed NC.
 *
 * A water in two states is under two books, and the one that governs a morning is the one for
 * the bank he launches from. The launch's coordinate was always in the app. What it lacked was
 * the line, and registry/water_state_parts.json is the line: for each water that crosses one,
 * each of its states' Census outline cut to the ground within reach of the water. See
 * write_state_parts() in Scripts/label_water_states.py for the cut and why it is not simplified.
 *
 * NOTHING HERE GUESSES. A launch outside every part, a water the file does not carry, and a file
 * that did not load all answer `state: null` with the reason, and the caller says so out loud.
 */
import { registryLoader } from './registry-loader.js';

export const WATER_STATE_PARTS_PATH = '/chartpacks/_registry/water_state_parts.json';

const _parts = registryLoader(WATER_STATE_PARTS_PATH,
  (p) => p && p.waters && typeof p.waters === 'object' && p.waters);

export const primeWaterStateParts = (opts) => _parts.prime(opts);
export const waterStatePartsPrimed = () => _parts.primed();
/** Tests only. */
export const _resetWaterStateParts = () => _parts.reset();

/** Even-odd ray cast. `ring` is [[lon, lat], ...]. */
function inRing(lon, lat, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Inside a GeoJSON Polygon or MultiPolygon, holes honoured. */
export function inGeometry(lon, lat, g) {
  if (!g || !Array.isArray(g.coordinates)) return false;
  const polys = g.type === 'Polygon' ? [g.coordinates]
              : g.type === 'MultiPolygon' ? g.coordinates : [];
  for (const poly of polys) {
    if (!poly.length || !inRing(lon, lat, poly[0])) continue;
    if (poly.slice(1).some((hole) => inRing(lon, lat, hole))) continue;
    return true;
  }
  return false;
}

/**
 * The state `[lon, lat]` is in, among the states of water `slug`.
 *
 * @param {string} slug
 * @param {[number, number]} at  [lon, lat], the order every geometry in this app uses
 * @param {object} [payload]     the parsed file; defaults to the loaded one (tests pass their own)
 * @returns {{state: string|null, why: string}}
 */
export function launchStateOn(slug, at, payload = _parts.get()) {
  if (!payload || !payload.waters) return { state: null, why: 'the state lines have not loaded' };
  const w = payload.waters[slug];
  if (!w || !w.parts) return { state: null, why: 'this water does not cross a state line' };
  const [lon, lat] = Array.isArray(at) ? at : [];
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return { state: null, why: 'the launch has no position' };
  for (const [st, g] of Object.entries(w.parts)) {
    if (inGeometry(lon, lat, g)) return { state: st, why: 'the launch is in ' + st };
  }
  return { state: null, why: `the launch is more than ${w.reach_m || '?'} m from the water` };
}
