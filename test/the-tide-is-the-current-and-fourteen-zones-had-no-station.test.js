// THE TIDE IS THE CURRENT, AND FOURTEEN OF SIXTEEN COASTAL ZONES HAD NO STATION.
//
// The coastal prompt block has said "THE TIDE IS THE CURRENT here — there is no spot-lock, so
// every stop is pedal work against moving water and you must say which way it is running" since
// it was written. The line above it printed the speed. Neither of them could fire on the water
// Ryan actually fishes.
//
// Measured over all 207 rows of water_bindings.json, 2026-09-15: THIRTY waters carry `tides` and
// only SEVEN carry a `currentpredictions` station. Of the sixteen coastal zones the app offers,
// TWO have one — Cape Fear and Brunswick/St Simons. Charleston has none. Every South Carolina
// zone has none. So both readers — the prompt and the conditions strip — have been starved since
// the day they were written, and there was no way to see it from either: A BLANK CURRENT ROW AND
// SLACK WATER LOOK IDENTICAL.
//
// registry/coastal_current_stations.json was built for exactly this on 2026-09-03 — 2,785 CO-OPS
// stations filtered to those inside a zone boundary, 360 bindings across 16 of 22 zones, 75 of
// them in Charleston Harbour — and nothing ever read it.
//
// THREE SEPARATE DEFECTS, and they fail independently:
//   1. no station for fourteen zones — the Worker now falls back to the zone registry
//   2. the SET was computed and sent to the conditions strip and dropped before the prompt, so
//      the model was told to say which way the water runs and never told which way it runs
//   3. the DISTANCE was dropped the same way, so a prediction taken at the harbour entrance read
//      exactly like one taken in the creek
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from './expect-shim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');

const { compassOf, COMPASS_16 } = await import('../js/utils/compass.js');
const { coastalPromptBlock } = await import('../js/modules/plan-prompt.js');

describe('the compass is in one place now', () => {
  it('rounds to the nearest point, which floor does not', () => {
    // `Math.floor(deg / 22.5)` is wrong by up to 11 degrees and every copy of this table was an
    // opportunity to write it.
    // The N/NNE boundary is 11.25 degrees, not 22.5 — the first draft of this test asserted
    // compassOf(22) === 'N' and the code was right.
    expect(compassOf(0)).toBe('N');
    expect(compassOf(11)).toBe('N');
    expect(compassOf(12)).toBe('NNE');
    expect(compassOf(350)).toBe('N');
    expect(compassOf(121)).toBe('ESE');
  });

  it('wraps past 360 and below 0 instead of falling off the end', () => {
    expect(compassOf(360)).toBe('N');
    expect(compassOf(370)).toBe('N');
    expect(compassOf(-10)).toBe('N');
  });

  it('NULL RATHER THAN NORTH when there is no bearing', () => {
    // A missing direction rendered as north is a claim, and it is the claim somebody acts on
    // when they decide which way to drift a bait.
    // Number(null) is 0 and Number.isFinite(0) is true, so a Number() guard alone renders every
    // missing bearing as due north. That is what the first version of compassOf() did.
    for (const v of [null, undefined, '', NaN, 'nope', false]) expect(compassOf(v)).toBeNull();
  });

  it('and the copies are gone from the modules that could import it', () => {
    expect(src('js/modules/plan-preflight.js')).not.toContain("'NNE'");
    expect(src('js/modules/measure-tool.js')).not.toContain("'NNE'");
    expect(COMPASS_16.length).toBe(16);
    // plan-builder's copy lives inside the report's generated HTML — a string handed to a browser
    // with no module loader — so it genuinely cannot import and is the one copy left standing.
    expect(src('js/modules/plan-builder.js')).toContain("'NNE'");
  });
});

