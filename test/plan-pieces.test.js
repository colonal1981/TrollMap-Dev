import { describe, it, expect } from './expect-shim.mjs';
import { reachCurve, deepestUsable, buildPieces } from '../js/modules/plan-pieces.js';

// ── THE RULE BEING TESTED ──────────────────────────────────────────────────────────────────
//
// "A route is a stretch of water you can fish without touching the rods." Everything here is
// about the one number that decides it: the shallowest water within the wander envelope, and
// whether a bait clears it for long enough to be a pass.
//
// Ryan, on why coverage percentages are the wrong answer:
//   "54% fishable for a route is not fishable at all honestly"
// so every assertion below is about the LONGEST UNBROKEN stretch, never the total.

const STEP = 40;

describe('reachCurve — how much unbroken water at each depth', () => {
  it('finds the longest continuous run, not the total', () => {
    // two usable stretches: 6 stations (200 m) and 4 stations (120 m), split by a shoal
    const env = [30, 30, 30, 30, 30, 30, 4, 4, 30, 30, 30, 30];
    const c = reachCurve(env, STEP, [20], 2);
    expect(c.get(20).lengthM).toBe(200);
  });

  it('a shoal ends the pass no matter how narrow', () => {
    const clean = reachCurve([30, 30, 30, 30, 30, 30, 30], STEP, [20], 2).get(20).lengthM;
    const nicked = reachCurve([30, 30, 30, 4, 30, 30, 30], STEP, [20], 2).get(20).lengthM;
    // one bad station halves it, because you would have to pull the rods either side of it.
    // n stations span n-1 gaps: seven clean stations are 240 m, three are 80.
    expect(clean).toBe(240);
    expect(nicked).toBe(80);
  });

  it('uncharted breaks the run — unknown is not deep', () => {
    // -1 is "nobody sounded it". Treating it as deep is how you troll a bait into a stump.
    const c = reachCurve([40, 40, 40, -1, 40, 40, 40], STEP, [20], 2);
    expect(c.get(20).lengthM).toBe(80);
  });

  it('deeper baits get less water, and the trade is readable', () => {
    const env = [45, 45, 30, 30, 30, 30, 45, 45];
    const c = reachCurve(env, STEP, [10, 20, 38], 2);
    expect(c.get(10).lengthM).toBe(280);          // everything clears a 10 ft bait
    expect(c.get(20).lengthM).toBe(280);          // still everything
    expect(c.get(38).lengthM).toBe(40);           // only the deep ends, and they are not joined
  });

  it('refuses to invent a clearance', () => {
    // How much water a bait needs under it is a fishing judgement — Ryan, on being asked for a
    // number: "wrong question claude... it is not a math equation". So there is no default.
    let threw = false;
    try { reachCurve([30, 30, 30], STEP, [10]); } catch (e) { threw = /fishing judgement/.test(e.message); }
    expect(threw).toBe(true);
  });

  it('returns nothing rather than something useless', () => {
    expect(reachCurve([5, 5, 5], STEP, [30], 2).size).toBe(0);
    expect(reachCurve([], STEP, [10], 2).size).toBe(0);
    expect(reachCurve(null, STEP, [10], 2).size).toBe(0);
  });
});

describe('deepestUsable — the question a fisherman actually asks', () => {
  it('picks the deepest bait that still makes a pass, not the longest stretch', () => {
    const c = new Map([[10, { lengthM: 3000, from: 0, to: 75 }],
                       [30, { lengthM: 900, from: 10, to: 32 }]]);
    // 10 ft carries three times the water and is still the wrong answer: he asked how deep he
    // can fish it, and 30 ft clears the bar he set.
    expect(deepestUsable(c, 600).depthFt).toBe(30);
  });

  it('respects his minimum for the day rather than a constant', () => {
    const c = new Map([[10, { lengthM: 3000, from: 0, to: 75 }],
                       [30, { lengthM: 900, from: 10, to: 32 }]]);
    expect(deepestUsable(c, 2000).depthFt).toBe(10);   // 30 ft no longer makes a pass
    expect(deepestUsable(c, 5000)).toBe(null);         // nothing does
  });
});

// A lane at `ft` deep running east, `n` stations long, offset north by `northDeg`.
function lane(id, ft, n, northDeg, chartedFt) {
  const coords = Array.from({ length: n }, (_, k) => [-80.72 + (k * STEP) / 91851.6, 34.38 + northDeg]);
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
           properties: { id, fitted: true, depth_ft: chartedFt ?? ft, envelope_m: 25,
                         envelope_step_m: STEP, envelope_ft: Array(n).fill(ft) } };
}

