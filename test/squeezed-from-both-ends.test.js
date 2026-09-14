/**
 * test/squeezed-from-both-ends.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * 2026-09-14, the first Wateree plan built on the measured oxygen depths. The model used the FLOOR
 * and never looked at the CEILING: three of six rods at 0-5 ft, described as striper presentations,
 * on a day the water read 84.9 F against a fish FishBase records to 77 F. Both numbers were in the
 * prompt. Nothing asked it to intersect them.
 *
 * Every number in the block is measured — the live gauge, FishBase's recorded range, and an oxygen
 * depth off a vertical cast. The one inference is licensed by the data: measured anoxia means the
 * column is stratified, because a mixed column stays oxygenated to the bottom, so temperature falls
 * with depth and the deepest oxygenated water is the coolest oxygenated water.
 *
 * WHAT IT MUST NEVER DO is name the depth where warm water meets dead water. That needs a vertical
 * TEMPERATURE profile, and the same prompt already declares this water has none.
 *
 *   node --test test/squeezed-from-both-ends.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { researchIntel } from '../js/modules/plan-inputs.js';

const WATEREE = {
  lakeName: 'Wateree Lake (Kershaw Co, SC)',
  identity: { archetype: 'lake', maxDepthFt: 58 },
  biology: { predatorSpecies: ['Striped Bass'] },
  limnology: {
    thermocline: { summerDepthFt: null, method: null, note: 'surface grabs with a depth stamp' },
    oxygen: { depletionDepthFt: 16.4, anoxicBelowFt: 19.7, note: 'measured vertical profile' },
  },
};
const TRAITS = { biology: { predatorSpecies: ['Striped Bass'], speciesTraits: {
  species: 'Striped Bass', scientific: 'Morone saxatilis', tempMinC: 8, tempMaxC: 25 } } };
const NOW = Date.parse('2026-09-14T14:00:00Z');
const run = (live, pf = TRAITS, profile = WATEREE) =>
  String(researchIntel(profile, ['Striped Bass'], 'summer', NOW, pf, live));

test('it fires when the surface is above the range the species is recorded in', () => {
  const t = run({ tempF: 84.9, tempFrom: 'tailwater' });
  assert.match(t, /SQUEEZED FROM BOTH ENDS TODAY/);
  assert.match(t, /84\.9°F/);
  assert.match(t, /46–77°F/, 'the species range must be stated in F, from tempMinC/tempMaxC');
  assert.match(t, /16\.4 ft/);
  assert.match(t, /19\.7 ft/);
});

test('a gauge that is not the lake says so', () => {
  assert.match(run({ tempF: 84.9, tempFrom: 'tailwater' }),
    /TAILWATER gauge below the dam, not the lake itself/);
  assert.doesNotMatch(run({ tempF: 84.9, tempFrom: null }), /TAILWATER|upstream gauge/);
});

test('the inference is licensed by the anoxia and says which way it runs', () => {
  const t = run({ tempF: 84.9 });
  assert.match(t, /a mixed column stays oxygenated to the bottom/);
  assert.match(t, /DEEPEST OXYGENATED WATER IS THE COOLEST OXYGENATED WATER/);
});

test('it refuses to name the depth where the two meet', () => {
  const tail = run({ tempF: 84.9 }).split('WHERE THE TWO MEET')[1] || '';
  assert.ok(tail, 'the refusal clause must be present');
  assert.match(tail, /must not be stated/);
  assert.match(tail, /no vertical temperature profile|none has been published/i);
  // no invented boundary depth in the refusal clause
  assert.doesNotMatch(tail.replace(/19\.7 ft|16\.4 ft/g, ''), /\d+(\.\d+)? ?ft/);
});

test('silent when there is no squeeze, and when an input is missing', () => {
  assert.doesNotMatch(run({ tempF: 70 }), /SQUEEZED FROM BOTH ENDS/,
    '70F is inside 46-77F -- no squeeze to report');
  assert.doesNotMatch(run(null), /SQUEEZED FROM BOTH ENDS/, 'no live reading, no claim');
  assert.doesNotMatch(run({ tempF: 84.9 }, { biology: { predatorSpecies: ['Striped Bass'] } }),
    /SQUEEZED FROM BOTH ENDS/, 'no measured species range, no claim');
  const noOx = { ...WATEREE, limnology: { ...WATEREE.limnology, oxygen: {} } };
  assert.doesNotMatch(run({ tempF: 84.9 }, TRAITS, noOx), /SQUEEZED FROM BOTH ENDS/,
    'no measured oxygen depth, no stratification evidence, no claim');
});
