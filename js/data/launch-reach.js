/**
 * launch-reach.js — every landing that can REACH a water, and how far it is BY WATER.
 *
 * `launches.json` in the pack, from Scripts/build_ramp_reach.py: the charted water rasterised at
 * 25 m and walked outward from the water's own channel, so each landing carries the distance a
 * boat travels rather than the one a crow flies.
 *
 * WHY IT EXISTS. Ryan launches at Pack's Landing, which SCDNR files under Lake Marion, and runs
 * a canal beside the railroad into the Congaree — fishing the canal on the way. Nothing in the
 * app could see that: the ramp binding is NAME-FIRST, so a landing filed under "Lake Marion"
 * never reached "Congaree River" however close it sat. And straight-line distance, which is what
 * I reached for first, is wrong in the one direction that matters:
 *
 *     Pack's Landing (Rimini)   straight 2,367 m     by water 1,801 m
 *     Low Falls Landing         straight   330 m     by water   254 m
 *
 * The water route is SHORTER because it follows the canal instead of cutting the swamp.
 *
 * ONE LOADER, TWO DROPDOWNS. This lives here and not in plan-builder.js because the Plan tab and
 * the map tab are filled by different modules, and the first cut put the reach list in only one
 * of them. Ryan, on finding that out: *"Just to confirm they show on both the plan and map
 * tabs?"* — they did not. A module both import cannot drift the way two copies would.
 *
 * ANNOTATED, NOT FILTERED. There is no distance cutoff anywhere in here, by decision: *"If you
 * can have these ramps be both river and lake I do not see the downside"*, and then *"Annotates
 * reads like the better answer"*. The label carries the run and the choice is made in the boat.
 */

import { CF_WORKER_URL } from '../core/state.js';
import { resolveR2Key } from './lake-keys.js';

// r2Key -> landings[], or null while a fetch is in flight. A water with no launches.json caches
// [] and is never asked again, which is the normal case for most packs.
const CACHE = new Map();

/**
 * The landings for a water, or [] if they are not here yet.
 *
 * Synchronous on purpose: both dropdowns build their options in one pass and neither can await.
 * The first call starts the fetch and returns []; `onReady` fires once it lands so the caller can
 * redraw. A second call in the same tick does NOT start a second fetch — the map is claimed
 * before the request goes out.
 *
 * @param {string} waterbodyName  the picker's own name for the water
 * @param {function} [onReady]    called with the landings when a fetch completes with any
 * @returns {Array} landings, each {name, lat, lon, water_m, straight_m, station_m, filed, src}
 */
export function launchReach(waterbodyName, onReady) {
  const key = resolveR2Key(waterbodyName);
  if (!key) return [];
  if (CACHE.has(key)) return CACHE.get(key) || [];
  CACHE.set(key, null);
  (async () => {
    let got = [];
    try {
      const r = await fetch(`${CF_WORKER_URL}/chartpacks/${encodeURIComponent(key)}/launches.json`);
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d && d.landings)) got = collapse(d.landings);
      }
    } catch (_) { /* a pack without one is the normal case, not an error */ }
    CACHE.set(key, got);
    if (got.length && typeof onReady === 'function') onReady(got, waterbodyName, key);
  })();
  return [];
}

/**
 * "Rimini — 1.1 mi by water", or just the name when the landing is ON the water.
 *
 * Under a tenth of a mile is on it: every ramp sits on the bank, so a number there would be
 * measuring the walk down the concrete and not the run out to the fish. Past ten miles the tenth
 * is noise against a day's planning.
 */
export function reachLabel(r) {
  const m = Number(r && r.water_m);
  const nm = (r && r.name) || '(unnamed launch)';
  if (!Number.isFinite(m)) return nm;
  if (m < 160) return nm;
  const mi = m / 1609.34;
  return `${nm} — ${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi by water`;
}

/**
 * Is this landing already in the list, by position?
 *
 * 0.0004 deg is about 40 m: two feeds' records of one ramp collapse, two real ramps on one lot
 * do not. Position and not name, because the whole reason this file exists is that the same
 * landing carries different names in different feeds.
 */
export function samePlace(a, b) {
  return Number.isFinite(a && a.lat) && Number.isFinite(b && b.lat)
      && Math.abs(a.lat - b.lat) < 0.0004 && Math.abs(a.lon - b.lon) < 0.0004;
}

/**
 * One row per landing, and the row KEEPS THE NAME.
 *
 * Both dropdowns already dropped a second feed's copy of a landing, and both did it the same
 * way: first one wins, skip the rest. The list arrives sorted by water distance, so when an
 * unnamed OSM record is twenty-five metres nearer by water than the named DNR record beside it,
 * the row that survives is the one with no name. Measured across all 63 packs: 311 collapsed
 * groups, and in 31 of them the surviving row was unnamed while a discarded one had a name --
 * "Saluda Shoals Park", "Cannons Creek", "ELWELLS FERRY", "Pitch" at 25 m of water. Ryan reads
 * the dropdown, and "(unnamed launch)" is not a ramp he can find.
 *
 * Done HERE rather than in the two callers because it is one question, and the callers each
 * still guard against duplicating a ramp THEY already placed, which is a different one. The
 * nearest record's distances win, because the nearest water is the true answer for that spot;
 * only the name, and the lists of who files it and where it came from, merge upward.
 */
function collapse(rows) {
  const out = [];
  const union = (a, b) => [...new Set([...(a || []), ...(b || [])])].sort();
  for (const r of rows) {
    const hit = out.find((p) => samePlace(p, r));
    if (!hit) { out.push({ ...r }); continue; }
    if (!hit.name && r.name) hit.name = r.name;
    hit.filed = union(hit.filed, r.filed);
    hit.src = union(hit.src, r.src);
  }
  return out;
}
