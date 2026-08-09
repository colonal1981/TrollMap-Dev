import { describe, it, expect } from './expect-shim.mjs';
import { DEFAULT_WEIGHTS, DEFAULT_RELIEF_WEIGHTS, selectCandidates, overlapFraction, forModel,
  metresBetween } from '../js/modules/plan-candidates.js';
import { structureWeights, RESEARCH_LEAD } from '../js/modules/plan-inputs.js';

// ---------------------------------------------------------------------------
// Why this test exists
//
// Ryan, 2026-08-08: "i already answered how to weight each of the types of
// structure... this should have already been in the build docs... did you
// even build it to spec?"
//
// He had, it was, and I had not. TROLLING_RUNS_THE_LINE_WAS_ALWAYS_THERE
// counted Wateree's own trollingIntelligence across 11 species and 4 seasons
// -- 104 structure citations -- and I shipped a weight table that inverted it:
// humps top at 3, flats at 0 with a comment calling them "navigational marks,
// not targets". The measurement puts humps LAST at 3 of 104 and flats sixth,
// cited by more species than anything but the channel edge.
//
// So the counts are pinned here. They are a measurement, not a taste. If they
// change it should be because somebody recounted, and this test should change
// in the same commit as the recount.
// ---------------------------------------------------------------------------

// Straight out of the doc.
const CITED = {
  timber: 27, channel_edge: 12, point: 11, docks: 10,
  creek_mouth: 10, flats: 8, ledge: 4, hump: 3,
};

describe('the weight table matches the measured citation count', () => {
  it('scores the most-cited thing highest and the least-cited lowest', () => {
    expect(DEFAULT_WEIGHTS.timber).toBe(CITED.timber);
    expect(DEFAULT_WEIGHTS.point).toBe(CITED.point);
    expect(DEFAULT_WEIGHTS.creek_mouth).toBe(CITED.creek_mouth);
    expect(DEFAULT_WEIGHTS.ledge).toBe(CITED.ledge);
    expect(DEFAULT_WEIGHTS.hump).toBe(CITED.hump);
    // The inversion, stated as an assertion so it cannot come back.
    expect(DEFAULT_WEIGHTS.hump < DEFAULT_WEIGHTS.timber).toBe(true);
    expect(DEFAULT_WEIGHTS.hump < DEFAULT_WEIGHTS.point).toBe(true);
    expect(DEFAULT_WEIGHTS.hump < DEFAULT_WEIGHTS.shallow).toBe(true);
  });

  it('does not treat flats as navigational marks', () => {
    // `shallow` is flats. Eight cites across six species -- more species than points, ledges or
    // humps. The first table scored it 0.
    expect(DEFAULT_WEIGHTS.shallow).toBe(CITED.flats);
  });

  it('scores the channel edge, which is second in the count and had no score at all', () => {
    expect(DEFAULT_RELIEF_WEIGHTS.channel_edge).toBe(CITED.channel_edge);
    expect(DEFAULT_RELIEF_WEIGHTS.channel_edge > DEFAULT_WEIGHTS.point).toBe(true);
  });

  it('keeps hazards at zero, the one place "not a target" is right', () => {
    expect(DEFAULT_WEIGHTS.hazard).toBe(0);
  });
});

