/**
 * test/the-day-ran-out-at-eight-in-the-morning.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Lake Wateree, 2026-09-14. Launch 06:00, return 15:00 — a 540 minute window — and the plan that
 * came back was 131 minutes: two legs over one run, one stop, done at 08:12, 13 Ah of 80.
 *
 * timeBudgetBlock had always stated the window and always refused to let a leg be dropped when the
 * day ran LONG. It said nothing about a day that runs short, and assemblePlan() checked one
 * direction too: `estPlannedMin > windowMin`. So a plan filling a quarter of the day was silent.
 *
 * THE THRESHOLD IS THE PLAN'S OWN SHORTEST LEG. If the unspent time is at least as long as the
 * shortest leg already in the plan, one more leg of the kind it already chose would have fit —
 * a fact about this plan, not a rule about days. Anything less than one leg of slack is full.
 *
 *   node --test test/the-day-ran-out-at-eight-in-the-morning.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeBudgetBlock } from '../js/modules/plan-prompt.js';

test('the block asks for the whole window and names the measured failure', () => {
  const b = timeBudgetBlock(540, '06:00', '15:00', 300);
  assert.match(b, /MUST ACCOUNT FOR ALL 540 MINUTES/);
  assert.match(b, /131 minute plan/, 'the block cites the day it was written for');
  assert.match(b, /Fill it with WATER, not with padding/);
});

test('it demands a reason rather than a longer plan', () => {
  const b = timeBudgetBlock(540, '06:00', '15:00', 300);
  assert.match(b, /IF IT STILL COMES IN SHORT, SAY SO IN THE PLAN AND SAY WHY/);
  assert.match(b, /A short day is a legitimate answer/,
    'padding a day to hit a number is the failure this must not cause');
  assert.match(b, /a day that totals far less is wrong unless it says why/);
});

test('the over case is untouched — it still refuses to drop a leg for him', () => {
  const over = timeBudgetBlock(240, '06:00', '10:00', 400);
  assert.match(over, /160 minutes\s*\nMORE than he has/);
  assert.match(over, /Do not solve this by dropping a leg/);
  assert.match(over, /WHERE THE CLOCK RUNS OUT/);
});

test('silent about the window when there is no window', () => {
  assert.equal(timeBudgetBlock(0, '06:00', '15:00', 100), '');
  assert.equal(timeBudgetBlock(null, '06:00', '15:00', 100), '');
});

// ── AND THE CHECK ON THE RESULT, NOT JUST THE ASK ──────────────────────────────────────────────
import { assemblePlan } from '../js/modules/plan-assemble.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';

const lureByName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;
const LEG = { runId: 'wateree_lake#81', lengthM: 1800, depthFt: 28, maxRunDepthFt: 28,
              start: [-80.70, 34.35], end: [-80.68, 34.36],
              coordinates: [[-80.70, 34.35], [-80.69, 34.355], [-80.68, 34.36]],
              passes: [], speedMph: 2.0 };
const ROD = { id: 'R1', lure: 'MR Crankbait (6-12ft)', rig: 'fluoro', role: 'troll',
              leadFt: 80, runsDepthFt: [6, 12] };
const day = (launchTime, returnTime) => assemblePlan({
  candidates: [LEG], launch: [-80.71, 34.348],
  loadout: { rods: [ROD] }, deploy: { [LEG.runId]: { port: 'R1' } },
  stops: [], changes: [], launchTime, returnTime, usableAh: 80, lureByName,
});
const shortWarn = (plan) => (plan.warnings || []).filter((w) => /unspent/.test(w));

test('one short leg against a nine hour window is reported, with the plan own numbers', () => {
  const plan = day('06:00', '15:00');
  const said = shortWarn(plan);
  assert.equal(said.length, 1, 'a quarter-filled day must not pass silently');
  assert.match(said[0], new RegExp(`of ${plan.budget.windowMin} min`));
  assert.match(said[0], /unspent/);
  assert.match(said[0], /shortest leg in it runs \d+ min/,
    'the threshold must be stated as the plan own shortest leg, not as a picked number');
  assert.match(said[0], /A short day is a fine answer; an unexplained one is not/);
});

test('a window the plan genuinely fills says nothing', () => {
  // A window barely longer than the single leg leaves less than one more leg of slack.
  const plan = day('06:00', '06:50');
  assert.ok(plan.budget.estPlannedMin > 0);
  assert.equal(shortWarn(plan).length, 0,
    'less than one leg of slack is a full day, not a short one');
});

test('it never fires alongside the over-budget warning', () => {
  const over = day('06:00', '06:10');
  const both = (over.warnings || []).filter((w) => /unspent/.test(w)).length
             && (over.warnings || []).filter((w) => /against a \d+ min window/.test(w)).length;
  assert.ok(!both, 'a day cannot be simultaneously too long and too short');
});
