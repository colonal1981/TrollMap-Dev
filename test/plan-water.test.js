import { describe, it, expect } from './expect-shim.mjs';
import {
  depthLadder, optionality, ladderPartners, reasons, dayCost, offerWater,
} from '../js/modules/plan-water.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS FOR
//
// "the purpose of the plan is to find fish" — so this does not pick water, it OFFERS water with
// the reasons written out and lets Ryan choose. Every test below is about one of the two things
// the first version of this module got wrong, or about the one number that is allowed to say no.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const STEP = 40;

/** A lane running east at `ft` deep, `n` stations long, offset north by `northDeg`. */
function lane(id, ft, n, northDeg = 0, opts = {}) {
  const coords = Array.from({ length: n }, (_, k) => [-80.72 + (k * STEP) / 91851.6, 34.38 + northDeg]);
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
           properties: { id, fitted: true, depth_ft: ft, envelope_m: 25, envelope_step_m: STEP,
                         envelope_ft: Array(n).fill(ft),
                         envelope_deep_ft: Array(n).fill(opts.deepFt ?? ft),
                         envelope_line_ft: Array(n).fill(opts.lineFt ?? ft),
                         ...opts.props } };
}

describe('depthLadder — the axis is water depth, not bait depth', () => {
  it('spans the fish band with room either side to be wrong', () => {
    const l = depthLadder([20, 30]);
    expect(l[0] <= 12).toBe(true);
    expect(l[l.length - 1] >= 38).toBe(true);
    expect(l.every((d, i) => i === 0 || d - l[i - 1] === 2)).toBe(true);
  });

  it('never offers a depth of zero', () => {
    // A band starting at 1 ft would pad to -7 without the floor, and "water at least -7 ft deep"
    // is not a thing a chart can answer.
    expect(depthLadder([1, 4])[0] > 0).toBe(true);
  });
});

describe('optionality — the offer curve is monotone and does not measure laps', () => {
  it('reads the corridor, not the curve', () => {
    // THE BUG THIS PINS: the first version read the offer curve and reported "6-18 ft available,
    // about 4 laps". Water at least 18 ft deep is ALSO water at least 6 ft deep, so that span was
    // the same lane counted seven times. The corridor is what actually holds depth, and the
    // pipeline stamps both its sides.
    const p = { envelope: [20, 20, 21], envelopeDeep: [24, 24, 25], offers: [
      { depthFt: 6, lengthM: 3360 }, { depthFt: 12, lengthM: 3200 }, { depthFt: 18, lengthM: 3000 }] };
    const o = optionality(p);
    expect(o.fromFt).toBe(20);
    expect(o.toFt).toBe(24);
    expect(o.spanFt).toBe(4);
  });

  it('treats a missing deep side as no spread rather than as unknown depth', () => {
    expect(optionality({ envelope: [18, 18], envelopeDeep: null }).spanFt).toBe(0);
  });

  it('ignores uncharted stations instead of reading -1 as a depth', () => {
    // -1 is "nobody sounded it". Averaged in as a number it drags every corridor toward zero.
    expect(optionality({ envelope: [-1, 22, 22], envelopeDeep: [-1, 26, 26] }).fromFt).toBe(22);
  });
});

