// THE CARD SHOWED THE SALINITY AND THE PLAN FOR THE SAME DAY HAD NONE.
//
// Ryan, 2026-09-15: "lets do some chemistry and measure some salt before we do the extraction and
// find out we left something we needed behind." This is what the measuring found, and it was not
// on the drive — it was in the live path.
//
// COUNTED over the thirteen coastal zones in registry/water_bindings.json, 2026-09-15:
//
//   zone                      water-quality sondes   USGS sites publishing 00095/00480
//   ace_basin_sc                              3                                      0
//   st_helena_sc                              2                                      0
//   charleston_sc                             1                                      8
//   santee_delta_sc                           2                                      2
//   winyah_bay_sc                             2                                      3
//   the other eight                           0                                   0..6
//
// So on ACE BASIN and ST. HELENA a NERRS reserve sonde is the ONLY source of salinity, oxygen or
// water temperature that either water has. `Worker/ndbc.js` has read all three off those sondes
// since it was written. `Worker/conditions.js` promoted exactly one of them — water temperature —
// into the shared slot, and `out.salt` and `out.dissolved_oxygen` went on being filled from USGS
// sites only. On a water with no USGS site they stayed null.
//
// The result was visible and nobody could see it: conditions-strip.js renders the sonde's
// salinity straight off `c.ndbc.ocean`, so the CARD for ACE Basin showed a measured psu while the
// SmartPlan for the same water on the same day said nothing about salt at all. The comment beside
// that card row even promised the rest of the sonde "stays in the payload for SmartPlan" — a
// promise with no code behind it.
//
// THE RECURRING DEFECT, again: a value fetched correctly and addressed to nobody.
//
// UNITS ARE THE WHOLE RISK IN THE FIX. The sonde reports psu on the Practical Salinity Scale and
// USGS publishes ppt under 00480; the sonde's oxygen column is ppm and USGS 00300 is mg/L. This
// app converts neither, anywhere, so the promotion carries its own value key and its own unit
// word all the way to the prompt. These tests exist mostly to hold that line: the day somebody
// writes `salinityPpt = salinity_psu` the plan starts quoting a measurement that was never taken.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from './expect-shim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');

// A GUARD ABOUT WHAT CODE DOES MUST NOT SEE WHAT CODE SAYS. Six tests in this repo have already
// passed or failed by matching their own prose; every source read here is comment-stripped first.
const strip = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const WORKER = strip(src('Worker/conditions.js'));
const COND = strip(src('js/utils/water-conditions.js'));
const PRE = strip(src('js/modules/plan-preflight.js'));

const { coastalPromptBlock, conditionsPromptBlock } = await import('../js/modules/plan-prompt.js');
const { isNum, num } = await import('../js/utils/num.js');

// `SONDE_PROMOTIONS` appears TWICE in the source -- the declaration and the `for (const p of`
// that walks it -- so a naive split('SONDE_PROMOTIONS')[1] is the gap BETWEEN them and contains
// the table but not the loop. The first draft of these tests did exactly that and three of them
// failed against correct code. Each half is cut on its own terms.
const TABLE = WORKER.split('SONDE_PROMOTIONS = [')[1].split('];')[0];
const LOOP = WORKER.split('for (const p of SONDE_PROMOTIONS)')[1].split('\n  }')[0];

