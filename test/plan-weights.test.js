import { describe, it, expect } from './expect-shim.mjs';
import { DEFAULT_WEIGHTS, DEFAULT_RELIEF_WEIGHTS, selectCandidates } from '../js/modules/plan-candidates.js';
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
