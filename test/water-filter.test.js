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

// The shape in registry/lake_index.json on disk.
const rec = (o = {}) => ({ name: 'Somewhere Lake', slug: 'somewhere_lake', state: 'SC',
                           area_acres: 2000, charted: 0.9, feature_type: 'lake', ...o });

/**
 * The shape `registryRecordFor()` ACTUALLY hands back in the browser.
 *
 * `lake-registry.js` normalises every row on load: `area_acres` -> `areaAcres`, `ramp_sources` ->
 * `rampSources`, `feature_type` -> **featureType**. The predicate read only the file's spelling,
 * so `isRiver` was always false in the app and every river sailed through the switch meant to hold
 * it back — Ryan, 2026-08-11: "your river filter isn't working in research."
 *
 * Every count I took was against the JSON file, which is snake_case, so none of them could have
 * caught it. That is why this variant exists and why the river tests below run BOTH shapes.
 */
const appRec = (o = {}) => {
  const { area_acres: a, feature_type: f, ramp_sources: rs, ...rest } = rec(o);
  return { ...rest, areaAcres: a, featureType: f, rampSources: rs };
};

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

  // REWRITTEN 2026-08-14. This asserted that the keep-list reached past every preset including
  // research. Ryan: "the whole point of the river toggle was to remove rivers from the research
  // list if i didn't want to see them... the whole point of filtering for over 1000 acres is so
  // that i only see researchable lakes... why have a hard override on that thought process?"
  //
  // No good reason. The keep-list came from the MAP, where hiding his water is the failure. A
  // research work list is the opposite case: being absent from it hides nothing from the app.
  it('the keep-list holds the map and the planner, and does NOT hold the work list', () => {
    for (const n of ['Bates Old River', 'Congaree River', 'Wateree Lake', 'Lower Saluda River']) {
      expect(isKeepAlways(n)).toBe(true);
      expect(makePredicate('map', null)(null, n)).toBe(true);
      expect(makePredicate('planner', null)(null, n)).toBe(true);
      // The work list answers with its own rules or it is not a filter.
      expect(research(null, n)).toBe(false);
    }
  });

  it('a river named after another river is not that river', () => {
    // `n.endsWith(' ' + k)` said "French Broad River" IS "Broad River", and "First Broad River"
    // too. Measured against the shipped 457: the `broad river` entry alone passed five rivers
    // through the toggle, three of them in other states.
    for (const n of ['French Broad River', 'First Broad River', 'Little Broad River']) {
      expect(isKeepAlways(n)).toBe(false);
    }
    // The leading qualifier stays — that form has real cases and cost nothing.
    expect(isKeepAlways('Broad River')).toBe(true);
    expect(isKeepAlways('Broad River (Cherokee Co, NC)')).toBe(true);
  });

  it('a river he fishes still goes when the toggle is off — that IS the toggle', () => {
    const congaree = rec({ feature_type: 'river', area_acres: 9000, name: 'Congaree River' });
    expect(research(congaree, 'Congaree River')).toBe(false);
    const withRivers = makePredicate('research', null, { includeRivers: true });
    expect(withRivers(congaree, 'Congaree River')).toBe(true);
  });

  it('holds rivers back by default and takes them on request — IN BOTH RECORD SHAPES', () => {
    // A river's acreage is the area of a RIBBON — it measures length, not whether anyone writes
    // about the fishing. 72 passed on acreage alone, including the Mississippi at 163,923 acres
    // in Tennessee and Reelfoot Lake mis-typed as a river.
    //
    // BOTH shapes, because the first version of this test used only the file's spelling and
    // passed green while the browser let every river through. A predicate is only correct against
    // the record its caller actually holds.
    const withRivers = makePredicate('research', null, { includeRivers: true });
    for (const make of [rec, appRec]) {
      const river = make({ feature_type: 'river', area_acres: 5000, name: 'Judd Slough' });
      expect(research(river, 'Judd Slough')).toBe(false);
      expect(withRivers(river, 'Judd Slough')).toBe(true);
    }
  });

  it('reads acreage and coastal off either spelling too', () => {
    // Same normalisation, same trap. `areaAcres` is what the app holds.
    expect(research(appRec({ area_acres: 30, name: 'Adams Mill Pond' }), 'Adams Mill Pond')).toBe(false);
    expect(research(appRec({ area_acres: 4000 }), 'Somewhere Lake')).toBe(true);
    expect(research(appRec({ feature_type: 'coastal', area_acres: 0, charted: 0 }), 'Cape Romain')).toBe(true);
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
