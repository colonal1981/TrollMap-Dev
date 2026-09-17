// ---------------------------------------------------------------------------------------------
// A RIVER LEG IS A DRIFT, NOT A LANE.
//
// Ryan, 2026-09-16, on why the Congaree bench came back with nothing worth offering: "for most
// narrower rivers there aren't going to be a bunch of different lanes you can follow... you are
// going to either pick a side or the middle and then kind of follow where the fish might be... i
// am not equipped on the kayak to really anchor on a river so i am going to be moving no matter
// what." And on what the app owes him: "the app just needs to point me over structure... if it
// can draw a line that i can follow and then turn me back around based on speed."
//
// Measured after he said it: all 57 rivers have a median channel width under 200 m and 43 are
// under 80 m. The Congaree gets 1,473 trolling runs over 126.8 km of water 145 m wide -- 11.6
// "lanes" per kilometre, which is one piece of water cut up 11.6 times rather than 11.6 choices.
// Of those 1,473, the selector rejected 915 as unreachable over the water graph and 415 as not
// fitted, before depth was ever consulted. Both of those tests are about lanes.
//
// THIS MODULE DOES NOT ADD A SECOND CANDIDATE GENERATOR. It produces run-shaped LINES from the
// centreline the pipeline already built, and hands them to selectCandidates() unchanged, so the
// window slider, the structure scoring, the per-type caps, the battery and trip-window checks,
// the spatial dedupe and the ranking are the existing ones. A drift differs from a contour lane
// in where the line comes from, not in what a leg is.
//
// WHY THE GEOMETRY DOES THE SIDE-MATCHING AND NO SIGN CONVENTION IS READ. Every stamped feature
// carries a signed `off_m` and a `bend_side`, and it would be easy to filter structure onto a
// drift by comparing those. kindHits() already measures the real distance from a line to a
// feature, so a quarter-left drift picks up the left-bank holes because they are physically near
// it. One less convention to get backwards, and it is the same join docks and attractors use.
// ---------------------------------------------------------------------------------------------

import { cumulative, kindHits, metresBetween } from './plan-candidates.js';

// THE THREE POSITIONS ARE HIS, AND THE FRACTIONS ARE THE ONES ALREADY MEASURED.
//
// FOUR_THINGS_A_RIVER_DAY_HAS_TO_TELL_HIM_2026-09-16.md measured the Congaree at exactly these
// offsets and found the water under the boat changes by three times the median depth depending on
// which one he takes: quarter-left p50 3 ft, mid-channel p50 5 ft, quarter-right p50 3 ft. So
// "pick a side or the middle" is a bait-depth decision as well as a battery one, and these are
// not new numbers -- they are the ones the measurement was taken at.
export const LATERALS = [
  { key: 'quarter_left', frac: 0.25, label: 'quarter-left, a rod off the left bank' },
  { key: 'mid_channel', frac: 0.50, label: 'mid-channel' },
  { key: 'quarter_right', frac: 0.75, label: 'quarter-right, a rod off the right bank' },
];

