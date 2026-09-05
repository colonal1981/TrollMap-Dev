// WHAT THE WATER IS DOING TODAY, and the two prompts it writes.
//
// SmartPlan v2 planned every trip on clarity, temperature, pool level and wind. On a RIVER that
// leaves out the number that decides the day — Ryan's own reasoning, already written into
// conditionsStrip(): "a river at a normal stage pushing 8,000 cfs is a different trip from the
// same stage at 400, and the stage alone does not say which." On the COAST it leaves out the
// tide, which is the only thing that moves at all.
//
// Almost none of it was new data. /conditions/<slug> has returned flow, flood category, dam
// generation, projected releases, tidal current, surge and salinity since it was written, and the
// strip above the map has painted them the whole time. The planner was asking a smaller question
// of the same Worker route.
import { describe, it, expect } from './expect-shim.mjs';
import { fetchWaterState, launchMoment } from '../js/modules/plan-preflight.js';
import { coastalPromptBlock, riverPromptBlock, buildPlanRequest } from '../js/modules/plan-prompt.js';

const DAY = '2026-08-20';

/** A /conditions envelope as readConditions() shapes one. Only the fields under test are set. */
const conditions = (over = {}) => ({ ok: true, error: null, featureType: null, ...over });

const RIVER = conditions({
  featureType: 'river',
  flowCfs: 8120, flowBand: 'above the 75th percentile', flowMedian: 2400,
  flowGauge: 'USGS 02169500 Congaree River at Columbia',
  stageFt: 9.4, stageBasis: 'gage height', stageVsActionFt: -2.1,
  generatingNow: true,
  releases: { kind: 'projected', next: { mileMarkerName: 'Bates Bridge', at: `${DAY}T14:00`, cfs: 12000 } },
});

const TIDE = {
  station: '8665530', stage: 'ebb', stageLabel: 'Falling (ebb)',
  heightFt: 3.24, rangeFt: 5.37,
  nextEvent: { type: 'low', at: new Date(`${DAY}T11:42:00`), heightFt: 0.31 },
};

const call = (over = {}) => fetchWaterState('Congaree River', DAY, {
  worker: 'https://w', launchTime: '06:00',
  fetchConditions: async () => RIVER,
  fetchTide: async () => null,
  fetchIntrusion: async () => null,
  ...over,
});

// A LAKE WITH A DAM IS NOT A RIVER, AND THE PROMPT USED TO SAY IT WAS.
//
// fetchWaterState() fills `river` when the water has a flow reading OR a generating dam, which is
// correct -- an impoundment on the Wateree or the Catawba has both, and both matter. But
// riverPromptBlock() gated on the mere presence of that object, opened with "RIVER — THE FLOW IS
// THE DAY", and asked the model where the seams and eddies set up and whether a leg was worth
// running upstream. On 13,700 acres of Lake Wateree the model did as it was told:
//
//     "The low flow (1,020 ft³/s) means fish will be less concentrated in current seams and more
//      likely to be found on main lake structure."
//
// Ryan: "whats up with this on a lake?" The discriminator -- `featureType` -- was on the object
// the whole time and nothing read it.
const LAKE = conditions({
  featureType: 'lake',
  flowCfs: 1020, flowBand: 'below the 25th percentile', flowMedian: 2400,
  flowGauge: 'USGS 02148000 Wateree River near Camden',
  stageFt: 97.4, generatingNow: true,
});

const lakeState = (over = {}) => fetchWaterState('Wateree Lake (Kershaw Co, SC)', DAY, {
  worker: 'https://w', launchTime: '06:00',
  fetchConditions: async () => LAKE,
  fetchTide: async () => null,
  fetchIntrusion: async () => null,
  ...over,
});

