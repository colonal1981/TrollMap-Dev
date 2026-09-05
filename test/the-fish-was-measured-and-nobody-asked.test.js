/**
 * test/the-fish-was-measured-and-nobody-asked.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * 802 species were pulled from FishBase on 2026-09-04 into registry/fishbase_traits.json. On
 * 2026-09-05 Ryan ran verify_registry_r2.py and it came back 404 -- no upload had shipped it --
 * and grepping Worker/ and js/ for the name found no reader either. Built, unshipped, unread.
 *
 * The one thing in this codebase saying what is forage and what is a target was NON_GAME_SPECIES
 * in facts-util.js: about sixty names typed by hand, whose own comments record every time it was
 * wrong -- hickory shad missing while American shad was in it, `MULLET (STRIPED AND WHITE)`,
 * `Other Species`, `Black Bass Spp.`
 *
 *   node --test test/the-fish-was-measured-and-nobody-asked.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { researchIntel } from '../js/modules/plan-inputs.js';

const JULY = Date.parse('2026-07-15T12:00:00Z');
const BASS = {
  species: 'Largemouth Bass', scientific: 'Micropterus salmoides',
  trophicLevel: 3.8, trophicSe: 0.4, maxLengthCm: 97, commonLengthCm: 40,
  waterColumn: 'benthopelagic', tempMinC: 10, tempMaxC: 32, source: 'FishBase',
};
const SHAD = {
  species: 'Threadfin Shad', scientific: 'Dorosoma petenense',
  trophicLevel: 2.8, trophicSe: 0.1, maxLengthCm: 22, waterColumn: 'pelagic',
};
const profile = (traits) => ({
  identity: { maxDepthFt: 150 },
  limnology: { thermocline: { summerDepthFt: 24 }, oxygen: {}, waterClarity: {} },
  biology: traits ? { speciesTraits: traits } : {},
});
const line = (traits, sp) => (researchIntel(profile(traits), sp || 'Largemouth Bass', 'summer', JULY)
  || '').split('\n').find((l) => l.includes('measured (FishBase'));

test('the measured numbers reach the plan', () => {
  const l = line(BASS);
  assert.ok(l, 'the line is printed');
  assert.match(l, /trophic level 3\.8 ± 0\.4/);
  assert.match(l, /lives benthopelagic/);
  assert.match(l, /reaches 38 in, commonly 16 in/, 'centimetres are converted');
  assert.match(l, /recorded in 50–90°F water/, 'and so is celsius');
});

// THE LINE NON_GAME_SPECIES WAS DRAWING BY HAND, DRAWN BY A NUMBER FROM DIET STUDIES.
test('the trophic level is translated, because 3.8 means nothing to a reader', () => {
  assert.match(line(BASS), /\(eats fish\)/);
  assert.match(line(SHAD, 'Threadfin Shad'), /\(plankton and invertebrates\)/);
  assert.match(line({ ...BASS, trophicLevel: 3.2 }), /mixed — invertebrates and small fish/);
});

// A FACT ABOUT THE SPECIES ANYWHERE IS A WEAKER CLAIM THAN A FACT ABOUT THIS STATE, and the
// food-habits line beside it already says "statewide — not measured on this water". This one
// has to say more, not less.
test('it cannot be read as a fact about this water', () => {
  const l = line(BASS);
  assert.match(l, /the species anywhere, NOT this water/);
  assert.match(l, /FishBase/);
  assert.match(l, /Micropterus salmoides/, 'the binomial it was joined on is shown');
});

test('a partial row prints what it has and invents nothing', () => {
  const l = line({ species: 'X', scientific: 'Genus species', trophicLevel: 3.1 });
  assert.match(l, /trophic level 3\.1 \(mixed/);
  assert.doesNotMatch(l, /±/, 'no standard error was published, so none is shown');
  assert.doesNotMatch(l, /reaches/);
  assert.doesNotMatch(l, /recorded in/);
  assert.doesNotMatch(l, /lives/);
});

test('no row, no line, and the plan is unharmed', () => {
  assert.equal(line(null), undefined);
  const text = researchIntel(profile(null), 'Largemouth Bass', 'summer', JULY);
  assert.match(text, /Thermocline in summer: 24 ft/, 'everything else still prints');
});

// A row with a binomial and nothing measured is not worth a line.
test('a row with no measurements at all prints nothing', () => {
  assert.equal(line({ species: 'X', scientific: 'Genus species' }), undefined);
});
