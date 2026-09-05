/**
 * test/the-inch-mark-ended-the-string.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-09-05, on a plan that died whole:
 *
 *   the model's answer could not be read: Expected ',' or '}' after property value in JSON at
 *   position 1608 ... { "id": "R5", "lure": "3" <<HERE>>Lipless Crankbait", ...
 *
 * The bag holds `3" Lipless Crankbait`. The prompt printed it raw -- in the tackle list and again
 * in the per-bait depth note -- and asked for `"lure": "exact name from the list"`. The model did
 * exactly that and the unescaped inch mark ended the JSON string four characters in.
 *
 * TWELVE OF SIXTY-ONE lures carry one. A fifth of the bag could kill a plan outright, after the
 * pack was fetched and every leg computed, and it took the whole day with it rather than one rod.
 *
 *   node --test test/the-inch-mark-ended-the-string.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanRequest, resolveTackleName, promptSafeTackleName }
  from '../js/modules/plan-prompt.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';

const NAMES = TACKLE_INVENTORY.map((l) => l.name);
const QUOTED = NAMES.filter((n) => n.includes('"'));
const byName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;
const prompt = () => buildPlanRequest({
  water: 'Wateree Lake', ramp: 'Clearwater Cove', date: '2026-07-15', launchTime: '06:00',
  returnTime: '15:00', species: ['Largemouth Bass'], conditions: {},
  candidates: [{ runId: 'A', depthFt: 18, maxRunDepthFt: 12, lengthM: 900, estMin: 20 }],
  tackle: NAMES, trollable: NAMES, snapEligible: NAMES.slice(0, 5), lureByName: byName,
}).user;

test('the bag really does carry inch marks — this is not a hypothetical', () => {
  assert.ok(QUOTED.length >= 10, `${QUOTED.length} quoted names in a ${NAMES.length}-lure bag`);
  assert.ok(QUOTED.includes('3" Lipless Crankbait'), 'the one that broke his plan');
});

test('no lure name reaches the model with a quote in it', () => {
  const p = prompt();
  for (const n of QUOTED) {
    assert.ok(!p.includes(n), `the raw name ${JSON.stringify(n)} is still in the prompt`);
    assert.ok(p.includes(promptSafeTackleName(n)),
      `the safe form of ${JSON.stringify(n)} is missing — the bait vanished instead`);
  }
});

// Every place a name is printed, not just the list: the tackle line, the tie-only line, the
// snap-eligible line, the cast-only line, the per-bait depth notes, and the per-leg "cannot use
// on this leg" list inside the candidate JSON.
test('every printed name is safe, wherever it is printed', () => {
  for (const line of prompt().split('\n')) {
    assert.ok(!/\d(?:\.\d+)?" (?:Lipless|Blade|Swimbait)/.test(line),
      `a raw inch mark survived: ${line.slice(0, 90)}`);
  }
});

// THE SIZE IS THE WHOLE POINT. Before the exact tier went in, `3in Lipless Crankbait` resolved
// through the word tier to `2" Lipless Crankbait` -- no shared token carries the size, so it
// scored on "lipless" and "crankbait" and took whichever came first. A crash traded for a
// silently wrong bait is not a fix.
test('the name comes back as the right lure, exactly, not as a guess', () => {
  for (const n of QUOTED) {
    const hit = resolveTackleName(promptSafeTackleName(n), NAMES);
    assert.ok(hit, `${JSON.stringify(n)} did not resolve at all`);
    assert.equal(hit.name, n, `${promptSafeTackleName(n)} resolved to the wrong bait`);
    assert.equal(hit.tier, 'exact', 'it is the form we showed it — that is not a guess');
  }
});

test('sizes of the same bait do not collide', () => {
  assert.equal(resolveTackleName('2in Lipless Crankbait', NAMES).name, '2" Lipless Crankbait');
  assert.equal(resolveTackleName('3in Lipless Crankbait', NAMES).name, '3" Lipless Crankbait');
  assert.equal(resolveTackleName('4in Lipless Crankbait', NAMES).name, '4" Lipless Crankbait');
});

test('the substitution is reversible across the whole bag', () => {
  const safe = NAMES.map(promptSafeTackleName);
  assert.equal(new Set(safe).size, NAMES.length, 'two lures share a quote-free form');
});

// A model that DOES escape correctly must keep working, and so must every other tier.
test('the older tiers are untouched', () => {
  assert.equal(resolveTackleName('3" Lipless Crankbait', NAMES).tier, 'exact');
  assert.equal(resolveTackleName('DD3 Crankbait', NAMES).name, 'DD3 Crankbait (20-25ft)');
  assert.equal(resolveTackleName('DD3 Crankbait', NAMES).tier, 'substring');
  assert.equal(resolveTackleName('Nothing By That Name At All', NAMES.slice(0, 2)), null);
});
