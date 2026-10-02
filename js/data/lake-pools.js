// Personal use only, not for distribution or resale; not for navigation.
/**
 * WHICH WATER A RAMP CAN REACH ON ITS OWN LAKE -- item 50.
 *
 * Ryan, 2026-10-02, on Lake Monticello: *"the app needs to be prevented from running plans from a
 * ramp on a part of the lake the ramp can't access... beyond that the ramp needs to be listed so
 * that i can choose to launch from the ramp and plan/fish the accessible area from that ramp"*.
 *
 * A lake can hold water its own ramps cannot reach: Monticello's 285-acre Recreational Lake behind
 * the SC-99 dike, Marion's Borrow Pit and Wyboo Swamp. The registry calls each part of the one
 * lake, so both planners offered the Recreational Lake's lanes from the 99 ramp (3 of Pick Water's
 * pieces in every depth band tried), and the water graph joins the two across the dike. A pool is
 * told apart by POLYGON ADJACENCY in the pack's own depth areas -- Scripts/build_pools.py writes
 * chartpack/<slug>/pools.json -- and here a plan keeps to the pool its ramp is on:
 *
 *   - a ramp on the main pool plans the main pool, and nothing inside any of `pools`;
 *   - a ramp on one of `pools` plans that pool and nothing else.
 *
 * NO FILE, NO RESTRICTION. A river has none (the registry cuts a river at its dams, so a break in
 * its chart is a gap, not a dike), and a pack built before this keeps planning as it did. Nothing
 * here is said in the dropdown: *"there is not room in the dropdown for you to put all of that
 * info about it being a separate lake... and it would just show as noise to me"*.
 */

import { CF_WORKER_URL } from '../core/state.js';
import { indexRing, inIndexedRing } from '../utils/geojson-coords.js';

/** Same 40 m as samePlace() in launch-reach.js: is the ramp on the screen this landing. */
const SAME_PLACE_DEG = 0.0004;
/** How many points of a line are asked. A lane is in the pool most of its points are in. */
const LINE_SAMPLES = 20;

/**
 * pools.json -> an index, or null when the file is missing or says nothing usable.
 * @returns {{pools: Array<{id:number, acres:number, polys:object[][], box:number[]}>,
 *            landings: Array<{lat:number, lon:number, pool:(number|null)}>} | null}
 */
export function poolIndex(file) {
  if (!file || !Array.isArray(file.pools)) return null;
  const pools = [];
  for (const p of file.pools) {
    // Each ring indexed once (geojson-coords.js), because a lake's lanes ask it thousands of times.
    const polys = (Array.isArray(p && p.rings) ? p.rings : [])
      .filter((poly) => Array.isArray(poly) && Array.isArray(poly[0]) && poly[0].length >= 4)
      .map((poly) => poly.map(indexRing));
    if (!polys.length) continue;
    const box = [Math.min(...polys.map((q) => q[0].x0)), Math.min(...polys.map((q) => q[0].y0)),
                 Math.max(...polys.map((q) => q[0].x1)), Math.max(...polys.map((q) => q[0].y1))];
    pools.push({ id: Number(p.id), acres: p.acres, polys, box });
  }
  const landings = (Array.isArray(file.landings) ? file.landings : [])
    .filter((l) => Number.isFinite(l && l.lat) && Number.isFinite(l && l.lon));
  return { pools, landings };
}

/** The pool a point is on: the id of the pool it is inside, else 0, the main pool. */
export function poolAt(ix, lon, lat) {
  if (!ix || !Number.isFinite(lon) || !Number.isFinite(lat)) return 0;
  for (const p of ix.pools) {
    const [x0, y0, x1, y1] = p.box;
    if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
    for (const poly of p.polys) {
      if (inIndexedRing(lon, lat, poly[0]) && !poly.slice(1).some((h) => inIndexedRing(lon, lat, h))) {
        return p.id;
      }
    }
  }
  return 0;
}

/**
 * The pool a ramp launches onto. Its landing in pools.json says, matched within 40 m; a ramp the
 * file does not list is on the main pool, which is where every ramp the dropdown showed before this
 * already was. A landing whose pool could not be found (null) is left unrestricted rather than
 * planned on nothing.
 *
 * @param {number[]} ramp [lon, lat]
 * @returns {number|null} the pool id, or null for "do not restrict"
 */
