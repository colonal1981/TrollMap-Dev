import { describe, it, expect } from './expect-shim.mjs';
import { makePredicate, chartedState, hasBathymetry, isKeepAlways, PRESETS } from '../js/data/water-filter.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ONE PREDICATE, THREE SURFACES
//
// This module shipped and was imported by NOTHING for several days, which is how `coveredBy()`
// came to have a docstring and no body: makePredicate() threw ReferenceError on the first record
// with `charted: 0` and nobody could see it. So the first thing here is simply that each preset
// RUNS, on every shape of record the registry actually holds.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const rec = (o = {}) => ({ name: 'Somewhere Lake', slug: 'somewhere_lake', state: 'SC',
                           area_acres: 2000, charted: 0.9, feature_type: 'lake', ...o });

describe('every preset executes against every shape of record', () => {
  it('does not throw on charted 0, null, or a missing field', () => {
    for (const p of Object.keys(PRESETS)) {
      const keep = makePredicate(p, []);
      for (const c of [0, null, undefined, 0.9, 1]) {
        expect(typeof keep(rec({ charted: c }), 'Somewhere Lake')).toBe('boolean');
      }
    }
  });
});

describe('charted is TRI-STATE and nothing may collapse it', () => {
  it('reads null as unknown, not as no', () => {
    // 52 registry rows are null. Reading null as false deletes the coast.
    expect(chartedState(rec({ charted: null }))).toBe('unknown');
    expect(chartedState(rec({ charted: 0 }))).toBe('no');
    expect(chartedState(rec({ charted: 0.4 }))).toBe('yes');
  });

  it('only a reconciled duplicate rescues an uncharted water', () => {
    expect(hasBathymetry(rec({ charted: 0 }))).toBe('no');
    expect(hasBathymetry(rec({ charted: 0, covered_by: 'congaree_river' }))).toBe('yes');
  });
});

describe('the research preset — a work list, not a map', () => {
  const research = makePredicate('research', null);

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Ryan, 2026-08-11: "i dont think the DNR feeds are going through your filter." He was right.
  //
  // makePredicate keeps a record it cannot resolve, because a failure to match is
  // indistinguishable from a water that deserves cutting. 424 of the 1,196 pickable names have no
  // registry record — they arrive live from the DNR ramp feeds — so under that rule every one of
  // them passed regardless of size, and the "filtered" list still ran past six hundred.
  //
  // The first fix applied it to the research picker only, leaving the map preset keeping
  // everything on my own reasoning that "looking is free". Ryan had already said otherwise,
  // twice — "in any of the bars", and "this needs to apply to waters that we get from dnr and not
  // the registry as well" — and said it a third time: "once you fix that in all 3 places".
  // ───────────────────────────────────────────────────────────────────────────────────────────
  it('drops a DNR name the registry cannot identify — on ALL THREE bars', () => {
    for (const p of ['map', 'planner', 'research']) {
      expect(makePredicate(p, null)(null, 'Sandy Run Creek Landing')).toBe(false);
    }
  });

  it('the presets differ on a RESOLVED record, not on an absent one', () => {
    // A charted lake with no ramp: fine to look at, not plannable, worth researching if it is big.
    const noRamp = rec({ area_acres: 4000, charted: 0.9, ramps: null, ramp_sources: null });
    expect(makePredicate('map', null)(noRamp, noRamp.name)).toBe(true);
    expect(makePredicate('planner', null)(noRamp, noRamp.name)).toBe(false);
    expect(research(noRamp, noRamp.name)).toBe(true);
    // A measured-zero pond with a ramp: no bar wants it.
    const pond = rec({ area_acres: 30, charted: 0, ramps: { natl: [{}] } });
    for (const p of ['map', 'planner', 'research']) {
      expect(makePredicate(p, null)(pond, 'Adams Mill Pond')).toBe(false);
    }
  });

  it('an UNMEASURED water is not an empty one — null survives the map gate', () => {
    // 52 rows are null, including all 22 coastal zones. Only a measured zero is dropped.
    expect(makePredicate('map', null)(rec({ charted: null, area_acres: 300 }), 'Somewhere')).toBe(true);
  });

  it('never drops water Ryan actually fishes, record or no record', () => {
    // isKeepAlways runs before every preset, so no filter can reach past it.
    for (const n of ['Bates Old River', 'Congaree River', 'Wateree Lake', 'Lower Saluda River']) {
      expect(isKeepAlways(n)).toBe(true);
      expect(research(null, n)).toBe(true);
    }
  });

  it('holds rivers back by default and takes them on request', () => {
    // A river's acreage is the area of a RIBBON — it measures length, not whether anyone writes
    // about the fishing. 72 passed on acreage alone, including the Mississippi at 163,923 acres
    // in Tennessee and Reelfoot Lake mis-typed as a river.
    const river = rec({ feature_type: 'river', area_acres: 5000, name: 'Judd Slough' });
    expect(research(river, 'Judd Slough')).toBe(false);
    expect(makePredicate('research', null, { includeRivers: true })(river, 'Judd Slough')).toBe(true);
  });

  it('keeps every coastal zone whatever its acreage says', () => {
    expect(research(rec({ feature_type: 'coastal', area_acres: 0, charted: 0 }), 'Cape Romain')).toBe(true);
    expect(research(rec({ slug: 'coast_beaufort_sc', area_acres: 0, charted: null }), 'Beaufort')).toBe(true);
  });

  it('drops a pond, and the acre floor is adjustable', () => {
    const pond = rec({ area_acres: 25, name: 'Adams Mill Pond' });
    expect(research(pond, 'Adams Mill Pond')).toBe(false);
    expect(makePredicate('research', null, { minAcres: 20 })(pond, 'Adams Mill Pond')).toBe(true);
  });

  it('keeps the small lakes that actually researched well', () => {
    // Measured against his own 60 profiles: Cheoah 1,198 ac scored 80%, Secession 1,332 scored
    // 92%, Nantahala 1,381 scored 85%, Blalock 1,481 scored 97%. Size did not predict material,
    // so the floor stays where it is and this test is what stops it drifting up quietly.
    for (const [name, acres] of [['Cheoah Lake', 1198], ['Secession Lake', 1332],
                                 ['Nantahala Lake', 1381], ['Lake Blalock', 1481]]) {
      expect(research(rec({ name, area_acres: acres }), name)).toBe(true);
    }
  });
});