/**
 * HOW MANY LINES THIS RIVER HAS, AND IT IS A FUNCTION OF THE CORRIDOR, NOT A WIDTH SOMEBODY PICKED.
 *
 * FORTY_THREE_OF_FIFTY_SEVEN_RIVERS_HAVE_NO_SIDE_TO_PICK measured the Congaree's 189 holes against
 * how wide a corridor the boat actually fishes, and the answer moves with the corridor:
 *
 *     plan                              15m    25m    40m    60m   100m
 *     one line: mid-channel              45     80    116    154    177
 *     up one quarter, back the other     98    145    171    180    180
 *
 * At a 15 m corridor the pair is worth 2.2x the single line. At 100 m it is worth 1.02x, because a
 * 100 m corridor from mid-channel already covers a 145 m river bank to bank. The published split --
 * "43 rivers under 80 m gain 1.03x, the 14 wide ones gain 3.16x" -- was that same comparison at one
 * corridor, and 80 m is where THAT corridor happened to put the line. It is not a property of rivers.
 *
 * SO THE RULE IS THE GEOMETRY AND NOT THE TABLE. The quarter lines sit at 0.25 and 0.75 of the
 * width, so they are `0.5 * width` apart, and they are two lines rather than one line drawn twice
 * only when their corridors do not overlap: `0.5 * width >= 2 * corridor`. At today's 100 m corridor
 * no river in the card qualifies -- all 57 have a median channel under 200 m -- so every river is one
 * mid-channel line, which is exactly what the 177-vs-180 row says it should be. When the corridor
 * comes down to the 15 m he measured his own reach at, the threshold falls to 60 m of width and the
 * 14 wide rivers become two lanes, which is what the 45-vs-98 row says.
 *
 * MID-CHANNEL IS THE ONE LINE. Which single quarter is best varies per river with where its bends
 * fall -- on the Congaree quarter-right wins at 15 m and mid-channel wins at 60 and 100 -- so
 * choosing a quarter needs a measurement this app does not have per river. Mid-channel needs none,
 * carries the deepest water of the three (p50 5 ft against 3 ft either side, which is a bait-depth
 * decision), and is the measured best at the corridor actually in force.
 *
 * @param {number} medianWidthM  the river's median charted channel width
 * @param {number} corridorM     how far off the line a feature is still his -- `maxOffM`
 */
export function lateralsFor(medianWidthM, corridorM) {
  const w = Number(medianWidthM);
  const c = Number(corridorM);
  const apart = Number.isFinite(w) && w > 0 ? 0.5 * w : 0;
  const disjoint = Number.isFinite(c) && c > 0 && apart >= 2 * c;
  return disjoint ? [LATERALS[0], LATERALS[2]] : [LATERALS[1]];
}

/** The median of the charted station widths, which is what lateralsFor() asks about. */
export function medianWidthM(widths) {
  const v = (Array.isArray(widths) ? widths : [])
    .map(Number).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return Number(mid.toFixed(1));
}

// The pack's structure kinds, joined to a drift by real distance. Docks and the state attractor
// feed are deliberately NOT here: selectCandidates() joins those itself for every run it is given,
// and joining them twice would count every dock on the river twice.
export const DRIFT_JOIN_KINDS = ['hole', 'ledge', 'point', 'cove', 'creek_mouth', 'hump',
                                 'timber', 'shallow', 'pile', 'bridge', 'hazard'];

const DEG_LAT_M = 111320;

// ── THE CURRENT, AND WHY THE GUARD IS 2 FT ────────────────────────────────────────────────────
//
// `ampHoursBand()` in plan-water.js has resolved a current against a course since the day it was
// written, charged the component on the nose, and deliberately not floored a following current at
// zero -- which is exactly Ryan's "usage will be close to 0 if there is river current". Nobody has
// ever supplied it. `currentMph` occurs nowhere else in js/ or Worker/. This is where the supply
// starts, because the centreline is the first thing in the app that knows a cross-section.
//
// V = Q/A, and it is only as good as the charted section. On the Congaree 105 of 2,537 stations have
// no charted depth at all and 877 MORE have no charted point deeper than 2 ft -- thin chart, not a
// shallow river, on water that is 76% charted. Dividing 3,000 cfs by one of those sections returns
// 8.30 mph, which is not a river. Reading only the sections with at least two feet somewhere returns
// p10 0.60, p50 0.96, p90 2.17 mph, which is. So 2 ft is where the arithmetic stopped being
// nonsense, measured by the builder before any of this was wired -- not a number anybody liked.
const REAL_SECTION_FT = 2;
const CFS_TO_CMS = 0.0283168466;
const MS_TO_MPH = 2.2369363;

/**
 * The mean of a set of bearings, which is NOT the mean of their numbers.
 *
 * Averaging 350 and 10 arithmetically gives 180 -- a river doubling back on itself -- so the mean
 * is taken on the unit circle. Returns null when the bearings cancel, which is a reach that goes
 * nowhere on average and has no direction to report.
 */