export function rampPool(ix, ramp) {
  if (!ix || !Array.isArray(ramp)) return null;
  const [lon, lat] = ramp;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  for (const l of ix.landings) {
    if (Math.abs(l.lat - lat) < SAME_PLACE_DEG && Math.abs(l.lon - lon) < SAME_PLACE_DEG) {
      return l.pool === null || l.pool === undefined ? null : Number(l.pool);
    }
  }
  return 0;
}

function points(geom) {
  if (!geom) return [];
  const c = geom.coordinates;
  switch (geom.type) {
    case 'Point': return [c];
    case 'MultiPoint': case 'LineString': return c || [];
    case 'MultiLineString': case 'Polygon': return (c || []).flat();
    case 'MultiPolygon': return (c || []).flat(2);
    default: return [];
  }
}

/** The pool a feature is on: a point's own, a line's or an area's by most of its points. */
export function featurePool(ix, feature) {
  const pts = points(feature && feature.geometry);
  if (!pts.length) return 0;
  if (pts.length === 1) return poolAt(ix, pts[0][0], pts[0][1]);
  const step = Math.max(1, Math.floor(pts.length / LINE_SAMPLES));
  const tally = new Map();
  for (let i = 0; i < pts.length; i += step) {
    const k = poolAt(ix, pts[i][0], pts[i][1]);
    tally.set(k, (tally.get(k) || 0) + 1);
  }
  let best = 0, n = -1;
  for (const [k, v] of tally) if (v > n) { best = k; n = v; }
  return best;
}

/**
 * What a plan from this ramp may use. `keep(feature)` and `keepAt(lon, lat)` answer true for
 * everything when there is no pools file, no pool for the ramp, or nothing off the main pool.
 *
 * @param {object|null} file  pools.json as fetched
 * @param {number[]} ramp     [lon, lat]
 */
export function rampWater(file, ramp) {
  const ix = poolIndex(file);
  const pool = rampPool(ix, ramp);
  const open = !ix || pool === null || !ix.pools.length;
  const keep = open ? () => true : (f) => featurePool(ix, f) === pool;
  const keepAt = open ? () => true : (lon, lat) => poolAt(ix, lon, lat) === pool;
  let dropped = 0;
  const fc = (c) => {
    if (open || !c || !Array.isArray(c.features)) return c;
    const features = c.features.filter((f) => keep(f) || (dropped++, false));
    return { ...c, features };
  };
  const p = !open && pool ? ix.pools.find((q) => q.id === pool) : null;
  return { pool: open ? null : pool, acres: p ? p.acres : null, keep, keepAt, fc,
           dropped: () => dropped };
}

// pack key -> pools.json, or null when the pack has none. Asked once per water.
const FILES = new Map();

/**
 * pools.json for a water, by pack key, for a caller that does not already hold it (the closer-
 * landing check). null when there is none, which is every river and any pack built before it.
 */
export async function poolsFor(key) {
  if (!key) return null;
  if (FILES.has(key)) return FILES.get(key);
  let file = null;
  try {
    const r = await fetch(`${CF_WORKER_URL}/chartpacks/${encodeURIComponent(key)}/pools.json`);
    file = r && r.ok ? await r.json() : null;
  } catch (_) { file = null; }
  FILES.set(key, file);
  return file;
}

/**
 * The landings that launch onto the same pool as this ramp. The closer-landing check (change
 * request 10) costs every landing on the water with a router that crosses SC-99, so without this
 * it would offer the Recreation Lake ramp for a main-lake day by the dike, and the 99 ramp for a
 * day on the Recreational Lake. Every landing when there is nothing to tell them apart.
 *
 * @param {object|null} file  pools.json
 * @param {number[]} ramp     [lon, lat]
 * @param {Array} landings    landingsFor() rows, {lat, lon, ...}
 */
export function sameWaterLandings(file, ramp, landings) {
  const ix = poolIndex(file);
  const pool = rampPool(ix, ramp);
  if (!ix || pool === null || !ix.pools.length) return landings || [];
  return (landings || []).filter((l) => l && rampPool(ix, [Number(l.lon), Number(l.lat)]) === pool);
}
