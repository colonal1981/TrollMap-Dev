import { describe, it, expect } from './expect-shim.mjs';
import { readConditions } from '../js/utils/water-conditions.js';
import { conditionsPromptBlock, CONDITION_FACTS, CONDITION_ELSEWHERE }
  from '../js/modules/plan-prompt.js';

// ---------------------------------------------------------------------------
// Why this test exists
//
// The same bug has now been found three times, in three files, and each time
// the fix was to make one hand-written list longer:
//
//   2026-09-06  conditionsPromptBlock() printed fifteen of the card's
//               twenty-four facts. Nine were added by hand.
//   2026-09-05  fetchWaterState() returned six keys of the sixty /conditions
//               parses. plan-preflight.js:554 wrote down the general form --
//               "The third time it is the LIST that is wrong, not the length
//               of it" -- and fixed it by spreading the whole object.
//   2026-09-22  conditionsPromptBlock() was still the hand-written list, and
//               twenty-six keys reached the conditions card and nothing else.
//
// A longer list fails again the next time a field is added to the producer,
// because nothing connects the two. This test is that connection: every key
// readConditions() produces must be claimed by a fact the prompt may print,
// or recorded in CONDITION_ELSEWHERE as already said by another block.
//
// It fails in BOTH directions on purpose. A key the producer grew and nobody
// dispositioned is the original bug. A key claimed here that the producer does
// not return is the OTHER half -- a rename in water-conditions.js leaves a
// disposition pointing at nothing, and the fact quietly stops firing while the
// table still reads as complete. That is exactly how the probe that read this
// project's GeoPackage came to swap two columns: the list and the thing it
// described drifted, and only the list was ever read.
// ---------------------------------------------------------------------------

const PRODUCED = Object.keys(readConditions(null));