describe('ladderPartners — where the laps actually come from', () => {
  // "i agree with you that 3/4 of a mile is fine as long as the app can draw the line back the
  // other way at the other depth... it doesn't seem to be good at linking them together"
  const near = (a, b) => [{ key: 'a', holdsFt: a, lengthM: 1400, coords:
                             Array.from({ length: 20 }, (_, k) => [-80.72 + k * 0.0004, 34.38]) },
                          { key: 'b', holdsFt: b, lengthM: 900, coords:
                             Array.from({ length: 20 }, (_, k) => [-80.72 + k * 0.0004, 34.38 + 60 / 110540]) }];

  it('pairs two pieces you can turn between at different depths', () => {
    const r = ladderPartners(near(12, 20));
    expect(r[0].length).toBe(1);
    expect(r[0][0].holdsFt).toBe(20);
    expect(r[0][0].turnM <= 100).toBe(true);
  });

  it('refuses a partner at the same depth — that is another lap of the same pattern', () => {
    expect(ladderPartners(near(20, 21))[0].length).toBe(0);
  });

  it('refuses a partner you would have to move the boat to reach', () => {
    const far = near(12, 20);
    far[1].coords = far[1].coords.map((c) => [c[0], 34.38 + 600 / 110540]);
    expect(ladderPartners(far)[0].length).toBe(0);
  });

  it('is symmetric — if you can turn onto it, you can turn back', () => {
    const r = ladderPartners(near(12, 26));
    expect(r[0].length).toBe(1);
    expect(r[1].length).toBe(1);
  });
});

describe('reasons — arguments, never a verdict', () => {
  const piece = { lengthM: 2200, holdsFt: 18, duplicates: 1, chartedFrac: 1,
                  envelope: [18, 18], envelopeDeep: [19, 19], near: [] };

  it('says so when a piece is one pass and then a decision', () => {
    const r = reasons(piece, { minM: 600, fishBandFt: [15, 40], partners: [] });
    expect(r.against.some((s) => /nothing within a turn/.test(s))).toBe(true);
  });

  it('names the depths a partner offers, not just that one exists', () => {
    const r = reasons(piece, { minM: 600, fishBandFt: [15, 40],
                               partners: [{ holdsFt: 26, turnM: 66, lengthM: 900 }] });
    expect(r.for.some((s) => /26 ft/.test(s) && /66 m/.test(s))).toBe(true);
  });

  it('never calls a hazard a hazard-or-a-target — it says where it is and stops', () => {
    // "not information... TARGET!!!" — the same timber is a target under a plan that puts the
    // bait above it and a snag under one that puts the bait into it.
    const r = reasons({ ...piece, near: [{ t: 'hazard', d: 30, s: 100 }] },
                      { minM: 600, fishBandFt: [15, 40], partners: [] });
    const line = r.against.find((s) => /hazard/.test(s));
    expect(/depends on how deep the baits run/.test(line)).toBe(true);
  });

  it('reads charted_frac, and says it about the PASS rather than about the piece', () => {
    // It used to read "only 60% of this is charted". `charted_frac` is stamped per pass, and a
    // piece is a trim of one -- reachCurve breaks its run on an uncharted station, so every
    // station on a piece is charted by construction (0 of Wateree's 70 contain one). Whenever
    // the sentence fired it was describing water the leg had been cut to avoid.
    const r = reasons({ ...piece, chartedFrac: 0.6 }, { minM: 600, partners: [] });
    const line = r.against.find((s) => /60%/.test(s));
    expect(line).toBeTruthy();
    expect(/the pass this was cut from/.test(line)).toBe(true);
    expect(/60% of this is charted/.test(line)).toBe(false);
    // and it says why that matters: the run stops where the survey stops.
    expect(/ends where it does/.test(line)).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // THE BAND IS NOT A FILTER ON WATER — 2026-08-11
  //
  // This used to assert that water deeper than the band produced a reason AGAINST reading "fine
  // for suspended fish, but the bottom here tells you nothing about them". The sentiment was
  // right and the filing was wrong: it is not a mark against the water at all.
  //
  // Ryan, reading the tab live: "the sonar is going to tell me right away where in that 15-40 the
  // fish are... as long as the plan puts me over water with the right features in the right depth
  // the llm can adjust the baits to catch fish there." The constraint is the shoal, not the fish.
  //
  // It also hung on `holding === 'suspended'`, which SPECIES_BEHAVIOR_V2 never sets on any entry
  // — so the kind branch could not fire from the built-in table at all, and every deep piece got
  // the harsh sentence instead.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  it('does not hold deep water against a piece — the band is context, not a filter', () => {
    const deep = { ...piece, holdsFt: 60, envelope: [60, 60], envelopeDeep: [62, 62] };
    const r = reasons(deep, { minM: 600, fishBandFt: [15, 40], partners: [] });
    expect(r.against.some((s) => /outside the/.test(s))).toBe(false);
    expect(r.for.some((s) => /the baits work the column/.test(s))).toBe(true);
  });

  it('does object when the band does not FIT — water shallower than the fish', () => {
    // The one direction that is a real objection: the depth they are using does not exist here.
    const shallow = { ...piece, holdsFt: 6, envelope: [6, 7], envelopeDeep: [7, 8] };
    const r = reasons(shallow, { minM: 600, fishBandFt: [15, 40], partners: [] });
    expect(r.against.some((s) => /does not exist on this piece/.test(s))).toBe(true);
  });

  it('always states the bait ceiling, because the assembler now enforces it', () => {
    // "nice to see to confirm that the program/llm gets it right" — a constraint the app applies
    // silently and never displays cannot be confirmed by anyone.
    const r = reasons(piece, { minM: 600, partners: [] });
    expect(r.for.some((s) => /nothing may run deeper than \d+ ft/.test(s))).toBe(true);
  });

  it('states the ceiling the PLAN enforces — the line, not the bank beside it', () => {
    // It used to quote `holdsFt`, off `envelope_ft`, which is the shallowest water within a
    // wander -- the bank you steer AWAY from. plan-from-water.js stopped sizing baits that way on
    // 2026-08-30, and this tab did not, so the two showed different ceilings for the same water:
    // wateree_lake#526 read "nothing may run deeper than 6 ft" while the model was correctly
    // handed maxRunDepthFt: 19. Ryan: "as long as the model gets that 13ft limit... that is the
    // point."
    const p = { ...piece, holdsFt: 6,
                water: { line: { minFt: 19, medianFt: 25, maxFt: 32 },
                         side: { minFt: 7, medianFt: 20, maxFt: 32 } } };
    const line = reasons(p, { minM: 600, partners: [] }).for.find((s) => /may run deeper/.test(s));
    expect(/nothing may run deeper than 19 ft/.test(line)).toBe(true);
    expect(/6 ft/.test(line)).toBe(false);
    // and the wander number survives as the warning it is, not as the ceiling
    expect(/comes up to 7 ft/.test(line)).toBe(true);
    expect(/depth cue calls before you reach it/.test(line)).toBe(true);
  });

  it('falls back to holdsFt only on a pack with no envelope profile', () => {
    const line = reasons(piece, { minM: 600, partners: [] }).for.find((s) => /may run deeper/.test(s));
    expect(/nothing may run deeper than 18 ft/.test(line)).toBe(true);
  });
});

