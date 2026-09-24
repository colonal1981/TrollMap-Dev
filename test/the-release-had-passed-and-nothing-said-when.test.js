/**
 * test/the-release-had-passed-and-nothing-said-when.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Five fields the operators publish that the Worker parsed and nothing read, all found by the
 * register on 2026-09-23 and wired on 2026-09-24:
 *
 *   Duke   Recedes            when a release has passed a marker -- for a kayak, when the water
 *                             is safe again. 18:48 arrival, 23:48 recedes on the Wateree fixture.
 *   Duke   LowInputStage      the Low Inflow Protocol stage, on the level row every Duke lake has.
 *   TVA    LowExptd/UpperExptd  the range TVA says it will hold the lake in today.
 *   TVA    FloodGuide         the higher curve: above it the operator must pass water.
 *   USACE  Bottom of Conservation  the floor of the band whose top the app already showed.
 *
 * And one that was read wrong: the plan prompt looked for `at` on a Duke arrival, which carries
 * `arrival`, so the release line reached the model with no time on it.
 *
 *   node --test test/the-release-had-passed-and-nothing-said-when.test.js
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { releasePassingNow, riverArrivals, easternClock, chartDatumShape } from '../Worker/conditions.js';
import { normalizeDukeRow } from '../Worker/worker-data.js';
import { readConditions } from '../js/utils/water-conditions.js';
import { conditionsPromptBlock, riverPromptBlock } from '../js/modules/plan-prompt.js';

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const FX = JSON.parse(src('./fixtures/operators/duke-flow-arrivals-1.2026-09-23.json'));
const LEVEL = JSON.parse(src('./fixtures/operators/duke-current-level.2026-09-23.json'));

// The fixture's one release, as fetchDukeFlowArrivals shapes it. 2026-09-24 is EDT.
const ev = FX.Dams[0].FlowArrivalRecessions[0];
const ARR = Date.parse(`${ev.Arrival}-04:00`);
const REC = Date.parse(`${ev.Recedes}-04:00`);
const wateree = { damName: ev.DamName, mileMarkerName: ev.MileMarkerName, arrival: ev.Arrival,
                  recedes: ev.Recedes, arrivalEpoch: ARR, recedesEpoch: REC };
// A Bridgewater release at the top of the chain, published on the same basin schedule.
const morganton = { damName: 'Bridgewater', mileMarkerName: 'Morganton Greenway',
                    arrival: '2026-09-24T17:30:00', recedes: '2026-09-24T21:00:00',
                    arrivalEpoch: Date.parse('2026-09-24T17:30:00-04:00'),
                    recedesEpoch: Date.parse('2026-09-24T21:00:00-04:00') };
const sched = { basinName: FX.RiverBasinName, basinId: 1, arrivals: [morganton, wateree] };
const GAUGES = ['Wateree River near Camden, SC', 'Wateree River below Wateree Dam'];
const AT = (hhmm) => Date.parse(`2026-09-24T${hhmm}:00-04:00`);

describe('a release that has arrived and not receded is PASSING, and says until when', () => {
  it('passing between arrival and recedes, and not either side of it', () => {
    expect(releasePassingNow([wateree], AT('18:00')).length).toBe(0);
    expect(releasePassingNow([wateree], AT('18:48')).length).toBe(1);
    expect(releasePassingNow([wateree], AT('21:00')).length).toBe(1);
    expect(releasePassingNow([wateree], AT('23:48')).length).toBe(0);
  });

  it('an arrival with no recession time is not called passing -- nobody said when it ends', () => {
    expect(releasePassingNow([{ ...wateree, recedesEpoch: null }], AT('20:00')).length).toBe(0);
  });

  it('five hours, 23:48 Eastern, in Duke\'s own numbers', () => {
    expect((REC - ARR) / 36e5).toBe(5);
    expect(easternClock(REC)).toBe('11:48 PM');
  });
});

describe('/river speaks about THIS river\'s markers, passing and due', () => {
  it('the Morganton surge is not a fact about the Wateree', () => {
    const r = riverArrivals(sched, 'Wateree River (below Wateree Dam)', GAUGES, null, AT('17:45'));
    expect(r.agrees).toBe(true);
    expect(r.passing.length).toBe(0);
    expect(r.upcoming.map((a) => a.mileMarkerName)).toEqual(['Highway 1/Highway 601 Landing']);
    expect(r.in_basin).toBe(2);
  });

  it('once it arrives it moves from upcoming to passing, instead of vanishing', () => {
    const r = riverArrivals(sched, 'Wateree River (below Wateree Dam)', GAUGES, null, AT('20:00'));
    expect(r.passing.map((a) => a.mileMarkerName)).toEqual(['Highway 1/Highway 601 Landing']);
    expect(r.upcoming.length).toBe(0);
  });

  it('the route uses it, and a passing release is a no-go without a position', () => {
    const w = src('../Worker/trollmap-worker.js');
    expect(w).toContain('riverArrivals(sched, cfg.label || key, gaugeNames, basinRow, Date.now())');
    expect(w).not.toContain('next: sched.arrivals[0],');
    expect(w).toContain('passing_now: mine.passing');
    expect(w).toMatch(/A DAM RELEASE IS PASSING \$\{p\.mileMarkerName\} NOW/);
    expect(w).toContain('easternClock(next.recedesEpoch)');
  });

  it('the plan builder and the card show when it has passed', () => {
    const pb = src('../js/modules/plan-builder.js');
    expect(pb).toContain('d.dam_schedule?.passing_now');
    expect(pb).toContain('clockET(ev.recedesEpoch)');
    const card = src('../js/modules/conditions-strip.js');
    expect(card).toContain('it.recedes ? `, passed by');
  });
});

describe('the plan prompt gets the release time it was missing', () => {
  const ws = { featureType: 'river', river: { projectedRelease: wateree } };
  it('reads `arrival`, which is what Duke sends, and `recedes` beside it', () => {
    const text = riverPromptBlock(ws, { isRiver: true });
    expect(text).toContain('Highway 1/Highway 601 Landing at 18:48, passed by 23:48');
  });
});

describe('Duke\'s Low Inflow Protocol stage, off the level row', () => {
  const b = { slug: 'wateree_lake', display_name: 'Wateree Lake (Kershaw Co, SC)', feature_type: 'lake' };
  it('Wateree\'s row carries Stage 2 and the card object gets it, dated', () => {
    const d = normalizeDukeRow(LEVEL[0]);
    const cd = chartDatumShape(b, { duke: d });
    expect(cd.lip_stage).toBe(2);
    expect(cd.lip_stage_as_of).toBe('2026-09-22T21:25:23');
    const c = readConditions({ ok: true, water: { chart_datum: cd } });
    expect(c.dukeLipStage).toBe(2);
  });

  it('-1 is "none declared": no stage, and the raw value kept apart', () => {
    const d = normalizeDukeRow(LEVEL[3]);          // Tillery, LowInputStage -1
    const cd = chartDatumShape({ ...b, slug: 'lake_tillery', display_name: 'Lake Tillery' }, { duke: d });
    expect(cd.lip_stage).toBe(null);
    expect(cd.lip_stage_raw).toBe(-1);
  });

  it('with no guide curve, the prompt still says the stage', () => {
    const c = readConditions({ ok: true, water: { chart_datum: { lip_stage: 3, lip_stage_as_of: '2026-09-22T21:25:33' } } });
    expect(conditionsPromptBlock(c)).toContain('Stage 3 of its Low Inflow Protocol (level feed, 2026-09-22)');
  });
});

describe('TVA\'s range and flood guide, and the Corps\' floor, reach the card object and the prompt', () => {
  const c = readConditions({ ok: true, water: {
    tva: { guide_curve_ft: 1062, vs_guide_ft: -1.2, flood_guide_ft: 1065.5, expected_range_ft: [1060.5, 1062.5] },
    usace: { project: 'Hartwell', conservation_pool_ft: 660, bottom_of_conservation_ft: 625 },
  } });

  it('every one is read', () => {
    expect(c.tvaFloodGuideFt).toBe(1065.5);
    expect(c.tvaExpectedRangeFt).toEqual([1060.5, 1062.5]);
    expect(c.usaceFloorFt).toBe(625);
  });

  it('and said', () => {
    const text = conditionsPromptBlock(c);
    expect(text).toContain('between 1060.5 and 1062.5 ft today');
    expect(text).toContain('flood guide is 1065.5 ft');
    expect(text).toContain('conservation band runs 625–660 ft');
  });

  it('a half-published range is not a range', () => {
    const half = readConditions({ ok: true, water: { tva: { expected_range_ft: [1060.5, null] } } });
    expect(half.tvaExpectedRangeFt).toBe(null);
  });
});
