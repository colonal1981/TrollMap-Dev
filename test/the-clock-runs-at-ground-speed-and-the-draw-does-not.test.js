// THE DRAW IS AT THROUGH-WATER SPEED AND THE CLOCK RUNS AT GROUND SPEED.
//
// `ampHoursBand()` called `ampHours(metres, throughWater)`, and `ampHours()` uses its one speed
// argument for both the current draw and the elapsed time. In still water those are the same number.
// The moment the water moves they are not, and the function's own signature says which is which:
// `@param mph speed over ground`.
//
// Found 2026-09-16 while wiring the first current the app has ever had. The old form understated an
// upstream leg by a third, in the direction that breaks the one rule Ryan said must be rigid: "if
// they are going to run out of battery because of choice they shouldn't be able to make that choice."
// No test pinned the old value, so nothing about it was deliberate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ampHoursBand } from '../js/modules/plan-water.js';
import { ampHours, ampsAtMph } from '../js/modules/plan-candidates.js';

const MI = 1609.34;

test('in still water the two speeds are the same number and nothing changes', () => {
  // The regression guard for the fix: it must not move the still-water case, which is every lake
  // day with no wind and is what the two-point battery fit was made against.
  const still = ampHoursBand(5000, 2.0, 90, {});
  assert.ok(Math.abs(still.ah - ampHours(5000, 2.0)) < 1e-9,
            'no current, no wind: identical to the plain curve');
  assert.equal(still.throughWaterMph, 2);
});

test('upstream costs the draw of the water and the hours of the ground', () => {
  // 8 km at 2.0 mph over ground against 1.0 mph of current is 3.0 mph through the water.
  const up = ampHoursBand(8000, 2.0, 90, { currentMph: 1.0, currentDeg: 90 });
  assert.equal(up.throughWaterMph, 3);
  assert.equal(up.currentMph, 1);

  const expected = ampsAtMph(3.0) * (8000 / MI) / 2.0;   // draw at 3.0, clock at 2.0
  const oldWrong = ampHours(8000, 3.0);                   // draw AND clock at 3.0
  assert.ok(Math.abs(up.ah - expected) < 1e-9, `${up.ah} should be ${expected}`);
  assert.ok(up.ah > oldWrong * 1.4, `the old form understated it: ${oldWrong} vs ${up.ah}`);
  // And the size of it, because a third of a leg's battery is not a rounding difference.
  assert.ok(up.ah > 25 && up.ah < 26, `~25.3 Ah on his numbers, got ${up.ah.toFixed(2)}`);
});

test('and a following current is still a discount, not a floor at zero', () => {
  // The comment beside the through-water sum argues this and it must survive the fix: "a tailwind
  // and a following current both help, so neither is floored at zero -- clamping a push to zero
  // would make every day cost more than it does."
  const down = ampHoursBand(8000, 2.0, 90, { currentMph: 1.0, currentDeg: 270 });
  assert.equal(down.throughWaterMph, 1);
  assert.equal(down.currentMph, -1);
  const still = ampHoursBand(8000, 2.0, 90, {});
  assert.ok(down.ah < still.ah, 'going with the water is cheaper than still water');
  // Same distance, same ground speed, so the clock is identical and only the draw differs.
  const expected = ampsAtMph(1.0) * (8000 / MI) / 2.0;
  assert.ok(Math.abs(down.ah - expected) < 1e-9);
});

test('up and back is dearer than twice the still-water leg', () => {
  // The whole reason this matters on a river. He fishes up and comes back: "i go up stream against
  // the current for at least half the day... then i come back down... speed on the way back is much
  // easier and usage will be close to 0 if there is river current."
  //
  // The saving downstream does NOT cancel the cost upstream, because the draw curve is convex --
  // amps go as mph^1.756, so a mph added on the nose costs more than a mph taken off the tail saves.
  // The old arithmetic hid that by shortening the upstream clock, which is exactly the leg it should
  // have been lengthening.
  const up = ampHoursBand(8000, 2.0, 90, { currentMph: 1.0, currentDeg: 90 });
  const down = ampHoursBand(8000, 2.0, 270, { currentMph: 1.0, currentDeg: 90 });
  const stillTwice = 2 * ampHoursBand(8000, 2.0, 90, {}).ah;
  assert.ok(up.ah + down.ah > stillTwice,
            `up+back ${(up.ah + down.ah).toFixed(1)} Ah should exceed still-water ${stillTwice.toFixed(1)}`);
  // And it is direction-independent, which is what lets a river leg be costed before anything has
  // decided which way round it gets fished.
  const upOther = ampHoursBand(8000, 2.0, 270, { currentMph: 1.0, currentDeg: 270 });
  const downOther = ampHoursBand(8000, 2.0, 90, { currentMph: 1.0, currentDeg: 270 });
  assert.ok(Math.abs((up.ah + down.ah) - (upOther.ah + downOther.ah)) < 1e-9,
            'the pair costs the same whichever end you start from');
});

test('wind was affected by the same conflation, on every lake day', () => {
  // 3% of a 12 mph headwind is 0.36 mph of surface drift, so through-water is 2.36 against a ground
  // speed of 2.0. The clock must still run at 2.0.
  const b = ampHoursBand(5000, 2.0, 90, { wind: { mph: 12, deg: 90 } });
  assert.equal(b.throughWaterMph, 2.36);
  assert.equal(b.headwindMph, 12);
  const expected = ampsAtMph(2.36) * (5000 / MI) / 2.0;
  assert.ok(Math.abs(b.ah - expected) < 1e-9);
  assert.ok(b.ah > ampHours(5000, 2.36), 'and it is dearer than the old form said');
});