describe('dayCost — the one thing allowed to say no', () => {
  // "if it is a battery thing i would say we need a safety hard stop... if they are going to run
  // out of battery because of choice they shouldn't be able to make that choice"
  const RAMP = [-80.72, 34.38];
  const at = (lonOff, latOff) => ({ lengthM: 1600, coords: [
    [-80.72 + lonOff, 34.38 + latOff], [-80.72 + lonOff + 0.01, 34.38 + latOff]] });

  it('costs an empty day at nothing rather than dividing by zero', () => {
    const d = dayCost([], { ramp: RAMP, usableAh: 80 });
    expect(d.fits).toBe(true);
    expect(d.ah).toBe(0);
  });

  it('finds the cheapest ORDER, not the order they were ticked in', () => {
    // Ticked far, near, far — the answer must not be to drive past the near one twice.
    const far = at(0.20, 0), close = at(0.005, 0), far2 = at(0.21, 0);
    const d = dayCost([far, close, far2], { ramp: RAMP, usableAh: 400 });
    expect(d.exact).toBe(true);
    expect(d.order[0]).toBe(1);
  });

  it('starts each pass at whichever end is nearer, because a pass fishes both ways', () => {
    const d = dayCost([at(0.05, 0)], { ramp: RAMP, usableAh: 400 });
    expect(d.flips[0]).toBe(false);          // start at the near end, as drawn
    const back = { lengthM: 1600, coords: [[-80.72 + 0.06, 34.38], [-80.72 + 0.05, 34.38]] };
    expect(dayCost([back], { ramp: RAMP, usableAh: 400 }).flips[0]).toBe(true);
  });

  it('refuses over usable Ah and says by how much', () => {
    const d = dayCost([at(0.3, 0), at(0.4, 0), at(0.5, 0)], { ramp: RAMP, usableAh: 5 });
    expect(d.fits).toBe(false);
    expect(/over by/.test(d.reason)).toBe(true);
  });

  it('says when the ordering is a heuristic rather than pretending it is exact', () => {
    // Past 8 pieces this is nearest-neighbour plus 2-opt. A heuristic that claims to be exact is
    // how a refusal ends up wrong in the direction that costs a paddle home.
    const many = Array.from({ length: 10 }, (_, i) => at(0.01 * i, 0));
    expect(dayCost(many, { ramp: RAMP, usableAh: 400 }).exact).toBe(false);
    expect(dayCost(many.slice(0, 8), { ramp: RAMP, usableAh: 400 }).exact).toBe(true);
  });

  it('reports a long day without refusing it — only the battery is a hard stop', () => {
    const d = dayCost([at(0.3, 0), at(0.4, 0)], { ramp: RAMP, usableAh: 4000, windowMin: 60 });
    expect(d.fits).toBe(true);
    expect(d.overWindowMin > 0).toBe(true);
  });

  it('never claims the transit distance is over water', () => {
    // Straight lines between leg ends are the OPTIMISTIC answer, so a refusal is safe and an
    // accept is provisional. Saying which is the whole reason the flag is here.
    expect(dayCost([at(0.05, 0)], { ramp: RAMP, usableAh: 400 }).overWater).toBe(false);
  });
});

