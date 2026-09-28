/**
 * test/the-chart-was-sounded-at-full-pool.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * A coastal zone gets coastalPromptBlock and a river gets riverPromptBlock. A RESERVOIR -- nearly
 * every water this app covers -- got neither, so the only level information reaching the model
 * was `poolLevel` inside the conditions JSON: `$('planPoolLevel')?.value`, the raw string out of
 * a form field. A bare elevation with no datum, no full pool and no sign of which way it was off.
 *
 * The Worker has computed the whole thing since chartDatumShape() was written -- charted_at
 * 'full_pool', the drawdown, the operator's own sentence -- and says of itself "which is exactly
 * why this is REPORTED and never APPLIED". The card shows it. The printable report prints it.
 * levelSentence() says it in one line. The thing choosing baits against charted depths was never
 * told, and Garmin sounded those packs at full pool.
 *
 * THAT LAST CLAUSE IS RETRACTED, 2026-09-27. It was never measured. Against Ryan's own sounder,
 * Wateree's chart was made about 2.3 ft below full pool; see js/data/chart-levels.js and the
 * tests below. The file keeps its name so the history reads in one place.
 *
 *   node --test test/the-chart-was-sounded-at-full-pool.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanRequest } from '../js/modules/plan-prompt.js';

const prompt = (waterState) => buildPlanRequest({
  water: 'Wateree Lake', ramp: 'Clearwater Cove', date: '2026-07-15', launchTime: '06:00',
  returnTime: '15:00', species: ['Striped Bass'], conditions: {}, candidates: [], waterState,
}).user;
const LAKE = { featureType: 'lake', levelFt: 97.5, fullPoolFt: 100, belowFullPoolFt: 2.5,
               levelSource: 'Duke Energy', feedName: 'Wateree' };

test('a drawn-down reservoir tells the model the size of the offset', () => {
  const p = prompt(LAKE);
  assert.match(p, /WHERE THE WATER IS TODAY/);
  assert.match(p, /2\.50 ft below full pool/, 'levelSentence, not a second wording');
  assert.match(p, /full pool 100 ft/);
  assert.match(p, /Duke Energy — Wateree/, 'and where the number came from');
});

// THE CONSEQUENCE IS THE POINT, NOT THE NUMBER -- AND ON 2026-09-27 THE NUMBER TURNED OUT WRONG.
// These tests used to hold "sounded at FULL POOL ... subtract 2.5 ft from every charted number".
// Measured against Ryan's own sounder that night, Wateree's chart was made about 2.3 ft below full
// pool (js/data/chart-levels.js). So on a water nobody has measured, the drawdown is not the
// correction -- his call: the chart as it stands, said so -- and on a measured water the offset is
// the lake against the chart's own level.
test('a water whose chart level is not measured is told NOT to subtract the drawdown', () => {
  const p = prompt(LAKE);
  assert.match(p, /Garmin's chart as it stands, and nothing in this app has adjusted it/);
  assert.match(p, /has NOT been measured on this water, so the drawdown above is NOT the correction/);
  assert.match(p, /wateree lake \(made 2\.3 ft below full pool\)/, 'the measured lake is the reason');
  assert.doesNotMatch(p, /Take [\d.]+ ft off every other charted number/);
});

test('a measured water gets the lake against its chart, worked through', () => {
  const p = prompt({ ...LAKE, slug: 'wateree_lake', belowFullPoolFt: 3.5, chartBelowFullPoolFt: 2.3 });
  assert.match(p, /that chart was made about 2\.3 ft below full pool,\s+measured against his own sounder on 2026-08-29, 2026-08-31 and 2026-09-26/);
  assert.match(p, /the water is 1\.2 ft SHALLOWER than the chart/);
  assert.match(p, /charted 16 ft ceiling is working 14\.8 ft/, 'worked through, not asserted');
});

test('a measured water above its chart level is not told to take anything off', () => {
  const p = prompt({ ...LAKE, belowFullPoolFt: 1.0, chartBelowFullPoolFt: 2.3 });
  assert.match(p, /1\.3 ft DEEPER than the chart/);
  assert.doesNotMatch(p, /Take [\d.]+ ft off/);
});

test('a measured water at its chart level says so', () => {
  const p = prompt({ ...LAKE, belowFullPoolFt: 2.3, chartBelowFullPoolFt: 2.3 });
  assert.match(p, /The lake is at that level today/);
});

// Rivers and coastal zones have their own blocks and no full pool to be below -- chartDatumShape
// returns `pending: 'not a lake ...'` for them.
test('rivers and coastal zones get no pool block', () => {
  assert.doesNotMatch(prompt({ ...LAKE, featureType: 'river' }), /WHERE THE WATER IS TODAY/);
  assert.doesNotMatch(prompt({ ...LAKE, featureType: 'coastal' }), /WHERE THE WATER IS TODAY/);
});

test('no level, no block — and no invented one', () => {
  assert.doesNotMatch(prompt(null), /WHERE THE WATER IS TODAY/);
  assert.doesNotMatch(prompt({ featureType: 'lake' }), /WHERE THE WATER IS TODAY/);
  assert.doesNotMatch(prompt({ featureType: 'lake', error: 'HTTP 500' }),
    /WHERE THE WATER IS TODAY/);
});

// It was the only thing that explained why Wateree ran high in August 2026: a barge, and planned
// maintenance. Parsed since normalizeDukeRow was written and surfaced nowhere the plan could see.
test("the operator's own sentence rides with the number", () => {
  const p = prompt({ ...LAKE, operatorMessage: 'Planned maintenance — barge on site.' });
  assert.match(p, /The operator's own note: Planned maintenance — barge on site\./);
});
