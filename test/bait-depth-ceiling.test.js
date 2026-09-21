import { describe, it, expect } from './expect-shim.mjs';
import { assemblePlan } from '../js/modules/plan-assemble.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';
import { depthWindow, leadForDepth } from '../js/data/lure-knowledge.js';
import { buildSmartPlanV2 } from '../js/modules/smart-plan-v2.js';
import { planToTimeline } from '../js/modules/plan-to-timeline.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A BAIT TOO DEEP FOR THE WHOLE STRETCH IS BROUGHT UP
//
// Ryan, 2026-08-11: "the shallowest that water runs is 20ft... well then even if the water is
// 25-35ft don't give me a bait that runs deeper than 20ft with the lead and speed that you gave."
//
// The band the fish are in is NOT the constraint — the sounder answers that on the day. The
// constraint is the water, and it was the only number in this whole system that the app had
// measured, showed to Ryan in the reasons, and never told the model.
//
// NARROWED 2026-09-14, AND THE TITLE OF THIS BLOCK CHANGED WITH IT. The August rule was applied
// to every leg with a shoal on it, including legs that are deep nearly all the way along, and on
// reading one of those Ryan said: "i dont see anything wrong with leg 8... 11-25ft of water with
// the median being 20ft", then "flag the rise and let me decide". So a bait that clears the water
// the pass MOSTLY is keeps the lead he set and the rise is flagged — that half is the last block
// in this file. What stayed is this one: a bait too deep for the stretch generally still comes up.
// The fixtures here now say which kind of water they are, instead of inheriting a 28 ft median
// that quietly made all of them the other case.
//
// These tests use REAL inventory and REAL lure physics rather than a stub, because the whole
// point is that the app can compute this and does not have to ask. A 3" Lipless Crankbait on
// 120 ft of lead at 2.0 mph runs to 25 ft — that is `depthWindow` inverting `leadForDepth`, not
// a number written here.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const LIPLESS = TACKLE_INVENTORY.find((l) => l.type === 'lipless' && l.weightOz === 0.5);
const lureByName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;

