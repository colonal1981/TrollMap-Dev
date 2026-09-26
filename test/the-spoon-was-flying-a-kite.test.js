/**
 * test/the-spoon-was-flying-a-kite.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Lake Wateree, 2026-09-14. The plan warned:
 *
 *   "R6 on wateree_lake#362 says it runs to 16 ft, but 70 ft of lead at 2 mph puts a Nichols
 *    Lake Fork Flutter Spoon 3/4oz at 22 ft — going with the measured number"
 *
 * Ryan: "is the spoon depths assuming that i am using the 2oz trolling weight rig? because a
 * 3/4oz spoon unweighted at 2mph is a surface lure not these depths??? unless i am thinking
 * wrong?"
 *
 * He was not thinking wrong, and the answer was worse than a wrong number: there WAS no rig in
 * the app. The 2oz trolling weight appeared in three code comments and was an object in none of
 * them, so nothing could add its mass to anything. The 22 ft came out right only because the
 * ratio it inherited, 3.5, had been quoted for the weighted rig by someone who never wrote that
 * down — and was then labelled `refOz: 0.75`, the weight of the SPOON.
 *
 * Confirmed the same day: "the 3/4 spoon is currently rigged with a 2 oz trolling weight inline
 * ... the weight attaches to one of the swivel snap rods then has a 5ft fluro leader with the
 * spoon tied on with a no slip loop knot", and, asked what that rig runs on 70 ft at 2 mph,
 * "About 20 ft sounds right". So the constant stands and the label moves to the system mass.
 *
 *   node --test test/the-spoon-was-flying-a-kite.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depthWindow, leadForDepth, systemWeightOz, requiresInlineWeight,
         changeCostFor, presentationDelta, connectionFor } from '../js/data/lure-knowledge.js';
import { TACKLE_INVENTORY, TROLLING_WEIGHTS_OWNED_OZ,
         RIGGED_TROLLING_WEIGHT_OZ } from '../js/data/tackle-inventory.js';
import { assemblePlan } from '../js/modules/plan-assemble.js';

const byId = (id) => TACKLE_INVENTORY.find((l) => l.id === id);
const lureByName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;
const SPOON = byId('spoon_3quarter');
const SPOON118 = byId('spoon_nichols_118');

// ── THE BOX ────────────────────────────────────────────────────────────────────────────────────
test('the weights are hardware in the inventory, derived and not typed twice', () => {
  assert.deepEqual(TROLLING_WEIGHTS_OWNED_OZ, [1, 2, 3], 'Ryan owns 1, 2 and 3 oz');
  assert.equal(RIGGED_TROLLING_WEIGHT_OZ, 2, 'the 2 oz is the one tied on');
});

test('a trolling weight is never offered as a bait', () => {
  for (const w of TACKLE_INVENTORY.filter((l) => l.type === 'trolling_weight')) {
    assert.equal(w.trollable, false, `${w.name} must not be trollable`);
    assert.equal(w.castable, false, `${w.name} must not be castable`);
  }
  // Both bag builders filter on `trollable || castable`; this is that filter.
  const bag = TACKLE_INVENTORY.filter((l) => l.trollable || l.castable);
  assert.equal(bag.some((l) => l.type === 'trolling_weight'), false);
});

test('the snap holds the weight, so a weight is snap-legal in its own right', () => {
  assert.equal(connectionFor('trolling_weight'), 'snap');
});

// ── THE MASS THAT SINKS IT ─────────────────────────────────────────────────────────────────────
test('system weight is the bait plus what is ahead of it on the line', () => {
  assert.equal(systemWeightOz({ weightOz: 0.75 }), 0.75);
  assert.equal(systemWeightOz({ weightOz: 0.75, inlineWeightOz: 2 }), 2.75);
  assert.equal(systemWeightOz({ weightOz: null, inlineWeightOz: 2 }), 2);
  assert.equal(systemWeightOz({}), null, 'no mass is null, never zero-as-a-number');
});

test('HIS NUMBER SURVIVES: the rigged spoon on 70 ft at 2 mph still comes out about 20 ft', () => {
  const w = depthWindow({ ...SPOON, inlineWeightOz: 2 }, { speedMph: 2.0, leadFt: 70 });
  assert.equal(w.mode, 'lead');
  assert.deepEqual([w.min, w.max], [18, 22], '"About 20 ft sounds right" — Ryan, 2026-09-14');
  assert.equal(leadForDepth({ ...SPOON, inlineWeightOz: 2 }, 20, 2.0), 70,
    'and it inverts: 20 ft asks for the 70 ft the plan had');
});

test('the bare spoon is a surface lure and the app now says so instead of a depth', () => {
  const w = depthWindow(SPOON, { speedMph: 2.0, leadFt: 70 });
  assert.equal(w.mode, 'needs_weight');
  assert.equal(w.min, null);
  assert.equal(w.max, null, 'no number at all — a planing bait has no running depth');
  assert.match(w.reason, /planing surface/);
  assert.match(w.reason, /inline trolling weight/);
});

test('the rig is NAMED in the answer, which is the question Ryan had to ask', () => {
  const w = depthWindow({ ...SPOON, inlineWeightOz: 2 }, { speedMph: 2.0, leadFt: 70 });
  assert.equal(w.inlineWeightOz, 2);
  assert.match(w.controlledBy, /2oz inline weight/,
    'the old string was "lead length + speed + weight" and that is what made him ask');
});

test('the second Nichols scales on system mass, not on the spoon alone', () => {
  // Both spoons behind the same 2 oz weight are 2.75 and 3.125 oz of system: 14% apart. Keyed on
  // the spoon alone they read 50% apart, and the heavier one was pushed four feet too deep.
  const a = depthWindow({ ...SPOON, inlineWeightOz: 2 }, { speedMph: 2.0, leadFt: 70 });
  const b = depthWindow({ ...SPOON118, inlineWeightOz: 2 }, { speedMph: 2.0, leadFt: 70 });
  assert.ok(b.max - a.max <= 2, `1-1/8oz should sit just under the 3/4oz, got ${a.max} vs ${b.max}`);
  assert.ok(b.max > a.max, 'heavier still runs deeper');
});

test('only the flutter spoon declares the requirement — nothing else was ruled on', () => {
  assert.equal(requiresInlineWeight('flutter_spoon'), true);
  for (const t of ['spoon_casting', 'bucktail', 'swimbait_paddle', 'blade_vibe', 'vertical_jig']) {
    assert.equal(requiresInlineWeight(t), false, `${t} sinks on its own; Ryan never said otherwise`);
  }
});

// ── WHAT A CHANGE COSTS ────────────────────────────────────────────────────────────────────────
test('changing a bait behind a trolling weight is a knot even on a snap rod', () => {
  assert.equal(changeCostFor('flutter_spoon', 'snap'), 'fluoro',
    '5 ft of fluoro and a no-slip loop is not a snap');
  assert.equal(changeCostFor('blade_vibe', 'snap'), 'snap');
  assert.equal(changeCostFor('blade_vibe', 'fluoro'), 'fluoro');
});

// ── WHAT A CHANGE BUYS ─────────────────────────────────────────────────────────────────────────
test('C1: swimbait to blade vibe moved nothing but noise and flash', () => {
  const d = presentationDelta({ ...byId('swimbait_4in'), weightOz: 0.5 }, byId('blade_3in'),
                              { speedMph: 2.0, leadFt: 70 });
  assert.deepEqual(d.depth.from, d.depth.to, 'both run the same feet on the same lead');
  assert.deepEqual(d.differs.sort(), ['flash', 'noise']);
  for (const f of ['water_column', 'profile', 'speed', 'depth']) assert.ok(d.same.includes(f));
});

test('a swap that actually moves the bait is not flagged', () => {
  const d = presentationDelta({ ...byId('swimbait_4in'), weightOz: 0.5 },
                              { ...SPOON, inlineWeightOz: 2 }, { speedMph: 2.0, leadFt: 70 });
  assert.ok(d.differs.includes('depth'));
  assert.ok(d.differs.includes('water_column'));
  assert.equal(d.depth.overlapFt, 0, '11-15 ft against 18-22 ft do not meet');
});

// ── END TO END, THROUGH THE ASSEMBLER ──────────────────────────────────────────────────────────
const LEG = { runId: 'wateree_lake#362', lengthM: 2400, depthFt: 30, maxRunDepthFt: 30,
              start: [-80.70, 34.35], end: [-80.68, 34.36],
              coordinates: [[-80.70, 34.35], [-80.69, 34.355], [-80.68, 34.36]],
              passes: [], speedMph: 2.0 };
const plan = (rods, deploy, changes = []) => assemblePlan({
  candidates: [LEG], launch: [-80.71, 34.348], loadout: { rods }, deploy,
  stops: [], changes, launchTime: '06:00', returnTime: '15:00', usableAh: 80, lureByName,
});
const R6 = { id: 'R6', lure: SPOON.name, rig: 'snap', role: 'troll',
             leadFt: 70, runsDepthFt: [10, 16] };

test('the assembler fits the weight and puts it on the leg, not in a comment', () => {
  const p = plan([R6], { [LEG.runId]: { starboard: 'R6' } });
  const leg = p.legs.find((l) => l.runId === LEG.runId);
  assert.equal(leg.rodPlan?.R6?.inlineWeightOz, 2, 'the 2 oz that is tied on');
});

// CHANGED 2026-09-26. This asserted the claim check fired: the model asked for 10-16 ft on 70 ft of
// lead, the app kept the 70 (18-22 ft behind the 2oz weight) and reported "going with the app's
// number". But the prompt tells the model, for this bait, "Say what depth you want it at and leave
// the weight and the lead to the app" -- so the app now LEADS it to the 10-16 ft asked for instead
// of overruling the depth with a lead it told the model not to price. Ryan's Sep 26 Wateree plan
// is why: the kept lead put the spoon 24-28 ft down, under a 19.7 ft anoxic line. What this test
// is about is unchanged and still asserted: the sentence names the rig and calls nothing measured.
test('the note names the rig and no longer calls arithmetic a measurement', () => {
  const p = plan([R6], { [LEG.runId]: { starboard: 'R6' } });
  const said = (p.decisions || []).filter((w) => /R6/.test(w) && /10-16 ft the plan asked for/.test(w));
  assert.equal(said.length, 1,
    `expected the fitted lead to be reported, got ${JSON.stringify(p.decisions)}`);
  assert.match(said[0], /behind the 2oz inline weight/, 'the rig reaches the page');
  assert.doesNotMatch(said[0], /measured/,
    'lure-knowledge says "STILL UNCALIBRATED" three times in its own header');
  assert.match(said[0], /The 70 ft of lead the plan named runs that rig to 22 ft/);
  const leg = p.legs.find((l) => l.runId === LEG.runId);
  assert.ok(leg.rodPlan.R6.leadFt < 70, 'the leg fishes the fitted lead, not the named one');
});

test('an empty swap is warned about, and kept', () => {
  const rods = [R6,
    { id: 'R5', lure: 'Swimbait 4.6" – Jighead', rig: 'snap', role: 'troll',
      leadFt: 70, runsDepthFt: [11, 15] }];
  const p = plan(rods, { [LEG.runId]: { port: 'R5', starboard: 'R6' } },
                 [{ beforeRunId: LEG.runId, rodId: 'R5', from: 'Swimbait 4.6" – Jighead',
                    to: '3" Blade Vibe Bait',
                    why: 'Transitioning to a tighter vibrating bait to trigger suspended fish near timber.' }]);
  assert.equal(p.changes.length, 1, 'kept — dropping a legitimate change is the worse failure');
  const said = (p.warnings || []).filter((w) => /change of sound, not of presentation/.test(w));
  assert.equal(said.length, 1, `expected the empty-swap warning, got ${JSON.stringify(p.warnings)}`);
  assert.match(said[0], /changes noise and flash/);
  assert.deepEqual(p.changes[0].buys.differs.sort(), ['flash', 'noise']);
});