describe('trollingIntelligence leads the weights, per the build doc', () => {
  // "Whether six stands of flooded timber beat nine humps depends on the species, the season and
  // where the forage is, and that judgement lives in the app's trollingIntelligence."
  const WATEREE_SUMMER = ['main lake points', 'creek mouths', 'lower lake basin'];

  it('lifts what the research named above everything it did not', () => {
    const { weights } = structureWeights(DEFAULT_WEIGHTS, DEFAULT_RELIEF_WEIGHTS, WATEREE_SUMMER);
    // Points were named; timber was not. Timber's base of 27 must not win anyway -- that is the
    // exact failure a multiplier would have left in place.
    expect(weights.point > weights.timber).toBe(true);
    expect(weights.creek_mouth > weights.timber).toBe(true);
    expect(weights.timber).toBe(DEFAULT_WEIGHTS.timber);   // untouched, not zeroed
  });

  it('keeps the measured order inside the named group', () => {
    const { weights } = structureWeights(DEFAULT_WEIGHTS, DEFAULT_RELIEF_WEIGHTS, WATEREE_SUMMER);
    expect(weights.point).toBe(DEFAULT_WEIGHTS.point + RESEARCH_LEAD);
    expect(weights.point > weights.creek_mouth).toBe(true);   // 11 cites beats 10, as counted
  });

  it('routes river-channel language to relief, where it belongs', () => {
    // "river channel" has no `near[]` type. It is a property of the run, so it must lift the
    // relief weight or it lifts nothing at all.
    const { reliefWeights, matched } = structureWeights(
      DEFAULT_WEIGHTS, DEFAULT_RELIEF_WEIGHTS, ['river channel', 'current breaks']);
    expect(reliefWeights.channel_edge).toBe(DEFAULT_RELIEF_WEIGHTS.channel_edge + RESEARCH_LEAD);
    expect(matched.includes('relief:channel_edge')).toBe(true);
  });

  it('reports the phrases it could not place instead of dropping them', () => {
    const { unmatched } = structureWeights(
      DEFAULT_WEIGHTS, DEFAULT_RELIEF_WEIGHTS, ['main lake points', 'suspended bait over open water']);
    expect(unmatched.length).toBe(1);
    expect(unmatched[0].includes('suspended bait')).toBe(true);
  });

  it('falls back to the measured table when there is no profile', () => {
    const { weights, reliefWeights } = structureWeights(DEFAULT_WEIGHTS, DEFAULT_RELIEF_WEIGHTS, null);
    expect(weights).toEqual(DEFAULT_WEIGHTS);
    expect(reliefWeights).toEqual(DEFAULT_RELIEF_WEIGHTS);
  });
});

describe('the weights actually change which legs get offered', () => {
  // Two runs: one passes timber, one passes points. Whichever the weights favour should rank
  // first. If this passes both ways round, the weights are decorative.
  // TWO THINGS THIS FIXTURE HAS TO CONTROL FOR, both learned by getting them wrong.
  //
  // 1. The spatial dedupe drops a candidate starting within 1.2 km of a better one, so two runs
  //    on the same geometry silently become one and the comparison tests nothing.
  // 2. `value` is score DISCOUNTED BY TRANSIT SHARE, so a run further from the ramp loses even
  //    with a much higher score. Placed one east and one west of the ramp, the transit is equal
  //    and the weights are the only thing left that can move the order.
  function run(kind, relief, lon0) {
    const coords = Array.from({ length: 41 }, (_, k) => [lon0 + k * 0.0006, 34.38]);
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
      properties: { depth_ft: 20, length_m: 2200, routable: true, relief,
        near: Array.from({ length: 6 }, (_, k) => ({ s: 200 + k * 300, t: kind, d: 25 })) } };
  }
  const runs = [run('timber', 'flat', -80.720), run('point', 'channel_edge', -80.764)];
  const opts = { ramp: [-80.73, 34.38], slug: 'w', depthFt: [0, 99], usableAh: 999, windowMin: 9999 };

  it('ranks the timber leg first on the measured defaults', () => {
    const out = selectCandidates(runs, opts);
    expect(out.length).toBe(2);
    expect(out[0].runIndex).toBe(0);
  });

  it('ranks the points leg first once the research names points', () => {
    const w = structureWeights(DEFAULT_WEIGHTS, DEFAULT_RELIEF_WEIGHTS, ['main lake points', 'river channel']);
    const out = selectCandidates(runs, { ...opts, weights: w.weights, reliefWeights: w.reliefWeights });
    expect(out[0].runIndex).toBe(1);
  });

  it('carries the relief score so the ordering is explainable', () => {
    const out = selectCandidates(runs, opts);
    const onChannel = out.find((c) => c.runIndex === 1);
    expect(onChannel.reliefScore).toBe(DEFAULT_RELIEF_WEIGHTS.channel_edge);
  });
});


