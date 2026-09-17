// THE APP DRAWS THE RIVER DAY, BECAUSE THERE WAS NEVER ANYTHING ABOUT THE WATER TO CHOOSE.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-09-17: "is there anything to actually choose on a river... or should it just be that
// the app figures out where i should turn around and draws a route that goes up one side and back
// down the other?"
//
// Measured from his own ramp before this was built. Barney Jordan is at km 123.8 of a 126.8 km
// centreline: 123.8 km of river upstream, 3.0 km down, and the downstream structure count stops
// rising after 4 km because the river ENDS. No direction to pick, no lane to pick, no order to
// pick, and the distance is whatever the battery and the clock allow.
//
// And the model had been getting those four wrong while getting the bait right: 191 minutes over
// the window, then 149 under, then an 18.30 Ah pass chosen over a 12.13 Ah one covering twice the
// water.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riverDay } from '../js/modules/plan-candidates.js';

// A reach as selectCandidates leaves it: gated, scored, priced both ways, and stamped with which
// side of the launch it is on.
const reach = (dir, m, lengthM, score, upAh, downAh) => ({
  runId: `r:drift:mid_channel@${m}`, fromRamp: { direction: dir, m },
  lengthM, score, batteryAhUpstream: upAh, batteryAhDownstream: downAh,
  drift: { side: 'mid_channel', label: 'mid-channel' },
});

test('the day walks outward from the ramp and stops where the clock stops', () => {
  // AN 8 km REACH OUT AND BACK IS 9.94 MILES, which at 2 mph is 298 MINUTES -- more than half a
  // nine-hour day in one lump. My first version of this test said 149 and was reading the one-way
  // number; the arithmetic is what showed that whole reaches cannot be the unit.
  const arm = [0, 8000, 16000, 24000].map((m) => reach('upstream', m, 8000, 100, 12, 3));
  const legs = riverDay(arm, { usableAh: 500, windowMin: 540, trollMph: 2 });
  assert.equal(legs.length, 2, 'one whole reach and a trimmed second');
  assert.equal(legs.day.binding, 'clock');
  assert.deepEqual(legs.map((l) => l.fromRamp.m), [0, 8000]);
  // NEAREST THE LAUNCH FIRST. A river day is one path and it starts where the boat does.
  assert.ok(legs.day.plannedMin <= 540);
  assert.ok(legs.day.unspentMin <= 1, `the window is filled, ${legs.day.unspentMin} left`);
});

// THE WHOLE POINT OF TRIMMING. Without it this day is 298 of 540 minutes and calls the other 242
// unspendable -- the same under-filled day the model produced on 2026-09-17.
test('the reach that does not fit whole is cut to what is left, not dropped', () => {
  const arm = [0, 8000].map((m) => reach('upstream', m, 8000, 100, 12, 3));
  const legs = riverDay(arm, { usableAh: 500, windowMin: 540, trollMph: 2 });
  assert.equal(legs.length, 2);
  assert.ok(legs[1].lengthM < 8000 && legs[1].lengthM > 0, `trimmed to ${legs[1].lengthM} m`);
  assert.equal(legs[1].trimmedFrom, 8000, 'and it says it was cut');
  // The battery scales with it rather than being charged for water nobody fishes.
  assert.ok(legs[1].batteryAhUpstream < 12);
});

test('and a sliver is not a leg -- under a tenth of a reach the day just ends', () => {
  const arm = [reach('upstream', 0, 8000, 100, 12, 3), reach('upstream', 8000, 8000, 100, 12, 3)];
  const legs = riverDay(arm, { usableAh: 500, windowMin: 310, trollMph: 2 });
  assert.equal(legs.length, 1, 'the 12 minutes left do not make a leg');
});

test('and where the battery stops, when that is the one that binds', () => {
  const arm = [0, 8000, 16000].map((m) => reach('upstream', m, 8000, 100, 20, 5));
  const legs = riverDay(arm, { usableAh: 55, windowMin: 5000, trollMph: 2 });
  assert.equal(legs.day.binding, 'battery');
  assert.ok(legs.day.plannedAh <= 55);
  assert.ok(legs.day.unspentAh < 1, `the battery is spent, ${legs.day.unspentAh} Ah left`);
});

