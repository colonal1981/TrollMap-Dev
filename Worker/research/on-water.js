/**
 * on-water.js -- is a sampling station ON the water, or only inside its box?
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * The WQP pull asks for everything inside the water's registry BOUNDING BOX. A box is a rectangle,
 * and a long river's rectangle takes in whole lakes. Measured 2026-09-24 over the 68 waters with
 * three or more positioned Secchi stations, against the outline the app draws:
 *
 *     lakes    528 stations, 494 inside the outline, 34 outside (13 of them more than 1 km)
 *     rivers   279 stations,   9 inside the outline, 259 more than 1 km outside
 *
 * The Great Pee Dee River was reading Lake Moultrie, 75 km away; the Ocmulgee was reading Lake
 * Blackshear's dam forebay; Hiwassee Lake was averaging in 71 readings from Lake Chatuge; the Dan
 * River's nearest long-record station was Talbott Reservoir. Each became that water's measured
 * "normal".
 *
 * Inside the outline is the rule, with no distance tolerance to pick: the outline is the water.
 * Every polygon of it counts -- a lake split into several parts is still one water -- and a point
 * in a hole (an island) is not on the water.
 */

import { inRing } from '../../js/utils/geojson-coords.js';

/** Every polygon in a GeoJSON object, as arrays of rings of [lon, lat]. */
export function polygonsOf(geojson) {
  const out = [];
  const walk = (g) => {
    if (!g || typeof g !== 'object') return;
    if (g.type === 'FeatureCollection') (g.features || []).forEach(walk);
    else if (g.type === 'Feature') walk(g.geometry);
    else if (g.type === 'GeometryCollection') (g.geometries || []).forEach(walk);
    else if (g.type === 'Polygon' && Array.isArray(g.coordinates)) out.push(g.coordinates);
    else if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) g.coordinates.forEach((p) => out.push(p));
  };
  walk(geojson);
  return out.filter((p) => Array.isArray(p[0]) && p[0].length >= 4);
}

// inRing() is the one even-odd ray cast, in js/utils/geojson-coords.js (2026-09-25).

/** True when (lon, lat) is inside any polygon's outer ring and none of that polygon's holes. */
export function onWater(polygons, lon, lat) {
  for (const poly of polygons || []) {
    if (!inRing(lon, lat, poly[0])) continue;
    if (!poly.slice(1).some((hole) => inRing(lon, lat, hole))) return true;
  }
  return false;
}

/**
 * Split station ids by where they are: `on` (a Set of ids inside the outline), `off` (placed and
 * outside, with their position), `unplaced` (ids the Station endpoint gave no position for, which
 * cannot be shown to be on the water and are not counted as if they were).
 */
export function splitByWater(ids, places, polygons) {
  const on = new Set();
  const off = [];
  const unplaced = [];
  for (const id of ids) {
    const p = places.get(id);
    if (!p) { unplaced.push(id); continue; }
    if (onWater(polygons, p.lon, p.lat)) on.add(id);
    else off.push({ id, name: p.name || null, lat: p.lat, lon: p.lon });
  }
  return { on, off, unplaced };
}
