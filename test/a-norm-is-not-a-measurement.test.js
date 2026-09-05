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
 * NOTHING READS THIS TABLE YET, AND A TEST SAID WHY. The first wiring printed the estimate into
 * researchIntel()'s block, which is headed "Researched profile for this lake". Three existing
 * tests failed at once, all asserting the same invariant from different directions:
 * plan-depth-band's "omits what the research could not establish rather than emitting a blank",
 * and two that require an empty profile to return null. They are right. A national table is not
 * a research finding about this water, and a lake nobody has researched must not read as
 * researched because a table had a row for its depth class. The estimate needs its own named
 * input through buildPlanRequest(), beside `conditions` and `waterState`, and that is a
 * four-file change that has not been made. Until then this guards the table itself.
 *
 *   node --test test/a-norm-is-not-a-measurement.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { THERMOCLINE_NORMS, depthClassFor, thermoclineNorm }
  from '../js/data/thermocline-norms.js';

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