test('and where the river simply runs out, which is the Congaree downstream', () => {
  const legs = riverDay([reach('downstream', 0, 3000, 40, 5, 1)],
                        { usableAh: 500, windowMin: 540, trollMph: 2 });
  assert.equal(legs.length, 1);
  assert.equal(legs.day.binding, 'the river ran out');
  assert.ok(legs.day.unspentMin > 400, 'a short day is a fine answer; it just has to say so');
});

test('EVERY LEG IS FISHED BOTH WAYS, because that is what a river day is', () => {
  const legs = riverDay([reach('upstream', 0, 4000, 50, 6, 2)],
                        { usableAh: 500, windowMin: 540, trollMph: 2 });
  assert.equal(legs[0].trollPasses, 2);
  // Out and back over 4 km is 8 km fished, and the battery is the two directions added, not one
  // doubled -- upstream and downstream are not the same price on moving water.
  assert.equal(legs.day.fishedM, 8000);
  assert.equal(legs.day.plannedAh, 8);
});

test('the richer bank of the launch is fished first, and it is chosen on structure', () => {
  const up = [reach('upstream', 0, 4000, 10, 5, 2)];
  const down = [reach('downstream', 0, 4000, 900, 5, 2)];
  const legs = riverDay([...up, ...down], { usableAh: 500, windowMin: 5000, trollMph: 2 });
  assert.equal(legs[0].fromRamp.direction, 'downstream', 'the side with the water goes first');
  assert.equal(legs[1].fromRamp.direction, 'upstream');
  // And the day says what it weighed, so a short day can be read rather than guessed at.
  assert.equal(legs.day.offered.length, 2);
  assert.equal(legs.day.offered[0].takenFirst, true);
  assert.equal(legs.day.offered[0].worth, 900);
});

test('when the far bank has no budget left it is simply not in the day', () => {
  const legs = riverDay([reach('upstream', 0, 8000, 500, 12, 3),
                         reach('downstream', 0, 8000, 10, 12, 3)],
                        { usableAh: 500, windowMin: 200, trollMph: 2 });
  assert.equal(legs.length, 1, 'a trimmed piece of the richer bank, and nothing from the far one');
  assert.equal(legs[0].fromRamp.direction, 'upstream');
  assert.ok(legs[0].trimmedFrom === 8000);
});

test('a lake lane is not a river day and this function says nothing about one', () => {
  const lane = { runId: 'wateree_lake#27', lengthM: 4000, score: 100, batteryAh: 9 };
  assert.equal(riverDay([lane], { usableAh: 80, windowMin: 540 }).length, 0);
});

test('a reach with no measured current still costs two passes', () => {
  // Where the pack could not divide a discharge there is one number, and out-and-back is twice it.
  const c = { runId: 'r@0', fromRamp: { direction: 'upstream', m: 0 }, lengthM: 4000,
              score: 10, batteryAh: 7 };
  const legs = riverDay([c], { usableAh: 500, windowMin: 540, trollMph: 2 });
  assert.equal(legs.length, 1);
  assert.equal(legs.day.plannedAh, 14);
});

// ── AND THE MODEL DOES NOT GET TO UNDRAW IT ───────────────────────────────────────────────────
//
// Added 2026-09-17 with the speed work, because the two halves are one change: once riverDay()
// picks the reaches, the order and the turnaround, and the assembler sets the speed from the bait,
// there is nothing left on a river leg for the model to send but the rods and a sentence.
//
// AND THE FIRST TEST HERE IS A BUG THAT SHIPPED WITH STAGE ONE. `planArgsFrom` spread the model's
// answer over the candidate, absent fields included -- `{...c, trollPasses: undefined}` REPLACES
// the 2 riverDay() stamped, orientLegs' laps() reads undefined as one pass, and the day silently
// loses the whole way home. It only worked when the model echoed a number it had been told.
const { planArgsFrom } = await import('../js/modules/plan-prompt.js');

