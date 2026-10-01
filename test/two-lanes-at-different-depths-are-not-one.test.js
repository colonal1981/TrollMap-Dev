// Two lanes at different depths are not the same water.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-01, on an October striper plan for Lake Marion from Rowland Subdivision: "the
// depths seem to be way to shallow unless i am missing something". He was not. All 12 lanes
// offered were outside the 20-30 ft band, because the dedupe in selectCandidates() dropped the
// deep lanes near the ramp as duplicates of shallow ones that started nearby:
//   #1540 21-29 ft for #1660 1-15 ft (starts 280 m apart), #6810 19-25 ft for #473 7-18 ft
//   (corridor overlap 0.92). Measured on chartpack/lake_marion, 20-30 ft, suspended: 0 of the
//   12 offered in the band before, 2 after (#1370 16-26 ft at 485 m, #544 22-31 ft at 1.9 km).
//
// What these hold:
//   1. a deep lane starting 280 m from a shallow one is offered beside it;
//   2. a deep lane inside the corridor of a shallow one is offered beside it;
//   3. nested lanes whose water overlaps are still one lane (the case the dedupe was written for);
//   4. a lane with no measured range is judged by the old tests alone.
import { describe, it, expect } from './expect-shim.mjs';
import { selectCandidates } from '../js/modules/plan-candidates.js';

const STEP = 100;
const N = 23; // 2,200 m at 100 m a sounding
const ramp = [-80.73, 34.38];
const lane = (id, lat, lo, hi, extra = {}) => ({
  type: 'Feature',
  geometry: { type: 'LineString',
              coordinates: Array.from({ length: 41 }, (_, k) => [-80.725 + k * 0.0006, lat]) },
  properties: {
    id, depth_ft: (lo + hi) / 2, length_m: 2200, routable: true, relief: 'flat', fitted: true,
    shallowest_ft: lo,
    envelope_step_m: STEP,
    envelope_line_ft: Array.from({ length: N }, (_, k) => lo + ((hi - lo) * ((k * 7) % N)) / (N - 1)),
    envelope_ft: Array.from({ length: N }, (_, k) => lo + ((hi - lo) * ((k * 5) % N)) / (N - 1)),
    near: Array.from({ length: 6 }, (_, k) => ({ s: 200 + k * 300, t: 'point', d: 25 })),
    ...extra,
  },
});
const OPTS = { ramp, slug: 'w', fishDepthFt: [0, 99], holding: 'bottom', usableAh: 999, windowMin: 9999 };
const ids = (out) => out.map((c) => c.runId).sort();

describe('selectCandidates -- two lanes at different depths are not one', () => {
  it('offers a deep lane that starts 280 m from a shallow one', () => {
    const out = selectCandidates([lane('shallow', 34.38, 1, 15), lane('deep', 34.3825, 21, 29)], OPTS);
    expect(ids(out)).toEqual(['deep', 'shallow']);
  });

  it('offers a deep lane inside the corridor of a shallow one', () => {
    const out = selectCandidates([lane('shallow', 34.38, 7, 18), lane('deep', 34.3804, 19, 25)], OPTS);
    expect(ids(out)).toEqual(['deep', 'shallow']);
  });

  it('still keeps one of two nested lanes whose water overlaps', () => {
    const out = selectCandidates([lane('a', 34.38, 13, 18), lane('b', 34.3825, 15, 20)], OPTS);
    expect(out.length).toBe(1);
    expect(out.selection.rejected.dedupe).toBe(1);
  });

  it('judges a lane with no measured range by the old tests alone', () => {
    const bare = lane('bare', 34.3825, 21, 29);
    delete bare.properties.envelope_line_ft;
    const out = selectCandidates([lane('shallow', 34.38, 1, 15), bare], OPTS);
    expect(out.length).toBe(1);
  });
});
