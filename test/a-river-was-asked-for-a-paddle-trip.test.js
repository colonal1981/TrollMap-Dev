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
  assert.ok(qs.some((q) => /seasonal patterns/i.test(q)), 'no river query asks when');
  // `spring summer fall` came out of the query text with the other loose keywords. The calendar
  // question lives in the purpose, which is ranked against rather than matched.
  assert.match(build(ROSTER).purpose, /which months each species runs/i,
    'nothing asks the provider for the calendar');
});

test('the water\'s own fish reach the provider, not a typed-in three', () => {
  const { purpose, namedSpecies } = build(ROSTER);
  assert.ok(namedSpecies.includes('Largemouth Bass'));
  assert.ok(namedSpecies.includes('Striped Bass'));
  // The lake set hardcodes "bass crappie striped bass" for every water in four states. A river
  // must not inherit that: a trout tailwater does not hold crappie.
  assert.doesNotMatch(purpose, /bass crappie striped bass/i);
});

test('a roster label is turned into something a page would say', () => {
  const { namedSpecies, purpose } = build(ROSTER);
  // "White Bass / Hybrid" is a heading in a regulations table and "Redear Sunfish (Shellcracker)"
  // is a record's name. Neither is a form a page uses.
  assert.ok(namedSpecies.includes('White Bass'), 'the slash form was not reduced to the fish');
  assert.ok(namedSpecies.includes('Redear Sunfish'), 'the parenthetical form was not reduced');
  assert.ok(!namedSpecies.some((s) => /Hybrid|Shellcracker|[/(]/.test(s)),
    `a raw roster label survived: ${namedSpecies.join(' | ')}`);
  assert.doesNotMatch(purpose, /Hybrid|Shellcracker/, 'a raw roster label reached the provider');
});

test('no fish name goes in the query text, because the provider will chase the fish', () => {
  // Naming Bluegill returned Panfish on the Fly, a TikTok cook-and-eat, a lure build, a Reddit
  // thread, an Instagram hashtag and Crispy Bluegill Tacos. None about the Congaree. A distinctive
  // word does not narrow the search onto this water, it drags the search toward whatever that word
  // is famous for.
  for (const q of build(ROSTER).queries) {
    assert.doesNotMatch(q, /bluegill|sunfish|crappie|perch|largemouth|striped|catfish/i,
      `a species name is still in the query text: ${q}`);
  }
});

test('the roster steers through purpose, which the provider ranks against', () => {
  const { purpose, namedSpecies } = build(ROSTER);
  for (const s of namedSpecies) {
    assert.ok(purpose.includes(s), `${s} is in namedSpecies and not in the purpose`);
  }
  assert.match(purpose, /IN THIS RIVER/, 'the purpose does not tie the species to this water');
  assert.match(purpose, /recipe/i, 'the purpose does not reject the cook-and-eat results');
});

test('a river with no roster gets a purpose with no species paragraph', () => {
  const { purpose, namedSpecies } = build([]);
  assert.deepEqual(namedSpecies, []);
  assert.doesNotMatch(purpose, /THE SPECIES THIS RIVER HOLDS/);
});

test('the dead -site: operator is out of the query text', () => {
  // TinyFish documents site:/-site: as DEPRECATED and they did nothing: every river query carried
  // three of them and TikTok, Facebook, Instagram, YouTube and Reddit results all came back.
  // discover.js passes exclude_domains as a parameter now, which is what clients.js built for.
  for (const q of build(ROSTER).queries) {
    assert.doesNotMatch(q, /-?site:/i, `a dead search operator is still in the query: ${q}`);
  }
});

test('no query word belongs to another trade', () => {
  // `seams` took the structure query to coal mining, dressmaking and a Martin Fowler essay on
  // mainframes -- "Coal seam gas", "How to Sew an Inseam Pocket with French Seams!", "Satin seam
  // puckering ruins all my hard work : r/sewhelp", "Uncovering the Seams in Mainframes".
  for (const q of build(ROSTER).queries) {
    assert.doesNotMatch(q, /\bseams?\b/i, `a word that belongs to sewing and coal is in: ${q}`);
  }
});

test('a river with no roster is asked about seasons without inventing a fish', () => {
  const seasonal = build([]).queries.find((q) => /seasonal/i.test(q));
  assert.ok(seasonal, 'the seasonal query vanished when the roster was empty');
  assert.doesNotMatch(seasonal, /bass|catfish|crappie|trout|perch|bream/i,
    'a river with no species list was told which fish it holds');
});

test('exactly one query is scoped to the outdoor press, and it is the seasonal one', () => {
  // Ryan pointed an agent at carolinasportsman.com and got catalpa worms, a 3/4-to-1oz sinker
  // chosen by current, tying to snags instead of anchoring, and "seldom fish the middle of the
  // river". Our keyword searches returned the river's elevation. The pipeline had always
  // recognised that domain as fishing writing and had never asked it anything.
  const { queries, pressScoped } = build(ROSTER);
  assert.equal(pressScoped.length, queries.length, 'pressScoped is not index-aligned with queries');
  assert.deepEqual(pressScoped, [false, false, true]);
  assert.match(queries[pressScoped.indexOf(true)], /seasonal patterns/i,
    'the press scope landed on the wrong query');
});

test('a press-scoped query names no domain itself -- discover.js owns the list', () => {
  for (const q of build(ROSTER).queries) {
    assert.doesNotMatch(q, /\.com|\.org|\.gov/i, `a domain is hardcoded into a query: ${q}`);
  }
});

test('the structure query is untouched -- it was never the problem', () => {
  const qs = build(ROSTER).queries;
  assert.equal(qs.length, 3, 'the river set is no longer three queries');
  assert.ok(qs.some((q) => /shoals ledges outside bends deep holes riprap/.test(q)),
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
  assert.ok(typed.namedSpecies.includes('Striped Bass'),
    'the roster reached waterTypeSearch and not the builder');
  assert.ok(typed.purpose.includes('Striped Bass'),
    'the roster reached the builder and not the provider');
});

test('waterTypeSearch called without a roster still returns a usable set', () => {
  const typed = waterTypeSearch('river', 'fisheries', 'Congaree River', 'SC');
  assert.ok(typed && typed.queries.length === 3);
});

test('the purpose stays inside the 2000 characters TinyFish allows', () => {
  // Letters only: searchableSpecies() rejects a name with a digit in it, so a numbered fixture
  // tests the filter rather than the cap. That is how the first version of this test read 0 of 200.
  const huge = Array.from({ length: 200 }, (_, i) =>
    `Fabricated Fish ${String.fromCharCode(65 + (i % 26)).repeat(1 + Math.floor(i / 26))}`);
  const { purpose, namedSpecies } = build(huge);
  assert.ok(purpose.length <= 2000, `purpose is ${purpose.length} characters`);
  // What survived the trim is what the provider was told, and namedSpecies has to agree -- a log
  // line built from it must not name a fish the purpose never mentioned.
  assert.ok(namedSpecies.length > 0 && namedSpecies.length < huge.length,
    `namedSpecies is ${namedSpecies.length} of ${huge.length}`);
  for (const s of namedSpecies) assert.ok(purpose.includes(s), `${s} is claimed and not sent`);
});

test('an ordinary roster is nowhere near the cap', () => {
  const real = ['Largemouth Bass', 'Smallmouth Bass', 'Striped Bass', 'White Bass / Hybrid',
                'Channel Catfish', 'Blue Catfish', 'Flathead Catfish', 'Catfish', 'Bluegill',
                'Redear Sunfish (Shellcracker)', 'White Perch', 'Bowfin', 'Chain Pickerel',
                'Black Crappie', 'White Crappie', 'American Shad', 'Longnose Gar',
                'Spotted Sucker'];
  const { purpose, namedSpecies } = build(real);
  assert.equal(namedSpecies.length, 18, 'a real roster was trimmed and should not have been');
  assert.ok(purpose.length < 1800, `purpose is ${purpose.length} characters`);
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
