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
import { buildPieces, joinsFor, followBar, joinedPiece } from '../js/modules/plan-pieces.js';

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


describe('a join taken is a PIECE, because nothing downstream should learn a new thing', () => {
  // legFrom(), waterBand(), optionality(), depthCues(), the strip chart and the GPX all read a
  // piece. A joined run is not a new kind of object, it is a longer piece of water -- "blue and
  // purple to me are pretty much one line".
  const lanes = () => [lane('a', 30, 40, 0), lane('b', 30, 40, 40 * STEP + 200)];
  const taken = (ls = lanes(), depth = 30) => {
    const pieces = build(ls);
    const j = joinsFor(pieces, { depthAt: flat(depth), clearFt: 2, bar: 10, minM: 600,
                                 depths: DEPTHS })[0];
    return { pieces, j, piece: joinedPiece(pieces, j) };
  };

  it('the geometry and the profile agree on how long the run is', () => {
    // The property every reader that walks one against the other depends on, and the one whose
    // absence put a shoal warning 13 m into a leg trimmed to avoid that shoal.
    const { piece } = taken();
    expect((piece.envelope.length - 1) * piece.envelopeStepM).toBe(piece.lengthM);
    expect(piece.envelopeLine.length).toBe(piece.envelope.length);
    expect(piece.envelopeDeep.length).toBe(piece.envelope.length);
  });

  it('names both halves, so a warning about it can be found', () => {
    const { pieces, piece } = taken();
    expect(piece.runId).toBe(`${pieces[0].runId}+${pieces[1].runId}`);
    expect(piece.joinedFrom.length).toBe(2);
  });

  it('quotes only the depths that run the WHOLE thing', () => {
    const { piece } = taken();
    // Every offer has to cover the run; a curve quoting the longest fragment reads like a
    // promise about the run and is about half of it.
    expect(piece.offers.length > 0).toBe(true);
    for (const o of piece.offers) expect(o.lengthM >= piece.lengthM - piece.envelopeStepM).toBe(true);
    expect(Math.max(...piece.offers.map((o) => o.depthFt))).toBe(piece.holdsFt);
  });

  it('a hole in the survey is not a join at all, however small', () => {
    // Not "a lower chartedFrac" -- reachCurve breaks a run on an uncharted station, so one
    // unsounded patch anywhere in the gap means no single bait runs the whole thing and there is
    // nothing to offer. -1 is not zero and not "probably deep"; it ends the stretch, same as a
    // shoal. This is also why a joined piece's own stations are always charted, and why
    // `chartedFrac` on it is inherited rather than recounted.
    const hole = [east(40 * STEP + 80), east(40 * STEP + 130)];
    const patchy = (pt) => (pt[0] > hole[0] && pt[0] < hole[1] ? null : 30);
    const pieces = build(lanes());
    expect(joinsFor(pieces, { depthAt: patchy, clearFt: 2, bar: 10, minM: 600,
                              depths: DEPTHS }).length).toBe(0);
    // and the same pair joins the moment the survey covers it
    expect(joinsFor(pieces, { depthAt: flat(30), clearFt: 2, bar: 10, minM: 600,
                              depths: DEPTHS }).length).toBe(1);
  });

  it('inherits the weaker half\'s charted fraction rather than recounting to 1', () => {
    const ls = lanes();
    ls[0].properties.charted_frac = 0.6;
    ls[1].properties.charted_frac = 0.95;
    expect(taken(ls).piece.chartedFrac).toBe(0.6);
  });

  it('keeps `relief` only when both halves agree', () => {
    const ls = lanes();
    ls[0].properties.relief = 'channel_edge';
    ls[1].properties.relief = 'channel_edge';
    expect(taken(ls).piece.relief).toBe('channel_edge');
    ls[1].properties.relief = 'flat';
    // A channel edge joined to a flat is not a channel edge, and saying so would put a reason on
    // the card that is true of half the run.
    expect(taken(ls).piece.relief).toBe(null);
  });

  it('turns a half round with its geometry when the run enters it backwards', () => {
    // THE BUG CLASS THIS PINS. A piece joined at its START is travelled backwards, so its
    // profile has to reverse with its coordinates. Getting this wrong lands every station on the
    // wrong water -- the same fault that announced a 3 ft shoal on a leg trimmed to avoid it.
    //
    // Lane `w` sits WEST of `e`, so the run leaves `e` at its start, crosses the gap westward,
    // and meets `w` at its end. `e` is therefore reversed.
    // Rising east, and deep enough throughout that the trim keeps the whole lane -- otherwise the
    // piece is cut back to its deep end and the two are simply too far apart to join.
    const deep = Array.from({ length: 40 }, (_, k) => 30 + k);      // 30 ft rising to 69 east
    const e = lane('e', 30, 40, 0);
    e.properties.envelope_ft = deep.slice();
    e.properties.envelope_line_ft = deep.slice();
    e.properties.envelope_deep_ft = deep.slice();
    const w = lane('w', 30, 40, -(40 * STEP + 200));
    // minM spans the whole lane on purpose: with a gradient, deepestUsable() otherwise trims `e`
    // back to its deep end -- correctly -- and the two ends end up too far apart to join at all.
    const pieces = build([e, w], { clearFt: 2, minM: 1500 });
    const j = joinsFor(pieces, { depthAt: flat(30), clearFt: 2, bar: 10, minM: 1500,
                                 depths: DEPTHS })[0];
    expect(j).toBeTruthy();
    const piece = joinedPiece(pieces, j);
    // The joined run starts at whichever end the pair was walked from; whichever it is, the
    // FIRST coordinate must sit over the FIRST envelope station.
    const first = piece.coords[0][0], last = piece.coords[piece.coords.length - 1][0];
    const eastFirst = first > last;                    // travelling west
    const head = piece.envelope[0], tail = piece.envelope[piece.envelope.length - 1];
    // `e`'s deep end is its EAST end. If the run starts in the east it starts deep, and if it
    // starts in the west it ends deep. Either way the profile must not contradict the geometry.
    expect(eastFirst ? head > tail : tail > head).toBe(true);
  });

  it('takes the nearer ramp distance of the two halves', () => {
    const pieces = build(lanes(), { ramps: [{ name: 'x', lonLat: [LON, LAT] }] });
    const j = joinsFor(pieces, { depthAt: flat(30), clearFt: 2, bar: 10, minM: 600,
                                 depths: DEPTHS })[0];
    const piece = joinedPiece(pieces, j);
    expect(piece.rampM.x).toBe(Math.min(pieces[0].rampM.x, pieces[1].rampM.x));
  });
});


