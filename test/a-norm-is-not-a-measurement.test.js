/**
 * test/a-norm-is-not-a-measurement.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-09-05, on being told his own sonar could answer the thermocline question:
 * *"but that is backwards... you are saying i must go fish a lake to find out information to
 * fish a lake"*. A plan is written before the trip, and 342 of 355 waters have no cast at all.
 *
 * And immediately after, the constraint on the fix: *"estimate is better than nothing for
 * sure... as long as the LLM doesn't take that as the depth the fish are at"*.
 *
 * WHERE IT PRINTS, AND WHY NOT WHERE IT FIRST DID. The first wiring put the estimate inside
 * researchIntel()'s block, which is headed "Researched profile for this lake". Three existing
 * tests failed at once on one invariant: plan-depth-band's "omits what the research could not
 * establish rather than emitting a blank", and two requiring an empty profile to return null.
 * They were right. A national table is not a research finding about this water, and a lake
 * nobody has researched must not read as researched because a table had a row for its depth
 * class. It now travels as its own named input and prints in its own prompt section, beside the
 * coastal and river blocks. Until then this guards the table itself.
 *
 *   node --test test/a-norm-is-not-a-measurement.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { THERMOCLINE_NORMS, depthClassFor, thermoclineNorm }
  from '../js/data/thermocline-norms.js';
import { thermoclineNormFor, researchIntel } from '../js/modules/plan-inputs.js';
import { buildPlanRequest } from '../js/modules/plan-prompt.js';

const JULY = Date.parse('2026-07-15T12:00:00Z');
const JANUARY = Date.parse('2026-01-15T12:00:00Z');
const DEEP = { identity: { maxDepthFt: 150 }, limnology: { thermocline: { summerDepthFt: null } } };
const prompt = (norm) => buildPlanRequest({
  water: 'Test Water', ramp: 'A ramp', date: '2026-07-15', launchTime: '06:00',
  returnTime: '15:00', species: ['Striped Bass'], conditions: {}, candidates: [],
  thermoclineNorm: norm,
}).user;

test('the bins are the registry quartiles, ascending, and classify by max depth', () => {
  const e = THERMOCLINE_NORMS.depthClassEdgesFt;
  assert.equal(e.length, 3);
  assert.ok(e[0] < e[1] && e[1] < e[2], 'edges ascend');
  assert.equal(depthClassFor(e[0] - 1), 0);
  assert.equal(depthClassFor(e[2] + 1), 3);
  assert.equal(depthClassFor(null), null);
  assert.equal(depthClassFor(0), null);
  assert.equal(depthClassFor('not a depth'), null);
});

// AN UNSTRATIFIED LAKE HAS NO THERMOCLINE, and inventing one for February is worse than silence.
test('there is no answer outside June through September', () => {
  for (const m of [1, 4, 5, 10, 12]) assert.equal(thermoclineNorm(150, m), null, `month ${m}`);
  for (const m of [6, 7, 8, 9]) assert.ok(thermoclineNorm(150, m), `month ${m}`);
});

// THE SPREAD IS THE POINT. At the ninetieth percentile the error on a big lake is still twenty
// feet, so no row may be served as a lone figure. A caller that cannot reach p25, p75 and the
// cast count has no business printing the median.
test('every published row carries its spread and its sample size', () => {
  for (const m of [6, 7, 8, 9]) {
    for (const d of [8, 20, 40, 150, 400]) {
      const n = thermoclineNorm(d, m);
      if (!n) continue;
      assert.ok(n.medianFt > 0, 'a median');
      assert.ok(n.p25Ft <= n.medianFt && n.medianFt <= n.p75Ft, 'the median sits inside its band');
      assert.ok(n.casts >= 4, 'four casts is the fewest a quartile can sit between');
      assert.ok(n.basis === 'depth class and month' || n.basis === 'month');
      assert.equal(n.month, m);
    }
  }
});

test('a deep lake and a pond do not get the same answer', () => {
  const deep = thermoclineNorm(150, 9);
  const pond = thermoclineNorm(12, 9);
  assert.ok(deep.medianFt > pond.medianFt + 10,
    `deep ${deep.medianFt} ft should sit well below pond ${pond.medianFt} ft`);
});

// A cell is published only where its median differs from the month's by more than its own
// standard error -- see build_thermocline_norms.py. Where it was refused the month row answers,
// so a lake whose depth is unknown is still told something rather than nothing.
test('an unknown depth falls back to the month rather than to silence', () => {
  const n = thermoclineNorm(null, 8);
  assert.ok(n, 'the month row answers');
  assert.equal(n.basis, 'month');
  assert.deepEqual({ ...THERMOCLINE_NORMS.byMonth['8'], month: 8, basis: 'month' }, n);
});

test('the table is generated, not typed: every cell traces to counted casts', () => {
  const cells = Object.entries(THERMOCLINE_NORMS.byDepthClassAndMonth);
  assert.ok(cells.length > 0);
  for (const [key, row] of cells) {
    assert.match(key, /^[0-3]:[6-9]$/, `${key} is depthClass:month`);
    assert.ok(Number.isFinite(row.casts) && row.casts >= 4, `${key} carries its cast count`);
    assert.ok(Number.isFinite(row.stdErrFt), `${key} carries the error its publication turned on`);
  }
});


// ── WHAT ACTUALLY REACHES THE MODEL ──────────────────────────────────────────────────────────

// THE MEASUREMENT STANDS AND THE TABLE NEVER RUNS BESIDE IT. A typical value printed next to a
// measured one is an invitation to average them.
test('a measured thermocline suppresses the estimate entirely', () => {
  assert.equal(thermoclineNormFor(
    { identity: { maxDepthFt: 150 }, limnology: { thermocline: { summerDepthFt: 24 } } },
    JULY), null);
  assert.equal(thermoclineNormFor(DEEP, JULY, { limnology: { thermocline: { summerDepthFt: 31 } } }),
    null, 'a pack measurement suppresses it too');
});

test('with no cast on the water there is an estimate, and it follows the trip date', () => {
  assert.equal(thermoclineNormFor(DEEP, JULY).month, 7);
  assert.equal(thermoclineNormFor(DEEP, Date.parse('2026-09-15T12:00:00Z')).month, 9);
  assert.equal(thermoclineNormFor(DEEP, JANUARY), null, 'no thermocline to state in January');
  // NO PROFILE STILL GETS THE MONTH ROW. The depth class is what a profile would have added;
  // without it the calendar still says something, and the block it prints into says in its first
  // line that nothing was measured here. This is the one place the function differs from
  // researchIntel(), which returns null for a profile that reaches no plan -- that one is a claim
  // about this water and this is a statement about lakes.
  const noProfile = thermoclineNormFor(null, JULY);
  assert.ok(noProfile, 'the month row still answers');
  assert.equal(noProfile.basis, 'month');
});

// The invariant the first wiring broke, asserted from this side as well.
test('the estimate is not in the research block', () => {
  const text = researchIntel(
    { identity: { maxDepthFt: 150, archetype: 'reservoir' },
      limnology: { thermocline: { summerDepthFt: null }, oxygen: {}, waterClarity: {} } },
    'Striped Bass', 'summer', JULY);
  assert.doesNotMatch(text || '', /National Lakes Assessment/);
  assert.doesNotMatch(text || '', /NOT MEASURED/);
});

test('the prompt carries the estimate in a section of its own, or not at all', () => {
  assert.doesNotMatch(prompt(null), /THERMOCLINE ON THIS WATER HAS NOT BEEN MEASURED/);
  const p = prompt(thermoclineNormFor(DEEP, JULY));
  assert.match(p, /THE THERMOCLINE ON THIS WATER HAS NOT BEEN MEASURED/);
  assert.ok(p.indexOf('HAS NOT BEEN MEASURED') < p.indexOf('WHAT IS ALREADY KNOWN'),
    'it sits outside the research block, not inside it');
});

// Ryan's condition on the whole idea: "as long as the LLM doesn't take that as the depth the
// fish are at." The figure cannot be lifted out of this block without every caveat attached.
test('the number cannot be quoted without its band, its sample and its warnings', () => {
  const n = thermoclineNormFor(DEEP, JULY);
  const p = prompt(n);
  assert.ok(p.includes(String(n.medianFt)), 'the median is there');
  assert.ok(p.includes(String(n.p25Ft)) && p.includes(String(n.p75Ft)), 'so is the band');
  assert.ok(p.includes(String(n.casts)), 'and the sample size');
  assert.match(p, /NOT a fact about this one/);
  assert.match(p, /more likely reads shallow/);
  assert.match(p, /a boundary, not a depth to fish/);
  // The prompt wraps, so the sentence spans a line break -- match across the whitespace rather
  // than reflowing prose to suit a regex.
  assert.match(p, /Whatever the sounder shows\s+on the day beats every word of this/);
  assert.match(p, /July/, 'the trip month, not the word "summer"');
});
