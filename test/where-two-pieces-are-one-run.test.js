// WHERE TWO PIECES ARE ONE RUN.
//
// Ryan, looking at three legs the app had drawn across water he fishes as a single line:
//
//   > blue and purple to me are pretty much one line / see how i routed around that shallow spot
//   > and combined the 2 lines... that is how i would fish that
//
// and on why they came out stubby in the first place: "the trolling runs don't really make
// sense... they are still too short and stubby and do not link where they should".
//
// A piece ends where reachCurve ran out of water for the bait, not where the fishing ends. This
// is the pass that puts them back together, and every rule in it is either his or the pack's:
//
//   the turn    followBar() -- the sharpest bend the FITTING already leaves inside a lane it
//               calls followable. Not an angle anybody picked.
//   the gap     no longer than `minM`, HIS number for the day.
//   the bait    one bait, unbroken, the whole way. Asked on 2026-08-30 whether a depth change
//               across a join makes it two runs: "One run only if one bait covers it."
//
// AND NOTHING ABOUT "OPEN WATER", because he took that phrase apart: "when fish are suspended
// there is no such thing as open water... if fish are hugging bottom or i am fishing for catfish
// that hug bottom then that might mean something... so the fisherman's answer is that it
// depends." It depends on `holding`, so the bait depths worth testing come IN from the caller and
// the floor is REPORTED rather than judged.
import { describe, it, expect } from './expect-shim.mjs';
import { buildPieces, joinsFor, followBar } from '../js/modules/plan-pieces.js';

const STEP = 40;
const M_LAT = 110540, mLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);
const LAT = 34.38, LON = -80.72;
const east = (m) => LON + m / mLon(LAT);

/** A straight lane running east, `n` stations of `ft` water, starting `fromM` east of LON. */
function lane(id, ft, n, fromM = 0, north = 0) {
  const coords = Array.from({ length: n }, (_, k) => [east(fromM + k * STEP), LAT + north]);
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
           properties: { id, fitted: true, depth_ft: ft, envelope_m: 25, envelope_step_m: STEP,
                         envelope_ft: Array(n).fill(ft),
                         envelope_line_ft: Array(n).fill(ft),
                         envelope_deep_ft: Array(n).fill(ft) } };
}
/** A sounder that says the same thing everywhere, or nothing at all. */
const flat = (ft) => () => ft;
const DEPTHS = Array.from({ length: 18 }, (_, i) => 6 + i * 2);
const build = (lanes, o = {}) => buildPieces(lanes, { clearFt: 2, minM: 600, ...o }).pieces;

describe('the follow bar comes off the pack, not off a preference', () => {
  it('a dead straight lane sets it at zero', () => {
    expect(followBar([lane('a', 30, 40)], STEP)).toBe(0);
  });

  it('and a bend in a fitted lane raises it to that bend', () => {
    const f = lane('a', 30, 20);
    // turn the back half 90 degrees north
    const c = f.geometry.coordinates;
    for (let i = 10; i < c.length; i++) c[i] = [c[9][0], LAT + ((i - 9) * STEP) / M_LAT];
    // Not 90: the metric is degrees per 80 m of TRAVEL, and 80 m of travel straddles the corner
    // rather than sitting on it. That is the quantity a junction is compared against, so the
    // corner reading the same way on both sides of the comparison is the point.
    const b = followBar([f], STEP);
    expect(b > 30).toBe(true);
    expect(b <= 90).toBe(true);
  });

  it('an unfitted lane does not get a vote', () => {
    const f = lane('a', 30, 20);
    f.properties.fitted = false;
    const c = f.geometry.coordinates;
    for (let i = 10; i < c.length; i++) c[i] = [c[9][0], LAT + ((i - 9) * STEP) / M_LAT];
    expect(followBar([f], STEP)).toBe(0);
  });
});