describe('the flow block knows what kind of water it is on', () => {
  it('a lake with an inflow gauge still carries the river object', async () => {
    // Not a bug -- this is what lets the generation and the tailrace reach the plan at all.
    const ws = await lakeState();
    expect(ws.featureType).toBe('lake');
    expect(ws.river).toBeTruthy();
    expect(ws.river.flowCfs).toBe(1020);
  });

  it('but it is NOT told the flow is the day', async () => {
    const out = riverPromptBlock(await lakeState());
    expect(/RIVER — THE FLOW IS THE DAY/.test(out)).toBe(false);
    expect(/IMPOUNDMENT/.test(out)).toBe(true);
  });

  it('and it is told in as many words not to write river prose', async () => {
    const out = riverPromptBlock(await lakeState());
    for (const word of ['seams', 'eddies', 'bend', 'upstream']) {
      // The words appear once, inside the prohibition. What must not happen is the model being
      // ASKED for them.
      expect(out.includes('Do NOT write about seams, eddies, which side of a bend, or')).toBe(true);
      expect(word.length > 0).toBe(true);
    }
    expect(/GAUGE READING ON AN IMPOUNDMENT/.test(out)).toBe(true);
  });

  it('the facts still travel — only the framing changed', async () => {
    const out = riverPromptBlock(await lakeState());
    expect(out).toMatch(/1,020 ft³\/s/);
    expect(out).toMatch(/below the 25th percentile/);
    expect(out).toMatch(/GENERATING/);
    expect(out).toMatch(/97\.4 ft/);
  });

  it('a river is unchanged, which is the half that already worked', async () => {
    const out = riverPromptBlock(await call());
    expect(/RIVER — THE FLOW IS THE DAY/.test(out)).toBe(true);
    expect(out).toMatch(/where the seams and eddies set up/);
    expect(/IMPOUNDMENT/.test(out)).toBe(false);
  });
});

describe('launchMoment', () => {
  it('reads the tide at the launch, not at noon', () => {
    // A tide stage at noon is not the tide stage at 06:00, and on a flat that is the difference
    // between a target and dry ground.
    expect(launchMoment(DAY, '06:00').getHours()).toBe(6);
    expect(launchMoment(DAY, '6:30 AM').getMinutes()).toBe(30);
    expect(launchMoment(DAY, '1:15 PM').getHours()).toBe(13);
    expect(launchMoment(DAY, '12:00 AM').getHours()).toBe(0);
  });

  it('falls back to midday rather than to now', () => {
    expect(launchMoment(DAY, '').getHours()).toBe(12);
    expect(launchMoment(DAY, null).getHours()).toBe(12);
  });
});

describe('fetchWaterState — the river half', () => {
  it('carries the flow, the band it sits in, and the gauge that said so', async () => {
    const ws = await call();
    expect(ws.featureType).toBe('river');
    expect(ws.river.flowCfs).toBe(8120);
    expect(ws.river.flowVsNormal).toBe('above the 75th percentile');
    expect(ws.river.flowMedianCfs).toBe(2400);
    expect(ws.river.flowGauge).toMatch(/02169500/);
  });

  it('prefers the tidally filtered flow and says that is what it is', async () => {
    // A tidal river's raw discharge reverses twice a day, so its instantaneous value is not the
    // river's flow. Reporting it unlabelled would be reporting the tide as the river.
    const ws = await call({ fetchConditions: async () => conditions({
      featureType: 'river', flowCfs: -1400, tidalFlowCfs: 900 }) });
    expect(ws.river.flowCfs).toBe(900);
    expect(ws.river.flowIsTidallyFiltered).toBe(true);
    expect(riverPromptBlock(ws)).toMatch(/tidally filtered/);
  });

  it('generation travels as a boolean, because false is as useful as true', async () => {
    const on = await call();
    expect(on.river.generatingNow).toBe(true);
    const off = await call({ fetchConditions: async () => conditions({
      featureType: 'river', flowCfs: 400, generatingNow: false }) });
    // "not generating" is the reason nothing is moving — dropping it as falsy would lose that.
    expect(off.river.generatingNow).toBe(false);
    expect(riverPromptBlock(off)).toMatch(/NOT GENERATING/);
  });

  it('only a PROJECTED release travels', async () => {
    // An observed discharge is already `flowCfs`; printing it again as a schedule is the mistake
    // `kind` exists to prevent.
    const ws = await call();
    expect(ws.river.projectedRelease.mileMarkerName).toBe('Bates Bridge');
    const obs = await call({ fetchConditions: async () => conditions({
      featureType: 'river', flowCfs: 400, releases: { kind: 'observed', next: { cfs: 9000 } } }) });
    expect(obs.river.projectedRelease).toBeUndefined();
  });

  it('does not name the flood category on an ordinary day', async () => {
    // "no_flooding" is the normal state; saying it every day trains you to stop reading the line.
    const ws = await call({ fetchConditions: async () => conditions({
      featureType: 'river', flowCfs: 400, floodCategory: 'no_flooding' }) });
    expect(ws.river.floodCategory).toBeUndefined();
    const flood = await call({ fetchConditions: async () => conditions({
      featureType: 'river', flowCfs: 40000, floodCategory: 'minor_flooding' }) });
    expect(flood.river.floodCategory).toBe('minor flooding');
    expect(riverPromptBlock(flood)).toMatch(/FLOOD STAGE/);
  });

  it('an out-of-service gauge is stated, not inferred around', async () => {
    const ws = await call({ fetchConditions: async () => conditions({
      featureType: 'river', stageFt: 4.2, gaugeOutOfService: true, generatingNow: false }) });
    expect(ws.river.flowCfs).toBeUndefined();
    const b = riverPromptBlock(ws);
    expect(b).toMatch(/OUT OF SERVICE/);
    expect(b).toMatch(/Do not infer one from the stage/);
  });

  it('a lake with no flow gets no river block at all', async () => {
    const ws = await call({ fetchConditions: async () => conditions({
      featureType: 'lake', belowFullPoolFt: 1.2 }) });
    expect(ws.river).toBeNull();
    expect(riverPromptBlock(ws)).toBe('');
  });

  // WAS `expect(ws).toBeNull()` UNTIL 2026-09-05, and that was the bug written down as an
  // expectation. A reservoir sitting 1.2 ft below full pool with no river block and no tide is
  // MOST OF THE REGISTRY, and returning null there threw away the level, the almanac, the water
  // temperature and the drought notice along with the river block that was correctly absent.
  // poolPromptBlock() reads belowFullPoolFt off this object, so "WHERE THE WATER IS TODAY" --
  // the block telling the model every charted depth was sounded at full pool -- printed on
  // nothing, ever. The absence of a river block is the claim; the absence of the water is not.
  it('keeps the lake itself when there is no river and no tide', async () => {
    const ws = await call({ fetchConditions: async () => conditions({
      featureType: 'lake', belowFullPoolFt: 1.2, levelFt: 98.8, fullPoolFt: 100,
      civilDawn: '06:34', sunrise: '06:59', sunset: '19:52', civilDusk: '20:17',
      waterTempF: 85.1 }) });
    expect(ws).not.toBeNull();
    expect(ws.belowFullPoolFt).toBe(1.2);
    expect(ws.civilDawn).toBe('06:34');
    expect(ws.sunset).toBe('19:52');
    expect(ws.waterTempF).toBe(85.1);
    expect(ws.featureType).toBe('lake');
  });

  it('still returns null when nothing answered at all', async () => {
    const ws = await call({ fetchConditions: async () => null });
    expect(ws).toBeNull();
  });
});

