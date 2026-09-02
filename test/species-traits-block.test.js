/**
 * species-traits-block.test.js — the state's own account of the FISH reaches the fisheries agent.
 *
 * `biology.spawnTiming`, `baitfishMovement` and `forageSpatial` were cut on 2026-09-01 because we
 * had both concluded no document in the corpus answered them. A lake report does not say when
 * crappie spawn. SCDNR's Guide to Freshwater Fishes of South Carolina says it in one sentence,
 * per species, and it was already on the drive -- as were NC WRC's Wildlife Profiles.
 *
 * This is the sibling of agency-guidance-block.test.js and the opposite axis: that file is per
 * WATER, this is per SPECIES and statewide. Keyed by species precisely so it is not copied onto
 * sixty-four lake profiles, which is the shape this refactor keeps deleting.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REG = path.join(ROOT, '..', 'registry');
const TRAITS = JSON.parse(readFileSync(path.join(REG, 'species_traits.json'), 'utf8'));

// Lifted out of the shipped file rather than reimplemented, so this tests the text the model will
// actually be sent. agents.js itself pulls in the whole Worker.
const SRC = readFileSync(path.join(ROOT, 'Worker', 'research', 'agents.js'), 'utf8');
const lift = (name) => {
  const head = SRC.indexOf(`function ${name}(`);
  const start = SRC.slice(head - 6, head) === 'async ' ? head - 6 : head;
  return SRC.slice(start, SRC.indexOf('\n}\n', head) + 3);
};
const mod = await import('data:text/javascript,' + encodeURIComponent(
  `export ${lift('speciesTraitsEntries')}\nexport ${lift('speciesTraitsBlock')}\n`
    .replace('await speciesTraits(env)', 'globalThis.__ST_TABLE')
    .replace(/canonicalizeResearchSpecies\(n\)/g, '(globalThis.__ST_CANON)(n)')));

globalThis.__ST_TABLE = TRAITS.species;
// The real canon lives in facts-util; the only fold this test needs is the page-vs-plan one.
globalThis.__ST_CANON = (n) => String(n || '').replace(/^(Black|White)\s+Crappie$/i, 'Crappie');

test("SCDNR's spawning temperature reaches the prompt, as SCDNR wrote it", async () => {
  const entries = await mod.speciesTraitsEntries({}, 'SC');
  const block = mod.speciesTraitsBlock(entries, ['Crappie']);
  assert.ok(block.includes('approach 60 degrees Fahrenheit'),
    'the black crappie spawning temperature must arrive verbatim');
  assert.ok(/SPAWNING:/.test(block), 'under the label the state printed it under');
  assert.ok(/SCDNR/.test(block), 'attributed to the agency that published it');
});

test('a species group is sent only its own species accounts', async () => {
  const entries = await mod.speciesTraitsEntries({}, 'SC');
  const bass = mod.speciesTraitsBlock(entries, ['Largemouth Bass', 'Smallmouth Bass']);
  assert.ok(bass.includes('Largemouth Bass') && bass.includes('Smallmouth Bass'));
  assert.ok(!bass.includes('Black Crappie'), 'a bass call must not carry the crappie account');
  assert.ok(bass.length < 4000, 'and must not carry all 30 KB of the file');
});

test('the water gets its own state, and the neighbour only where its own state is silent', async () => {
  const nc = await mod.speciesTraitsEntries({}, 'NC');
  const bluegill = nc.filter((e) => e.species === 'Bluegill');
  assert.equal(bluegill.length, 1, 'NCWRC covers bluegill, so SCDNR is not also sent');
  assert.ok(/NCWRC, NC$/m.test(bluegill[0].text), 'and it is the NC row');

  // NCWRC publishes no largemouth profile, so the other states answer -- and every row that does
  // says which state it is. TWRA joined the file on 2026-09-02, so this is now more than one row:
  // the rule is not "exactly one", it is "none of them is passed off as this water's own state".
  const lmb = nc.filter((e) => e.species === 'Largemouth Bass');
  assert.ok(lmb.length >= 1);
  assert.ok(lmb.every((e) => e.text.includes('neighbouring state')),
    'a state that is not this water\'s must SAY so, every time');
  assert.ok(!lmb.some((e) => /NCWRC/.test(e.text)), 'and none of them may claim to be NCWRC');

  const sc = await mod.speciesTraitsEntries({}, 'SC');
  const scBluegill = sc.filter((e) => e.species === 'Bluegill');
  assert.equal(scBluegill.length, 1);
  assert.ok(!scBluegill[0].text.includes('neighbouring'), 'an SC water gets SCDNR plainly');
});

test('a species none of the three guides covers gets no block, and nothing throws', async () => {
  const entries = await mod.speciesTraitsEntries({}, 'SC');
  // On the form, in the books, and in none of the three species guides. Muskellunge WAS this
  // test's example and stopped being one the day TWRA's guide was read -- which is the whole
  // point of the file, so the example moves rather than the assertion softening.
  for (const absent of ['Roanoke Bass', 'Shadow Bass', 'Kokanee Salmon', 'Northern Pike']) {
    assert.equal(mod.speciesTraitsBlock(entries, [absent]), '', `${absent} has no account`);
  }
  assert.equal(mod.speciesTraitsBlock([], null), '');
});

test('every species in the file produces a block in every state', async () => {
  for (const state of ['SC', 'NC', 'TN']) {
    const entries = await mod.speciesTraitsEntries({}, state);
    const named = new Set(entries.map((e) => e.species));
    assert.equal(named.size, TRAITS.species_count,
      `${state}: all ${TRAITS.species_count} species must be reachable`);
    for (const name of named) {
      assert.ok(mod.speciesTraitsBlock(entries, [name]).length > 200,
        `${state}: ${name} must produce a block`);
    }
  }
});
