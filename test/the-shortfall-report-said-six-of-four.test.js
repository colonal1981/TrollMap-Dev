/**
 * test/the-shortfall-report-said-six-of-four.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * THE RUN OF 2026-09-02 REPORTED 14 WATERS SHORT OF THEIR CONFIRMED SPECIES AND ONE OF THEM WAS.
 *
 * Every case below is a real roster and a real answer, copied out of
 * _reports/research_lakes_20260902_140512.json. The tell was in the arithmetic the report printed
 * beside the names: "Cherokee Lake: 6 of 4", "Fort Loudoun Lake: 8 of 4". A shortfall report that
 * says more came back than went in is measuring the wrong thing.
 *
 *   node --test test/the-shortfall-report-said-six-of-four.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitConjunctiveName, missingConfirmedSpecies } from '../Worker/research/agents.js';

test('a heading that lists its members is split into them, sharing the head noun', () => {
  assert.deepEqual(splitConjunctiveName('Striped and Cherokee Bass'),
                   ['Striped Bass', 'Cherokee Bass']);
  assert.deepEqual(splitConjunctiveName('Striped and Hybrid Striped Bass'),
                   ['Striped Bass', 'Hybrid Striped Bass']);
  // Ends in a single word, so there is no head noun to hand back down the list.
  assert.deepEqual(splitConjunctiveName('Walleye, Sauger, and Saugeye'),
                   ['Walleye', 'Sauger', 'Saugeye']);
  assert.deepEqual(splitConjunctiveName('Walleye and Sauger'), ['Walleye', 'Sauger']);
  // The same split reproduces a row somebody typed into GROUP_TERM_MAP by hand.
  assert.deepEqual(splitConjunctiveName('Rock Bass or Redeye and Shadow Bass'),
                   ['Rock Bass', 'Redeye Bass', 'Shadow Bass']);
});

test('one name is not a list -- GROUP_TERM_MAP owns those', () => {
  assert.deepEqual(splitConjunctiveName('Black Bass'), []);
  assert.deepEqual(splitConjunctiveName('Crappie'), []);
  assert.deepEqual(splitConjunctiveName(''), []);
  assert.deepEqual(splitConjunctiveName(null), []);
});

test('CHEROKEE LAKE (Hawkins Co, TN) came back 6 of 4 and lost nothing', () => {
  const confirmed = ['Black Bass', 'Striped And Cherokee Bass', 'Crappie',
                     'Walleye Sauger And Saugeye'];
  const returned = ['Crappie', 'Walleye Sauger And Saugeye', 'Largemouth Bass',
                    'Smallmouth Bass', 'Striped Bass', 'Hybrid Striped Bass'];
  assert.deepEqual(missingConfirmedSpecies(confirmed, returned), []);
});

test('FORT LOUDOUN LAKE (Knox Co, TN): the catfish group answered with all three catfish', () => {
  const confirmed = ['Black Bass', 'Crappie', 'Sauger', 'Catfish'];
  const returned = ['Crappie', 'Blue Catfish', 'Channel Catfish', 'Flathead Catfish', 'Sauger',
                    'Largemouth Bass', 'Smallmouth Bass', 'Spotted Bass'];
  assert.deepEqual(missingConfirmedSpecies(confirmed, returned), []);
});

test('HYCO LAKE (Person Co, NC): Black and White Crappie are the Crappie that came back', () => {
  const confirmed = ['White Bass / Hybrid', 'Crappie', 'Largemouth Bass', 'Catfish', 'Sunfish',
                     'White Crappie', 'Black Crappie', 'Striped Bass'];
  const returned = ['White Bass / Hybrid', 'Largemouth Bass', 'Striped Bass', 'Crappie',
                    'Catfish', 'Sunfish'];
  assert.deepEqual(missingConfirmedSpecies(confirmed, returned), []);
});

test('LAKE HICKORY (Catawba Co, NC) IS the real one -- the catfish group returned nothing', () => {
  const confirmed = ['Alabama Bass', 'Black Crappie', 'Bluegill', 'Channel Catfish', 'Crappie',
                     'Largemouth Bass', 'Catfish', 'Redear Sunfish (Shellcracker)', 'Striped Bass',
                     'Sunfish'];
  const returned = ['Alabama Bass', 'Largemouth Bass', 'Striped Bass', 'Crappie', 'Bluegill',
                    'Redear Sunfish (Shellcracker)', 'Sunfish'];
  // Both names for the fish that did not come back, and nothing else.
  assert.deepEqual(missingConfirmedSpecies(confirmed, returned), ['Channel Catfish', 'Catfish']);
});

test('a group heading is not a free pass -- no member back, still missing', () => {
  assert.deepEqual(missingConfirmedSpecies(['Black Bass'], ['Crappie', 'Bluegill']),
                   ['Black Bass']);
  assert.deepEqual(missingConfirmedSpecies(['Striped and Cherokee Bass'], ['Walleye']),
                   ['Striped and Cherokee Bass']);
});
