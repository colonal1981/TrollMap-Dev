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
