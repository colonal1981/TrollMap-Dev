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

// THE CONSEQUENCE IS THE POINT, NOT THE NUMBER. This is the same failure the bait-depth block
// exists to prevent, arriving by a different road.
test('it says what the offset does to every charted depth', () => {
  const p = prompt(LAKE);
  assert.match(p, /sounded at FULL POOL, and nothing in this app has adjusted it/);
  assert.match(p, /2\.5 ft LOWER than the chart assumes/);
  assert.match(p, /subtract 2\.5 ft from every charted number/);
  assert.match(p, /charted 16 ft ceiling is working 13\.5 ft/, 'worked through, not asserted');
});

test('a lake ABOVE full pool is not told to subtract', () => {
  const p = prompt({ ...LAKE, belowFullPoolFt: -1.4, levelFt: 101.4 });
  assert.match(p, /1\.4 ft HIGHER than the chart assumes/);
  assert.doesNotMatch(p, /subtract/);
});

test('a lake at full pool says so and asks for no correction', () => {
  const p = prompt({ ...LAKE, belowFullPoolFt: 0, levelFt: 100 });
  assert.match(p, /right at the level the chart assumes/);
  assert.doesNotMatch(p, /subtract/);
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