// -----------------------------------------------------------------------------------------------
// "why would i launch at clearwater cove and then go fish the opposite side of the lake in the
// cove where colonel creek boat ramp is????"  -- Ryan, 2026-08-09
//
// Distance from the ramp was in the ranking already, as a discount by TRANSIT SHARE:
// score / (1 + moveAh/fishAh). But that is a ratio, and a long leg has a large fishAh, so the
// deadhead is diluted in the denominator -- a 6 km leg four miles out was barely taxed while a
// 2 km leg the same distance out was taxed hard. Distance from the ramp is not a property of how
// long the leg is and must not be scaled by it.
//
// It is a PREFERENCE, not a filter. The far water is still offered; it just loses to good water
// nearby. The feasibility cuts (usableAh, windowMin) are separate and still hard.
// -----------------------------------------------------------------------------------------------
describe('distance from the ramp is a cost, not just a filter', () => {
  function run(lon0, lat, pts, hits) {
    const coords = Array.from({ length: pts }, (_, k) => [lon0 + k * 0.0006, lat]);
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
      properties: { depth_ft: 20, length_m: (pts - 1) * 55, routable: true, relief: 'flat',
        near: Array.from({ length: hits },
                         (_, k) => ({ s: 200 + k * 400, t: (k % 2 ? 'hump' : 'point'), d: 25 })) } };
  }
  // 2.2 km of water off the ramp, and 6.5 km of BETTER water four miles away.
  const nearRun = run(-80.720, 34.3800, 41, 6);
  const farRun = run(-80.760, 34.4400, 120, 16);
  const opts = { ramp: [-80.73, 34.38], slug: 'w', depthFt: [0, 99], usableAh: 999, windowMin: 9999 };

  it('the far water genuinely scores higher — this is not a fixture that decides itself', () => {
    const out = selectCandidates([nearRun, farRun], opts);
    const near = out.find((c) => c.runIndex === 0);
    const far = out.find((c) => c.runIndex === 1);
    expect(far.score).toBeGreaterThan(near.score);
    expect(far.fromRampM).toBeGreaterThan(6000);
    expect(near.fromRampM).toBeLessThan(1500);
  });

  it('without the ramp bias the far leg wins, which is the bug', () => {
    // rampBiasM enormous => proximity ~1 => the ranking as it was before this commit.
    const out = selectCandidates([nearRun, farRun], { ...opts, rampBiasM: 1e9 });
    expect(out[0].runIndex).toBe(1);
  });

  it('with it, the water off the ramp wins', () => {
    const out = selectCandidates([nearRun, farRun], opts);
    expect(out[0].runIndex).toBe(0);
  });

  it('but the far water is still offered, because this is a preference', () => {
    const out = selectCandidates([nearRun, farRun], opts);
    expect(out.length).toBe(2);
    expect(out.some((c) => c.runIndex === 1)).toBe(true);
  });

  it('carries what it did and why, so the ordering can be argued with', () => {
    const out = selectCandidates([nearRun, farRun], opts);
    for (const c of out) {
      expect(Number.isInteger(c.fromRampM)).toBe(true);
      expect(c.proximity > 0 && c.proximity <= 1).toBe(true);
      // the nearer end of the leg, not whichever end the contour happens to start at
      expect(c.fromRampM).toBe(Math.min(c.transitInM, c.transitOutM));
    }
    // and the factor falls off with distance rather than switching
    const near = out.find((c) => c.runIndex === 0);
    const far = out.find((c) => c.runIndex === 1);
    expect(near.proximity).toBeGreaterThan(far.proximity);
    expect(far.proximity).toBeGreaterThan(0.2);
  });
});


