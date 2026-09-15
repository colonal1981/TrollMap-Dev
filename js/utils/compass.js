/**
 * compass.js — the sixteen-point compass, once.
 *
 * FOUR COPIES OF THE SAME SIXTEEN STRINGS, and the fourth was about to be written when this file
 * was made instead. plan-preflight.js had `DIRS` for the wind, measure-tool.js had `dirs` inside
 * calcBearing, and plan-builder.js has a third inside the report's generated HTML -- that one is
 * a string handed to a browser with no module loader and genuinely cannot import, so it stays and
 * is the only copy left.
 *
 * A table repeated is a table that can disagree with itself, and this one has a real way to go
 * wrong: `Math.round(deg / 22.5) % 16` is correct and `Math.floor` is not, by up to 11 degrees.
 * One implementation is one place to get that right.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */

export const COMPASS_16 = Object.freeze([
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
]);

/**
 * The compass point a bearing falls on, or null when there is no bearing.
 *
 * NULL RATHER THAN 'N'. A missing direction rendered as north is a claim, and it is the claim a
 * person acts on when they decide which way to drift a bait.
 */
export function compassOf(deg) {
  // Number(null), Number(undefined) and Number('') are 0, '' and NaN-or-zero respectively, and
  // `Number.isFinite(0)` is true -- so a Number() guard alone turns every missing bearing into
  // due north. Caught by this file's own test on the first run.
  if (deg === null || deg === undefined || deg === '' || typeof deg === 'boolean') return null;
  const d = Number(deg);
  if (!Number.isFinite(d)) return null;
  return COMPASS_16[Math.round(((d % 360) + 360) % 360 / 22.5) % 16];
}