// TWO NUMBERS, BECAUSE SINCE 2026-09-14 THE ANSWER DEPENDS ON BOTH.
//
// This helper took the ceiling alone and hard-coded `depthFt: 28`, so every leg in this file was
// 28 ft of water with a shoal on it -- and that is the case capBaitDepth now FLAGS rather than
// caps ("flag the rise and let me decide"). Water that is shallow the whole way along is a
// different leg and has to be written as one, so the median is the second argument. It defaults
// to 28 for the blocks that do mean a rise on deep water.
const LEG = (maxRunDepthFt, depthFt = 28) => ({
  runId: 'wateree_lake#81', lengthM: 1800, depthFt, maxRunDepthFt,
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

describe('a bait too deep for the whole stretch is brought up', () => {
  it('shortens the lead rather than refusing the plan', () => {
    // 120 ft of lead puts this bait at 25 ft, and this leg is 20 ft of water coming up to 18 —
    // shallow the whole way along, so 25 ft is wrong for the pass and not merely for one rise.
    expect(depthWindow(LIPLESS, { speedMph: 2.0, leadFt: 120 }).max).toBe(25);
    const rod = { id: 'R1', lure: LIPLESS.name, rig: 'snap', role: 'troll', leadFt: 120,
                  runsDepthFt: [21, 25] };
    const plan = build(LEG(18, 20), rod);
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

  it('sizes the bait off maxRunDepthFt, NOT off the leg\'s nominal depth', () => {
    // 20 ft of water with a 12 ft rise, and a bait at 25 ft: too deep either way, so it IS
    // corrected -- and the question is which number it was corrected to. Clearing 20 is not
    // clearing 12. Sizing off the nominal depth is exactly the mistake.
    //
    // THIS ASSERTION USED TO READ `depthWindow(..., leadFt: lead).max <= 18` ON A LEG WHOSE LEAD
    // NO LONGER MOVES. `lead` came back undefined once the rise case stopped being capped, a
    // lead-controlled window with no lead has `max: null`, and `null <= 18` is true — so it
    // passed while testing nothing at all. An absent number must not be able to satisfy a check.
    const rod = { id: 'R1', lure: LIPLESS.name, rig: 'snap', role: 'troll', leadFt: 120 };
    const leg = LEG(12, 20);
    expect(leg.depthFt).toBe(20);
    const plan = build(leg, rod);
    const lead = planned(plan, 0, 'R1').leadFt;
    expect(Number.isFinite(lead)).toBe(true);
    expect(depthWindow(LIPLESS, { speedMph: 2.0, leadFt: lead }).max <= 12).toBe(true);
  });

  it('corrects a runsDepthFt the model got wrong', () => {
    // The model claims 12-14 ft while asking for 120 ft of lead, which is 25. Nothing has ever
    // checked one against the other, and the claim is what a reader believes.
    const rod = { id: 'R1', lure: LIPLESS.name, rig: 'snap', role: 'troll', leadFt: 120,
                  runsDepthFt: [12, 14] };
    const plan = build(LEG(34), rod);
    // MOVED TO `decisions` 2026-09-21: the sentence ends "going with the app's number", so it
    // is the app reporting what it settled, not something he has to settle. Still said, still
    // pinned, in the list that is not competing for his attention at the ramp.
    expect(plan.decisions.some((w) => /says it runs to 14 ft/.test(w))).toBe(true);
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
  // 10 FT OF WATER COMING UP TO 8, BECAUSE THAT IS WHAT LEG 2 WAS.
  //
  // The fixture inherited `depthFt: 28` from the LEG helper, which made it 28 ft of water with an
  // 8 ft rise -- the case capBaitDepth flags rather than caps since 2026-09-14, so the shortening
  // this block is about stopped happening and the block failed. But the leg it is drawn from is
  // real and it is not that case: the 2026-08-30 plan's leg 2 IS the 6 ft line, shallow the whole
  // way along, which is why shortening the fluke there was the right call and inheriting it onto
  // legs 1 and 3 was the bug. The median was the one thing the fixture never said out loud.
  //
  // Nothing about the CLAIM changed here. The deep leg is not shortened, the bag is not mutated,
  // and the warning names one leg.
  const DEEP = { ...LEG(34), runId: 'wateree_lake#46' };
  const SHALLOW = { ...LEG(8, 10), runId: 'wateree_lake#362',
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

  // THESE TWO ASSERTED `rodPlan` WAS undefined ON A LEG THAT NEEDED NO CHANGE, UNTIL 2026-09-06.
  //
  // That was the old behaviour and it was the bug next door: capBaitDepth() recorded the window
  // it had computed only inside its two failure branches, so the one case where the number was
  // thrown away was the case where nothing was wrong with it -- and the card then printed
  // whatever the model had typed in the spread row. Ryan, reading a row that said 6-10 ft under
  // a bait the inventory rates 6-12: "you want me to fish at 6-10 ft but give me a bait that is
  // probably going to run closer to 12".
  //
  // The claim these tests are actually about is untouched and still asserted: the deep leg's
  // LEAD is not shortened and the bag is not mutated. Only the recording changed.
  it('the shallow leg is shortened and the deep one is not', () => {
    const { plan } = twoLegs();
    const legs = plan.legs.filter((l) => l.type === 'troll');
    const deep = legs.find((l) => l.runId === DEEP.runId);
    const shallow = legs.find((l) => l.runId === SHALLOW.runId);
    expect(deep.rodPlan.R1.leadFt).toBe(undefined);           // 25 ft clears 34 ft of water
    expect(shallow.rodPlan.R1.leadFt < 120).toBe(true);
    expect(depthWindow(LIPLESS, { speedMph: 2.0, leadFt: shallow.rodPlan.R1.leadFt }).max <= 8)
      .toBe(true);
  });

  it('and the deep leg still fishes what the model asked for', () => {
    const { rod, plan } = twoLegs();
    expect(rod.leadFt).toBe(120);
    const deep = plan.legs.filter((l) => l.type === 'troll').find((l) => l.runId === DEEP.runId);
    expect(deep.rodPlan.R1.leadFt).toBe(undefined);
    // and it now carries what the app computed, which is the whole point of the change
    expect(deep.rodPlan.R1.runsDepthFt).toEqual(
      [depthWindow(LIPLESS, { speedMph: 2.0, leadFt: 120 }).min,
       depthWindow(LIPLESS, { speedMph: 2.0, leadFt: 120 }).max]);
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
  // WAS THE FLUKE, AND IS THE SENKO SINCE 2026-09-14. Ryan: "rig it up with either a belly weight
  // or a jighead and now it does troll", so the fluke moved to `swimbait_paddle` where the head is
  // the weight. The BEHAVIOUR this block tests -- a cast-only bait reporting no trolling depth
  // rather than inventing one -- is unchanged and now belongs to the baits that really are
  // cast-only. The Senko is the cleanest of them: weighted it tracks fine and simply does nothing,
  // so it is cast-only on action, not on buoyancy.
  const FLUKE = TACKLE_INVENTORY.find((l) => l.id === 'cast_stickbait');

  // WHAT CHANGED 2026-09-14, AND WHAT DID NOT.
  //
  // Ryan: "here is the thing about the fluke... rig it up with either a belly weight or a jighead
  // and now it does troll". So the flag is true now — his rule, in ACTION_SOURCE, says the action
  // comes from the pull. What has NOT changed is a word of the behaviour this file tests: the
  // fluke's type is `cast_only`, depthMode 'none', so an UNBALLASTED one still has no running
  // depth at any lead and a troll rod carrying one is still a rod fishing nothing. The original
  // quote behind all of this carried the qualifier the old flag dropped: "and if it is WEIGHTLESS
  // you think a fluke at 2mph is even going to sink?"
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

  // THIS TEST USED TO ASSERT THE LEAD WAS SHORTENED, and the lane it asserts it on is the one
  // described right above: 28 ft of water with a single 8 ft rise. That is the case Ryan took the
  // cap OFF on 2026-09-14 ("flag the rise and let me decide"), so the current answer here is the
  // flag — and the flag proves this block's subject just as well, because neither the flag nor the
  // cap can happen unless smart-plan-v2 handed `lureByName` to assemblePlan and not only to
  // buildPlanRequest. What it must never go back to is silence.
  it('flags the rise, which it can only do if the planner handed it the resolver', async () => {
    const r = await buildSmartPlanV2(OPTS);
    const leg = r.plan.legs.find((l) => l.type === 'troll');
    const got = (leg.rodPlan || {}).R5 || {};
    expect(got.leadFt).toBe(undefined);                       // 120 ft, as the model asked for it
    // The rise is on `decisions`: bottomNote on the leg card already says it where it means
    // something. See plan-assemble.js.
    const said = r.plan.decisions.filter((w) => /^R5 /.test(w)).join(' | ');
    expect(said).toMatch(/THE LEAD IS LEFT WHERE YOU SET IT/);
    // The number that WOULD clear is computed and kept, which is the half he acts on.
    expect(Number.isFinite(got.clearsAt)).toBe(true);
    expect(depthWindow(LIPLESS, { speedMph: 2.0, leadFt: got.clearsAt }).max <= 8).toBe(true);
    // AND IT SAYS WHERE THE RISE IS, because the chart does say. This lane's 8 ft station is index
    // 20 of a 100 m envelope, so it is 2,000 m into the pass, and the leg now carries the array the
    // ceiling was read from. Ryan, 2026-09-19, having read the old sentence four times on one plan:
    // it ended by telling him the chart could not place the shallow spot it had just measured.
    expect(said).toMatch(/about 2,000 m into the pass/);
    expect(said).not.toMatch(/the chart does not say where the rise is/);
    expect(leg.envelope[20]).toBe(8);
    expect(leg.envelopeStepM).toBe(100);
  });

  // AND IT HAS TO REACH THE CARD, NOT JUST THE WARNINGS ARRAY.
  //
  // `clearsAt` was computed, written onto the leg, and read by nobody — the same failure this
  // pipeline has made five times in one month: a value worked out correctly and addressed to no
  // one. The decision it exists for gets made on the water, off the card, so the card is where it
  // has to be. planToTimeline() is the whole card path and this is the one number on it that came
  // out of the flag.
  it('and the clearing lead reaches the card, because that is where he decides', async () => {
    const r = await buildSmartPlanV2(OPTS);
    const leg = r.plan.legs.find((l) => l.type === 'troll');
    const t = planToTimeline(r.plan, { warnings: r.plan.warnings });
    // `type` is 'troll' on transit entries too (the preview branches on it and reads a deadhead
    // through the same renderer), so the trolling leg is the one whose `legType` says so.
    const card = t.timeline.find((c) => c.type === 'troll' && c.legType === 'troll');
    const rod = (card.rods || []).find((x) => x.rod === 'R5');
    expect(rod.clearance.taps).toBe(true);                   // 25 ft of bait into an 8 ft rise
    expect(rod.clearance.note).toMatch(/digs into the 8 ft rise — \d+ ft of lead clears it/);
    expect(card.bottomNote).toMatch(/Shorten to \d+ ft if you want it up over the rise instead/);
  });
});

// ── A ONE-SHOAL CEILING IS A RISE TO AVOID, NOT A WHOLE PASS TO FISH SHALLOW ────────────────────
//
// `maxRunDepthFt` is a THRESHOLD -- the shallowest point the whole stretch clears, set by one rise
// somewhere along it -- and capBaitDepth's own note says exactly that. It then shortened the lead
// for the ENTIRE pass to clear that rise.
//
// wateree_lake#216, 2026-09-14: a lipless pulled off 17 ft down to 11, on a leg that runs 11-25 ft
// with a MEDIAN of 20. Ryan: "i dont see anything wrong with leg 8... 11-25ft of water with the
// median being 20ft... it is not much different than the other water offered." Asked whether to
// keep the cap or flag the rise: "flag the rise and let me decide."
//
// HIS ORIGINAL RULE IS NOT REVERSED. 2026-08-11: "the shallowest that water runs is 20ft... even if
// the water is 25-35ft don't give me a bait that runs deeper than 20ft." On that leg the shallowest
// WAS the character of the water. Here it is one rise on a twenty-foot stretch. Two situations, and
// they had one answer.
//
// THE SPLIT USES THE LEG'S OWN TWO NUMBERS so there is no threshold to invent: clears the median ->
// flagged and left alone; does not clear the median -> too deep for the stretch, corrected as before.
describe('a rise on deep water is flagged, and shallow water is still corrected', () => {
  const lureByName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;
  const leg = (minFt, medFt, maxFt) => ({
    runId: 'wateree_lake#216', lengthM: 2400, depthFt: medFt,
    depthMinFt: minFt, depthMaxFt: maxFt, maxRunDepthFt: minFt,
    start: [-80.70, 34.35], end: [-80.68, 34.36],
    coordinates: [[-80.70, 34.35], [-80.68, 34.36]], passes: [], speedMph: 2.0 });
  const ROD = { id: 'R6', lure: '3" Lipless Crankbait', rig: 'snap', role: 'troll',
                leadFt: 80, runsDepthFt: [12, 16] };
  const run = (c) => assemblePlan({
    candidates: [c], launch: [-80.71, 34.348], loadout: { rods: [ROD] },
    deploy: { 'wateree_lake#216': { starboard: 'R6' } }, stops: [], changes: [],
    launchTime: '06:00', returnTime: '15:00', usableAh: 80, lureByName });
  const said = (p) => (p.decisions || []).filter((w) => /^R6 /.test(w)).join(' | ');
  // A LEAD THE APP SHORTENED IS STILL A WARNING, and it is the one thing in this block that is.
  // The split is not by which rod said it, it is by whether he has to do anything: the rise is
  // left for him to decide about and lands in `decisions`; a lead that was CHANGED is a number
  // on his reel that is no longer the one he set.
  const warned = (p) => (p.warnings || []).filter((w) => /^R6 /.test(w)).join(' | ');
  const leadOn = (p) => (p.legs.find((l) => l.runId === 'wateree_lake#216') || {})
    .rodPlan?.R6?.leadFt;

  it('leaves the lead alone on 11-25 ft water with a median of 20', () => {
    const p = run(leg(11, 20, 25));
    expect(leadOn(p)).toBe(undefined);                       // 80 ft, as he set it
    expect(said(p)).toMatch(/THE LEAD IS LEFT WHERE YOU SET IT/);
  });

  it('and hands him the number that WOULD clear, without applying it', () => {
    const w = said(run(leg(11, 20, 25)));
    expect(w).toMatch(/Shorten to 48 ft over the rise if you want it off the bottom there/);
    // THIS LEG FIXTURE CARRIES NO ENVELOPE, and that is the case the old sentence was written for:
    // a pack with no per-station profile genuinely cannot place the rise, so it still says so. The
    // planner-level test below is the one with an envelope on it.
    expect(w).toMatch(/the chart does not say where the rise is/);
  });

  it('states all three numbers, because the decision rests on the comparison', () => {
    const w = said(run(leg(11, 20, 25)));
    expect(w).toMatch(/runs 13-17 ft/);                      // the bait
    expect(w).toMatch(/this leg is 11-25 ft/);               // the envelope
    expect(w).toMatch(/median of 20 ft/);                    // what the pass mostly is
  });

  it('water that really is shallow all along is still corrected', () => {
    const p = run(leg(11, 12, 14));
    expect(leadOn(p)).toBe(48);
    expect(warned(p)).toMatch(/too shallow for it along the whole stretch, so shortened the lead to 48 ft/);
    expect(warned(p)).not.toMatch(/LEFT WHERE YOU SET IT/);
    expect(said(p)).not.toMatch(/LEFT WHERE YOU SET IT/);
  });

  it('a bait that already clears the rise says nothing at all', () => {
    const shallowRod = { ...ROD, leadFt: 30 };
    const p = assemblePlan({
      candidates: [leg(11, 20, 25)], launch: [-80.71, 34.348],
      loadout: { rods: [shallowRod] }, deploy: { 'wateree_lake#216': { starboard: 'R6' } },
      stops: [], changes: [], launchTime: '06:00', returnTime: '15:00', usableAh: 80, lureByName });
    expect(said(p)).not.toMatch(/LEFT WHERE YOU SET IT|shortened the lead|too deep/);
  });
});
