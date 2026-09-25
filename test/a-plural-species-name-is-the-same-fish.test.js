// Personal use only, not for distribution or resale; not for navigation.
//
// A PLURAL SPECIES NAME IS THE SAME FISH.
//
// Lake Monticello's roster carried "Black Crappie", "Black Crappies" and "White Crappies" side by
// side (2026-09-25), and the species answers answered the first two separately. An agency page
// writes the plural; RESEARCH_SPECIES_CANON has only the singular; titleCaseWords() made the plural
// a species of its own.
//
//   node --test test/a-plural-species-name-is-the-same-fish.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeResearchSpecies as canon } from '../Worker/research/facts-util.js';

test('a plural of a name the map knows is that name', () => {
  assert.equal(canon('Black Crappies'), 'Black Crappie');
  assert.equal(canon('white crappies'), 'White Crappie');
  assert.equal(canon('Channel Catfishes'), 'Channel Catfish');
  assert.equal(canon('Bluegills'), 'Bluegill');
});

test('nothing is invented: a name the map does not know is left as it was', () => {
  assert.equal(canon('Stripers'), 'Stripers');
  assert.equal(canon('Bass'), 'Bass', 'a double s is not a plural');
  assert.equal(canon('Walleye'), 'Walleye');
});

test('an inherited member of the map is not a species', () => {
  assert.equal(canon('constructor'), 'Constructor');
  assert.equal(canon('toString'), 'Tostring');
});