describe('every field /conditions produces has a decision recorded about it', () => {
  it('claims each produced key exactly once', () => {
    const seen = new Map();
    for (const f of CONDITION_FACTS) {
      for (const k of f.keys) {
        if (seen.has(k)) throw new Error(`${k} is claimed by both ${seen.get(k)} and ${f.id}`);
        seen.set(k, f.id);
      }
    }
    for (const k of Object.keys(CONDITION_ELSEWHERE)) {
      if (seen.has(k)) throw new Error(`${k} is claimed by fact ${seen.get(k)} and by CONDITION_ELSEWHERE`);
      seen.set(k, 'elsewhere');
    }
    const undecided = PRODUCED.filter((k) => !seen.has(k));
    expect(undecided).toEqual([]);
  });

  it('claims nothing the producer does not return', () => {
    const produced = new Set(PRODUCED);
    const claimed = [...CONDITION_FACTS.flatMap((f) => f.keys), ...Object.keys(CONDITION_ELSEWHERE)];
    expect(claimed.filter((k) => !produced.has(k))).toEqual([]);
  });

  it('gives every fact an id and a say()', () => {
    for (const f of CONDITION_FACTS) {
      expect(typeof f.id).toBe('string');
      expect(typeof f.say).toBe('function');
      expect(Array.isArray(f.keys) && f.keys.length > 0).toBe(true);
    }
  });

  it('says nothing at all about a water nothing answered for', () => {
    // num.js exists because this block once sent "Water temperature null °F" to
    // the model on every water with no gauge bound to it.
    expect(conditionsPromptBlock(readConditions(null))).toBe('');
    expect(conditionsPromptBlock({ error: 'timeout' })).toBe('');
    expect(conditionsPromptBlock(null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The twenty-six, as facts. Each of these numbers was fetched, parsed, printed
// on the card and never shown to the thing that picks the lures.
// ---------------------------------------------------------------------------

describe('the facts that decide a lure now reach the model', () => {
  it('gives the barometric TREND, not just one reading', () => {
    const b = conditionsPromptBlock({ pressureMb: 1009.4, pressure3h: -1.8,
                                      obsStation: 'Lake Wateree', obsKmAway: 0.1 });
    expect(b).toMatch(/Barometer FALLING −1\.8 mb over 3 h/);
    expect(b).toMatch(/feeding window/);
    // The old caveat must NOT be printed when there IS a trend.
    expect(/there is no trend in it/.test(b)).toBe(false);
  });

  it('keeps the honest caveat where the source publishes one reading only', () => {
    expect(conditionsPromptBlock({ pressureMb: 1010.1 }))
      .toMatch(/one observation, so there is no trend in it/);
  });

  it('refuses to call a dead barometer steady', () => {
    const b = conditionsPromptBlock({ pressureStale: true });
    expect(b).toMatch(/too old to use/);
    expect(b).toMatch(/do not treat the gap as "steady"/);
  });

  it('gives the level trend and says which quantity it measures', () => {
    const b = conditionsPromptBlock({ trend24h: 0.34, trend7d: -1.2, trendUnits: 'ft',
                                      trendMeasures: 'pool elevation', trendCoversHours: 168 });
    expect(b).toMatch(/pool elevation RISING — 24 h \+0\.34 ft, 7 d −1\.20 ft/);
    expect(b).toMatch(/covering 7 days/);
    expect(b).toMatch(/rising water pushes fish shallow/);
  });

  it('says a trend it cannot reach back far enough for rather than printing a zero', () => {
    expect(conditionsPromptBlock({ trend24h: 0.1, trendUnits: 'ft' }))
      .toMatch(/7 d not enough series to say/);
  });

  it('gives generation as a SIZE, not only as a boolean', () => {
    const b = conditionsPromptBlock({ tvaDischargeCfs: 14200, tvaTailwaterFt: 821.4 });
    expect(b).toMatch(/discharge 14,200 ft³\/s · tailwater 821\.4 ft/);
    expect(b).toMatch(/cannot hold position in/);
  });

  it('gives the operator target the level should be judged against', () => {
    expect(conditionsPromptBlock({ tvaVsGuideFt: 1.4, tvaGuideFt: 1020 }))
      .toMatch(/Against TVA's guide curve: \+1\.4 ft, guide 1020 ft/);
    expect(conditionsPromptBlock({ usaceTargetFt: 660, usaceProject: 'HARTWELL' }))
      .toMatch(/Corps target pool 660 ft — what HARTWELL is SUPPOSED to be at today/);
  });

  it('gives the Duke guide curve and the rank, with the caveat attached', () => {
    const b = conditionsPromptBlock({ dukeGuide: {
      vs_target_ft: -1.1, full_pond_ft: 225.5, today: { target: 98.9, min: 97, max: 100 },
      vs_same_date: { band: 'higher than usual', higher_than: 24, n: 30, window_days: 3,
                      from: 2021, to: 2026 },
      caveat: 'They took it to 99 to float a barge near the dam.' } });
    expect(b).toMatch(/−1\.1 ft against a guide curve of 98\.9/);
    expect(b).toMatch(/higher than 24 of 30 readings/);
    expect(b).toMatch(/float a barge/);
  });

  it('gives the seasonal swing, because the chart was sounded at full pool', () => {
    expect(conditionsPromptBlock({ seasonalDrawdownFt: 4, seasonalDrawdownFrom: 'USACE' }))
      .toMatch(/moved 4 ft across a year by USACE/);
  });

  it('gives the drought rule the water will be run under', () => {
    const b = conditionsPromptBlock({
      droughtNotice: { stage: 2, suspends_recreation_flows: true,
                       text: 'The basin is in Stage 2 of the Low Inflow Protocol.' },
      droughtLevel: { level: 'Drought Level 1', ft: 654.5, comment: 'Reduce releases to 3,600 cfs' } });
    expect(b).toMatch(/Low Inflow Protocol — Stage 2/);
    expect(b).toMatch(/recreation flow releases are SUSPENDED/i);
    expect(b).toMatch(/Drought Level 1 \(654\.5 ft\) — Reduce releases to 3,600 cfs/);
  });

  it('gives the MEASURED turbidity and lets it outrank the modelled word', () => {
    const b = conditionsPromptBlock({ turbidityFnu: 14.4, turbidityGauge: 'CONGAREE AT CFMS1',
                                      clarity: 'Clear', clarityIsMeasured: false });
    expect(b).toMatch(/Turbidity 14\.4 FNU — MEASURED, USGS 63680/);
    expect(b).toMatch(/colour, flash and profile/);
    // The modelled "Clear" must not be printed beside a measured 14.4 FNU.
    expect(/Clarity Clear/.test(b)).toBe(false);
  });

  it('labels a modelled clarity as modelled where there is no reading', () => {
    expect(conditionsPromptBlock({ clarity: 'Stained', clarityIsMeasured: false,
                                   clarityNote: 'No clarity measurements exist for this water.' }))
      .toMatch(/MODELLED FROM RAINFALL, not measured/);
  });

  it('names what this water does not measure, so no value is invented for it', () => {
    const b = conditionsPromptBlock({
      unpublished: [{ code: '63680', label: 'turbidity' }, { code: '00300', label: 'dissolved oxygen' }],
      silent: [{ code: '00010', label: 'water temperature', usgs_site: '02168504',
                 reason: 'no_reading' }] });
    expect(b).toMatch(/NOT MEASURED ON THIS WATER — no gauge bound to it publishes turbidity, dissolved oxygen/);
    expect(b).toMatch(/Do not supply a value for any of them/);
    expect(b).toMatch(/MEASURED HERE BUT NOT REPORTING TODAY — water temperature \(site 02168504, no reading\)/);
  });

  it('gives the flow anomaly its period of record', () => {
    expect(conditionsPromptBlock({ flowAnomaly: 0.5, flowAnomalyOf: 'Wateree River near Camden',
                                   flowPeriod: '1929-2025', flowYears: 96 }))
      .toMatch(/Flow versus normal \+0\.5 for Wateree River near Camden/);
    expect(conditionsPromptBlock({ flowAnomaly: 0.5, flowYears: 96 }))
      .toMatch(/96 years of record/);
  });

  it('offers an anemometer on the water beside the forecast, not instead of it', () => {
    const b = conditionsPromptBlock({ windMeasured: { mph: 1.1, gustMph: 2.2, dirDeg: 160,
      station: 'WATS1', kmFromWater: 0.1, ageMin: 66, stale: true } });
    expect(b).toMatch(/Wind MEASURED on this water: 1 mph gusting 2 from 160°/);
    expect(b).toMatch(/NDBC WATS1, 0\.1 km out, 66 min old/);
    expect(b).toMatch(/conditions\.windByHour/);
  });

  it('says nothing about wind when the only reading is a model from another county', () => {
    expect(/Wind MEASURED/.test(conditionsPromptBlock({ windMph: 9, windDirDeg: 200,
      windFrom: 'model', obsStation: 'COLUMBIA METRO AIRPORT', obsKmAway: 54 }))).toBe(false);
  });

  it('reports a refused release schedule as a gap rather than a no-release day', () => {
    expect(conditionsPromptBlock({ releasesRefused: 'the operator page did not answer' }))
      .toMatch(/That is a gap, not a no-release day/);
  });

  it('survives a sub-object whose shape changed upstream', () => {
    // dukeGuide arrives shaped by the Worker. A shape that moved is a missing
    // line, not a plan with no conditions in it.
    const b = conditionsPromptBlock({ waterTempF: 71.2,
                                      dukeGuide: { vs_same_date: 'not an object any more' } });
    expect(b).toMatch(/Water temperature 71\.2 °F/);
  });
});