// -----------------------------------------------------------------------------------------------
// "from what i can tell the 2 routes fish almost the exact same water." -- Ryan, 2026-08-09
//
// Measured off that GPX:
//
//     L1 · 23 ft    runs WEST from -80.7337 to -80.7856
//     L2 · 25.9 ft  starts at -80.7666 and runs EAST back through -80.7337
//
// Roughly half of L2 retraces L1, two feet deeper, in the opposite direction. The dedupe compared
// START POINTS -- 2.7 km apart -- and waved it through. A start-point test cannot see an overlap,
// only a coincidence.
// -----------------------------------------------------------------------------------------------
describe('two legs on one shoreline are one leg', () => {
  const line = (lonA, lonB, lat, n) =>
    Array.from({ length: n }, (_, k) => [lonA + (lonB - lonA) * k / (n - 1), lat]);
  const feat = (coords, depth, hits, lenM) => ({
    type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
    properties: { depth_ft: depth, length_m: lenM, routable: true, relief: 'flat',
      near: Array.from({ length: hits },
                       (_, k) => ({ s: 300 + k * 450, t: (k % 2 ? 'hump' : 'point'), d: 25 })) },
  });

  // The two legs from the plan, and a third on the far bank of the same arm ~440 m away.
  const L1 = feat(line(-80.7337, -80.7856, 34.3600, 60), 23, 10, 4775);
  const L2 = feat(line(-80.7666, -80.7337, 34.3603, 40), 25.9, 6, 3027);
  const FAR_BANK = feat(line(-80.7666, -80.7337, 34.3640, 40), 24, 6, 3027);
  const opts = { ramp: [-80.7300, 34.3600], slug: 'w', depthFt: [0, 99],
                 usableAh: 999, windowMin: 9999 };

  it('the start-point rule alone lets the duplicate through — that is the bug', () => {
    // dedupeOverlap above 1 can never trigger, so this is the ranking as it was before.
    const out = selectCandidates([L1, L2], { ...opts, dedupeOverlap: 1.1 });
    expect(out.length).toBe(2);
  });

  it('the deeper twin is dropped, and the better one is what survives', () => {
    const out = selectCandidates([L1, L2], opts);
    expect(out.length).toBe(1);
    expect(out[0].depthFt).toBe(23);
  });

  it('the far bank of the same arm is still two legs, not one', () => {
    // 440 m apart. A dedupe that merges opposite banks would cost him half the water on any
    // narrow arm, which is worse than the duplicate it is fixing.
    const out = selectCandidates([L1, FAR_BANK], opts);
    expect(out.length).toBe(2);
  });

  it('overlapFraction is direction-blind and measures what it says', () => {
    const a = L1.geometry.coordinates, b = L2.geometry.coordinates;
    // L2 lies entirely inside L1's span, running the other way.
    expect(overlapFraction(b, a)).toBe(1);
    // and L1 is only partly inside L2, because it is longer
    expect(overlapFraction(a, b)).toBeGreaterThan(0.4);
    expect(overlapFraction(a, b)).toBeLessThan(0.8);
    expect(overlapFraction(FAR_BANK.geometry.coordinates, a)).toBe(0);
  });

  it('survives geometry it cannot measure rather than throwing', () => {
    expect(overlapFraction(null, [[0, 0], [1, 1]])).toBe(0);
    expect(overlapFraction([[0, 0]], [[0, 0], [1, 1]])).toBe(0);
    expect(overlapFraction([[0, 0], [0, 0]], [[0, 0], [1, 1]])).toBe(0);
  });
});