export function meanBearingDeg(degs) {
  let x = 0, y = 0, n = 0;
  for (const d of degs) {
    if (!Number.isFinite(d)) continue;
    const r = (d * Math.PI) / 180;
    x += Math.cos(r); y += Math.sin(r); n++;
  }
  if (!n || (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12)) return null;
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * TRANSIT ON A RIVER IS RIVER MILES, AND UNTIL NOW IT WAS A STRAIGHT LINE.
 *
 * `selectCandidates()` prices the hop from the ramp to a leg and back with `o.transitM`, which
 * defaults to the straight line between two points. On a lake that is the deliberate, documented
 * choice -- it is the optimistic answer, and understating a refusal is the safe direction. On a
 * river it is not a trade-off, it is wrong: a river bends back on itself, and the straight line
 * between the ramp and a leg crosses ground.
 *
 * MEASURED ON THE LIVE APP, 2026-09-17, Congaree from Barney Jordan. The one candidate that
 * survived was priced at 11.2 km in and 14.2 km back -- straight lines -- for 5 km of fishing, so
 * the day came out 70.3 Ah of an 80 Ah budget and 364 of 540 minutes, 84% of its distance dead.
 * Meanwhile the river block in the same prompt told the model the day turns him around at 9 miles
 * up and assumes no transit at all. Two halves of one prompt describing different days.
 *
 * Ryan, on what a river day actually is: "its not like you are going to drive to a certain spot to
 * start fishing, its a kayak you just start fishing", and "up one side and down the other is
 * probably the right answer."
 *
 * SO THE TURNAROUND IS NOT IMPOSED, IT EMERGES. Nothing here bounds, filters or clips the reaches.
 * The distance is simply measured along the channel the boat has to follow, and the battery and
 * window gates that already exist then reject what he cannot reach -- which is what they are for.
 * A bound would have been a second gate saying the same thing in a different place.
 *
 * `Math.max(straight, along)` AND NO THRESHOLD. A point that is not on this channel projects onto
 * some station anyway, and its along-river distance is then meaningless -- but it can never be
 * nearer than the straight line, so the max is honest for both cases and needs no "is this point on
 * the river" cutoff, which would be a number nobody measured.
 *
 * @param {object} centrelineFc  the pack's centreline.geojson
 * @returns {?function} (aLonLat, bLonLat) => metres, or null when there is no usable centreline
 */
export function centrelineTransit(centrelineFc) {
  const feat = centrelineFc && centrelineFc.features && centrelineFc.features[0];
  const line = feat && feat.geometry && feat.geometry.coordinates;
  const p = (feat && feat.properties) || {};
  const stationM = p.station_m || [];
  const n = Math.min(Array.isArray(line) ? line.length : 0, stationM.length);
  if (n < 2) return null;

  // ── COARSE THEN FINE, AND REFINING AROUND ONE COARSE WINNER IS WRONG ON A RIVER ───────────────
  //
  // This is called twice per window and there are thousands of windows, so a full scan of 2,537
  // stations per lookup is not free. But the obvious coarse-then-fine -- take the best coarse
  // sample, refine around it -- FAILS ON EXACTLY THE SHAPE A RIVER IS. A hairpin brings two arms
  // within a couple of hundred metres of each other, the nearest coarse sample lands on the WRONG
  // ARM, and the refine never leaves it. The test caught it on a 4 km hairpin: a point 2,450 m
  // along resolved to 5,600 m, on the way back.
  //
  // THE BOUND IS DERIVED, NOT PICKED. With a coarse step of K stations at spacing s, the nearest
  // coarse sample to the true best station is at most (K/2)·s further along the line, so its
  // straight-line distance can exceed the true best's by at most K·s. Every coarse sample within
  // that of the coarse winner is therefore a candidate for containing the true nearest station,
  // and all of them are refined. On a river that is a handful of arms, not the whole line.
  const COARSE = 20;
  const spacing = Math.abs(Number(stationM[1]) - Number(stationM[0])) || 50;
  const SLACK = COARSE * spacing;
  const cache = new Map();
  const riverMetreAt = (pt) => {
    if (!Array.isArray(pt) || pt.length < 2) return null;
    const key = `${pt[0].toFixed(5)},${pt[1].toFixed(5)}`;
    if (cache.has(key)) return cache.get(key);
    const coarse = [];
    let cBest = Infinity;
    for (let i = 0; i < n; i += COARSE) {
      const d = metresBetween(line[i], pt);
      coarse.push([i, d]);
      if (d < cBest) cBest = d;
    }
    let bi = 0, bd = Infinity;
    for (const [i, d] of coarse) {
      if (d > cBest + SLACK) continue;
      for (let j = Math.max(0, i - COARSE); j < Math.min(n, i + COARSE + 1); j++) {
        const dj = metresBetween(line[j], pt);
        if (dj < bd) { bd = dj; bi = j; }
      }
    }
    const out = Number(stationM[bi]);
    const val = Number.isFinite(out) ? out : null;
    cache.set(key, val);
    return val;
  };

  const transit = (a, b) => {
    const straight = (Array.isArray(a) && Array.isArray(b)) ? metresBetween(a, b) : 0;
    const ma = riverMetreAt(a), mb = riverMetreAt(b);
    if (ma == null || mb == null) return straight;
    return Math.max(straight, Math.abs(ma - mb));
  };
  // WHERE A POINT IS ON THE RIVER, not just how far it is from another one. The ramp's station is
  // what anchors the day's reaches (see riverDriftRuns), and it is the SAME projection, with the
  // SAME hairpin-proof coarse pass and the same cache -- attached to the closure rather than
  // exported separately, because a second projector is a second answer to "where on the river is
  // this", and the two would come apart the first time either was tuned.
  transit.stationAt = riverMetreAt;
  return transit;
}

/**
 * THE DAY'S CURRENT, FROM THE REACHES THAT HAVE ONE.
 *
 * A day-level figure for the prompt, which has asked "how much of the trolling speed is the river
 * rather than the motor" since it was written with nothing but a raw discharge to answer it.
 *
 * THE MEDIAN, AND THE SUPPORT BESIDE IT. The current varies seven-fold along one river at a single
 * discharge, so one number cannot describe a river and this one does not pretend to -- `n of ofN`
 * says how many reaches could be measured at all, and the basis says why the rest could not. A
 * consumer that wants per-reach numbers has them on each drift.
 */
export function driftCurrentSummary(drifts) {
  const v = [];
  let measuredBasis = null, unmeasuredBasis = null;
  const list = Array.isArray(drifts) ? drifts : [];
  for (const d of list) {
    const p = (d && d.properties) || {};
    const c = Number(p.current_mph);
    if (Number.isFinite(c)) { v.push(c); if (!measuredBasis) measuredBasis = p.current_basis || null; }
    else if (!unmeasuredBasis) unmeasuredBasis = p.current_basis || null;
  }
  if (!list.length) return null;
  v.sort((a, b) => a - b);
  const medianMph = v.length
    ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2)
    : null;
  return {
    medianMph: medianMph == null ? null : Number(medianMph.toFixed(2)),
    n: v.length,
    ofN: list.length,
    // The reason travels with the absence, as it does on every drift.
    basis: v.length ? measuredBasis : unmeasuredBasis,
  };
}

