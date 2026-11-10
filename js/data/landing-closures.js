/**
 * landing-closures.js -- landings known to be closed, each with who said so and the day it was read.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 11/8, of the area bar on Wateree: "for taylor creek or colonel creek this should tell you to launch at those
 * instead maybe?", and "i think taylors landing is closed temporarily because of a invasive grass". So an area names
 * the landing nearest it by water when that is not his ramp (plan-areas.js), and a closure known here is said beside
 * it with its source and the date it was read. A closure is a fact with a date, not a forever: it is said "as read on"
 * and a reopening is a line taken out of this list. Matched to a landing within NEAR_M of `at`, on the same water.
 */

export const NEAR_M = 300;

export const LANDING_CLOSURES = Object.freeze([
  Object.freeze({
    water: 'wateree_lake', name: 'Taylor Creek', aka: 'Taylors Creek Access Area', at: [-80.875784, 34.43773],
    why: 'closed by Duke Energy while SCDES treats giant salvinia in the cove',
    source: 'SCDES, Aquatic Nuisance Plants',
    url: 'https://des.sc.gov/programs/bureau-water/aquatic-science/aquatic-nuisance-plants',
    read: '2026-11-08',
  }),
]);

const metres = (a, b) => {
  const kx = 111320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110540);
};

/** The closure known for this landing ({lon, lat} or {at}) on this water, or null. */
export function closureFor(slug, landing) {
  const at = Array.isArray(landing && landing.at) ? landing.at
    : landing && Number.isFinite(Number(landing.lon)) && Number.isFinite(Number(landing.lat)) ? [Number(landing.lon), Number(landing.lat)] : null;
  if (!slug || !at) return null;
  return LANDING_CLOSURES.find((c) => c.water === slug && metres(c.at, at) <= NEAR_M) || null;
}
