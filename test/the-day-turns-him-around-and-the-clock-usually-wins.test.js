// THE DAY TURNS HIM AROUND, AND SAYING WHICH CONSTRAINT BINDS IS THE WHOLE VALUE.
//
// Ryan: "if it can draw a line that i can follow and then turn me back around based on speed, and can
// actually predict river current and how much battery i would use that would be even better."
//
// The riverPromptBlock has asked the model "how much of the trolling speed is the river rather than the
// motor" and "whether a leg is worth running upstream at all" since it was written, with nothing but a
// discharge in ft3/s to answer either -- a volume, not a speed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnaroundMiles, ampsAtMph } from '../js/modules/plan-candidates.js';
import { driftCurrentSummary } from '../js/modules/river-drifts.js';
import { riverPromptBlock } from '../js/modules/plan-prompt.js';

const RIVER = { featureType: 'river', river: { flowCfs: 3000, flowGauge: 'USGS 02169500' } };
const LAKE = { featureType: 'lake', river: { flowCfs: 1020, generatingNow: false } };

test('the asymmetry is real, and it comes out of the curve rather than a rule of thumb', () => {
  const t = turnaroundMiles({ usableAh: 80, windowMin: 540, trollMph: 2.0, currentMph: 0.95 });
  // Worked by hand: amps(2.95)/2 against it, amps(1.05)/2 with it.
  assert.ok(Math.abs(t.ahPerMileUp - ampsAtMph(2.95) / 2) < 0.01);
  assert.ok(Math.abs(t.ahPerMileDown - ampsAtMph(1.05) / 2) < 0.01);
  // Against it costs several times what it saves coming back, because the curve is convex -- which is
  // exactly why "at least half the day" is the right instinct and a bad rule.
  assert.ok(t.ahPerMileUp > t.ahPerMileDown * 4,
            `${t.ahPerMileUp} against vs ${t.ahPerMileDown} with`);
});

test('and on his boat it is the clock that binds, not the battery', () => {
  // 80 usable Ah against 0.95 mph buys about 13.9 miles up; a nine-hour window at 2.0 mph buys 9.0.
  // A number that quoted only the battery would send him planning water he has no hours for.
  const t = turnaroundMiles({ usableAh: 80, windowMin: 540, trollMph: 2.0, currentMph: 0.95 });
  assert.ok(t.batteryMiles > 13 && t.batteryMiles < 15, `battery ${t.batteryMiles}`);
  assert.equal(t.clockMiles, 9);
  assert.equal(t.milesUp, 9);
  assert.equal(t.binding, 'clock');
});

test('a faster river moves the battery limit in, monotonically', () => {
  const at = (c) => turnaroundMiles({ usableAh: 80, windowMin: 540, trollMph: 2.0, currentMph: c });
  const miles = [0, 0.5, 0.95, 1.4, 1.8].map((c) => at(c).batteryMiles);
  for (let i = 1; i < miles.length; i++) {
    assert.ok(miles[i] < miles[i - 1], `more current must mean fewer miles: ${miles.join(' > ')}`);
  }
  // AND THE CLOCK STILL WINS AT EVERY ONE OF THOSE, which was worth measuring rather than assuming:
  // my first version of this test asserted the battery binds at 1.8 mph and it does not -- 10.3 miles
  // against the clock's 9.0. On a nine-hour day at 2 mph the hours are the scarce thing almost always.
  for (const c of [0, 0.5, 0.95, 1.4, 1.8]) assert.equal(at(c).binding, 'clock', `at ${c} mph`);
});

test('but a half-charged battery is what actually takes the day off him', () => {
  // 40 usable Ah rather than 80 -- the realistic way the battery becomes the binding constraint.
  const half = turnaroundMiles({ usableAh: 40, windowMin: 540, trollMph: 2.0, currentMph: 0.95 });
  assert.ok(half.batteryMiles < half.clockMiles, `battery ${half.batteryMiles} vs clock ${half.clockMiles}`);
  assert.equal(half.binding, 'battery');
  assert.equal(half.milesUp, half.batteryMiles);
});