/** A point `dxM` east and `dyM` north of [lon, lat]. Flat enough over a channel width. */
function shift(lon, lat, dxM, dyM) {
  const mPerDegLon = DEG_LAT_M * Math.cos((lat * Math.PI) / 180);
  return [lon + dxM / (mPerDegLon || DEG_LAT_M), lat + dyM / DEG_LAT_M];
}

/**
 * A point `offM` to the RIGHT of a station, looking downstream.
 *
 * `bearing_deg` is the downstream bearing, degrees clockwise from north. Right of it is
 * bearing + 90; a negative `offM` therefore lands left. Left and right are named looking
 * downstream, which is the convention the builder stamped `bend_side` and `tributaries[].side`
 * with, so the three agree.
 */
export function offsetPoint(lon, lat, bearingDeg, offM) {
  const rad = ((bearingDeg + 90) * Math.PI) / 180;
  return shift(lon, lat, offM * Math.sin(rad), offM * Math.cos(rad));
}

/** Which column of `depth_profile_ft` a lateral fraction reads. */
export function profileIndexFor(fractions, frac) {
  if (!Array.isArray(fractions) || !fractions.length) return -1;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < fractions.length; i++) {
    const d = Math.abs(Number(fractions[i]) - frac);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * THE ONE PATH THROUGH THE RAMP, CUT INTO LEGS.
 *
 * A RIVER DAY IS ONE PATH, NOT A SET OF LEGS TO CHOOSE BETWEEN. Ryan, 2026-09-17: "up one side and
 * down the other is probably the right answer... that is probably the easiest." He launches, fishes
 * outward -- upstream while the battery is full, by preference -- turns, and fishes back to the
 * ramp. There is no driving to a spot: "its a kayak you just start fishing."
 *
 * SO THE REACHES ARE ANCHORED AT THE RAMP AND CONTIGUOUS. They are laid out from his launch
 * outward, each `maxM` long -- the ceiling selectCandidates already applies to a leg -- butted end
 * to end in both directions, so every candidate is a PIECE OF THE ONE PATH and the transit between
 * two consecutive ones is zero. Before this they were laid on a fixed grid from station 0 with a
 * `maxM / 2` stride, which is 126 km of Congaree cut into 96 overlapping options with no relation
 * to where the boat starts. The 2026-09-17 bench is what that produces: five candidates, three of
 * them the same eight kilometres of river at three lateral positions, all five fished, 731 minutes
 * against a 540 minute window.
 *
 * THE STRIDE IS `maxM` AND NOT `maxM / 2` FOR THE SAME REASON. Overlapping reaches existed to give
 * a ranker choices over one piece of water; a path has no choices to offer, and two halves of one
 * pass are not two legs.
 *
 * THE TURNAROUND IS STILL NOT IMPOSED HERE. Reaches run to both ends of the centreline and the
 * battery and window gates in selectCandidates reject what he cannot reach -- see centrelineTransit
 * above, which says the same thing about the same question. A bound here would be a second gate
 * saying it in a different place, and it would have to know a current this function has not
 * measured yet.
 *
 * WHAT IS DELIBERATELY ABSENT FROM THE PROPERTIES. `fitted` is not set, because the fitter never
 * saw these lines and a batch may not assert a field it did not compute -- and because
 * selectCandidates derives `fittedAvailable` from the array it is handed, a set containing only
 * drifts switches that gate off by itself rather than by being lied to. `routable` is not set
 * either: the field means the water graph could route this, the graph was never asked, and on a
 * river it should not be -- the charted water's own continuity is 88-99% with no land test at all,
 * and it was the lane routing that was discontinuous, not the river. `depth_ft` is absent because
 * there is no contour behind a drift; the depth comes from the chart, below, or not at all.
 *
 * @param {object} centrelineFc  the pack's centreline.geojson -- one LineString whose properties
 *                               carry parallel per-station arrays
 * @param {object} o
 * @param {object} [o.structures] structureIndex(...) -- without it the lines come back with an
 *                               empty `near[]`, which means every one of them scores zero and
 *                               selectCandidates rejects the lot as scoreless. Say so rather than
 *                               returning legs over water nothing was ever checked against.
 * @param {number} [o.maxM]      the leg ceiling, matched to selectCandidates' own default
 * @param {number} [o.maxOffM]   how far off the line a feature can be and still be on the way, and
 *                               the corridor lateralsFor() decides the number of lines on
 * @param {number} [o.rampStationM] where he launches, as a station on this centreline --
 *                               `centrelineTransit(fc).stationAt(ramp)`. Without it the reaches
 *                               fall back to the whole river from station 0, which is a river with
 *                               no day on it: every caller that is planning has a ramp.
 * @param {string[]} [o.kinds]   which pack kinds to join
 * @param {object[]} [o.laterals] override the lines lateralsFor() would choose, for tests
 * @returns {object[]} GeoJSON LineString features, shaped like trolling_runs.geojson entries
 */
/**
 * THE DAY'S REACHES, BUTTED END TO END AND WALKING OUTWARD FROM THE RAMP.
 *
 * Returns `[startM, endM]` pairs covering the whole centreline, ordered nearest-the-ramp-first in
 * each direction -- upstream first, because that is the half of the day he fishes first and the
 * order the reaches are offered in is the order they read in.
 *
 * Station increases DOWNSTREAM (3DHP's `flowdirection` sets vertex order), so upstream of the ramp
 * is the lower stations. That is the only place in this function a direction is decided, and it is
 * decided from the builder's convention rather than from a bearing.
 */
function reachesFromRamp(totalM, maxM, rampStationM) {
  const out = [];
  if (!(totalM > 0) || !(maxM > 0)) return out;
  const r = Number(rampStationM);
  if (!Number.isFinite(r)) {
    for (let a = 0; a < totalM; a += maxM) out.push([a, Math.min(totalM, a + maxM), null]);
    return out;
  }
  const ramp = Math.min(Math.max(r, 0), totalM);
  for (let e = ramp; e > 0; e -= maxM) {
    out.push([Math.max(0, e - maxM), e, { direction: 'upstream', m: Math.round(ramp - e) }]);
  }
  for (let a = ramp; a < totalM; a += maxM) {
    out.push([a, Math.min(totalM, a + maxM), { direction: 'downstream', m: Math.round(a - ramp) }]);
  }
  return out;
}

export function riverDriftRuns(centrelineFc, o = {}) {
  const feat = centrelineFc && centrelineFc.features && centrelineFc.features[0];
  const line = feat && feat.geometry && feat.geometry.coordinates;
  const p = (feat && feat.properties) || {};
  if (!Array.isArray(line) || line.length < 2) return [];

  const stationM = p.station_m || [];
  const bearing = p.bearing_deg || [];
  const width = p.width_m || [];
  const profiles = p.depth_profile_ft || [];
  const fractions = p.profile_fractions || [];
  const areaM2 = p.area_m2 || [];
  const deepest = p.deepest_line_ft || [];
  const n = Math.min(line.length, stationM.length, bearing.length, width.length);
  if (n < 2) return [];

  const maxM = o.maxM ?? 8000;
  const maxOffM = o.maxOffM ?? 100;
  const kinds = o.kinds || DRIFT_JOIN_KINDS;
  const slug = p.slug || o.slug || 'river';
  const totalM = Number(p.length_m) || stationM[n - 1] || 0;
  // ONE LINE OR TWO, DECIDED BY THE CORRIDOR AGAINST THIS RIVER'S OWN WIDTH -- see lateralsFor().
  // Overridable for tests, which is the only caller that should be naming positions by hand.
  const laterals = o.laterals || lateralsFor(medianWidthM(width), maxOffM);
  const reaches = reachesFromRamp(totalM, maxM, o.rampStationM);

  const out = [];
  for (const lat of laterals) {
    const col = profileIndexFor(fractions, lat.frac);
    for (const [reachStart, reachEnd, fromRamp] of reaches) {
      const coords = [];
      const depths = [];
      const bearings = [];
      const areas = [];
      let charted = 0, stations = 0;
      for (let i = 0; i < n; i++) {
        const sm = Number(stationM[i]);
        if (!(sm >= reachStart && sm <= reachEnd)) continue;
        const w = Number(width[i]);
        const offM = Number.isFinite(w) ? (lat.frac - 0.5) * w : 0;
        coords.push(offsetPoint(line[i][0], line[i][1], Number(bearing[i]) || 0, offM));
        bearings.push(Number(bearing[i]));
        stations++;
        // ONLY A SECTION WITH REAL DEPTH IN IT MAY DIVIDE A DISCHARGE. `deepest_line_ft` is the
        // guard the builder left for exactly this, and a station that fails it is left out of the
        // area rather than dragged into an average where it inflates the velocity.
        const a = Number(areaM2[i]);
        const dl = Number(deepest[i]);
        if (Number.isFinite(a) && a > 0 && Number.isFinite(dl) && dl >= REAL_SECTION_FT) {
          areas.push(a);
        }
        // A NULL HERE IS AN UNCHARTED STATION, NOT SHALLOW WATER. On the Congaree 105 of 2,537
        // stations have no charted depth at all and 877 more have nothing deeper than 2 ft on a
        // river that is 76% charted. Storing a 1 for those would be the `0 ft relief` defect --
        // a missing measurement wearing the clothes of a real one -- so they are counted as
        // uncharted and left out of the mean.
        const row = col >= 0 ? profiles[i] : null;
        const d = Array.isArray(row) ? Number(row[col]) : NaN;
        if (Number.isFinite(d) && d > 0) { depths.push(d); charted++; }
      }
      if (coords.length < 2) continue;
      const cum = cumulative(coords);
      const lengthM = cum[cum.length - 1];
      if (!(lengthM > 0)) continue;

      const near = o.structures
        ? kinds.flatMap((k) => kindHits(coords, cum, o.structures, maxOffM, k))
        : [];

      const props = {
        id: `${slug}:drift:${lat.key}@${Math.round(reachStart)}`,
        slug,
        // What this leg IS, in the vocabulary he used. Carried so the prompt and the card can say
        // "quarter-left, downstream, past three holes" instead of naming a contour that does not
        // exist on moving water.
        drift: { side: lat.key, label: lat.label, frac: lat.frac },
        reachFromM: Math.round(reachStart),
        // WHICH HALF OF THE DAY THIS IS, IN WORDS AND NOT A SIGN. The model is told to fish upstream
        // first and had no way to tell which leg was upstream: `flow_deg` says where the water goes,
        // not which side of the launch a reach is on. `{direction, m}` -- m being river metres from
        // the ramp to the NEAR end of the reach -- because a signed distance is the convention this
        // project keeps getting backwards, and there is nothing to get backwards about a word.
        // Absent when the caller gave no ramp, which is a river with no day laid out on it.
        ...(fromRamp ? { from_ramp: fromRamp } : {}),
        length_m: Number(lengthM.toFixed(1)),
        near,
        // The stations on this drift that the chart can answer for. Reported beside the depth
        // rather than folded into it, so a thinly charted reach reads as thinly charted.
        charted_stations: charted,
        stations,
        charted_frac: stations ? Number((charted / stations).toFixed(3)) : 0,
      };
      // MEASURED OR ABSENT. `mean_depth_ft` is the name passWaterFt() treats as measured, and on a
      // drift it genuinely is -- the depth along the path travelled, sampled off the chart every
      // 50 m at this lateral position. Where no station on the reach has a charted depth at this
      // position the field is omitted, eligibleForHolding() answers "no charted depth", and the
      // reach is counted in the depth bucket instead of being offered with a number nobody
      // measured.
      if (depths.length) {
        props.mean_depth_ft = Number((depths.reduce((a, b) => a + b, 0) / depths.length).toFixed(1));
        props.shallowest_ft = Math.min(...depths);
        props.deepest_ft = Math.max(...depths);
      }

      // ── WHICH WAY THE WATER IS GOING, AND HOW FAST ────────────────────────────────────────────
      //
      // The bearing is free -- 3DHP's `flowdirection` means vertex order is downstream, so the
      // builder's per-station bearing already points the way the water goes. Until now not one line
      // of js/ or Worker/ carried a flow direction at all; `upstream` and `downstream` appear 164
      // times and every one is a dam chain, a gauge chain or prose.
      //
      // AND THE REASON TRAVELS WITH THE ABSENCE. `current_basis` is always set, because "we asked
      // and the chart cannot answer" and "nobody asked" are different claims and a null with no
      // reason beside it is the hole a model fills from its own recall.
      const meanBearing = meanBearingDeg(bearings);
      if (meanBearing != null) props.flow_deg = Number(meanBearing.toFixed(1));
      const cfs = Number(o.flowCfs);
      if (o.tidal) {
        // Eleven of the 57 carry a NOAA tide station and their current REVERSES. An instantaneous
        // discharge is not the flow there, and Q/A does not describe it at all.
        props.current_basis = 'tidal — the current reverses here, so Q/A does not describe it';
      } else if (!Number.isFinite(cfs)) {
        props.current_basis = 'no discharge reading for this water';
      } else if (!areas.length) {
        props.current_basis = `no station on this reach has ${REAL_SECTION_FT} ft or more of charted `
                            + 'section, so there is nothing honest to divide the discharge by';
      } else {
        // PER STATION, THEN THE MEDIAN — not the discharge over a mean section.
        //
        // The two are not the same and the difference is not academic. Measured on the Congaree, a
        // reach can carry 2 supported stations out of 161, and an area averaged from two sections is
        // one number wearing a reach's clothes. The median of the per-station velocities is also the
        // statistic FOUR_THINGS_A_RIVER_DAY_HAS_TO_TELL_HIM measured this river with, so computing it
        // the same way means this wiring can be CHECKED against that measurement instead of merely
        // believed — and it reproduces it exactly: p10 0.60, p50 0.96, p90 2.17 mph at 3,000 cfs.
        const v = areas.map((a) => (cfs * CFS_TO_CMS / a) * MS_TO_MPH).sort((x, y) => x - y);
        const mid = v.length % 2
          ? v[(v.length - 1) / 2]
          : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
        props.current_mph = Number(mid.toFixed(2));
        // THERE IS ONE ANGLE HERE AND IT IS `flow_deg`, WHICH IS WHERE THE WATER IS GOING.
        //
        // The first version also emitted `current_deg` set to the same value, which was a trap:
        // `headwindMph()` follows the meteorological convention and wants the direction a flow comes
        // FROM, so a field named for a current and holding a heading it is going TO is 180 degrees
        // wrong the first time somebody passes it straight through. Two names for one angle with
        // opposite meanings is the defect this project keeps finding, so there is one name, it means
        // the plain-English thing, and the conversion happens at the point of use with a note on it.
        // See the cost in plan-candidates.js.
        props.current_area_m2 = Number((areas.reduce((a, b) => a + b, 0) / areas.length).toFixed(1));
        // HOW MUCH OF THE REACH IS BEHIND THAT NUMBER, as a field and not only as prose. A velocity
        // from 2 of 161 stations and one from 150 of 161 deserve different amounts of trust, and NO
        // THRESHOLD IS INVENTED HERE — whoever consumes it picks, which is the same rule the bend
        // radius follows. What is not acceptable is offering the number with the support invisible.
        props.current_stations = areas.length;
        props.current_frac = Number((areas.length / Math.max(1, stations)).toFixed(3));
        props.current_basis = `Q/A — median of ${areas.length} station velocities at `
                            + `${Math.round(cfs).toLocaleString()} ft3/s, ${areas.length} of `
                            + `${stations} stations carrying ${REAL_SECTION_FT} ft or more of `
                            + 'charted section';
      }
      out.push({ type: 'Feature',
                 geometry: { type: 'LineString', coordinates: coords },
                 properties: props });
    }
  }
  return out;
}