describe('offerWater — lanes in, choices out', () => {
  const lanes = [lane('a', 26, 60, 0, { deepFt: 30, lineFt: 28 }),
                 lane('b', 14, 60, 70 / 110540, { deepFt: 16, lineFt: 15 }),
                 lane('c', 26, 40, 900 / 110540, { deepFt: 27, lineFt: 26 })];

  it('refuses to hold a minimum length of its own', () => {
    // "nothing replaces minM: 1500 if i want to spend the day doing cast and stops on tiny
    // contours i should be able to do that" — so it is a field on the form, not a constant.
    let threw = false;
    try { offerWater(lanes, { fishBandFt: [15, 40] }); }
    catch (e) { threw = /decision for the day/.test(e.message); }
    expect(threw).toBe(true);
  });

  it('gives every piece a stable key, reasons and its partners', () => {
    const r = offerWater(lanes, { minM: 600, fishBandFt: [15, 40] });
    expect(r.pieces.length >= 2).toBe(true);
    expect(r.pieces.every((p) => typeof p.key === 'string')).toBe(true);
    expect(r.pieces.every((p) => Array.isArray(p.reasons.for))).toBe(true);
    expect(r.pieces.every((p) => Array.isArray(p.partners))).toBe(true);
  });

  it('links the two that are a turn apart and leaves the far one alone', () => {
    const r = offerWater(lanes, { minM: 600, fishBandFt: [15, 40] });
    const a = r.pieces.find((p) => p.runId === 'a');
    const c = r.pieces.find((p) => p.runId === 'c');
    expect(a.partners.some((q) => q.holdsFt <= 16)).toBe(true);
    expect(c.partners.length).toBe(0);
  });

  it('says what its depth axis means, because it is not the obvious one', () => {
    const r = offerWater(lanes, { minM: 600, fishBandFt: [15, 40] });
    expect(r.depthAxis).toBe('minimum water depth, ft');
  });
});
