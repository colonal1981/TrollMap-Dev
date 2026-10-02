// Personal use only, not for distribution or resale; not for navigation.
//
// A NULL OXYGEN DEPTH IS NOT 0 FT.
//
// Lake Moultrie from Short Stay, 2026-10-02. The researched profile carries an oxygen object with no
// depths in it -- its note says the records are "surface/grab samples only -- no vertical depth
// profiles" -- and the squeeze block read `Number(null)` as 0. The prompt said "Oxygen begins
// depleting below 0 ft, measured" and "Put the spread within a few feet of 0 ft", and every rod went
// out at 2-8 ft over 39-48 ft of water. Ryan: "absolute garbage".
//
//   node --test test/a-null-oxygen-depth-is-not-zero-feet.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { researchIntel, oxygenFloorFt } from '../js/modules/plan-inputs.js';

const NOTE = 'Monitoring data were found, but available records are surface/grab samples only — '
  + 'no vertical depth profiles. Thermocline cannot be derived from this source.';
const moultrie = (oxygen) => ({
  lakeName: 'Lake Moultrie, SC',
  identity: { archetype: 'lake' },
  biology: { predatorSpecies: ['Striped Bass'] },
  limnology: { thermocline: { summerDepthFt: null, note: NOTE }, oxygen },
});
const TRAITS = { biology: { predatorSpecies: ['Striped Bass'], speciesTraits: {
  species: 'Striped Bass', scientific: 'Morone saxatilis', tempMinC: 8, tempMaxC: 25 } } };
const NOW = Date.parse('2026-10-02T15:00:00Z');
const run = (profile) => String(researchIntel(profile, ['Striped Bass'], 'summer', NOW, TRAITS,
  { tempF: 80.4, tempFrom: 'upstream' }));

test('no oxygen depths, only a note: no squeeze block and no 0 ft floor', () => {
  for (const oxygen of [
    { depletionDepthFt: null, anoxicBelowFt: null, note: NOTE },
    { depletionDepthFt: 0, anoxicBelowFt: 0, note: NOTE },
    { depletionDepthFt: null, note: NOTE },
  ]) {
    const t = run(moultrie(oxygen));
    assert.doesNotMatch(t, /SQUEEZED FROM BOTH ENDS/, JSON.stringify(oxygen));
    assert.doesNotMatch(t, /below 0 ft|within a few feet of 0 ft|ABOVE 0 FT/, JSON.stringify(oxygen));
    assert.equal(oxygenFloorFt(moultrie(oxygen)), null, 'the gate already agreed: no floor');
  }
});

test('a measured depth still makes the block, as before', () => {
  const t = run(moultrie({ depletionDepthFt: null, anoxicBelowFt: 19.7, note: 'one cast' }));
  assert.match(t, /SQUEEZED FROM BOTH ENDS/);
  assert.match(t, /below 19\.7 ft/);
  assert.match(t, /JUST ABOVE 19\.7 FT/);
});
