// AN OXYGEN CAST STANDS FOR ITS OWN MONTH.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Change request 21. Lake Wateree, 2026-09-26: the oxygen floor was 19.7 ft, from ONE EPA National
// Lakes Assessment cast on 2022-07-21. It capped every lead and struck baits from the box, and
// Ryan's own sonar that day put 48% of the targets below it, down to about 35 ft. A reservoir's
// oxygen line moves through the season. Where none of a floor's casts is from the trip's month it
// is no longer a gate; the prompt still carries it, with its dates, and says it is another month's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oxygenFloorFt, oxygenFloorMonths, researchIntel } from '../js/modules/plan-inputs.js';

const WATEREE = { identity: { bodyType: 'reservoir' }, limnology: { oxygen: {
  depletionDepthFt: 16.4, anoxicBelowFt: 19.7,
  note: 'measured vertical profile, EPA National Lakes Assessment 7/21/2022' } } };
const MURRAY = { identity: { bodyType: 'reservoir' }, limnology: { oxygen: {
  depletionDepthFt: 40, anoxicBelowFt: 40,
  note: 'measured vertical profile -- the median of 6 summer casts: 25.0 ft EPA National '
      + 'Eutrophication Survey 1973-09-22; 30.0 ft EPA National Eutrophication Survey 1973-07-09' } } };
const UNDATED = { identity: { bodyType: 'reservoir' }, limnology: { oxygen: { anoxicBelowFt: 22 } } };

test('the months are read off the pipeline note, in both of its date forms', () => {
  assert.deepEqual(oxygenFloorMonths(WATEREE), [7]);
  assert.deepEqual(oxygenFloorMonths(MURRAY), [7, 9]);
  assert.deepEqual(oxygenFloorMonths(UNDATED), []);
});

test('a July cast is not a gate on a late-September trip', () => {
  assert.equal(oxygenFloorFt(WATEREE, null, '2026-09-26'), null);
  assert.equal(oxygenFloorFt(WATEREE, null, '2026-07-04'), 19.7, 'its own month keeps it');
});

test('Murray keeps its floor in September, because it was measured in September', () => {
  assert.equal(oxygenFloorFt(MURRAY, null, '2026-09-27'), 40);
  assert.equal(oxygenFloorFt(MURRAY, null, '2026-08-15'), null);
});

test('no date asked, or no date on the cast, behaves exactly as before', () => {
  assert.equal(oxygenFloorFt(WATEREE), 19.7);
  assert.equal(oxygenFloorFt(UNDATED, null, '2026-09-26'), 22);
});

test('the squeeze prints the casts and says when none is from this month', () => {
  const profile = { ...WATEREE,
    biology: { speciesTraits: { species: 'Striped Bass', tempMinC: 10, tempMaxC: 25 } } };
  const intel = researchIntel(profile, 'Striped Bass', 'summer', Date.now(), null,
    { tempF: 80, tempFrom: 'gauge', when: '2026-09-26T12:00:00' }) || '';
  const text = Array.isArray(intel) ? intel.join('\n') : String(intel);
  assert.match(text, /EPA National Lakes Assessment 7\/21\/2022/);
  assert.match(text, /NONE OF THOSE CASTS IS FROM THIS MONTH/);
});