// -----------------------------------------------------------------------------------------------
// TRANSIT BETWEEN LEGS IS A COST AND NOTHING WAS COSTING IT.
//
// Measured off the plan of 2026-08-09 (wateree_lake, Clearwater Cove):
//
//     budget   totalM 28040   fishingM 15250   transitM 12790     46% of the day deadheading
//     T2 alone 9687 m, 103 min, 22.97 Ah — 43% of the day's whole 54.02 Ah, on one transit
//     L1 = wateree_lake#27, L2 = wateree_lake#34, chosen independently, about six miles apart
//
// Both legs were near the ramp. The ramp bias was working. What nothing looked at was the gap
// BETWEEN them, because every number on a candidate described the candidate alone.
//
// PLAN_SCHEMA_V2's "MODEL DECIDES" table gives the order to the model — "which runId, in which
// order" — so the fix is not to reorder behind it. It is to hand it the distances and say so in
// the prompt. These tests pin the distances; test/plan-prompt.test.js pins the saying.
// -----------------------------------------------------------------------------------------------
describe('the gap between consecutive legs is measured and handed over', () => {
  function eastWest(lon0, lat, pts) {
    const coords = Array.from({ length: pts }, (_, k) => [lon0 + k * 0.0006, lat]);
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
      properties: { depth_ft: 20, length_m: (pts - 1) * 55, routable: true, relief: 'flat',
        near: Array.from({ length: 6 },
                         (_, k) => ({ s: 200 + k * 400, t: (k % 2 ? 'hump' : 'point'), d: 25 })) } };
  }
  // Two legs of equal merit, both about the same distance from the ramp, ~5 km from each other.
  // This is the shape of the plan he took out: each leg fine on its own, the pair expensive.
  const A = eastWest(-80.760, 34.3800, 41);
  const B = eastWest(-80.700, 34.3800, 41);
  const opts = { ramp: [-80.73, 34.38], slug: 'w', depthFt: [0, 99], usableAh: 999, windowMin: 9999 };

  it('every candidate carries the deadhead to every other candidate it could precede', () => {
    const out = selectCandidates([A, B], opts);
    expect(out.length).toBe(2);
    for (const c of out) {
      const others = out.filter((k) => k.runId !== c.runId).map((k) => k.runId).sort();
      expect(Object.keys(c.transitToM).sort()).toEqual(others);
      // never a distance to itself — that hop does not exist
      expect(c.transitToM[c.runId]).toBe(undefined);
    }
  });

  it('the distance is END of this leg to START of that one, because that is what the boat travels',
    () => {
      const out = selectCandidates([A, B], opts);
      const [a, b] = out;
      expect(a.transitToM[b.runId]).toBe(Math.round(metresBetween(a.end, b.start)));
      expect(b.transitToM[a.runId]).toBe(Math.round(metresBetween(b.end, a.start)));
      // Directional on purpose: A→B and B→A are different hops and generally different lengths.
      expect(a.transitToM[b.runId] === b.transitToM[a.runId]).toBe(false);
    });

  it('measures the real gap rather than a token — these two are kilometres apart', () => {
    const out = selectCandidates([A, B], opts);
    const worst = Math.max(...out.map((c) => Math.max(...Object.values(c.transitToM))));
    expect(worst).toBeGreaterThan(3000);
  });

  it('only names candidates that survived the dedupe and the limit', () => {
    const out = selectCandidates([A, B], { ...opts, limit: 1 });
    expect(out.length).toBe(1);
    // Nothing to hop to, and no key pointing at water the model was never shown.
    expect(Object.keys(out[0].transitToM)).toEqual([]);
  });

  it('forModel ships them, since the model is the thing that owns the order', () => {
    const out = selectCandidates([A, B], opts);
    const m = forModel(out[0]);
    expect(m.transitToM[out[1].runId]).toBe(out[0].transitToM[out[1].runId]);
    // and the way home, which the day pays once and which the ordering also decides
    expect(m.transitToRampM).toBe(out[0].transitOutM);
    expect(m.transitFromRampM).toBe(out[0].transitInM);
  });
});
