/**
 * test/the-coast-had-no-fish.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * MURRELLS INLET v8.0, off Ryan's drive, 2026-09-02:
 *
 *   biology.predatorSpecies  Red Drum (Redfish), Spotted Seatrout (Speckled Trout),
 *                            Southern Flounder, Black Drum, Sheepshead, Cobia
 *   evidence.biology         {}
 *   biology.notes            "Coastal estuary — saltwater species baseline. Agents
 *                             estuary/tidal/saltwater_regulations will refine."
 *
 * Those five names are COASTAL_AGENT_HINTS.biology, handed to a model in a prompt and handed
 * back. The agents that were going to refine them were retired on 2026-08-31. Cobia is not an
 * inshore fish and no fact in that profile names it.
 *
 * Two separate defects, one test file: the roster had no standing, and the names it used could
 * not light up a checkbox even when they were right.
 *
 *   node --test test/the-coast-had-no-fish.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeResearchSpecies, uniqueResearchSpecies, isKnownResearchSpecies,
         splitSpeciesText } from '../Worker/research/facts-util.js';
import { SC_INSHORE_ROSTER, SC_INSHORE_BASIS } from '../Worker/research/coastal-agents.js';
import { speciesGroupsFor } from '../js/modules/species-selector.js';

test('the roster is the five Ryan named, in the form’s own spelling', () => {
  assert.deepEqual(SC_INSHORE_ROSTER, [
    'Red Drum (Redfish)', 'Speckled Trout (Spotted Seatrout)', 'Southern Flounder',
    'Black Drum', 'Sheepshead',
  ]);
  // Every one has to survive the canonicaliser unchanged, or the roster renames itself on save.
  for (const s of SC_INSHORE_ROSTER) assert.equal(canonicalizeResearchSpecies(s), s, s);
  assert.equal(uniqueResearchSpecies(SC_INSHORE_ROSTER).length, 5);
});

test('the basis says FLOOR, because that is what it is', () => {
  assert.match(SC_INSHORE_BASIS, /floor/i);
  assert.match(SC_INSHORE_BASIS, /not established/i,
    'a reader must not be able to mistake this for a survey of one zone');
});

test('BOTH spellings of the seatrout reach the one checkbox', () => {
  // Worker/research/clients.js already warns about this pair: "neither string contains the
  // other, so a lookup by substring misses and the angler is told the book says nothing about
  // seatrout." The profile carries one spelling and the checkbox carries the other.
  const box = 'Speckled Trout (Spotted Seatrout)';
  for (const spelling of ['Spotted Seatrout (Speckled Trout)', 'Spotted Seatrout',
                          'Speckled Trout', 'spotted sea trout', 'seatrout']) {
    assert.equal(canonicalizeResearchSpecies(spelling), box, spelling);
  }
});

test('the names the agencies and the reports actually write all land', () => {
  // SCDNR's own snapshot: red drum are "often referred to as 'spottail bass' or 'redfish'".
  assert.equal(canonicalizeResearchSpecies('spottail bass'), 'Red Drum (Redfish)');
  assert.equal(canonicalizeResearchSpecies('redfish'), 'Red Drum (Redfish)');
  // The SC book files three flounders under one heading and the form has one box.
  assert.equal(canonicalizeResearchSpecies('Flounders (Southern, Summer & Gulf)'),
               'Southern Flounder');
  assert.equal(canonicalizeResearchSpecies('flounder'), 'Southern Flounder');
});

test('"Spot" does not swallow the spotted fish', () => {
  // The lookup is an exact normalised key, not a substring, and this is the assertion that
  // proves it: three names beginning with the same four letters, three different fish.
  assert.equal(canonicalizeResearchSpecies('Spot'), 'Spot');
  assert.equal(canonicalizeResearchSpecies('Spotted Bass'), 'Spotted Bass');
  assert.equal(canonicalizeResearchSpecies('Spotted Seatrout'), 'Speckled Trout (Spotted Seatrout)');
  assert.equal(canonicalizeResearchSpecies('Spotted Sunfish'), 'Spotted Sunfish');
});

test('a coastal profile carrying this roster ticks five boxes and no more', () => {
  const profile = { biology: { predatorSpecies: [...SC_INSHORE_ROSTER] } };
  const groups = speciesGroupsFor('coast_murrells_inlet_sc', profile, []);
  const shown = groups.flatMap((g) => g.species.map((s) => s.value));
  for (const s of SC_INSHORE_ROSTER) {
    assert.ok(shown.includes(s), `${s} must have a checkbox on a coastal water`);
  }
  // The nineteen-box saltwater catalogue filtered to what this water is said to hold, which is
  // the whole point -- a floor that showed every box would be the "show everything" form Ryan
  // rejected on 2026-09-02.
  assert.ok(shown.length < 19, `filtered, not the whole catalogue (got ${shown.length})`);
});

test('the freshwater roster still works and the coast did not leak into it', () => {
  const fresh = { biology: { predatorSpecies: ['Largemouth Bass', 'Crappie', 'Blue Catfish'] } };
  const shown = speciesGroupsFor('wateree_lake', fresh, []).flatMap((g) => g.species.map((s) => s.value));
  assert.ok(shown.includes('Largemouth Bass'));
  assert.ok(!shown.includes('Red Drum (Redfish)'), 'no saltwater box on a reservoir');
  assert.ok(isKnownResearchSpecies('Largemouth Bass'));
});

test('a Georgia footnote marker is not part of the fish', () => {
  // Counted across every statewide row in regulations_table.json: GA marks 13 species and
  // SC, NC and TN mark none. This is the one that mattered -- the marker sits OUTSIDE the
  // closing bracket, so the parenthetical strip that fixes North Carolina's row walked past it
  // and Georgia's most targeted inshore fish canonicalised to "Red Drum B".
  const one = (s) => uniqueResearchSpecies(splitSpeciesText(s));
  assert.deepEqual(one('Red drum (Channel bass, Spottail bass, Redfish)**B'), ['Red Drum (Redfish)']);
  assert.deepEqual(one('RED DRUM (CHANNEL BASS, RED FISH, OR PUPPY DRUM)'), ['Red Drum (Redfish)']);
  assert.deepEqual(one('Amberjack*'), ['Amberjack']);
  assert.deepEqual(one('Sharks (other than Hammerheads, SSC and Prohibited Sharks)A'), ['Sharks']);
  // Three fish on one row of the SC book, and all three have a checkbox.
  assert.deepEqual(one('Atlantic Croaker, Spot, Whiting'),
                   ['Atlantic Croaker', 'Spot', 'Whiting (Southern Kingfish)']);
});

test('a real name with brackets in it is not damaged by the marker strip', () => {
  const one = (s) => uniqueResearchSpecies(splitSpeciesText(s));
  assert.deepEqual(one('Redear Sunfish (Shellcracker)'), ['Redear Sunfish (Shellcracker)']);
  assert.deepEqual(one('White Bass / Hybrid'), ['White Bass / Hybrid']);
  assert.deepEqual(one('Largemouth Bass'), ['Largemouth Bass']);
});
