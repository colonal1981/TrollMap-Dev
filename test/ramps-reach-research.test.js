// Why a 41,000-acre reservoir reported "ramps: 0".
//
// REAL NAMES. Every waterbody string below is one the ramp feeds actually use for
// j_strom_thurmond_reservoir, read out of registry/lake_index.json on 2026-08-16. There are
// nineteen of them for this one lake, across three feeds, and the registry already binds 168
// ramps to the slug — consolidate_lake_index.py did that join by geometry.
//
// From Ryan's run log the same evening:
//
//   ✔ Deterministic baseline loaded — owner: unknown, ramps: 0, species: 0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waterbodyMatchesLake } from '../Worker/research/facts-util.js';

const DISPLAY = 'J. Strom Thurmond Reservoir (Lincoln Co, GA/SC)';

// Verbatim, from the `wb` field on the registry's own ramp records.
const FEED_NAMES = [
  'Big Branch - Clarks Hill Lake', 'Broad River - Clarks Hill Lake',
  'Cherokee Creek - Clarks Hill Lake', 'Clarks Hill Lake',
  'Cliatt Creek - Clarks Hill Lake', 'Fishing Creek - Clarks Hill Lake',
  'Hart Creek - Clarks Hill Lake', 'Keg Creek - Clarks Hill Lake',
  'Lake Thurmond', 'Little River - Clarks Hill Lake',
  'Little River - Lake J. Strom Thurmond', 'Long Cane Creek  - Lake J. Strom Thurmond',
  'Long Cane Creek - Lake J. Strom Thurmond', 'Murray Creek - Clarks Hill Lake',
  'Pistol Creek - Clarks Hill Lake', 'Savannah River',
  'Savannah River - Clarks Hill Lake', 'Savannah River - Lake J. Strom Thurmond',
  'Soap Creek - Clarks Hill Lake',
];

test('the name matcher reaches ONE of the nineteen', () => {
  // Not zero, which is worth being exact about: "Lake Thurmond" survives because the matcher
  // strips a leading "lake " and "thurmond" is a substring of the suffixed display name. The
  // other eighteen — every "<Creek> - Clarks Hill Lake" — are lost, and with them most of the
  // 168 ramps the registry has bound to this slug.
  const matched = FEED_NAMES.filter((wb) => waterbodyMatchesLake(DISPLAY, wb));
  assert.deepEqual(matched, ['Lake Thurmond']);
  assert.equal(FEED_NAMES.length, 19);
});

test('and it is the county suffix that does it, not the feed', () => {
  // Strip the parenthetical and two of the nineteen come back. Still 2 of 19, which is why
  // the fix is to stop matching by name at all rather than to strip harder.
  const bare = 'J. Strom Thurmond Reservoir';
  const matched = FEED_NAMES.filter((wb) => waterbodyMatchesLake(bare, wb));
  assert.ok(matched.length > 0, 'the bare name should match at least one');
  assert.ok(matched.length < FEED_NAMES.length, 'and still not most of them');
});

test('the matcher is bidirectional substring, which is the family already on the deletion tab', () => {
  // Documented so nobody re-derives it: this is why "Savannah River" is dangerous. It matches
  // any lake whose name contains it, and any name contained in it.
  assert.equal(waterbodyMatchesLake('Savannah River', 'Savannah River - Clarks Hill Lake'), true);
  assert.equal(waterbodyMatchesLake('Savannah River - Clarks Hill Lake', 'Savannah River'), true);
});
