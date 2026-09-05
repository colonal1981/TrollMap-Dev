import { describe, it, expect } from './expect-shim.mjs';
import { selectCandidates } from '../js/modules/plan-candidates.js';

// ---------------------------------------------------------------------------
// Why this test exists
//
// Ryan, on the GPX from the Sep 5 Wateree plan: "look at leg 5 the entire leg
// is full of sharp turns and literally hugs the shore inside the dock line...
// if i trolled this as written i would take out every dock in clearwater
// cove". Then: "are these fitted lanes? i thought fitted fixed these angles".
//
// They were not fitted. Fitting does fix the angles. Counted on the real
// wateree_lake/trolling_runs.geojson, 2026-09-05:
//
//   2,843 runs -- 800 fitted, 2,043 not
//   shallowest_ft present on exactly the 800 fitted and none of the 2,043
//   turns over 45 degrees, 400-run sample of each:
//       fitted    mean 0.0   max 0    runs with any:   0/400
//       unfitted  mean 3.1   max 69   runs with any: 271/400
//   the four legs the model was handed: all four fitted:false, and #4 had
//       44 turns over 45 degrees and 16 over 90
//
// The unfitted runs carry `fit_note` recording the refusal in the fitter's own
// words -- "no fitted pass of 1500 m survived: this contour is not 2.0 ft deep
// for..." -- and `fitted`, `fit_note` and `shallowest_ft` appeared NOWHERE in
// plan-candidates.js. The selector offered the refusals beside the passes and
// scored them the same.
//
// The gate is measured, not chosen: a pack WITH fitted lanes offers only
// fitted lanes. A pack with none behaves exactly as before, because no
// candidates is worse than rough ones. Wateree is not starved by it -- 767 of
// the 800 fitted runs still clear a "deeper than 3 ft" rule.
// ---------------------------------------------------------------------------

const lane = (lon0, fitted, extra = {}) => ({
  type: 'Feature',
  geometry: { type: 'LineString',
              coordinates: Array.from({ length: 41 }, (_, k) => [lon0 + k * 0.0006, 34.38]) },
  properties: { depth_ft: 20, length_m: 2200, routable: true, relief: 'flat',
                fitted, ...(fitted ? { shallowest_ft: 14 } : { fit_note: 'no fitted pass of 1500 m survived' }),
                near: Array.from({ length: 6 }, (_, k) => ({ s: 200 + k * 300, t: 'point', d: 25 })),
                ...extra },
});

const OPTS = { ramp: [-80.73, 34.38], slug: 'w', fishDepthFt: [0, 99], holding: 'bottom',
               usableAh: 999, windowMin: 9999 };

describe('selectCandidates — a lane the fitter refused is not a lane', () => {
  it('offers only fitted lanes when the pack has them', () => {
    const runs = [lane(-80.764, false), lane(-80.720, true)];
    const out = selectCandidates(runs, OPTS);
    expect(out.length).toBe(1);
    expect(out[0].runIndex).toBe(1);
    expect(out.selection.rejected.unfitted).toBe(1);
    expect(out.selection.fittedAvailable).toBe(true);
  });

  it('leaves a pack with no fitted lanes exactly as it was', () => {
    const runs = [lane(-80.764, false), lane(-80.720, false)];
    const out = selectCandidates(runs, OPTS);
    expect(out.length).toBe(2);
    expect(out.selection.rejected.unfitted).toBe(0);
    expect(out.selection.fittedAvailable).toBe(false);
  });

  it('says which case the caller is in rather than leaving a silent zero', () => {
    // "800 unfitted runs were refused" and "this lake has no fitted lanes at
    // all" are different days on the water, and only this field separates them.
    const none = selectCandidates([lane(-80.72, false)], OPTS);
    const some = selectCandidates([lane(-80.72, true), lane(-80.764, false)], OPTS);
    expect(none.selection.fittedAvailable).toBe(false);
    expect(some.selection.fittedAvailable).toBe(true);
  });

  it('keeps every run accounted for, which is how the dedupe went unreported', () => {
    const runs = [lane(-80.764, false), lane(-80.720, true), lane(-80.700, false)];
    const out = selectCandidates(runs, OPTS);
    expect(out.selection.accountedFor).toBe(out.selection.considered);
  });

  it('treats a missing fitted flag as unfitted, not as fitted', () => {
    // An old pack predates the flag. It must not be promoted by silence.
    const old = lane(-80.764, undefined);
    delete old.properties.fitted;
    const out = selectCandidates([old, lane(-80.720, true)], OPTS);
    expect(out.length).toBe(1);
    expect(out.selection.rejected.unfitted).toBe(1);
  });
});
