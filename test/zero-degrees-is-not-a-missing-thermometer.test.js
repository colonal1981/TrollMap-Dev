// ZERO DEGREES IS NOT A MISSING THERMOMETER.
//
// smart-plan-v2-wiring.js builds the squeeze block's water temperature, and the comment directly
// above that line is a promise:
//
//   "THE SAME NUMBER THE MODEL IS SHOWN. The conditions block prints waterState's live reading,
//    so the squeeze has to reason about that one -- two temperatures for one lake in one prompt
//    is the defect fixed in bd48bcf... The form value is the fallback."
//
// The guard under it was `Number.isFinite(Number(waterState.waterTempF))`. `waterTempF` is
// declared `null` in water-conditions.js's defaults ON PURPOSE, so the object has the same shape
// on a water with no thermometer as on one with a gauge in it -- and `Number(null)` is 0, which is
// finite. So the guard passed on every ungauged water, the squeeze was handed ZERO DEGREES, and
// `inp.waterTempF` was never reached on the one path it exists for.
//
// It got worse this morning, not better. conditionsPromptBlock() used to print
// "Water temperature null °F" on those same waters and was fixed to stay silent. The moment it
// went silent, these two stopped agreeing: the block the comment points at says nothing and the
// squeeze says 0 °F. Two readings of ONE field, disagreeing, in one prompt -- precisely what
// bd48bcf closed and what the comment exists to prevent.
//
// Eighth instance of the Number(null) family. js/utils/num.js carries the list.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from './expect-shim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');
// A guard about what code DOES must not match what code SAYS: the prose above quotes the very
// expression these tests assert is gone.
const strip = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const WIRING = strip(src('js/modules/smart-plan-v2-wiring.js'));
const { isNum } = await import('../js/utils/num.js');

// The expression as it is written in the file, evaluated on the inputs that reach it. Importing
// smart-plan-v2-wiring.js pulls in the whole Smart Plan graph and `state`, so the one line is
// reproduced here and the test below pins that the file still says this.
//
// 2026-09-26: the line is now `lakeSurfaceTemp(waterState, inp.waterTempF)` in
// js/utils/water-conditions.js, because a reading below the dam on a lake is not the surface
// (Murray: 60.3 F in the Saluda below the dam, the lake near 80). The absence rules here are
// unchanged and are tested against the real function rather than a copy of one line.
const { lakeSurfaceTemp } = await import('../js/utils/water-conditions.js');
const squeezeTempF = (waterState, inp) => lakeSurfaceTemp(waterState, inp.waterTempF).tempF;

describe('the squeeze gets the measured temperature, the form value, or nothing', () => {
  it('a live reading wins', () => {
    expect(squeezeTempF({ waterTempF: 84.9 }, { waterTempF: 78 })).toBe(84.9);
  });

  it('a water with NO thermometer falls back to the form, and never to zero', () => {
    // This is the whole bug. Before the fix this returned 0.
    expect(squeezeTempF({ waterTempF: null }, { waterTempF: 78 })).toBe(78);
  });

  it('no waterState at all falls back to the form', () => {
    expect(squeezeTempF(null, { waterTempF: 78 })).toBe(78);
    expect(squeezeTempF(undefined, { waterTempF: 78 })).toBe(78);
  });

  it('gives nothing rather than zero when neither the gauge nor the form answered', () => {
    // A silent field is a field the prompt block skips. A zero is a reading the model will use.
    expect(squeezeTempF({ waterTempF: null }, {})).toBe(null);
  });

  it('a real zero from a real gauge still passes, because 0 °F is a reading', () => {
    // Not on his water in September, but the guard must reject absence and not the number zero.
    expect(squeezeTempF({ waterTempF: 0 }, { waterTempF: 78 })).toBe(0);
  });

  it('a blank string is absence, not zero', () => {
    expect(squeezeTempF({ waterTempF: '' }, { waterTempF: 78 })).toBe(78);
    expect(squeezeTempF({ waterTempF: '   ' }, { waterTempF: 78 })).toBe(78);
  });

  it('a numeric string from the form is still a number', () => {
    expect(squeezeTempF({ waterTempF: '84.9' }, { waterTempF: 78 })).toBe(84.9);
  });
});

describe('the file itself no longer carries the guard that caused it', () => {
  it('the squeeze temperature comes from lakeSurfaceTemp, with the form value as its fallback', () => {
    // If someone ever replaces `inp.waterTempF` with a literal, the fallback stops being the
    // thing the person typed and becomes another invented number.
    expect(/lakeSurfaceTemp\(waterState, inp\.waterTempF\)/.test(WIRING)).toBe(true);
  });

  it('nothing in the file still asks Number.isFinite(Number(...))', () => {
    // One copy left behind is the ninth instance waiting to happen.
    expect(WIRING.includes('Number.isFinite(Number(')).toBe(false);
  });

  it('lakeSurfaceTemp reads its numbers through num(), from the one place that defines it', () => {
    const WC = strip(src('js/utils/water-conditions.js'));
    expect(/import \{ num \} from '\.\/num\.js'/.test(WC)).toBe(true);
  });
});
