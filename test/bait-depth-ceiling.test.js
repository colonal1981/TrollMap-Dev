import { describe, it, expect } from './expect-shim.mjs';
import { assemblePlan } from '../js/modules/plan-assemble.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';
import { depthWindow, leadForDepth } from '../js/data/lure-knowledge.js';
import { buildSmartPlanV2 } from '../js/modules/smart-plan-v2.js';

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

// WHAT THIS LEG FISHES. capBaitDepth used to write its answer into the rod, and the rod is one
// object shared by every leg -- so these tests read `rod.leadFt` after the fact and passed while
// the shallowest leg of the day was quietly setting the lead for all of them. The answer now
// lives on the leg, so that is where they read it.
const planned = (plan, legIndex, rodId) =>
  (plan.legs.filter((l) => l.type === 'troll')[legIndex].rodPlan || {})[rodId] || {};

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
    const got = planned(plan, 0, 'R1');
    expect(got.leadFt < 120).toBe(true);
    // And the shortened lead must actually clear — not merely be shorter.
    expect(depthWindow(LIPLESS, { speedMph: 2.0, leadFt: got.leadFt }).max <= 18).toBe(true);
    // THE BAG IS UNTOUCHED. This is the half that was wrong: the loadout still carries what the
    // model asked for, and only this leg fishes it short.
    expect(rod.leadFt).toBe(120);
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
    expect(planned(plan, 0, 'R1').leadFt).toBe(undefined);
    expect(plan.warnings.some((w) => /shortened the lead/.test(w))).toBe(false);
  });

  it('reads the ceiling off maxRunDepthFt, NOT off the leg\'s nominal depth', () => {
    // This is the entire distinction. `depthFt` says 28 and the water really is that deep for
    // most of the pass; `maxRunDepthFt` says one spot on it comes up to 18. Sizing the bait off
    // the first number is exactly the mistake.
    const rod = { id: 'R1', lure: LIPLESS.name, rig: 'snap', role: 'troll', leadFt: 120 };
    const leg = LEG(18);
    expect(leg.depthFt).toBe(28);
    const plan = build(leg, rod);
    const lead = planned(plan, 0, 'R1').leadFt;
    expect(depthWindow(LIPLESS, { speedMph: 2.0, leadFt: lead }).max <= 18).toBe(true);
  });

  it('corrects a runsDepthFt the model got wrong', () => {
    // The model claims 12-14 ft while asking for 120 ft of lead, which is 25. Nothing has ever
    // checked one against the other, and the claim is what a reader believes.
    const rod = { id: 'R1', lure: LIPLESS.name, rig: 'snap', role: 'troll', leadFt: 120,
                  runsDepthFt: [12, 14] };
    const plan = build(LEG(34), rod);
    expect(plan.warnings.some((w) => /says it runs to 14 ft/.test(w))).toBe(true);
    expect(planned(plan, 0, 'R1').runsDepthFt[1]).toBe(25);
    expect(rod.runsDepthFt).toEqual([12, 14]);   // the model's claim is left as the model's claim
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ONE SHALLOW LEG MUST NOT SET THE LEAD FOR THE DEEP ONES
//
// Ryan's 2026-08-30 Wateree plan, from its own warnings: "R2 on wateree_lake#362: a Fluke on
// 80 ft of lead at 2 mph runs to 15 ft, and the shallowest water on this leg is 6 ft — shortened
// the lead to 24 ft so it clears". Leg 2 IS the 6 ft line and that is the right call for leg 2.
// Legs 1 and 3 are the 24 ft line with the stripers at 15-27 ft, and every one of them came out
// at 24 ft of lead running 2-6 ft -- 78 of the day's 115 trolling minutes with a rod set nine to
// twenty-one feet above the fish, and nothing in the plan saying so.
//
// A lead is per-pass. You let line out on the deep leg and reel it in on the shallow one.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('the lead belongs to the leg, not to the day', () => {
  const DEEP = { ...LEG(34), runId: 'wateree_lake#46' };
  const SHALLOW = { ...LEG(8), runId: 'wateree_lake#362',
                    start: [-80.66, 34.37], end: [-80.64, 34.38],
                    coordinates: [[-80.66, 34.37], [-80.65, 34.375], [-80.64, 34.38]] };

  const twoLegs = () => {
    const rod = { id: 'R1', lure: LIPLESS.name, rig: 'snap', role: 'troll', leadFt: 120,
                  runsDepthFt: [21, 25] };
    return { rod, plan: assemblePlan({
      candidates: [DEEP, SHALLOW], launch: [-80.71, 34.348],
      loadout: { rods: [rod] },
      deploy: { [DEEP.runId]: { port: 'R1' }, [SHALLOW.runId]: { port: 'R1' } },
      stops: [], changes: [], launchTime: '06:30', returnTime: '13:00', usableAh: 80, lureByName,
    }) };
  };

  it('the shallow leg is shortened and the deep one is not', () => {
    const { plan } = twoLegs();
    const legs = plan.legs.filter((l) => l.type === 'troll');
    const deep = legs.find((l) => l.runId === DEEP.runId);
    const shallow = legs.find((l) => l.runId === SHALLOW.runId);
    expect((deep.rodPlan || {}).R1).toBe(undefined);          // 25 ft clears 34 ft of water
    expect(shallow.rodPlan.R1.leadFt < 120).toBe(true);
    expect(depthWindow(LIPLESS, { speedMph: 2.0, leadFt: shallow.rodPlan.R1.leadFt }).max <= 8)
      .toBe(true);
  });

  it('and the deep leg still fishes what the model asked for', () => {
    const { rod, plan } = twoLegs();
    expect(rod.leadFt).toBe(120);
    const deep = plan.legs.filter((l) => l.type === 'troll').find((l) => l.runId === DEEP.runId);
    expect(deep.rodPlan).toBe(undefined);
  });

  it('the warning names only the leg it applies to', () => {
    const { plan } = twoLegs();
    const said = plan.warnings.filter((w) => /shortened the lead/.test(w));
    expect(said.length).toBe(1);
    expect(said[0].includes(SHALLOW.runId)).toBe(true);
    expect(said[0].includes(DEEP.runId)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A WEIGHTLESS FLUKE AT 2 MPH DOES NOT SINK
//
// Ryan, 2026-08-30, on finding one rigged on the starboard troll rod for all three legs:
// "and if it is weightless you think a fluke at 2mph is even going to sink?"
//
// It planes. `cast_fluke` is `trollable: false` in his own inventory and LURE_KNOWLEDGE says
// `technique: 'Cast only'` -- and `cast_only` carried `depthMode: 'lead'`, so depthWindow()
// inverted leadForDepth() and answered "15 ft" for 80 ft of lead. That number is what made a
// cast-only bait on a troll rod look like a plan.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('a cast-only bait has no trolling depth', () => {
  const FLUKE = TACKLE_INVENTORY.find((l) => l.name === 'Fluke / Soft Jerkbait');

  it('is cast-only in the inventory, which is where this starts', () => {
    expect(FLUKE.trollable).toBe(false);
    expect(FLUKE.type).toBe('cast_only');
  });

  it('reports no running depth at any lead, rather than inventing one', () => {
    for (const leadFt of [24, 80, 120]) {
      const w = depthWindow(FLUKE, { speedMph: 2.0, leadFt });
      expect(w.max).toBe(null);
      expect(w.mode).toBe('none');
    }
    expect(depthWindow(FLUKE, { speedMph: 2.0, leadFt: 80 }).controlledBy).toMatch(/planes/);
  });

  it('and says so out loud when one is deployed on a troll rod', () => {
    const rod = { id: 'R2', lure: FLUKE.name, rig: 'fluoro', role: 'troll', leadFt: 80,
                  runsDepthFt: [12, 15] };
    const plan = build(LEG(24), rod);
    const said = plan.warnings.filter((w) => /CAST-ONLY/.test(w));
    expect(said.length).toBe(1);
    expect(said[0].includes('fishing nothing')).toBe(true);
    expect(plan.warnings.some((w) => /shortened the lead/.test(w))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A LEAD OF ZERO IS NOT A LEAD
//
// Ryan's plan of 2026-08-31 quoted `DD2 Crankbait (16-20ft) @ 0ft` on every leg it was on. The
// model had answered `leadFt: 0` for all three of its lipped baits, and it is easy to see why:
// rule 7 tells it a bill sets how deep a crankbait runs and no length of lead lifts it, which is
// true about DEPTH and says nothing about DISTANCE. At 0 ft the bait is at the rod tip.
//
// Nothing caught it. `0` is finite, so the guard let it through; depthWindow() on a rated bait
// reports the printed band whatever the lead, so the leg read 16–20 ft and every check after it
// passed. The zero rode all the way to the card.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('a rated bait is given the lead it takes to work it', () => {
  const DD2 = TACKLE_INVENTORY.find((l) => /DD2/.test(l.name));

  it('replaces a lead of zero with what the app itself would let out', () => {
    const rod = { id: 'R1', lure: DD2.name, rig: 'snap', role: 'troll', leadFt: 0,
                  runsDepthFt: [16, 20] };
    const plan = build(LEG(28), rod);
    const got = planned(plan, 0, 'R1');
    expect(got.leadFt > 0).toBe(true);
    // Not a number written here: leadForDepth() asked for the depth the bait is built to run.
    expect(got.leadFt).toBe(leadForDepth(DD2, depthWindow(DD2, { leadFt: null }).max, 2.0));
    // And it is said out loud, naming the distinction the model got wrong.
    expect(plan.warnings.some((w) => /0 ft of lead/.test(w) && /how far BEHIND the boat/.test(w)))
      .toBe(true);
    // The bag is untouched, the same as every other cap on this leg.
    expect(rod.leadFt).toBe(0);
  });

  it('answers a rated bait the model gave no lead at all', () => {
    const rod = { id: 'R1', lure: DD2.name, rig: 'snap', role: 'troll', runsDepthFt: [16, 20] };
    const plan = build(LEG(28), rod);
    expect(planned(plan, 0, 'R1').leadFt > 0).toBe(true);
    expect(plan.warnings.some((w) => /no lead at all/.test(w))).toBe(true);
  });

  it('leaves a real lead alone and says nothing', () => {
    const rod = { id: 'R1', lure: DD2.name, rig: 'snap', role: 'troll', leadFt: 76,
                  runsDepthFt: [16, 20] };
    const plan = build(LEG(28), rod);
    expect(plan.warnings.some((w) => /how far BEHIND the boat/.test(w))).toBe(false);
  });

  it('still says nothing it cannot answer: a lead-controlled bait with no lead', () => {
    // Its window IS the lead, so there is nothing to invert and nothing to hand back. It skips,
    // exactly as it did before, rather than inventing a distance.
    const rod = { id: 'R1', lure: LIPLESS.name, rig: 'snap', role: 'troll' };
    const plan = build(LEG(28), rod);
    expect((planned(plan, 0, 'R1')).leadFt).toBe(undefined);
    expect(plan.warnings.some((w) => /how far BEHIND the boat/.test(w))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// AND THE PLANNER HAS TO ACTUALLY HAND IT THE RESOLVER
//
// Ryan, 2026-09-04: "so you are saying that smartplan can hand me a trolling lane and a lure and
// not know whether that lure will be lost trolling that lane?"
//
// Every test above calls assemblePlan() directly and passes `lureByName` itself, so all of them
// pass while the thing is dead in the app. capBaitDepth()'s first line is
//
//     if (typeof lureByName !== 'function' || ...) return null;
//
// -- a silent no-op. plan-from-water.js passes the resolver twice, to buildPlanRequest AND to
// assemblePlan. smart-plan-v2.js passed it only to buildPlanRequest, so the MODEL was told how
// deep each bait runs and the app's own check on the answer never ran once: no lead shortened,
// no jighead fitted, no cast-only rod called out, on any lake, on every Smart Plan ever built.
//
// These two run the real planner end to end. They are here rather than in smart-plan-v2.test.js
// because what they guard is this file's subject, and this file is where someone looks.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('the ceiling survives the trip through the planner, not just the assembler', () => {
  const RAMP = [-80.7300, 34.3800];
  // A lane 4 km long that the fitter measured: the line runs 26-30 ft except for one 8 ft rise.
  // `envelope_ft` is the shallow side within the wander, `envelope_line_ft` the water under the
  // centreline -- waterBand() reads both and maxRunDepthFt comes off the line.
  const STEP = 100;
  const N = 40;
  const lineFt = Array.from({ length: N + 1 }, (_, k) => (k === 20 ? 8 : 28));
  const lane = {
    type: 'Feature',
    geometry: { type: 'LineString',
      coordinates: Array.from({ length: N + 1 }, (_, k) => [-80.720 + (k * STEP) / 91000, 34.380]) },
    properties: {
      id: 'w#1', depth_ft: 28, mean_depth_ft: 28, length_m: N * STEP, routable: true, fitted: true,
      envelope_step_m: STEP, envelope_line_ft: lineFt, envelope_ft: lineFt,
      near: Array.from({ length: 16 }, (_, k) => ({ s: 200 + k * 240, t: 'hump', d: 26 })),
    },
  };
  const PACK = {
    '/w/trolling_runs.geojson': { features: [lane] },
    '/w/structure.geojson': { features: [] },
    '/w/water_features.geojson': { features: [] },
  };

  // The model answers well: one leg, both rods out, the deep bait at the lead it asked for.
  // 120 ft of lead puts the lipless at 25 ft, and this lane comes up to 8.
  //
  // R5/R1 AND NOT R1/R2, because seatRods() puts a lipless on a snap rod and a crankbait on a
  // leader rod and RENAMES them to match. A leg deploying an id that got re-seated has no rods
  // in the water at all, which is a different bug and would hide this one.
  const DD2 = TACKLE_INVENTORY.find((l) => /DD2/.test(l.name));
  const model = async ({ user }) => {
    const runId = (user.match(/"runId":\s*"([^"]+)"/) || [])[1];
    return JSON.stringify({
      safety: { isGo: true, warning: '', rampEvaluation: 'sheltered' },
      loadout: { why: 'covering the band', rods: [
        { id: 'R1', lure: DD2.name, color: 'Shad', role: 'troll', leadFt: 60,
          runsDepthFt: [16, 20], why: 'the mid band' },
        { id: 'R5', lure: LIPLESS.name, color: 'Chrome', role: 'troll', leadFt: 120,
          runsDepthFt: [21, 25], why: 'the deep half' }] },
      legs: [{ runId, speedMph: 2.0, deploy: { port: 'R1', starboard: 'R5' }, why: 'the ledge' }],
      stops: [], changes: [], notes: {},
    });
  };

  const OPTS = {
    r2Key: 'w', chartpackBase: '', ramp: RAMP, rampName: 'Clearwater Cove',
    water: 'Lake Wateree, SC', date: '2026-08-10', launchTime: '06:00', returnTime: '15:00',
    species: 'Striped Bass', fishDepthFt: [15, 40], holding: 'suspended',
    usableAh: 80, windowMin: 540, conditions: {},
    tackle: [LIPLESS.name, DD2.name], inventory: [LIPLESS, DD2], lureByName,
    fetchJson: async (p) => PACK[p] ?? null,
    askModel: model,
  };

  it('measures the 8 ft rise and carries it onto the leg', async () => {
    const r = await buildSmartPlanV2(OPTS);
    const leg = r.plan.legs.find((l) => l.type === 'troll');
    // The lane's median is 28 and its shoal is 8. Both, on the leg, from the same envelope.
    expect(leg.depthFt).toBe(28);
    expect(leg.depthMinFt).toBe(8);
  });

  it('shortens the lead so the bait clears, exactly as Pick Water does', async () => {
    const r = await buildSmartPlanV2(OPTS);
    const leg = r.plan.legs.find((l) => l.type === 'troll');
    const got = (leg.rodPlan || {}).R5 || {};
    expect(got.leadFt !== undefined).toBe(true);
    expect(got.leadFt < 120).toBe(true);
    expect(depthWindow(LIPLESS, { speedMph: 2.0, leadFt: got.leadFt }).max <= 8).toBe(true);
    expect(r.plan.warnings.some((w) => /shortened the lead/.test(w))).toBe(true);
  });
});