describe('the sonde promotion covers every field the sonde measures and a consumer reads', () => {
  it('is a table, so adding a field is adding a row and not editing a branch', () => {
    // "nothing hand written... everything expandable". Three hand-written if-blocks would have
    // been three places to forget the unit key.
    expect(WORKER).toContain('SONDE_PROMOTIONS');
    expect(/SONDE_PROMOTIONS\s*=\s*\[/.test(WORKER)).toBe(true);
  });

  it('promotes temperature, salt and oxygen — not temperature alone', () => {
    expect(TABLE).toContain("field: 'water_temp'");
    expect(TABLE).toContain("field: 'salt'");
    expect(TABLE).toContain("field: 'dissolved_oxygen'");
  });

  it('reads the sonde keys ndbc.js actually shapes, not invented ones', () => {
    const shaped = strip(src('Worker/ndbc.js'));
    for (const k of ['water_c', 'salinity_psu', 'oxygen_ppm']) {
      expect(TABLE).toContain(k);
      // The name has to exist on the other side of the wire or the promotion is decoration.
      expect(shaped).toContain(`${k}:`);
    }
  });

  it('never overwrites a reading this water already produced', () => {
    // The binding order is a preference, not a result: a USGS site ON the water beats a sonde
    // beside it, and the sonde only answers where nothing else did.
    expect(LOOP).toContain('if (out[p.field]) continue;');
  });

  it('skips a field the sonde did not measure today rather than sending a zero', () => {
    // NOT SAMPLED IS NOT ZERO. A sonde out of the water reports nothing, not fresh water.
    expect(/Number\.isFinite\(sonde\[p\.from\]\)/.test(LOOP)).toBe(true);
  });

  it('does not put a usgs_site key on a reading that has no USGS site behind it', () => {
    expect(LOOP).toContain('ndbc_station:');
    expect(LOOP.includes('usgs_site:')).toBe(false);
  });

  it('runs before the upstream borrow, so a sonde beside the water beats one up the river', () => {
    // Two temperatures on one card is two numbers that can disagree, and the order decides which
    // one the card gets.
    expect(WORKER.indexOf('SONDE_PROMOTIONS')).toBeLessThan(WORKER.indexOf('upstreamTemp(b.slug'));
  });
});

describe('psu is not ppt and ppm is not mg/L, at every hop', () => {
  it('water-conditions keeps salinityPsu in its own field', () => {
    expect(COND).toContain('salinityPsu');
    expect(/out\.salinityPsu\s*=\s*w\.salt\.psu/.test(COND)).toBe(true);
    // The conversion this app refuses to do.
    expect(/salinityPpt\s*=\s*w\.salt\.psu/.test(COND)).toBe(false);
  });

  it('water-conditions keeps oxygenPpm in its own field', () => {
    expect(COND).toContain('oxygenPpm');
    expect(/out\.oxygenPpm\s*=\s*w\.dissolved_oxygen\.ppm/.test(COND)).toBe(true);
    expect(/oxygenMgL\s*=\s*w\.dissolved_oxygen\.ppm/.test(COND)).toBe(false);
  });

  it('both new fields are in the defaults block, so the shape is the same on a lake', () => {
    // Every field this app added without a default has eventually been read as undefined
    // somewhere that could not tell it from a missing reading.
    const defaults = COND.split('salinityPpt: null')[0].slice(-4000) + COND.split('salinityPpt: null')[1].slice(0, 2000);
    expect(defaults).toContain('salinityPsu: null');
    expect(defaults).toContain('oxygenPpm: null');
  });

  it('plan-preflight forwards salinityPsu onto the tidal block', () => {
    // The whole bug, one layer up: computed, and addressed to nobody.
    expect(/salinityPsu:\s*c && Number\.isFinite\(c\.salinityPsu\)/.test(PRE)).toBe(true);
  });
});

describe('the prompt says the salt on a zone whose only gauge is a sonde', () => {
  const zone = (tidal) => coastalPromptBlock({ featureType: 'coastal', tidal });

  it('prints psu, names the sonde and refuses to restate it as ppt', () => {
    const out = zone({
      salinityPpt: null, conductanceUsCm: null, salinityPsu: 31.4,
      saltGauge: 'Grove Plantation, ACE Basin Reserve, SC', saltGaugeKm: 1.4,
      saltBasis: 'salinity_psu',
    });
    expect(out).toContain('31.4 psu');
    expect(out).toContain('Grove Plantation, ACE Basin Reserve, SC');
    expect(out).toContain('1.4 km from the launch');
    expect(out).toContain('do not restate it as ppt');
    // And it must not have quietly grown a ppt line beside it.
    expect(out.includes('31.4 ppt')).toBe(false);
  });

  it('prefers a USGS ppt over a sonde psu when the water has both', () => {
    // Charleston binds eight sites publishing salt AND a sonde at Fort Johnson. One number.
    const out = zone({
      salinityPpt: 28.4, salinityPsu: 31.4, conductanceUsCm: 41200,
      saltGauge: 'Shem Creek', saltGaugeKm: 1.2, saltBasis: 'salinity',
    });
    expect(out).toContain('28.4 ppt');
    expect(out.includes('31.4 psu')).toBe(false);
    expect(out.includes('41200')).toBe(false);
  });

  it('prefers a sonde psu over a bare conductance, because psu is the salinity', () => {
    const out = zone({
      salinityPpt: null, salinityPsu: 31.4, conductanceUsCm: 41200,
      saltGauge: 'St. Pierre, ACE Basin Reserve, SC', saltGaugeKm: 0.9,
    });
    expect(out).toContain('31.4 psu');
    expect(out.includes('41200')).toBe(false);
  });

  it('still carries the far-gauge warning on a psu reading', () => {
    // The distance rule is about where the number was taken, not about which scale it is on.
    const out = zone({
      salinityPpt: null, salinityPsu: 8.2, saltGauge: 'Bennett’s Point', saltGaugeKm: 12.6,
    });
    expect(out).toContain('8.2 psu');
    expect(out).toContain('DIRECTION, NOT A READING');
  });

  it('says nothing at all on a zone that publishes no salt in any unit', () => {
    // Brunswick/St Simons and Ossabaw/St Catherines bind no salt gauge and no water-quality
    // sonde. A silent line is the right answer; an invented one is not.
    const out = zone({ salinityPpt: null, salinityPsu: null, conductanceUsCm: null });
    expect(out.includes('Salinity')).toBe(false);
    expect(out.includes('Conductance')).toBe(false);
  });
});

describe('the prompt says the oxygen on a zone whose only gauge is a sonde', () => {
  it('prints ppm, in the unit the sonde measured, with the same threshold', () => {
    const out = conditionsPromptBlock({ oxygenMgL: null, oxygenPpm: 5.8 });
    expect(out).toContain('5.8 ppm');
    expect(out).toContain('Below about 4');
    expect(out.includes('5.8 mg/L')).toBe(false);
  });

  it('prefers the USGS mg/L where a gauge publishes 00300', () => {
    const out = conditionsPromptBlock({ oxygenMgL: 6.1, oxygenPpm: 5.8 });
    expect(out).toContain('6.1 mg/L');
    expect(out.includes('5.8 ppm')).toBe(false);
  });

  it('says nothing when neither exists', () => {
    const out = conditionsPromptBlock({ oxygenMgL: null, oxygenPpm: null });
    expect(out.includes('Dissolved oxygen')).toBe(false);
  });
});

describe('the counted number in the comments is the counted number', () => {
  it('no longer claims Charleston binds twenty gauges publishing salt', () => {
    // I wrote "TWENTY" into two files on 2026-09-15 without counting. The real count off
    // registry/water_bindings.json is twenty-six bound gauges, EIGHT of which publish 00095 or
    // 00480, and five of those eight publish 00480. An invented number in a comment is a number
    // the next reader will believe.
    const raw = src('js/utils/water-conditions.js') + src('js/modules/plan-prompt.js');
    expect(/binds TWENTY gauges/.test(raw)).toBe(false);
    expect(/twenty publishing salinity or conductance/.test(raw)).toBe(false);
  });
});

// ── AND THE SECOND THING THE MEASURING FOUND, WHICH WAS BIGGER ──────────────────────────────
//
// Writing the oxygen test above produced this, on a `ws` with every field null:
//
//     WHAT THE GAUGES SAY TODAY
//     Water temperature null °F.
//     Dissolved oxygen null mg/L. Below about 4 mg/L is not holding fish.
//     Chance of rain null% in the first forecast period.
//     Barometer null mb — one observation, so there is no trend in it.
//     Flow versus normal null — National Water Model anomaly, published without units.
//
// conditionsPromptBlock()'s own docblock says "Every line is silent when its field is null.
// Nothing is inferred from an absence." Five lines did the opposite on every water with no gauge
// bound to it, which is most of the registry. The guard was `Number.isFinite(Number(x))`, and
// Number(null) is 0, and 0 is finite — so the guard passed and the template printed the ORIGINAL
// value, the string "null", beside a unit.
//
// plan-preflight.js spreads the whole water-conditions object into the summary and does not
// prune it, and water-conditions.js declares every one of these fields `null` in its defaults
// block ON PURPOSE so the shape is the same on every water. So null is not an edge case here;
// it is the normal state of an unbound field.
describe('a field nothing measured is silent, not a zero and not the word null', () => {
  it('prints no gauge block at all when no gauge said anything', () => {
    const out = conditionsPromptBlock({
      waterTempF: null, oxygenMgL: null, oxygenPpm: null,
      popPct: null, pressureMb: null, flowAnomaly: null,
    });
    expect(out).toBe('');
  });

  it('never puts the word null next to a unit', () => {
    const out = conditionsPromptBlock({
      waterTempF: null, oxygenMgL: null, popPct: null, pressureMb: null, flowAnomaly: null,
      moonPhase: 'waxing gibbous',
    });
    expect(/null\s*(°F|mg\/L|ppm|%|mb)/.test(out)).toBe(false);
    // The one field that DID answer still answers.
    expect(out).toContain('waxing gibbous');
  });

  it('still prints a real zero, because zero is a reading', () => {
    // The fix must not overshoot into treating 0 as absence. A flow anomaly of 0 means the
    // National Water Model puts this water exactly at normal, which is a fact.
    const out = conditionsPromptBlock({ flowAnomaly: 0 });
    expect(out).toContain('Flow versus normal 0');
  });

  it('isNum says no to every shape of absence and yes to every shape of number', () => {
    for (const v of [null, undefined, '', '   ', [], {}, NaN, Infinity, -Infinity, true, false, 'x']) {
      expect(isNum(v)).toBe(false);
    }
    for (const v of [0, -1, 3.4, '0', '3.4', ' 12 ']) expect(isNum(v)).toBe(true);
  });

  it('num returns null for an absence rather than zero', () => {
    // This is the whole bug in one assertion: the local copy this replaced returned 0 here.
    expect(num(null)).toBe(null);
    expect(num('')).toBe(null);
    expect(num('   ')).toBe(null);
    expect(num([])).toBe(null);
    expect(num(0)).toBe(0);
    expect(num('3.4')).toBe(3.4);
  });

  it('plan-prompt.js has no copy of the guard left in it', () => {
    // Twelve call sites in this one file used the pattern. Leaving one behind is leaving the
    // next instance of this family behind with it.
    expect(strip(src('js/modules/plan-prompt.js')).includes('Number.isFinite(Number(')).toBe(false);
  });
});
