import { describe, it, expect } from './expect-shim.mjs';
import { assemblePlan } from '../js/modules/plan-assemble.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';

// ---------------------------------------------------------------------------
// Why this test exists
//
// Ryan, 2026-09-06, reading the spread on a Wateree plan:
//
//   "MR Crankbait (6-12ft) ... 6–10ft
//    you want me to fish at 6-10 ft but give me a bait that is probably going
//    to run closer to 12 especially at 2mph"
//
// Two separate faults, both found from that one row.
//
// 1. The 6-10 was the model's. The inventory rates that bait 6-12 and
//    depthWindow() marks a rated pair `claimed: true` -- it came off the box,
//    nothing estimated it. The claim-vs-computed check used a `> 4` tolerance
//    that exists for lead-controlled windows, which ARE estimated by numeric
//    inversion; |10 - 12| is 2, so the invented number sailed through. On a
//    rated bait the tolerance is zero, which is not a threshold at all.
//
// 2. capBaitDepth() was passed exactly one number, the shallowest water on the
//    leg, and every check inside it asked whether the bait was deeper than the
//    bottom. Nothing ever asked whether it was anywhere near the FISH. That
//    plan's legs were 26-36, 15-25, 21-31 and 39-49 ft of water with a 6-12 ft
//    crankbait on the port rod of four of the five, and it raised no warning of
//    any kind, because it was not dragging.
//
// The band check is an interval test -- overlap or no overlap -- and it is a
// WARNING, not a refusal. A shallow bait at first light is a real choice.
// It is skipped entirely when `fishDepthStated` is false, because then the band
// is the depth of the WATER and "above the fish" is a claim about a quantity
// nobody measured.
// ---------------------------------------------------------------------------

const MR = TACKLE_INVENTORY.find((l) => /MR Crankbait/i.test(l.name));
const lureByName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;

const leg = (runId, depthFt, maxRunDepthFt) => ({
  runId, lengthM: 1800, depthFt, maxRunDepthFt,
  start: [-80.70, 34.35], end: [-80.68, 34.36],
  coordinates: [[-80.70, 34.35], [-80.69, 34.355], [-80.68, 34.36]],
  passes: [], speedMph: 2.0,
});

const build = (conditions, rodOver = {}) => {
  const warnings = [];
  const rod = { id: 'R1', lure: MR.name, rig: 'snap', role: 'troll', leadFt: 80, ...rodOver };
  const plan = assemblePlan({
    candidates: [leg('wateree_lake#81', 31, 26)], launch: [-80.71, 34.348],
    loadout: { rods: [rod] }, deploy: { 'wateree_lake#81': { port: 'R1' } },
    stops: [], changes: [], launchTime: '06:00', returnTime: '15:00', usableAh: 80,
    lureByName, conditions,
  });
  return { plan, warnings: plan.warnings || [] };
};

const FISH_DEEP = { depthBand: { ft: [26, 36], fishDepthStated: true, holding: 'suspended' } };
const FISH_SHALLOW = { depthBand: { ft: [4, 12], fishDepthStated: true, holding: 'suspended' } };
const WATER_ONLY = { depthBand: { ft: [3, 15], fishDepthStated: false, holding: 'suspended' } };

describe('capBaitDepth — too deep was caught and too shallow was invisible', () => {
  it('says so when the bait and the fish do not overlap at all', () => {
    const { warnings } = build(FISH_DEEP);
    const w = warnings.find((x) => /do not overlap/.test(x));
    expect(!!w).toBe(true);
    expect(w).toMatch(/ft ABOVE/);
    expect(w).toMatch(/fish are 26-36 ft/);
  });

  it('stays quiet when the bait is working the band', () => {
    const { warnings } = build(FISH_SHALLOW);
    expect(warnings.some((x) => /do not overlap/.test(x))).toBe(false);
  });

  it('will not claim "above the fish" when the band is a WATER depth', () => {
    // Wateree's stored profile today: [3,15] is "3-15 feet OF WATER", so there is
    // no fish depth to be above. The check must not fire on a quantity nobody measured.
    const { warnings } = build(WATER_ONLY);
    expect(warnings.some((x) => /do not overlap/.test(x))).toBe(false);
  });

  it('is silent rather than guessing when no band was supplied at all', () => {
    expect(build({}).warnings.some((x) => /do not overlap/.test(x))).toBe(false);
    expect(build(undefined).warnings.some((x) => /do not overlap/.test(x))).toBe(false);
  });
});

describe('a rated depth came off a box, so the model may not restate it', () => {
  it('flags the model narrowing a 6-12 bait to 6-10', () => {
    const { warnings } = build(WATER_ONLY, { runsDepthFt: [6, 10] });
    const w = warnings.find((x) => /going with the measured number/.test(x));
    expect(!!w).toBe(true);
    expect(w).toMatch(/says it runs to 10 ft/);
  });

  it('accepts the rated pair stated exactly', () => {
    const { warnings } = build(WATER_ONLY, { runsDepthFt: [6, 12] });
    expect(warnings.some((x) => /going with the measured number/.test(x))).toBe(false);
  });

  it('records the app number on every leg, not only the ones that warn', () => {
    const { plan } = build(WATER_ONLY, { runsDepthFt: [6, 12] });
    const troll = plan.legs.find((l) => l.type === 'troll');
    expect(troll.rodPlan.R1.runsDepthFt).toEqual([6, 12]);
    expect(troll.rodPlan.R1.depthClaimed).toBe(true);
  });
});