describe('the Worker falls back to the zone registry, and says which answered', () => {
  const w = src('Worker/conditions.js');

  it('a bound station still wins — this only fills a silence', () => {
    const i = w.indexOf('async function currentStationFor(');
    const fn = w.slice(i, w.indexOf('\n}\n', i));
    // The bindings are consulted FIRST and returned before the registry is even loaded.
    expect(fn.indexOf("from: 'water_bindings'")).toBeLessThan(fn.indexOf('coastalCurrentStations('));
  });

  it('the answer names which registry chose the station', () => {
    expect(w).toContain('bound_by: cur.from || null');
  });

  it('a registry that will not load is a silence, never a thrown tide block', () => {
    // The tide block is the part that keeps a kayak off the mud. A missing current registry must
    // not take it down with it.
    const i = w.indexOf('async function currentStationFor(');
    expect(w.slice(i, w.indexOf('\n}\n', i))).toMatch(/catch \(e\) \{\s*return null;/);
  });

  it('tideBlock is handed the slug, or it cannot look a zone up', () => {
    expect(w).toContain('async function tideBlock(b, lat, lon, date, slug, env)');
    expect(w).toContain('tideBlock(b, lat, lon, date, slug, env)');
  });
});

describe('the set and the distance reach the prompt', () => {
  const tidal = (extra) => ({ tidal: { zone: 'Charleston Harbor', stage: 'flood',
    stageLabel: 'flooding', ...extra } });

  it('the direction is printed in degrees AND as a compass point', () => {
    const t = coastalPromptBlock(tidal({ currentType: 'flood', currentKn: 1.8, currentDirDeg: 320 }));
    expect(t).toContain('setting 320°');
    expect(t).toContain('(NW)');
  });

  it('a current with no direction still prints, and claims no direction', () => {
    const t = coastalPromptBlock(tidal({ currentType: 'ebb', currentKn: 1.2 }));
    expect(t).toContain('ebb');
    expect(t).not.toContain('setting');
  });

  it('a station close to the launch is named plainly', () => {
    const t = coastalPromptBlock(tidal({ currentType: 'flood', currentKn: 1.8,
      currentStation: 'Shem Creek', currentStationKm: 0.8 }));
    expect(t).toContain('Predicted at Shem Creek');
    expect(t).toContain('0.8 km from the launch');
    expect(t).not.toContain('FAR ENOUGH');
  });

  it('A FAR STATION IS A TIMING FACT, NOT A SPEED — and says so', () => {
    // Charleston's nearest current station to a marsh ramp can be the harbour entrance between
    // the jetties. The turn transfers up the creek; 1.8 knots between two rock walls does not.
    const t = coastalPromptBlock(tidal({ currentType: 'flood', currentKn: 1.8,
      currentStation: 'Charleston Hbr. ent. (between jetties)', currentStationKm: 8.2 }));
    expect(t).toContain('FAR ENOUGH THAT IT IS THE TIMING THAT TRANSFERS, NOT THE SPEED');
    expect(t).toContain('do not state that speed as the current in his creek');
  });

  it('A BLANK CURRENT ROW IS NOT SLACK WATER, and the block refuses to let it read as one', () => {
    const t = coastalPromptBlock(tidal({}));
    expect(t).toContain('NO CURRENT PREDICTION ANSWERED');
    expect(t).toContain('missing station, NOT slack water');
  });

  it('...and that sentence never fires when a current DID answer', () => {
    const t = coastalPromptBlock(tidal({ currentType: 'slack', currentKn: 0 }));
    expect(t).not.toContain('NO CURRENT PREDICTION ANSWERED');
    // A genuine slack reading is a real answer and must survive `currentKn: 0`.
    expect(t).toContain('slack');
  });

  it('an inland water still gets no coastal block at all', () => {
    expect(coastalPromptBlock({})).toBe('');
    expect(coastalPromptBlock(null)).toBe('');
  });
});

describe('salt says WHICH gauge, on zones that bind twenty of them', () => {
  // THE SAME DEFECT ONE FIELD OVER, found while measuring whether the app had any salinity at
  // all. It has plenty: Charleston Harbor binds 25 gauges and TWENTY publish salinity or
  // specific conductance, two of them live salinity. The prompt printed "Salinity 12 ppt at the
  // gauge" — and a gauge up the Cooper reads water twenty parts per thousand different from one
  // at the harbour mouth. `saltGauge` and `saltBasis` had been computed by water-conditions.js
  // since it was written and reached nothing.
  const tidal = (extra) => ({ tidal: { zone: 'Charleston Harbor', stage: 'flood', ...extra } });

  it('names the gauge and its distance', () => {
    const t = coastalPromptBlock(tidal({ salinityPpt: 28.4, saltGauge: 'Shem Creek', saltGaugeKm: 1.2 }));
    expect(t).toContain('28.4 ppt at Shem Creek');
    expect(t).toContain('1.2 km from the launch');
  });

  it('A GAUGE UP THE SYSTEM IS A DIRECTION, NOT A READING — and says so', () => {
    const t = coastalPromptBlock(tidal({ salinityPpt: 6.1, saltGauge: 'Cooper River at Goose Creek',
                                         saltGaugeKm: 18.7 }));
    expect(t).toContain('IT IS A DIRECTION, NOT A READING');
    expect(t).toContain('do not state it as the salinity where he launches');
  });

  it('CONDUCTANCE IS NEVER CONVERTED TO PPT, and the block says that out loud', () => {
    // water-conditions.js refuses the conversion because a converted number would look like a
    // measurement and not be one, and `saltBasis` exists to say which of the two answered. A
    // prompt that quietly let the model do the conversion would undo that.
    const t = coastalPromptBlock(tidal({ conductanceUsCm: 41200, saltGauge: 'Ashley R', saltGaugeKm: 2 }));
    expect(t).toContain('41200 µS/cm at Ashley R');
    expect(t).toContain('NOT converted to ppt');
    expect(t).not.toContain('ppt at Ashley R');
  });

  it('an unnamed gauge still reads as a sentence', () => {
    expect(coastalPromptBlock(tidal({ salinityPpt: 12 }))).toContain('12 ppt at the gauge.');
  });

  it('and a zone with neither says nothing at all', () => {
    const t = coastalPromptBlock(tidal({}));
    expect(t).not.toContain('Salinity');
    expect(t).not.toContain('Conductance');
  });
});

describe('the fields survive the hop from /conditions to the prompt', () => {
  it('water-conditions carries the station distance and its provenance', () => {
    const wc = src('js/utils/water-conditions.js');
    expect(wc).toContain('out.currentStationKm');
    expect(wc).toContain('out.currentBoundBy');
  });

  it('and plan-preflight forwards all four onto the tidal object', () => {
    // THIS IS THE HOP THAT WAS BROKEN. Every one of these was computed and handed to the
    // conditions strip alone.
    const pf = src('js/modules/plan-preflight.js');
    for (const f of ['currentDirDeg', 'currentAt', 'currentStation', 'currentStationKm',
                     'saltGauge', 'saltGaugeKm', 'saltBasis']) {
      expect(pf).toContain(`${f}:`);
    }
  });
});