// A LANE THAT HOOKS INTO A DEAD END SHOULD STOP AT THE MOUTH.
//
// Ryan, on Leg 2 of a Wateree day: "the orange lane needs to either keep going past that cove it
// turns into or just stop", and on the same shape earlier: "i would never turn into the cove just
// to end the trolling run... no matter what you are pulling your lines out to get back out."
//
// Measured at that leg's exact end, 34.371333/-80.722038: the best way forward runs 400 m and the
// way back runs 1,000. Across 168 of Wateree's piece ends that ratio is 1.0 at the median, 1.0 at
// p90 and 3.1 at its worst -- so open water has the way on exactly as good as the way back, and
// four ends in the whole lake do not. Anything from about 1.5 to 2.5 picks out the same four,
// which is what a real gap looks like rather than a tuned number.
//
// THREE EARLIER VERSIONS WERE WRONG AND EACH ONE LOOKED RIGHT:
//
//   1. Rays against the SHORELINE index, counting a bearing closed if any shoreline vertex came
//      within 60 m. A lane fifty metres off a straight bank read as enclosed on every bearing
//      running alongside it, and the trim deleted a 2.68 mi piece of open water.
//   2. Omnidirectional: is water closing in on ALL sides within 240 m. That is a question about a
//      pond. A real cove mouth is wider, so it missed this leg entirely while costing 12.6 miles
//      and 11 pieces to fix one bad end.
//   3. Median of the forward arc and median of the rear arc. Ahead, one open bearing IS a way
//      out, so the arc's MAXIMUM is the question; behind, he came down the lane, so straight
//      astern is the question and a fan around it just measures how wide the cove is -- which
//      made the rule quieter the deeper in the lane ran.
//
// The version that ships costs 0.35 mi of 84.6 and takes the flagged ends from four to one.
describe('a pass stops where the lake does', () => {
  // East along open water, then north into a cove 300 m wide and 420 m deep.
  const COVE_X = 29 * STEP;
  const hook = () => {
    const n = 40, c = [];
    for (let k = 0; k < 30; k++) c.push([east(k * STEP), LAT]);
    for (let k = 1; k <= 10; k++) c.push([east(COVE_X), LAT + (k * STEP) / M_LAT]);
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: c },
             properties: { id: 'p', fitted: true, depth_ft: 30, envelope_m: 25,
                           envelope_step_m: STEP, envelope_ft: Array(n).fill(30),
                           envelope_line_ft: Array(n).fill(30), envelope_deep_ft: Array(n).fill(30) } };
  };
  const inWater = (pt) => {
    const n = (pt[1] - LAT) * M_LAT, e = (pt[0] - LON) * mLon(LAT);
    if (n > 20) return Math.abs(e - COVE_X) <= 150 && n <= 420;      // the cove
    return n > -800 && e > -800 && e < 2400;                          // the lake
  };
  const len = (o) => buildPieces([hook()], { clearFt: 2, minM: 600, ...o }).pieces[0]?.lengthM;

  it('leaves the pass alone when nothing is told about the water', () => {
    expect(len({})).toBe(39 * STEP);
  });

  it('and pulls it back out of the cove when it is', () => {
    const cut = len({ inWater });
    expect(cut < 39 * STEP).toBe(true);
    expect(cut >= 600).toBe(true);            // still a pass by his own minimum
  });

  it('the geometry and the profile still agree afterwards', () => {
    const p = buildPieces([hook()], { clearFt: 2, minM: 600, inWater }).pieces[0];
    expect((p.envelope.length - 1) * p.envelopeStepM).toBe(p.lengthM);
    expect(p.envelopeLine.length).toBe(p.envelope.length);
  });

  it('never eats more than half — a lane that LIVES up an arm is water, not a mistake', () => {
    // Every direction is short here, so astern never opens and the rule cannot fire at all.
    const narrow = (pt) => Math.abs((pt[1] - LAT) * M_LAT) < 80;
    expect(len({ inWater: narrow })).toBe(39 * STEP);
  });

  it('drops the pass when what is left is under his own minimum', () => {
    expect(buildPieces([hook()], { clearFt: 2, minM: 1400, inWater }).pieces.length).toBe(0);
  });
});
