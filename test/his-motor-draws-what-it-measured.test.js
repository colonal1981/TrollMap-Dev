// His motor draws what it measured.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Until 2026-09-28 every amp-hour in the app came from a two-point fit to two estimates: 5.0 A at
// 2.0 mph, exponent 1.756. On Wateree that day Ryan read 2.0 A at 1.9 mph into the wind, the app
// began logging his BMS, and the log against his GPX gave thirteen steady stretches. He also read
// "max speed today was 4.8mph and was pulling 25 amps 599 watts... which is the motor max". Then:
// "ok lets switch the app to my actual battery curve".
//
// What these hold:
//   1. the curve is fitted from the listed readings, in the file, not typed;
//   2. it goes through them: about 2.2 A at 2.0 mph, 25 A at full throttle, 2 A at 1.9 mph;
//   3. the prompt and the report quote Ah off the curve, not the old typed figures.

import { describe, it } from './expect-shim.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ampsAtMph, ahPerMile, AMPS_EXP, AMPS_REF_A, MEASURED_DRAW, TOP_SPEED_MPH }
  from '../js/modules/plan-candidates.js';

describe('the curve is his motor', () => {
  it('is fitted from the readings it lists', () => {
    assert.equal(MEASURED_DRAW.length, 14);
    // Least squares in log-log, done again here from the same rows.
    const xs = MEASURED_DRAW.map((r) => Math.log(r[0])), ys = MEASURED_DRAW.map((r) => Math.log(r[1]));
    const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
    const b = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    assert.ok(Math.abs(AMPS_EXP - b) < 1e-12);
    assert.ok(Math.abs(AMPS_REF_A - Math.exp(my - b * mx) * 2 ** b) < 1e-12);
  });

  it('goes through what he read', () => {
    assert.ok(Math.abs(ampsAtMph(2.0) - 2.21) < 0.01, `2.0 mph: ${ampsAtMph(2.0)}`);
    assert.ok(Math.abs(ampsAtMph(1.9) - 1.93) < 0.05, `1.9 mph: ${ampsAtMph(1.9)} (he read 2.0 into the wind)`);
    assert.ok(Math.abs(ampsAtMph(TOP_SPEED_MPH) - 25) < 0.5, `full throttle: ${ampsAtMph(TOP_SPEED_MPH)}`);
    assert.ok(AMPS_EXP > 2.7 && AMPS_EXP < 2.8, `exponent ${AMPS_EXP}`);
    // And it is about half the old fit at trolling speed, which is what his day showed: 15 Ah used
    // in 5.8 hours against a plan that priced its own day at 34.8.
    assert.ok(ampsAtMph(2.0) < 5.0 / 2);
  });

  it('prices a mile off the curve', () => {
    assert.ok(Math.abs(ahPerMile(2.0) - 1.1) < 0.01);
    assert.ok(Math.abs(ahPerMile(3.5) - 2.97) < 0.01);
  });
});

describe('what he reads says the same', () => {
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  it('the prompt quotes Ah per mile off the curve at the planners\' speeds', () => {
    const prompt = src('../js/modules/plan-prompt.js');
    assert.ok(!prompt.includes('Trolling costs about 2.5 Ah per mile'));
    assert.ok(prompt.includes('${ahPerMile(TROLL_MPH).toFixed(1)} Ah per mile'));
  });
  it('the report\'s battery rows come off the curve, and the hand-written ones are gone', () => {
    const pb = src('../js/modules/plan-builder.js');
    assert.ok(!pb.includes("'Typical (standard tournament troll 2.2–2.5 mph)'"));
    assert.ok(pb.includes('const a = ampsAtMph(mph);'));
  });
});
