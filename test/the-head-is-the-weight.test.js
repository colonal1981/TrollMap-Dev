/**
 * the-head-is-the-weight.test.js
 *
 * Ryan, 2026-08-30, reading fishing_plan 12: "for the jig head with a 4.6in swimbait... what
 * weight jig head is it using for the lead, speed, and depth calculations?"
 *
 * The answer was 1oz, and nothing had chosen it. `Swimbait 4.6" – Jighead` carries
 * `weightOz: null` — correctly, the head IS the weight — and `applyWeight()` short-circuits on a
 * falsy weight and returns the ratio unchanged. leadRatio 4.0 is quoted at refOz 1.0. So the
 * plan path priced every paddle tail as a 1oz head while the Spread tab, which calls
 * `jigheadForSwimbait()` first, priced the same bait at the same depth ~44 ft of lead apart.
 *
 * These tests pin the fix at both ends: the picker's rule, and the plan actually calling it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jigheadRangeOz, jigheadForSwimbait, depthWindow, leadForDepth }
  from '../js/data/lure-knowledge.js';
import { TACKLE_INVENTORY, JIGHEADS_OWNED_OZ, lureByName } from '../js/data/tackle-inventory.js';
import { assemblePlan } from '../js/modules/plan-assemble.js';
import { planToTimeline } from '../js/modules/plan-to-timeline.js';

const box = { jigheads: JIGHEADS_OWNED_OZ, maxLeadFt: 120 };
const sb46 = lureByName('Swimbait 4.6" – Jighead');
const sb38 = lureByName('Swimbait 3.8" – Jighead');
const sb60 = lureByName('Swimbait 6" – Jighead');

// ── the box ──────────────────────────────────────────────────────────────────

test('the box is exactly the seven heads Ryan listed', () => {
  // "1/4, 3/8, 1/2, 3/4, 1, 1 1/4, 1 1/2 is what i own"
  assert.deepEqual(JIGHEADS_OWNED_OZ, [0.25, 0.375, 0.5, 0.75, 1.0, 1.25, 1.5]);
});

test('the box is derived from the inventory, not typed beside it', () => {
  const entries = TACKLE_INVENTORY.filter((l) => l.type === 'jighead').map((l) => l.weightOz);
  assert.deepEqual(JIGHEADS_OWNED_OZ, entries.slice().sort((a, b) => a - b));
});

test('no paddle tail carries its own list of heads any more', () => {
  // Six per-lure `jigWeights` arrays existed, nothing read one, and all six disagreed with the
  // box — they offered 1/8 and 3/16oz heads he does not own. Reading one is what made a session
  // tell him a 4.6" bait tops out at 1/2oz.
  for (const l of TACKLE_INVENTORY) assert.equal(l.jigWeights, undefined, l.id);
});

test('the 6" swimbait he owns is in the inventory', () => {
  assert.ok(sb60, 'Swimbait 6" – Jighead missing');
  assert.equal(sb60.lengthIn, 6.0);
  assert.equal(sb60.weightOz, null);
});

// ── the range ────────────────────────────────────────────────────────────────

test('the head range is his sentence, length by length', () => {
  // "3.8 in can go with 1/4-1/2, 4.6 should go with 1/2-1, 5 inch can 3/4 - 1oz and the 6 inch
  //  that is not in the inventory that i do have can go 1-1.5oz"
  assert.deepEqual(jigheadRangeOz(3.8), { startOz: 0.25, maxOz: 0.5 });
  assert.deepEqual(jigheadRangeOz(4.6), { startOz: 0.5, maxOz: 1.0 });
  assert.deepEqual(jigheadRangeOz(5.0), { startOz: 0.75, maxOz: 1.0 });
  assert.deepEqual(jigheadRangeOz(6.0), { startOz: 1.0, maxOz: 1.5 });
});

test('a lure with no head rule gets null, not a range it could be filtered against', () => {
  assert.equal(jigheadRangeOz(3.0, 'lipless'), null);
  assert.equal(jigheadRangeOz(4.0, 'crankbait_dd'), null);
});

// ── the picker ───────────────────────────────────────────────────────────────

test('the picker starts where the bait starts and never goes lighter on its own', () => {
  // A 1/4oz head IS legal on a 4.6" — "i mean the 1/4 can go with a 4.6 i was just trying to make
  // it a little easier on the app" — but the only thing it buys is action, which is his call.
  // Choosing it for him is what asked for 104 ft of lead to hold 15 ft.
  for (const d of [3, 6, 10, 15]) {
    assert.equal(jigheadForSwimbait(sb46, d, 2.0, box).weightOz, 0.5, `${d} ft`);
  }
});

test('it goes heavier only to reach a depth, and stops at the hook-size cap', () => {
  assert.equal(jigheadForSwimbait(sb46, 15, 2.0, box).weightOz, 0.5);
  assert.equal(jigheadForSwimbait(sb46, 25, 2.0, box).weightOz, 0.75);
  assert.equal(jigheadForSwimbait(sb46, 40, 2.0, box).weightOz, 1.0);   // the cap, not the box
});

test('the cap binding says "longer bait", never "cannot reach"', () => {
  // The distinction decides what you do next. Blaming depth sends you looking for a heavier head,
  // which is the exact thing that tears the plastic off the hook.
  const r = jigheadForSwimbait(sb38, 40, 2.0, box);
  assert.equal(r.cappedBy, 'length');
  assert.equal(r.weightOz, 0.5);
  assert.match(r.note, /longer swimbait/);
});

test('the longest bait blames the lead, because there is nothing longer to reach for', () => {
  const r = jigheadForSwimbait(sb60, 55, 2.0, box);
  assert.equal(r.cappedBy, 'lead');
  assert.equal(r.weightOz, 1.5);
  assert.match(r.note, /more than 120ft of lead/);
});

test('a heavier head is always less line for the same depth', () => {
  let prev = Infinity;
  for (const w of JIGHEADS_OWNED_OZ) {
    const lead = leadForDepth({ type: 'swimbait_paddle', weightOz: w }, 20, 2.0);
    assert.ok(lead < prev, `${w}oz -> ${lead} ft, not less than ${prev}`);
    prev = lead;
  }
});

test('no box is not an empty box', () => {
  // Defaulting here is how the owned list came to live in two places.
  const r = jigheadForSwimbait(sb46, 15, 2.0, {});
  assert.equal(r.weightOz, null);
  assert.equal(r.cappedBy, 'no jigheads');
});

test('a lure that carries its own weight is not given a head', () => {
  assert.equal(jigheadForSwimbait(lureByName('3" Lipless Crankbait'), 15, 2.0, box), null);
  assert.equal(jigheadForSwimbait(lureByName('DD3 Crankbait (20-25ft)'), 22, 2.0, box), null);
});

// ── the bug, end to end ──────────────────────────────────────────────────────

const LEG = (maxRunDepthFt = 24) => ({
  runId: 'wateree_lake#14', lengthM: 4345, depthFt: 43, depthMinFt: 38, depthMaxFt: 48,
  maxRunDepthFt, start: [-80.70, 34.35], end: [-80.68, 34.36],
  coordinates: [[-80.70, 34.35], [-80.69, 34.355], [-80.68, 34.36]],
  passes: [], speedMph: 2.0,
});

const planWith = (rod, maxRunDepthFt) => assemblePlan({
  candidates: [LEG(maxRunDepthFt)], launch: [-80.71, 34.348],
  loadout: { rods: [rod] },
  deploy: { 'wateree_lake#14': { port: rod.id } },
  stops: [], changes: [], launchTime: '06:30', returnTime: '13:00', usableAh: 80,
  lureByName,
});

const planned = (plan, rodId) =>
  (plan.legs.filter((l) => l.type === 'troll')[0].rodPlan || {})[rodId] || {};

test('the plan fits a head instead of pricing the bait as a 1oz', () => {
  // fishing_plan 12, R5 verbatim: lead 60, speed 2, depth "13-17", jigWeight "".
  // 13-17 is what 60 ft returns for a 1oz head, and 1oz is above what this bait carries at all.
  const before = depthWindow({ ...sb46 }, { speedMph: 2, leadFt: 60 });
  assert.deepEqual([before.min, before.max], [13, 17], 'the bug it shipped with');

  const plan = planWith({ id: 'R5', lure: 'Swimbait 4.6" – Jighead', leadFt: 60,
                          runsDepthFt: [22, 25], role: 'troll', rig: 'snap' });
  const over = planned(plan, 'R5');
  assert.equal(over.jigheadOz, 0.75, 'a head was fitted');
  assert.ok(over.leadFt > 60, `lead followed the head, got ${over.leadFt}`);

  // and the reported window is that head on that lead, not a 1oz on the model's number
  const after = depthWindow({ ...sb46, weightOz: over.jigheadOz },
                            { speedMph: 2, leadFt: over.leadFt });
  assert.deepEqual(over.runsDepthFt, [after.min, after.max]);
});

test('the depth is the model\'s call and the lead is the app\'s arithmetic', () => {
  // The model was never told a head weight, so the lead it asks for is a number about a bait
  // with no mass. Its DEPTH is judgement and survives; its lead does not.
  const shallow = planWith({ id: 'R5', lure: 'Swimbait 4.6" – Jighead', leadFt: 200,
                             runsDepthFt: [8, 12], role: 'troll', rig: 'snap' });
  const deep = planWith({ id: 'R5', lure: 'Swimbait 4.6" – Jighead', leadFt: 200,
                          runsDepthFt: [22, 25], role: 'troll', rig: 'snap' });
  const a = planned(shallow, 'R5'), b = planned(deep, 'R5');
  assert.ok(a.leadFt < b.leadFt, 'the same asked-for lead produced the same depth');
  assert.equal(a.jigheadOz, 0.5);      // 8-12 ft: the head the bait starts on
  assert.equal(b.jigheadOz, 0.75);     // 22-25 ft: one step up, to reach it
  assert.notEqual(a.leadFt, 200);      // and neither is the 200 ft the model asked for
  assert.notEqual(b.leadFt, 200);
});

test('a rod the model gave no lead at all still gets a head and a lead', () => {
  // The guard used to `continue` on a missing lead, which for a paddle tail is the one bait whose
  // lead the app can work out from scratch.
  const plan = planWith({ id: 'R5', lure: 'Swimbait 4.6" – Jighead',
                          runsDepthFt: [14, 16], role: 'troll', rig: 'snap' });
  const over = planned(plan, 'R5');
  assert.equal(over.jigheadOz, 0.5);
  assert.ok(Number.isFinite(over.leadFt) && over.leadFt > 0);
});

test('the ceiling still wins over the head', () => {
  // maxRunDepthFt 24 on this leg. A head fitted for 40 ft must still be pulled up to clear.
  const plan = planWith({ id: 'R5', lure: 'Swimbait 4.6" – Jighead', leadFt: 60,
                          runsDepthFt: [38, 42], role: 'troll', rig: 'snap' });
  const over = planned(plan, 'R5');
  const w = depthWindow({ ...sb46, weightOz: over.jigheadOz },
                        { speedMph: 2, leadFt: over.leadFt });
  assert.ok(w.max <= 24, `runs to ${w.max} ft over a 24 ft ceiling`);
});

test('a bait that carries its own weight is untouched by any of this', () => {
  const plan = planWith({ id: 'R1', lure: '3" Lipless Crankbait', leadFt: 40,
                          runsDepthFt: [7, 11], role: 'troll', rig: 'snap' });
  const over = planned(plan, 'R1');
  assert.equal(over.jigheadOz, undefined);
});

// ── it reaches the page ──────────────────────────────────────────────────────

test('the head reaches the rod row, written the way it is sold', () => {
  // `jigWeight` was an empty string on every row of every plan, which is why he had nowhere to
  // look this up.
  const plan = planWith({ id: 'R5', lure: 'Swimbait 4.6" – Jighead', leadFt: 60,
                          runsDepthFt: [22, 25], color: 'Blueback Herring',
                          role: 'troll', rig: 'snap' });
  const { routeRods } = planToTimeline(plan, {});
  const row = routeRods.L1.find((r) => r.rod === 'R5');
  assert.equal(row.jigWeight, '3/4oz');
  assert.equal(row.lead, planned(plan, 'R5').leadFt);
});

test('every head in the box has a label a person would write on a packet', () => {
  const seen = new Map();
  for (const oz of JIGHEADS_OWNED_OZ) {
    const plan = planWith({ id: 'R5', lure: 'Swimbait 4.6" – Jighead', leadFt: 60,
                            runsDepthFt: [22, 25], role: 'troll', rig: 'snap' });
    plan.legs.filter((l) => l.type === 'troll')[0].rodPlan.R5.jigheadOz = oz;
    const row = planToTimeline(plan, {}).routeRods.L1.find((r) => r.rod === 'R5');
    seen.set(oz, row.jigWeight);
  }
  assert.deepEqual([...seen.values()],
    ['1/4oz', '3/8oz', '1/2oz', '3/4oz', '1oz', '1-1/4oz', '1-1/2oz']);
});

// ---------------------------------------------------------------------------
// AND IT HAS TO BE ON THE SCREEN, NOT JUST IN THE OBJECT.
//
// Ryan, 2026-08-31, a day after the head was fitted and filed: "if it is going
// to assign a swimbait... i need to know what size jighead the app is using for
// the lead and depth calculations... it says to use 63ft of lead... but with
// what weight... weight is going to change the depth that 63ft of lead gives
// me."
//
// The number was right and invisible. `jigWeight: "3/4oz"` was on every swimbait
// row of the saved plan, and rodSlotHtml() rendered the rig line only when the
// lure name contained "a-rig" or "umbrella" -- so the one rig whose depth is SET
// by the head weight was the only rig that never printed it. A lead figure with
// no weight beside it is half an instruction.
// ---------------------------------------------------------------------------
const { rodDepthCell } = await import('../js/modules/smart-plan-ui.js');

// The lead came off this cell entirely on 2026-08-31 -- Ryan cannot set one: "i don't have a
// ruler... there is literally no way for me to answer these questions". The head stays, because
// the head is what he ties on, and it is what he asked for in the first place.
test('the head rides with where the bait runs', () => {
  assert.equal(rodDepthCell('Stbd', { depth: '15–19', jigWeight: '3/4oz',
                                      clearance: { gap: 0, taps: true, floorFt: 19 } }),
               'Stbd 15–19 ft · taps bottom · 3/4oz head');
});

test('a bait with no head quotes no head', () => {
  assert.equal(rodDepthCell('Port', { depth: '18', lure: 'DD1 Crankbait (14-18ft)', jigWeight: '',
                                      clearance: { gap: 7, taps: false, floorFt: 25 } }),
               'Port 18 ft · 7 ft up');
});

test('a leg with no depth profile says nothing rather than a dash', () => {
  assert.equal(rodDepthCell('Port', { depth: '18', clearance: null }), 'Port 18 ft');
  assert.equal(rodDepthCell('Port', null), 'Port —');
});

// ---------------------------------------------------------------------------
// WHERE IT RUNS AGAINST THE BOTTOM HE CAN FEEL
//
// Ryan, 2026-08-31, on how he actually sets depth: "cast it out let out a bunch
// of line if the rod tips starts bouncing it is tapping bottom... reel up... that
// works for just about every bait i own lol" -- after establishing that he cannot
// measure a lead at all: "i don't have a ruler... there is literally no way for
// me to answer these questions".
//
// So the lead stopped being printed as an instruction. What his technique cannot
// tell him is whether bottom is where the plan wants him, and that is what these
// pin -- on the two legs of his own Sep 1 plan that the change was designed on.
// ---------------------------------------------------------------------------
const { planToTimeline: toTimeline } = await import('../js/modules/plan-to-timeline.js');

function legPlan(depthMinFt, depthMaxFt, portRuns, stbdRuns, portLure) {
  const leg = {
    id: 'L1', type: 'troll', runId: 'w#1', startM: 0, lengthM: 4500,
    depthFt: Math.round((depthMinFt + depthMaxFt) / 2), depthMinFt, depthMaxFt,
    speedMph: 2, batteryAh: 7, estDurationMin: 80, estStartTime: '09:00',
    deploy: { port: 'R1', starboard: 'R5' },
    rodPlan: { R1: { runsDepthFt: portRuns }, R5: { runsDepthFt: stbdRuns, jigheadOz: 0.5 } },
    coordinates: [[-80.70, 34.35], [-80.68, 34.36]], stops: [], marks: [],
  };
  return {
    planVersion: 2, meta: {}, conditions: {}, warnings: [], changes: [], legs: [leg],
    budget: { totalM: 4500, fishingM: 4500, transitM: 0 },
    loadout: { rods: [{ id: 'R1', lure: portLure, color: 'Sexy Shad', leadFt: 60 },
                      { id: 'R5', lure: 'Swimbait 4.6" – Jighead', color: 'Herring', leadFt: 111 }] },
  };
}
const card = (p) => toTimeline(p, {}).timeline.find((e) => e.type === 'troll');

test('his Leg 2: 36 ft of water, both baits well up, do not fish it down', () => {
  const e = card(legPlan(36, 47, [18, 18], [20, 22], 'DD1 Crankbait (14-18ft)'));
  assert.equal(e.rods[0].clearance.gap, 18);
  assert.equal(e.rods[0].clearance.taps, false);
  assert.equal(e.rods[1].clearance.gap, 14);
  assert.match(e.bottomNote, /Bottom is 36 ft here/);
  assert.match(e.bottomNote, /the deepest bait rides 14 ft off it/);
  assert.match(e.bottomNote, /14 ft under your own spread/);
});

test('his Leg 4: the swimbait finds the 19 ft rise, and that rise is the spot', () => {
  const e = card(legPlan(19, 29, [12, 12], [15, 19], 'MR Crankbait (6-12ft)'));
  assert.equal(e.rods[0].clearance.gap, 7);
  assert.equal(e.rods[1].clearance.taps, true);
  assert.match(e.bottomNote, /let it tap and come up, that rise is the spot/);
});

test('one depth is written once, not as a range against itself', () => {
  const e = card(legPlan(36, 47, [18, 18], [20, 22], 'DD1 Crankbait (14-18ft)'));
  assert.equal(e.rods[0].depth, '18');
  assert.equal(e.rods[1].depth, '20–22');
});

test('a leg with no depth profile carries no clearance and no note', () => {
  const p = legPlan(36, 47, [18, 18], [20, 22], 'DD1 Crankbait (14-18ft)');
  delete p.legs[0].depthMinFt; delete p.legs[0].depthFt;
  const e = card(p);
  assert.equal(e.rods[0].clearance, null);
  assert.equal(e.bottomNote, '');
});