describe('fetchWaterState — the tidal half', () => {
  const coastal = (over = {}) => fetchWaterState('Charleston Harbor, SC', DAY, {
    worker: 'https://w', launchTime: '06:00', species: 'Red Drum (Redfish)',
    fetchConditions: async () => conditions({ featureType: 'coastal', currentKn: 1.4,
      currentType: 'ebb', surgeFt: 0.62, salinityPpt: 22.4 }),
    fetchTide: async () => TIDE,
    fetchIntrusion: async () => ({ active: false }),
    ...over,
  });

  it('reads the stage from the hi/lo series, which /conditions cannot give', async () => {
    // "next event is high" cannot separate a flooding tide from slack high water — opposite days
    // on a grass flat, and the key DEPTH_BANDS and tacticalNote() are indexed by.
    const ws = await coastal();
    expect(ws.tidal.stage).toBe('ebb');
    expect(ws.tidal.stageLabel).toBe('Falling (ebb)');
    expect(ws.tidal.heightFtAboveMllw).toBe(3.2);
    expect(ws.tidal.dailyRangeFt).toBe(5.4);
    expect(ws.tidal.nextEvent).toEqual({ type: 'low', at: '11:42', heightFt: 0.3 });
  });

  it('resolves the species depth band and tactic off that stage', async () => {
    const ws = await coastal();
    expect(ws.tidal.depthBandFt).toEqual([4, 8]);      // redfish on the ebb
    expect(ws.tidal.tactic).toMatch(/oyster points/);
    // A different stage is a different band, which is the whole reason the stage is fetched.
    const flood = await coastal({ fetchTide: async () => ({ ...TIDE, stage: 'flood' }) });
    expect(flood.tidal.depthBandFt).toEqual([1, 4]);
  });

  it('a species coastal-scoring.js does not know gets the rules and no band', async () => {
    const ws = await coastal({ species: 'Sheepshead' });
    expect(ws.tidal.depthBandFt).toBeUndefined();
    expect(ws.tidal.tactic).toBeUndefined();
    expect(coastalPromptBlock(ws)).toContain('STRICT SAFETY CONSTRAINT');
  });

  it('surge under a third of a foot is dropped as noise', async () => {
    const ws = await coastal({ fetchConditions: async () => conditions({
      featureType: 'coastal', surgeFt: 0.1 }) });
    expect(ws.tidal.surgeVsPredictedFt).toBeUndefined();
  });

  it('a dead tide station does not cost the coast its current or salinity', async () => {
    // allSettled per source, not one try/catch over the lot.
    const ws = await coastal({ fetchTide: async () => { throw new Error('NOAA 503'); } });
    expect(ws.tidal.stage).toBeUndefined();
    expect(ws.tidal.currentKn).toBe(1.4);
    expect(ws.tidal.salinityPpt).toBe(22.4);
    expect(coastalPromptBlock(ws)).toMatch(/TIDE STAGE IS UNKNOWN/);
  });

  it('a dead conditions route does not cost the coast its tide', async () => {
    const ws = await coastal({ fetchConditions: async () => { throw new Error('502'); } });
    expect(ws.tidal.stage).toBe('ebb');
  });

  it('a failed /conditions is dropped rather than read as "no gauge"', async () => {
    // readConditions(null) returns a full object of nulls plus `error`, which looks exactly like
    // a water with no gauge if you only look at the fields.
    const ws = await coastal({ fetchConditions: async () => conditions({
      ok: false, error: 'HTTP 500', currentKn: 1.4 }) });
    expect(ws.tidal.currentKn).toBeUndefined();
    expect(ws.tidal.stage).toBe('ebb');
  });

  it('freshwater intrusion travels only when it is active', async () => {
    const quiet = await coastal();
    expect(quiet.tidal.freshwaterIntrusion).toBeUndefined();
    const loud = await coastal({ fetchIntrusion: async () => ({
      active: true, severity: 2, message: 'Santee discharge is 2.1x its 30-day mean',
      rivers: ['Santee River'] }) });
    expect(loud.tidal.freshwaterIntrusion.rivers).toBe('Santee River');
  });

  it('nothing answered at all is null, which is not the same as a water with no gauge', async () => {
    const ws = await coastal({
      fetchConditions: async () => null,
      fetchTide: async () => null,
      fetchIntrusion: async () => null,
    });
    // A coastal zone with neither source answering still carries the zone name and station-less
    // tidal marker, so the STRICT SAFETY CONSTRAINT is written either way.
    expect(ws && ws.tidal && ws.tidal.zone).toBe('Charleston Harbor, SC');
    expect(coastalPromptBlock(ws)).toContain('STRICT SAFETY CONSTRAINT');
  });
});