describe('joining two pieces of the same line', () => {
  // Two 40-station lanes in 30 ft, 200 m of 30 ft water between them, dead straight.
  const lanes = () => [lane('a', 30, 40, 0), lane('b', 30, 40, 40 * STEP + 200)];

  it('finds the join and reports the whole run, not the two halves', () => {
    const pieces = build(lanes());
    expect(pieces.length).toBe(2);
    const j = joinsFor(pieces, { depthAt: flat(30), clearFt: 2, bar: 10, minM: 600, depths: DEPTHS });
    expect(j.length).toBe(1);
    // The gap is between the PIECES, which are trimmed lanes -- stretchCoords drops the stations
    // outside the reach, so it is not the 200 m between the lanes' own ends.
    const a = pieces[0].coords[pieces[0].coords.length - 1], b = pieces[1].coords[0];
    const between = Math.round(Math.hypot((a[0] - b[0]) * mLon(LAT), (a[1] - b[1]) * M_LAT));
    expect(j[0].gapM).toBe(between);
    expect(j[0].turnDeg).toBe(0);
    expect(j[0].lengthM > pieces[0].lengthM + pieces[1].lengthM).toBe(true);
  });

  it('carries the bait that runs the WHOLE thing, not the best part of it', () => {
    // 30 ft of water with 2 ft of clearance: 28 ft is the deepest bait that clears throughout.
    const j = joinsFor(build(lanes()), { depthAt: flat(30), clearFt: 2, bar: 10, minM: 600,
                                         depths: DEPTHS })[0];
    expect(j.baitFt).toBe(28);
  });

  it('refuses when the gap will not carry the bait the two lanes carry', () => {
    // The lanes are 30 ft; the water between them is 8. His rule: "touching bottom in 1 place
    // means i dont have that lure anymore", and "One run only if one bait covers it."
    const j = joinsFor(build(lanes()), { depthAt: flat(8), clearFt: 2, bar: 10, minM: 600,
                                         depths: [20, 22, 24] });
    expect(j.length).toBe(0);
    // and a bait small enough for the shoal joins them, because then it IS one run
    const ok = joinsFor(build(lanes()), { depthAt: flat(8), clearFt: 2, bar: 10, minM: 600,
                                          depths: [6] });
    expect(ok.length).toBe(1);
    expect(ok[0].baitFt).toBe(6);
  });

  it('reports the floor and judges nothing about it', () => {
    // A suspended day does not care that the floor moves; a bottom day cares about nothing else.
    // So this is a measurement on the way out, not a filter on the way in.
    const j = joinsFor(build(lanes()), { depthAt: flat(12), clearFt: 2, bar: 10, minM: 600,
                                         depths: [6, 8] })[0];
    expect(j.floorFt.minFt).toBe(12);      // the gap
    expect(j.floorFt.maxFt).toBe(30);      // the lanes
    expect(j.baitFt).toBe(8);
  });

  it('holds the gap to HIS minM rather than a distance of mine', () => {
    const far = [lane('a', 30, 40, 0), lane('b', 30, 40, 40 * STEP + 900)];
    const o = { depthAt: flat(30), clearFt: 2, bar: 10, depths: DEPTHS };
    expect(joinsFor(build(far, { minM: 600 }), { ...o, minM: 600 }).length).toBe(0);
    expect(joinsFor(build(far, { minM: 600 }), { ...o, minM: 1200 }).length).toBe(1);
  });

  it('says nothing about a gap nobody sounded', () => {
    // -1 is uncharted and it is not zero and not "probably deep". reachCurve breaks the run on it,
    // so an unsurveyed gap simply is not a join.
    const j = joinsFor(build(lanes()), { depthAt: () => null, clearFt: 2, bar: 10, minM: 600,
                                         depths: DEPTHS });
    expect(j.length).toBe(0);
  });
});

describe('the turn is at the junction, not averaged over the gap', () => {
  // THE BUG THIS PINS. The first cut divided the junction angle by the gap's length to get a rate,
  // which meant a long gap divided any angle down to nothing -- a 90 degree corner met at the end
  // of a kilometre of straight line came out at 3 degrees per 80 m and passed. The boat turns
  // where the lane meets the gap; the length of the gap does not soften it.
  const across = () => {
    const a = lane('a', 30, 40, 0);
    // b runs NORTH, starting 200 m east of a's end -- so meeting it is a square corner
    const x = east(40 * STEP + 200);
    const b = { type: 'Feature',
      geometry: { type: 'LineString',
                  coordinates: Array.from({ length: 40 }, (_, k) => [x, LAT + (k * STEP) / M_LAT]) },
      properties: { id: 'b', fitted: true, depth_ft: 30, envelope_m: 25, envelope_step_m: STEP,
                    envelope_ft: Array(40).fill(30), envelope_line_ft: Array(40).fill(30),
                    envelope_deep_ft: Array(40).fill(30) } };
    return [a, b];
  };

  it('a square corner is refused however long the gap is', () => {
    const j = joinsFor(build(across()), { depthAt: flat(30), clearFt: 2, bar: 42.4, minM: 1200,
                                          depths: DEPTHS });
    expect(j.length).toBe(0);
  });

  it('and the same pair joins once the bar is wide enough to allow the corner', () => {
    const j = joinsFor(build(across()), { depthAt: flat(30), clearFt: 2, bar: 90, minM: 1200,
                                          depths: DEPTHS });
    expect(j.length).toBe(1);
    expect(j[0].turnDeg > 42.4).toBe(true);
  });
});

describe('it refuses to invent the things it is not given', () => {
  const pieces = () => build([lane('a', 30, 40, 0), lane('b', 30, 40, 40 * STEP + 200)]);
  const throws = (o) => { try { joinsFor(pieces(), o); return null; } catch (e) { return e.message; } };

  it('will not guess a clearance, a sounder or a follow bar', () => {
    expect(/depthAt/.test(throws({ clearFt: 2, bar: 10 }))).toBe(true);
    expect(/clearFt/.test(throws({ depthAt: flat(30), bar: 10 }))).toBe(true);
    expect(/bar/.test(throws({ depthAt: flat(30), clearFt: 2 }))).toBe(true);
  });
});