describe('buildPieces — lanes in, water out', () => {
  it('collapses nested contours into one piece', () => {
    // Three lanes 20 m apart. He wanders 25 m either side, so all three put the boat in the same
    // place: "i agree with you about the 14-18ft lines being basically the same route".
    const d = 20 / 110540;
    const r = buildPieces([lane('a', 30, 40, 0), lane('b', 32, 40, d), lane('c', 34, 40, 2 * d)],
                          { clearFt: 2, minM: 600 });
    expect(r.pieces.length).toBe(1);
    expect(r.pieces[0].duplicates).toBe(3);
  });

  it('the survivor is the member that offers the most', () => {
    const d = 20 / 110540;
    const r = buildPieces([lane('a', 30, 40, 0), lane('b', 44, 40, d)], { clearFt: 2, minM: 600 });
    expect(r.pieces[0].holdsFt).toBe(40);       // the deeper member, not the first one seen
  });

  it('keeps genuinely separate water separate', () => {
    // 400 m apart is not a wander, it is a different piece of shoreline.
    const r = buildPieces([lane('a', 30, 40, 0), lane('b', 30, 40, 400 / 110540)],
                          { clearFt: 2, minM: 600 });
    expect(r.pieces.length).toBe(2);
  });

  it('drops lanes that cannot make a pass at any depth, rather than shrinking the bar', () => {
    // 5 stations is 160 m. Admitting it would let stubs chain into each other — one early
    // version produced a single "piece" holding 981 members, which is most of a lake.
    const r = buildPieces([lane('a', 30, 5, 0)], { clearFt: 2, minM: 600 });
    expect(r.pieces.length).toBe(0);
    expect(r.usableCount).toBe(0);
  });

  it('ignores lanes with no envelope — unmeasured is not the same as shallow', () => {
    const bare = lane('x', 30, 40, 0);
    delete bare.properties.envelope_ft;
    expect(buildPieces([bare], { clearFt: 2, minM: 600 }).pieces.length).toBe(0);
  });

  it('carries the whole offer curve, not one depth', () => {
    const r = buildPieces([lane('a', 34, 40, 0)], { clearFt: 2, minM: 600 });
    const offers = r.pieces[0].offers;
    // the row is the trade-off, so he can see what going deeper costs in unbroken water
    expect(offers.length > 1).toBe(true);
    expect(offers[0].depthFt < offers[offers.length - 1].depthFt).toBe(true);
    expect(offers.every((o) => o.lengthM > 0)).toBe(true);
  });

  it('measures to the ramp from the nearest point of the water', () => {
    const r = buildPieces([lane('a', 30, 40, 0)],
                          { clearFt: 2, minM: 600, ramps: [{ name: 'x', lonLat: [-80.72, 34.38] }] });
    expect(r.pieces[0].rampM.x < 60).toBe(true);
  });
});

// THE ARRAYS AND THE LINE HAVE TO INDEX THE SAME WATER.
//
// `coords` is the stretch reachCurve cut; the envelope arrays used to be the whole pass. 56 of
// Wateree's 70 pieces start past station 0, so on most of them station i was not the water at
// i * stepM along the leg. depthCues() indexes exactly that way and put a "3 ft in 27 m, the
// shallowest water on this leg" warning 13 m into a piece whose own shallowest is 18 ft -- the
// shoal it had been trimmed to avoid, announced as if it were on it.
describe('the envelope is the piece, not the pass it was cut from', () => {
  // Four shallow stations, then twenty deep ones. A 20 ft bait cannot start until station 4.
  const shoaled = () => {
    const f = lane('a', 40, 24, 0);
    f.properties.envelope_ft = [3, 3, 3, 3, ...Array(20).fill(40)];
    f.properties.envelope_line_ft = [4, 4, 4, 4, ...Array(20).fill(42)];
    f.properties.envelope_deep_ft = [5, 5, 5, 5, ...Array(20).fill(45)];
    return f;
  };

  it('drops the stations the piece does not cross', () => {
    const p = buildPieces([shoaled()], { clearFt: 2, minM: 600 }).pieces[0];
    expect(p.envelope.length).toBe(20);
    expect(Math.min(...p.envelope)).toBe(40);      // not 3 -- that shoal is off this piece
    expect(p.envelopeLine.length).toBe(20);
    expect(p.envelopeDeep.length).toBe(20);
  });

  it('so station i is the water i * stepM along the leg', () => {
    const p = buildPieces([shoaled()], { clearFt: 2, minM: 600 }).pieces[0];
    // The geometry and the profile agree on how long this piece is, which is the property every
    // reader that walks one against the other was relying on and not getting.
    expect((p.envelope.length - 1) * p.envelopeStepM).toBe(p.lengthM);
  });

  it('and the band is measured on those stations too', () => {
    const p = buildPieces([shoaled()], { clearFt: 2, minM: 600 }).pieces[0];
    expect(p.water.line).toEqual({ minFt: 42, medianFt: 42, maxFt: 42 });
    expect(p.water.side.minFt).toBe(40);
  });
});