const RIVER = ['upstream', 'upstream'].map((d, i) => ({
  ...reach(d, i * 8000, 8000, 100, 12, 3),
  trollPasses: 2, currentMph: 0.84, passes: [],
  start: [-80.9, 33.88], end: [-80.8, 33.88],
}));
const RODS = [{ id: 'R1', lure: 'MR Crankbait (6-12ft)', color: 'shad', why: 'x' },
              { id: 'R5', lure: 'Nichols Lake Fork Flutter Spoon 3/4oz', color: 'chrome', why: 'y' }];
const answered = (legs) => planArgsFrom(
  { loadout: { why: 'two rods', rods: RODS }, legs, stops: [], changes: [], notes: {} },
  RIVER, { tackle: RODS.map((r) => r.lure) });

test('a river leg keeps the app\'s pass count when the model does not echo it', () => {
  const out = answered(RIVER.map((c) => ({ runId: c.runId, deploy: { port: 'R1', starboard: 'R5' },
                                           why: 'good water' })));
  for (const c of out.candidates) assert.equal(c.trollPasses, 2, `${c.runId} lost the way home`);
});

test('a speed or a pass count sent anyway is ignored, once, by name', () => {
  const out = answered(RIVER.map((c) => ({ runId: c.runId, speedMph: 3.4, trollPasses: 1,
                                           deploy: { port: 'R1', starboard: 'R5' }, why: 'x' })));
  for (const c of out.candidates) {
    assert.equal(c.trollPasses, 2);
    assert.equal(c.speedMph, undefined);
  }
  const said = out.problems.filter((p) => p.startsWith('ignored a speed or a pass count'));
  assert.equal(said.length, 1, out.problems.join('\n'));
  assert.ok(said[0].includes(RIVER[0].runId) && said[0].includes(RIVER[1].runId));
});

test('the order is the app\'s, and a reordered day is put back and said out loud', () => {
  const back = [RIVER[1], RIVER[0]].map((c) => ({ runId: c.runId, why: 'x',
                                                  deploy: { port: 'R1', starboard: 'R5' } }));
  const out = answered(back);
  assert.deepEqual(out.candidates.map((c) => c.runId), RIVER.map((c) => c.runId));
  assert.ok(out.problems.some((p) => p.includes('one path through the launch')));
});

test('a reach the model left out stays in the day with nothing in the water', () => {
  const out = answered([{ runId: RIVER[0].runId, why: 'x',
                          deploy: { port: 'R1', starboard: 'R5' } }]);
  assert.equal(out.candidates.length, 2, 'the app drew two reaches and spent the battery on two');
  assert.ok(out.problems.some((p) => p.includes(RIVER[1].runId) && p.includes('no rods')));
  // Not filled in from the leg beside it -- assemblePlan reports the empty spread on its own.
  assert.equal(out.deploy[RIVER[1].runId], undefined);
});

test('nothing at all still reads as nothing, rather than a day the app refilled', () => {
  const out = answered([]);
  assert.ok(out.problems.some((p) => p === 'the model chose no legs the app recognised'));
  assert.equal(out.candidates.length, 0);
});

test('a lake day is untouched: the model still sets the speed and the order', () => {
  const lake = RIVER.map((c) => ({ ...c, drift: null, currentMph: null, trollPasses: undefined }));
  const out = planArgsFrom(
    { loadout: { why: 'two rods', rods: RODS },
      legs: [lake[1], lake[0]].map((c) => ({ runId: c.runId, speedMph: 2.2, trollPasses: 2,
                                             deploy: { port: 'R1', starboard: 'R5' }, why: 'x' })),
      stops: [], changes: [], notes: {} },
    lake, { tackle: RODS.map((r) => r.lure) });
  assert.deepEqual(out.candidates.map((c) => c.runId), [lake[1].runId, lake[0].runId]);
  assert.equal(out.candidates[0].speedMph, 2.2);
  assert.equal(out.candidates[0].trollPasses, 2);
});