test('no window means the battery is the only answer there is, and it says so', () => {
  const t = turnaroundMiles({ usableAh: 80, trollMph: 2.0, currentMph: 0.95 });
  assert.equal(t.clockMiles, null);
  assert.equal(t.binding, 'battery');
  assert.equal(t.milesUp, t.batteryMiles);
  assert.equal(turnaroundMiles({ trollMph: 2.0 }), null, 'and no battery means no answer at all');
});

test('the day current is a median with its support beside it', () => {
  const d = (mph, basis) => ({ properties: mph == null
    ? { current_basis: basis } : { current_mph: mph, current_basis: basis } });
  const s = driftCurrentSummary([d(0.8, 'Q/A — a'), d(1.0, 'Q/A — b'), d(1.4, 'Q/A — c'),
                                 d(null, 'no station on this reach has 2 ft')]);
  assert.equal(s.medianMph, 1);
  assert.equal(s.n, 3);
  assert.equal(s.ofN, 4);
  assert.match(s.basis, /Q\/A/);
  // When NOTHING could be measured the reason travels instead of the number.
  const none = driftCurrentSummary([d(null, 'tidal — the current reverses here')]);
  assert.equal(none.medianMph, null);
  assert.equal(none.n, 0);
  assert.match(none.basis, /tidal/);
  assert.equal(driftCurrentSummary([]), null);
});

test('the prompt says the speed, the turnaround and which constraint binds', () => {
  const rc = { medianMph: 0.95, n: 69, ofN: 96, basis: 'Q/A — median of 40 station velocities',
               turnaround: turnaroundMiles({ usableAh: 80, windowMin: 540, trollMph: 2.0,
                                             currentMph: 0.95 }) };
  const block = riverPromptBlock(RIVER, { riverCurrent: rc });
  assert.match(block, /Current about 0\.95 mph down the channel/);
  assert.match(block, /69 of 96 reaches measurable/);
  assert.match(block, /48% of a 2 mph trolling speed/);
  assert.match(block, /turns him around at about 9 miles up/);
  assert.match(block, /the clock is what binds/);
  assert.match(block, /battery 13\.9 mi, clock 9 mi/);
  assert.match(block, /ORDER THE DAY UPSTREAM FIRST/);
  assert.match(block, /Assumes trolling the whole way at one speed and one current/,
               'the assumptions are stated, not buried');
});

test('and when there is no velocity it says why and forbids inventing one', () => {
  const block = riverPromptBlock(RIVER, {
    riverCurrent: { medianMph: null, n: 0, ofN: 96,
                    basis: 'tidal — the current reverses here, so Q/A does not describe it' },
  });
  assert.match(block, /No channel velocity for this water/);
  assert.match(block, /tidal/);
  assert.match(block, /Do not invent one/);
  assert.doesNotMatch(block, /turns him around/);
});

test('a lake is never told about channel velocity, whatever its gauge says', () => {
  // fetchWaterState() fills `river` for any water with a flow reading or a generating dam, so a Duke
  // impoundment lands in this block. It must not be handed a river sentence -- Ryan on the last time
  // that happened: "whats up with this on a lake?"
  const rc = { medianMph: 0.95, n: 10, ofN: 10, basis: 'Q/A — whatever',
               turnaround: turnaroundMiles({ usableAh: 80, windowMin: 540, trollMph: 2.0,
                                             currentMph: 0.95 }) };
  const block = riverPromptBlock(LAKE, { riverCurrent: rc });
  assert.doesNotMatch(block, /Current about/);
  assert.doesNotMatch(block, /turns him around/);
  assert.doesNotMatch(block, /No channel velocity/);
  assert.match(block, /NOT A CURRENT ACROSS THE LAKE/, 'it still gets the impoundment wording');
});

test('and a river with no riverCurrent at all is unchanged from before this existed', () => {
  const block = riverPromptBlock(RIVER, {});
  assert.match(block, /RIVER/);
  assert.match(block, /Discharge 3,000/);
  assert.doesNotMatch(block, /Current about/);
  assert.doesNotMatch(block, /No channel velocity/);
});
