import { describe, it, expect } from './expect-shim.mjs';
import { assemblePlan } from '../js/modules/plan-assemble.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';
import { depthWindow } from '../js/data/lure-knowledge.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE SHALLOWEST WATER ON THE LEG IS A CEILING ON THE BAIT
//
// Ryan, 2026-08-11: "the shallowest that water runs is 20ft... well then even if the water is
// 25-35ft don't give me a bait that runs deeper than 20ft with the lead and speed that you gave."
//
// The band the fish are in is NOT the constraint — the sounder answers that on the day. The
// constraint is the one shoal on the pass, and it was the only number in this whole system that
// the app had measured, showed to Ryan in the reasons, and never told the model.
//
// These tests use REAL inventory and REAL lure physics rather than a stub, because the whole
// point is that the app can compute this and does not have to ask. A 3" Lipless Crankbait on
// 120 ft of lead at 2.0 mph runs to 25 ft — that is `depthWindow` inverting `leadForDepth`, not
// a number written here.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const LIPLESS = TACKLE_INVENTORY.find((l) => l.type === 'lipless' && l.weightOz === 0.5);
const lureByName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;

const LEG = (maxRunDepthFt) => ({
  runId: 'wateree_lake#81', lengthM: 1800, depthFt: 28, maxRunDepthFt,
  start: [-80.70, 34.35], end: [-80.68, 34.36],
  coordinates: [[-80.70, 34.35], [-80.69, 34.355], [-80.68, 34.36]],
  passes: [], speedMph: 2.0,
});

const build = (leg, rod, extra = {}) => assemblePlan({
  candidates: [leg], launch: [-80.71, 34.348],
  loadout: { rods: [rod] },
  deploy: { [leg.runId]: { port: rod.id } },
  stops: [], changes: [], launchTime: '06:30', returnTime: '13:00', usableAh: 80,
  lureByName, ...extra,
});

describe('a bait may not run deeper than the shallowest water on the leg', () => {
  it('shortens the lead rather than refusing the plan', () => {
    // 120 ft of lead puts this bait at 25 ft. The leg has an 18 ft rise on it.
    expect(depthWindow(LIPLESS, { speedMph: 2.0, leadFt: 120 }).max).toBe(25);
    const rod = { id: 'R1', lure: LIPLESS.name, rig: 'snap', role: 'troll', leadFt: 120,
                  runsDepthFt: [21, 25] };
    const plan = build(LEG(18), rod);
    expect(rod.leadFt < 120).toBe(true);
    // And the shortened lead must actually clear — not merely be shorter.
    expect(depthWindow(LIPLESS, { speedMph: 2.0, leadFt: rod.leadFt }).max <= 18).toBe(true);
    const said = plan.warnings.filter((w) => /shortened the lead/.test(w));
    expect(said.length).toBe(1);
    // The number Ryan would look for has to be IN the sentence, both of them.
    expect(/18 ft/.test(said[0]) && /25 ft/.test(said[0])).toBe(true);
  });

  it('leaves a bait that already clears completely alone', () => {
    const rod = { id: 'R1', lure: LIPLESS.name, rig: 'snap', role: 'troll', leadFt: 120,
                  runsDepthFt: [21, 25] };
    const plan = build(LEG(34), rod);
    expect(rod.leadFt).toBe(120);
    expect(plan.warnings.some((w) => /shortened the lead/.test(w))).toBe(false);
  });

  it('reads the ceiling off maxRunDepthFt, NOT off the leg\'s nominal depth', () => {
    // This is the entire distinction. `depthFt` says 28 and the water really is that deep for
    // most of the pass; `maxRunDepthFt` says one spot on it comes up to 18. Sizing the bait off
    // the first number is exactly the mistake.
    const rod = { id: 'R1', lure: LIPLESS.name, rig: 'snap', role: 'troll', leadFt: 120 };
    const leg = LEG(18);
    expect(leg.depthFt).toBe(28);
    build(leg, rod);
    expect(depthWindow(LIPLESS, { speedMph: 2.0, leadFt: rod.leadFt }).max <= 18).toBe(true);
  });

  it('corrects a runsDepthFt the model got wrong', () => {
    // The model claims 12-14 ft while asking for 120 ft of lead, which is 25. Nothing has ever
    // checked one against the other, and the claim is what a reader believes.
    const rod = { id: 'R1', lure: LIPLESS.name, rig: 'snap', role: 'troll', leadFt: 120,
                  runsDepthFt: [12, 14] };
    const plan = build(LEG(34), rod);
    expect(plan.warnings.some((w) => /says it runs to 14 ft/.test(w))).toBe(true);
    expect(rod.runsDepthFt[1]).toBe(25);
  });

  it('does nothing at all, and claims nothing, without a lure resolver', () => {
    // An absent input must not become an assertion — same rule the missing shoreline follows.
    const rod = { id: 'R1', lure: LIPLESS.name, rig: 'snap', role: 'troll', leadFt: 120 };
    const plan = assemblePlan({
      candidates: [LEG(18)], launch: [-80.71, 34.348],
      loadout: { rods: [rod] }, deploy: { 'wateree_lake#81': { port: 'R1' } },
      stops: [], changes: [], launchTime: '06:30', returnTime: '13:00', usableAh: 80,
    });
    expect(rod.leadFt).toBe(120);
    expect(plan.warnings.some((w) => /lead|runs to/.test(w))).toBe(false);
  });
});
