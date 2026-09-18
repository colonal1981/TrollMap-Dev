/**
 * ── THE SAME LAUNCH UNDER TWO SPELLINGS ─────────────────────────────────────────────────────────
 *
 * A launch arrives from four places: the live state feeds through access-index.js (SCDNR, NCWRC,
 * GA WRD, TWRA), the national layer, OSM, and — on the six curated PLAN_RIVERS — a hand-written list
 * in plan-builder.js. They agree about the PLACE and disagree about the WORDS: `BARNEY JORDAN
 * LANDING` and `Barney Jordan (Columbia)` are one slab of concrete.
 *
 * Three files had their own version of that comparison: `rampCoords()` normalised and matched on
 * substrings, `populatePlanRampDropdown()` collapsed duplicates on a name and then on ~60 m, and
 * `getPlanRampCoords()` did a third thing. This is the one copy.
 *
 * WHAT IT COST BEFORE IT WAS ONE COPY, 2026-09-17: the map's ramp dropdown wrote a feed spelling
 * into the Plan tab's `#planRamp`, whose options on a curated river carry the hand-written names.
 * A `<select>` assigned a value none of its options hold has its value set to the EMPTY STRING —
 * that is the HTML rule, it does not throw — so picking a ramp on the map silently left the Plan tab
 * blank on exactly those six waters. `rampCoords()` then fell back to the first row of the merged
 * index and planned the day from it without saying so.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */

/**
 * How near two positions have to be to be one launch. 60 m is the radius
 * `populatePlanRampDropdown()` has used to collapse one ramp arriving from four sources since the
 * live feeds landed, so this is that number given a name rather than a new one.
 */
export const RAMP_SAME_M = 60;

/** Lowercase, punctuation to spaces, runs of space collapsed. The comparison every caller wanted. */
export function normRampName(v) {
  return String(v == null ? '' : v)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Metres between two [lat, lon] pairs, flat-earth at this scale and plenty for 60 m. */
export function metresApart(aLat, aLon, bLat, bLon) {
  if (![aLat, aLon, bLat, bLon].every((n) => Number.isFinite(n))) return Infinity;
  const k = Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
  return Math.hypot((bLon - aLon) * 111320 * k, (bLat - aLat) * 111320);
}

/**
 * WHICH ROW IS THIS LAUNCH, by name first and by position second.
 *
 * The name is tried exactly, then as a containment either way — `Barney Jordan (Columbia)` contains
 * `barney jordan`. Only then the position, because two launches CAN share a word ("Bushy Park -
 * Fresh Water" and "Bushy Park - Salt Water" are 40 m apart and are different ramps, and the names
 * are what tell them apart). A row with no coordinates simply cannot be matched by position; that is
 * the honest answer and the caller decides what to do about it.
 *
 * @param {{name?:string, lat?:number, lon?:number}[]} rows
 * @param {?string} name
 * @param {?number} lat
 * @param {?number} lon
 * @returns {number} index into `rows`, or -1
 */
export function matchRampIndex(rows, name, lat, lon) {
  const list = Array.isArray(rows) ? rows : [];
  const want = normRampName(name);
  if (want) {
    const exact = list.findIndex((r) => normRampName(r && r.name) === want);
    if (exact >= 0) return exact;
    const part = list.findIndex((r) => {
      const y = normRampName(r && r.name);
      return y && (want.includes(y) || y.includes(want));
    });
    if (part >= 0) return part;
  }
  const y = Number(lat), x = Number(lon);
  if (!Number.isFinite(y) || !Number.isFinite(x)) return -1;
  let best = -1, bestM = RAMP_SAME_M;
  for (let i = 0; i < list.length; i++) {
    const d = metresApart(y, x, Number(list[i] && list[i].lat), Number(list[i] && list[i].lon));
    if (d < bestM) { bestM = d; best = i; }
  }
  return best;
}
