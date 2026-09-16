/**
 * The river query set spent a query on paddling and had none left for a season.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Measured on the Congaree, 2026-09-16, the first river ever researched with this set: 20 facts,
 * categorised 12 summary / 4 ramp / 2 county / 1 consumptionAdvisory / 1 navigation. Nothing about
 * a season, a depth or a fish. `"Congaree River" float trip paddle access shoals fishing` returned
 * Paddle SC's Blue Trail, Discover South Carolina Outdoors and the National Park Service, and what
 * the extractor could take from those was the river's elevation and the park's acreage.
 *
 * The lake set has always asked `seasonal fishing patterns bass crappie striped bass`. The river
 * set replaced the state table rather than extending it, so rivers lost that query entirely.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WATER_TYPE_SEARCH, waterTypeSearch } from '../Worker/research/water-type-hints.js';

// The Congaree's actual roster, labels and all. These are the strings deterministic.js unions out
// of five sources, and "White Bass / Hybrid" is a regulatory heading, not something a page says.
const ROSTER = ['Largemouth Bass', 'Striped Bass', 'White Bass / Hybrid', 'Channel Catfish',
                'Redear Sunfish (Shellcracker)', 'Catfish', 'Black Crappie'];

const build = (species) => WATER_TYPE_SEARCH.river.fisheries('Congaree River', 'SC', species);

test('no river query asks for a paddle trip any more', () => {
  for (const species of [ROSTER, []]) {
    for (const q of build(species).queries) {
      assert.doesNotMatch(q, /float trip|paddle|canoe|kayak/i,
        `a river query is still asking for paddling content: ${q}`);
    }
  }
});

test('a river is asked about seasons, which is what the registry cannot answer', () => {
  const qs = build(ROSTER).queries;
  assert.ok(qs.some((q) => /seasonal fishing patterns/i.test(q)),
    'no river query asks when');
});

test('the seasonal query names the water\'s own fish, not a typed-in three', () => {
  const seasonal = build(ROSTER).queries.find((q) => /seasonal/i.test(q));
  assert.match(seasonal, /"Largemouth Bass"/);
  assert.match(seasonal, /"Striped Bass"/);
  // The lake set hardcodes "bass crappie striped bass" for every water in four states. A river
  // must not inherit that: a trout tailwater does not hold crappie.
  assert.doesNotMatch(seasonal, /bass crappie striped bass/i);
});

test('a roster label is turned into something a page would say', () => {
  const seasonal = build(ROSTER).queries.find((q) => /seasonal/i.test(q));
  // "White Bass / Hybrid" is a heading in a regulations table. Asking the web for a page
  // containing the word Hybrid and a slash is how the Congaree came back with 8 sources.
  assert.match(seasonal, /"White Bass"/, 'the slash form was not reduced to the fish');
  assert.doesNotMatch(seasonal, /Hybrid/, 'a regulatory label reached the query');
  assert.doesNotMatch(seasonal, /[/]/, 'a slash reached the query');
  // The parentheses in this query group the OR-ed fish; what must not survive is the roster's
  // own parenthetical, "Redear Sunfish (Shellcracker)".
  assert.doesNotMatch(seasonal, /Shellcracker/, 'a roster parenthetical reached the query');
});

test('three fish, OR-ed, because four AND-ed asks for a page that names all four', () => {
  const seasonal = build(ROSTER).queries.find((q) => /seasonal/i.test(q));
  assert.match(seasonal, /\("[^)]+ OR [^)]+ OR [^)]+\)/,
    'the fish are not an OR group');
  for (const late of ['Channel Catfish', 'Black Crappie', 'Redear']) {
    assert.ok(!seasonal.includes(late), `${late} is past the cap and still in the query`);
  }
});

test('a river with no roster is asked about seasons without inventing a fish', () => {
  const seasonal = build([]).queries.find((q) => /seasonal/i.test(q));
  assert.ok(seasonal, 'the seasonal query vanished when the roster was empty');
  assert.doesNotMatch(seasonal, /bass|catfish|crappie|trout|perch|bream/i,
    'a river with no species list was told which fish it holds');
});

test('the structure query is untouched -- it was never the problem', () => {
  const qs = build(ROSTER).queries;
  assert.equal(qs.length, 3, 'the river set is no longer three queries');
  assert.ok(qs.some((q) => /shoals ledges bends current seams holes/.test(q)),
    'the structure query was lost in the swap');
  assert.ok(qs.some((q) => /fishing report water level flow/.test(q)),
    'the current-conditions query was lost in the swap');
});

test('every river query is still anchored on the bare base name', () => {
  for (const q of build(ROSTER).queries) {
    assert.ok(q.startsWith('"Congaree River"'),
      `a query is not anchored on the quoted base name: ${q}`);
    // The seasonal query legitimately contains parentheses now -- they group the OR-ed fish. What
    // must never reach a query is the display name's own parenthetical, which is the bug that put
    // "Congaree River (to SC-601) (Richland Co, SC)" inside quotes on 353 of 355 waters.
    assert.doesNotMatch(q, /SC-601|Richland|\bCo,|\bCounty\b/,
      `the display name's parenthetical reached the query: ${q}`);
  }
});

test('waterTypeSearch carries the roster through to the builder', () => {
  const typed = waterTypeSearch('river', 'fisheries', 'Congaree River', 'SC', ROSTER);
  assert.ok(typed, 'a river got no typed query set');
  assert.ok(typed.queries.some((q) => q.includes('Striped Bass')),
    'the roster reached waterTypeSearch and not the query');
});

test('waterTypeSearch called without a roster still returns a usable set', () => {
  const typed = waterTypeSearch('river', 'fisheries', 'Congaree River', 'SC');
  assert.ok(typed && typed.queries.length === 3);
});

test('a lake still gets nothing, so its state table runs exactly as before', () => {
  assert.equal(waterTypeSearch('lake', 'fisheries', 'Lake Wateree', 'SC', ROSTER), null);
  assert.equal(waterTypeSearch(null, 'fisheries', 'Lake Wateree', 'SC', ROSTER), null);
});

test('the purpose rejects the content the dropped query used to bring in', () => {
  const { purpose } = build(ROSTER);
  assert.match(purpose, /paddling/i);
  assert.match(purpose, /park visitor/i);
  // And it asks for the thing the roster cannot supply.
  assert.match(purpose, /months/i);
});