describe('the blocks reach buildPlanRequest', () => {
  const base = {
    candidates: [], water: 'Congaree River', ramp: 'Bates Bridge', date: DAY,
    launchTime: '06:00', returnTime: '15:00', species: ['Striped Bass'],
    conditions: {}, tackle: ['Deep Crankbait'], snapEligible: ['Deep Crankbait'],
  };

  it('a reservoir prompt is unchanged by this whole change', () => {
    const a = buildPlanRequest(base).user;
    const b = buildPlanRequest({ ...base, waterState: null }).user;
    expect(a).toBe(b);
    expect(a.includes('STRICT SAFETY CONSTRAINT')).toBe(false);
    expect(a.includes('THE FLOW IS THE DAY')).toBe(false);
  });

  it('a river prompt gains the flow and keeps everything else', async () => {
    const ws = await call();
    const u = buildPlanRequest({ ...base, waterState: ws }).user;
    expect(u).toContain('THE FLOW IS THE DAY');
    expect(u).toContain('8,120 ft³/s');
    // The rules that were already there are still there, in front of it.
    expect(u).toContain('TWO RODS IN THE WATER ON EVERY SINGLE LEG');
    expect(u).toContain('RETURN EXACTLY THIS SHAPE');
  });

  it('a coastal prompt gains the restriction BEFORE the return shape', () => {
    const u = buildPlanRequest({ ...base, waterState: {
      featureType: 'coastal', tidal: { zone: 'Charleston Harbor, SC', stage: 'ebb' } } }).user;
    const guard = u.indexOf('STRICT SAFETY CONSTRAINT');
    const shape = u.indexOf('RETURN EXACTLY THIS SHAPE');
    expect(guard > 0).toBe(true);
    expect(guard < shape, 'the safety rule must come before the answer format').toBe(true);
  });
});
