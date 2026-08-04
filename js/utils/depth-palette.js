/**
 * depth-palette.js — ONE depth ladder for every layer that colours by depth.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS FILE EXISTS
 *
 * Murrells Inlet rendered the same depth in three different colours, because three layers
 * each carried their own band table:
 *
 *   depth polygons   5.9 / 11.8 / 17.7 / 29.9 / 35.8 / 59.7   (DEPTH_BANDS_COASTAL)
 *   contour lines    10 / 20 / 28 / 36 / 45 / 55 / 65          (DEPTH_COLORS)
 *   soundings        2 / 4 / 8                                 (inline in coastal-layers.js)
 *
 * At 15 ft charted the polygon drew #e9c46a, the contour crossing it drew #f4a261, and a
 * sounding sitting on both drew #4fc3f7. Each layer was internally consistent, which is
 * exactly why it never looked like a bug up close. Ryan, 2026-08-04: "the sounds are in one
 * colour scheme which doesn't match the depth polygon."
 *
 * The coastal table was the worse of the three. Its thresholds are commented in the original
 * as "NOAA ENC DEPARE uses metric-derived breaks" — they existed to land on ENC's own polygon
 * edges. Those polygons are Garmin's now in the six primary zones, so the band edges were
 * falling mid-interval and the fill genuinely did not line up with the linework.
 *
 * THE LADDER
 *
 * Every colour from the old freshwater table is preserved at its old threshold, so deep water
 * renders exactly as before. The change is at the shallow end: what used to be a single red
 * band covering everything under 10 ft is now three, on the soundings' 2 / 4 / 8 ft breaks.
 * That range is where a kayak decision actually gets made, and one flat red answered none of
 * it. Ryan approved this for fresh and salt alike — a 3 ft flat on Murray matters for the
 * same reason it matters in the marsh.
 *
 * Depths are FEET, and whatever the caller passes is what gets coloured. If a layer wants
 * tide-corrected colour it corrects the number first (see displayDepth in tide-engine.js);
 * this file has no opinion about datum.
 */

export const DEPTH_BANDS = [
  { max: 2,        color: '#b71c1c' },   // skinny — you are dragging
  { max: 4,        color: '#e63946' },
  { max: 8,        color: '#f4795b' },
  { max: 20,       color: '#f4a261' },
  { max: 28,       color: '#e9c46a' },
  { max: 36,       color: '#2a9d8f' },
  { max: 45,       color: '#00e5ff' },
  { max: 55,       color: '#0077b6' },
  { max: 65,       color: '#7b2d8b' },
  { max: Infinity, color: '#ffffff' },
];

/**
 * Colour for a depth in feet.
 *
 * A non-finite depth returns the deepest colour rather than throwing or drawing nothing:
 * a missing depth on a chart layer should look like unsurveyed water, not like a hole.
 */
export function depthColor(ft) {
  // null, undefined and '' must be rejected BEFORE Number(), because Number(null) and
  // Number('') are both 0 -- and 0 ft is the shallowest, reddest band. Unsurveyed water
  // would render as "you are aground here", which is worse than drawing nothing.
  // tide-engine.js carries the same guard for the same reason; this is the third time the
  // trap has been hit in this codebase, so it is now covered by a test.
  if (ft === null || ft === undefined || ft === '') {
    return DEPTH_BANDS[DEPTH_BANDS.length - 1].color;
  }
  const d = Number(ft);
  if (!Number.isFinite(d)) return DEPTH_BANDS[DEPTH_BANDS.length - 1].color;
  for (const band of DEPTH_BANDS) {
    if (d <= band.max) return band.color;
  }
  return DEPTH_BANDS[DEPTH_BANDS.length - 1].color;
}

/** Legend rows, shallow to deep, for a panel that wants to explain itself. */
export function depthLegend() {
  const out = [];
  let lo = 0;
  for (const band of DEPTH_BANDS) {
    out.push({
      color: band.color,
      label: band.max === Infinity ? `${lo}+ ft` : `${lo}–${band.max} ft`,
      min: lo,
      max: band.max,
    });
    lo = band.max;
  }
  return out;
}
