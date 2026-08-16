/**
 * structure-markers.js — how many humps and ledges earn coordinates in a research profile.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * THIS IS A SEPARATE FILE BECAUSE IT HAD TO BE TESTABLE. The capping lived inside
 * lake-research-engine.js, whose import graph reaches Leaflet and window-assigning browser
 * modules, so it could not be imported under node --test at all. A rule about how much data
 * ships that cannot be exercised is a rule nobody checks.
 *
 * WHY A CAP EXISTS AT ALL, counted off the real packs on 2026-08-16:
 *
 *     wateree_lake                  392 humps  ->  humpCoordinates  60,490 bytes
 *     hartwell_lake               1,751 humps  ->                  272,525 bytes
 *     j_strom_thurmond_reservoir  3,531 humps  ->                  549,450 bytes
 *
 * storage.js writes the profile with JSON.stringify(master, null, 2), so those are the bytes
 * that reach R2. Thurmond's saved profile warned at 810,424 against its own 250 KB threshold,
 * and the profile travels into every agent prompt -- which is why habitat's prompt measured
 * 402,757 characters in wrangler tail and why truncating extracted facts could not shrink it.
 * The bulk was never the facts.
 *
 * The old comment read: "Every hump ships: 395 on Wateree, and a hump is rare enough that each
 * one is worth a pin." True on Wateree. False on a 41,000-acre reservoir, and the difference
 * only shows up on the lake nobody measured.
 */

// Wateree carries 6,915 ledges. Only the steepest earn a marker and a stop candidate.
export const LEDGE_MARKER_CAP = 200;

// 400 is not chosen for neatness: it is just above Wateree's 392, which is the size this
// feature was written against and the only size it was ever observed to work at.
export const HUMP_MARKER_CAP = 400;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * The humps worth a pin, most relief first.
 *
 * Relief before area: a 6 ft rise is a place to stop, a 1 ft rise across 30 acres is the bottom
 * being slightly uneven. Same ordering idea as the ledge sort, which ranks by slope.
 *
 * Returns the count and a note as well as the coordinates, because a lake that lost 3,131 humps
 * to a cap should say so in its own profile rather than reading as a lake with 400.
 */
export function capHumps(placedHumps, cap = HUMP_MARKER_CAP) {
  const all = Array.isArray(placedHumps) ? placedHumps : [];
  const coordinates = [...all]
    .sort((a, b) => ((num(b.relief_ft) ?? 0) - (num(a.relief_ft) ?? 0))
                 || ((num(b.area_acres) ?? 0) - (num(a.area_acres) ?? 0)))
    .slice(0, cap)
    .map((h) => ({
      id: h.id, lat: h.lat, lon: h.lon,
      depth: num(h.depth_ft), areaAcres: num(h.area_acres),
      reliefFt: num(h.relief_ft), levels: num(h.levels),
    }));
  return {
    coordinates,
    total: all.length,
    note: all.length > cap
      ? `${all.length} humps mapped; the ${cap} with the most relief carry coordinates`
      : null,
  };
}
