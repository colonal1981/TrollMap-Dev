/**
 * closer-landing.js — say when the day's water is closer to another landing.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Change request 10. Ryan, 2026-09-25, on a Wateree plan whose legs 3-7 were 0.4-2.5 mi from June
 * Creek and 3-6 mi from Clearwater Cove, where he launched: *"if i am going to fish june creek then
 * i should have just launched at june creek"*. On a distance cap: *"I honestly don't know that
 * number... it depends on the day, the time of year and a bunch of other factors"*. So there is no
 * cap and nothing is refused: once a plan is built, the run out to its first leg and the run home
 * from its last are costed from every landing on the water with the same water router the plan
 * used, and the best one that beats his launch is named, with the miles.
 *
 * EXACT, NOT SAMPLED. A water route is never shorter than the straight line, so a landing whose
 * straight-line out-and-home already costs more than the best routed answer so far cannot win and
 * is never asked about. Candidates are tried cheapest-bound first and the search stops at the
 * first bound that cannot beat the best -- branch and bound, so on a lake with a hundred landings
 * it asks the router about a handful, and it needs no number of its own to decide which.
 */

import { samePlace } from '../data/launch-reach.js';

const R_EARTH_M = 6371008.8;
const MI = 1609.34;

/** Great-circle metres between two [lon, lat]. */
export function metresBetween(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2
          + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

const pathM = (cs) => {
  let m = 0;
  for (let i = 1; i < (cs || []).length; i++) m += metresBetween(cs[i - 1], cs[i]);
  return m;
};

/**
 * Where the day's fishing starts and finishes, and what his launch costs to reach them.
 *
 * `first` is the end of the transit out (or the first troll leg's start when the launch is on
 * it); `last` is the start of the run home, or the launch itself when the day already finishes
 * within reach of the ramp and the plan draws no run home. That costs his launch nothing, and
 * another landing is still charged its own way back from there.
 *
 * @returns {null|{first:number[], last:number[], outM:number, homeM:number}}
 */
export function dayEnds(plan, launch) {
  const legs = (plan && Array.isArray(plan.legs)) ? plan.legs : [];
  const trolls = legs.filter((l) => l && l.type === 'troll' && Array.isArray(l.coordinates)
                                    && l.coordinates.length);
  if (!trolls.length || !Array.isArray(launch)) return null;
  const out = legs[0] && legs[0].type === 'transit' && legs[0].role !== 'return'
    && Array.isArray(legs[0].coordinates) && legs[0].coordinates.length ? legs[0] : null;
  const ret = legs.slice().reverse().find((l) => l && l.type === 'transit' && l.role === 'return'
                                                 && Array.isArray(l.coordinates)
                                                 && l.coordinates.length) || null;
  return {
    first: out ? out.coordinates[out.coordinates.length - 1] : trolls[0].coordinates[0],
    last: ret ? ret.coordinates[0] : launch,
    outM: out ? Number(out.lengthM) || 0 : 0,
    homeM: ret ? Number(ret.lengthM) || 0 : 0,
  };
}

/**
 * The landing that reaches this day's water for the least running, when it is not his.
 *
 * @param {object}   o
 * @param {object}   o.plan      assemblePlan() output
 * @param {number[]} o.launch    his launch, [lon, lat]
 * @param {Array}    o.landings  landingsFor() rows: {name, lat, lon, water_m, route, listing}
 * @param {function} o.route     async ([lon,lat], [lon,lat]) -> {distanceM} | null, the plan's router
 * @returns {Promise<null|{landing:object, outM:number, homeM:number, savedM:number,
 *                         fromOutM:number, fromHomeM:number}>}
 */
export async function closerLanding(o) {
  const ends = dayEnds(o.plan, o.launch);
  if (!ends || !Array.isArray(o.landings) || typeof o.route !== 'function') return null;
  const mine = ends.outM + ends.homeM;
  if (!(mine > 0)) return null;
  const here = { lon: o.launch[0], lat: o.launch[1] };

  // A LANDING UP A CANAL OR A CREEK leaves by its own measured path (build_ramp_reach.py, channel
  // end first), so it is costed as that path plus the route on from the channel end.
  const cands = [];
  for (const l of o.landings) {
    if (!l || !Number.isFinite(l.lat) || !Number.isFinite(l.lon) || samePlace(l, here)) continue;
    const hasPath = Array.isArray(l.route) && l.route.length >= 2;
    const from = hasPath ? l.route[0] : [l.lon, l.lat];
    const lead = hasPath ? (Number.isFinite(Number(l.water_m)) ? Number(l.water_m) : pathM(l.route)) : 0;
    // Always both ways: a day that ends at his ramp still has to get back to THIS one.
    const bound = 2 * lead + metresBetween(from, ends.first) + metresBetween(ends.last, from);
    if (bound < mine) cands.push({ l, from, lead, bound });
  }
  cands.sort((a, b) => a.bound - b.bound);

  let best = null;
  for (const c of cands) {
    if (c.bound >= (best ? best.outM + best.homeM : mine)) break;
    let outR = null, homeR = null;
    try {
      outR = await o.route(c.from, ends.first);
      homeR = await o.route(ends.last, c.from);
    } catch (_) { continue; }
    // A pair the router will not answer is a landing this app cannot vouch for. Skipped, never
    // costed as a straight line -- that is the invention the plan's own transits refuse.
    if (!outR || !homeR || !Number.isFinite(outR.distanceM) || !Number.isFinite(homeR.distanceM)) continue;
    const outM = c.lead + outR.distanceM;
    const homeM = c.lead + homeR.distanceM;
    if (outM + homeM < (best ? best.outM + best.homeM : mine)) best = { landing: c.l, outM, homeM };
  }
  if (!best) return null;
  return { ...best, savedM: mine - best.outM - best.homeM, fromOutM: ends.outM, fromHomeM: ends.homeM };
}

/**
 * The sentence for the plan, or null when the saving does not reach a tenth of a mile -- the
 * precision every distance on the card is printed at, so a smaller one would read "0.0 mi closer".
 */
export function closerLandingNote(best, rampName) {
  if (!best || !(best.savedM > 0)) return null;
  const mi = (m) => (m / MI).toFixed(1);
  if (mi(best.savedM) === '0.0') return null;
  const l = best.landing || {};
  const name = l.name || '(unnamed launch)';
  const fee = l.listing === 'semi-private' ? ' (semi-private — a fee is likely)' : '';
  const ramp = rampName || 'your launch';
  return `${name}${fee} is ${mi(best.savedM)} mi closer to this day's water by boat: `
       + `${mi(best.outM)} mi out to the first leg and ${mi(best.homeM)} mi back from the last, `
       + `against ${mi(best.fromOutM)} and ${mi(best.fromHomeM)} mi from ${ramp}. The plan is `
       + `built from ${ramp}; launching there instead would change which water it offers.`;
}
