// Which key a lake's research profile is filed under.
//
// REAL NAMES. Every lakeName below is the exact string the app sends, read off the live
// registry and off Ryan's 2026-08-16 run log, and every expected id is what sanitizeLakeId
// produces from it. The incident this pins is in the log verbatim:
//
//   [evidence-pipeline] No profile yet for J. Strom Thurmond Reservoir (Lincoln Co, GA/SC)
//                       (j_strom_thurmond_reservoir_lincoln_co_ga_sc)
//   ...
//   [evidence-pipeline] Loaded ... v2.0 status=draft overall=31%
//
// A lake with a verified 95% profile was researched from scratch and landed a 31% draft,
// because the county suffix the index started adding in August is in no key ever written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeLakeId, stripLakeQualifiers, parseLakeBaseName,
  researchStorageId, researchStorageIdCandidates, resolveResearchStorageId,
} from '../Worker/research/keys.js';

const THURMOND = 'J. Strom Thurmond Reservoir (Lincoln Co, GA/SC)';
const HARTWELL = 'Hartwell Lake (Anderson Co, SC/GA)';
const WATEREE  = 'Wateree Lake (Kershaw Co, SC)';
const LOUDOUN  = 'Fort Loudoun Lake (Knox Co, TN)';

test('the county parenthetical is what defeated the state-suffix strip', () => {
  // The old regex was anchored to the end of the string, so a trailing ")" beat it and the
  // whole parenthetical survived into every baseLower-keyed lookup.
  assert.equal(stripLakeQualifiers(HARTWELL), 'Hartwell Lake');
  assert.equal(stripLakeQualifiers(THURMOND), 'J. Strom Thurmond Reservoir');
  assert.equal(stripLakeQualifiers('Hartwell Lake, SC/GA'), 'Hartwell Lake');
});

test('baseLower reaches the agency tables again — 41 pages were unreachable', () => {
  // GADNR_LAKE_PAGES is keyed 'hartwell'; TWRA_LAKE_PAGES is keyed 'fort loudoun'.
  // Before this, baseLower for Hartwell was the entire "hartwell lake (anderson co, sc/ga)",
  // which is why Thurmond's run reported "Found 11 sources (0 seeds + 11 discovered)".
  assert.equal(parseLakeBaseName(HARTWELL).toLowerCase(), 'hartwell');
  assert.equal(parseLakeBaseName(WATEREE).toLowerCase(), 'wateree');
  assert.equal(parseLakeBaseName(LOUDOUN).toLowerCase(), 'fort loudoun');
  assert.equal(parseLakeBaseName('Ft. Loudoun Reservoir').toLowerCase(), 'fort loudoun');
});

test('the suffixed id is exactly the one that 404d', () => {
  assert.equal(sanitizeLakeId(THURMOND), 'j_strom_thurmond_reservoir_lincoln_co_ga_sc');
  assert.equal(researchStorageId(THURMOND), 'j_strom_thurmond_reservoir_lincoln_co_ga_sc');
});

test('candidates put the pre-county name ahead of the suffixed one', () => {
  const c = researchStorageIdCandidates(THURMOND);
  assert.ok(c.indexOf('j_strom_thurmond_reservoir') < c.indexOf('j_strom_thurmond_reservoir_lincoln_co_ga_sc'),
    `bare must be tried first: ${JSON.stringify(c)}`);
  assert.ok(c.includes('j_strom_thurmond_reservoir_lincoln_co_ga_sc'),
    'the suffixed key must still be reachable — profiles have been saved under it');
});

test('the canonical map still wins where it applies', () => {
  // RESEARCH_CANONICAL_IDS exists so Clarks Hill and Thurmond cannot become two profiles.
  const c = researchStorageIdCandidates('Lake Thurmond, SC');
  assert.equal(c[0], 'clarks_hill_thurmond_sc_ga');
  assert.equal(researchStorageIdCandidates('Clarks Hill Lake, GA')[0], 'clarks_hill_thurmond_sc_ga');
});

test('a lake with no suffix and no alias yields exactly one candidate', () => {
  assert.deepEqual(researchStorageIdCandidates('Norris Lake'), ['norris_lake']);
});

test('the resolver returns the first key that exists, not the first it thought of', async () => {
  // The bucket holds only the pre-county key. This is the Thurmond case exactly.
  const bucket = new Set(['j_strom_thurmond_reservoir']);
  const found = await resolveResearchStorageId(THURMOND, async (id) => (bucket.has(id) ? { id } : null));
  assert.equal(found.id, 'j_strom_thurmond_reservoir');
});

test('when only the suffixed key exists it is still found', async () => {
  const bucket = new Set(['j_strom_thurmond_reservoir_lincoln_co_ga_sc']);
  const found = await resolveResearchStorageId(THURMOND, async (id) => (bucket.has(id) ? { id } : null));
  assert.equal(found.id, 'j_strom_thurmond_reservoir_lincoln_co_ga_sc');
});

test('when both exist the researched one wins over the draft the suffix created', async () => {
  const bucket = new Set(['j_strom_thurmond_reservoir', 'j_strom_thurmond_reservoir_lincoln_co_ga_sc']);
  const found = await resolveResearchStorageId(THURMOND, async (id) => (bucket.has(id) ? { id } : null));
  assert.equal(found.id, 'j_strom_thurmond_reservoir');
});

test('an empty bucket resolves to null rather than a guess', async () => {
  assert.equal(await resolveResearchStorageId(THURMOND, async () => null), null);
});

// A CANONICAL ROW KEYED ON A NAME COLLIDES WHEN TWO WATERS SHARE THE NAME — 2026-09-04.
//
// RESEARCH_CANONICAL_IDS carried 'lake_russell_ga' -> 'lake_russell_sc', written to keep Richard
// B Russell Lake (24,608 acres, SC/GA) from splitting into two profiles. The index also carries
// Lake Russell (Habersham Co, GA) — 88 acres, US Forest Service, a hundred miles from the
// Savannah — whose own legacy name "Lake Russell, GA" sanitizes to exactly that key. The small
// lake was being served the big one's entire profile.
test('the GA Lake Russell does not sanitize into Richard B Russell\'s profile', () => {
  // Its own spellings, and not one of them may become the reservoir's key.
  for (const n of ['Lake Russell (Habersham Co, GA)', 'Lake Russell, GA', 'Lake Russell (GA)']) {
    assert.notEqual(researchStorageId(n), 'lake_russell_sc', n);
    assert.ok(!researchStorageIdCandidates(n).includes('lake_russell_sc'),
      `${n} must not offer lake_russell_sc as a candidate`);
  }
});

test('Richard B Russell still reaches its profile, by a name it actually answers to', async () => {
  // "Lake Russell, SC" is in its identity names, so the canonical row was never what carried it.
  const found = await resolveResearchStorageId(
    'Richard B Russell Lake (Abbeville Co, SC/GA)',
    async (id) => (id === 'lake_russell_sc' ? { id } : null),
    ['Lake Richard Russell, SC/GA', 'Lake Russell', 'Lake Russell, SC']);
  assert.equal(found && found.id, 'lake_russell_sc');
});

test('the shared-border rows that remain each name ONE water', () => {
  // Thurmond, Wylie, Hartwell and Chatuge are single waters under two state spellings. Russell
  // was not, and that is the difference the map cannot express on its own.
  assert.equal(researchStorageId('Lake Wylie, NC'), 'lake_wylie_sc');
  assert.equal(researchStorageId('Thurmond Lake, GA'), 'clarks_hill_thurmond_sc_ga');
  assert.equal(researchStorageId('Chatuge Lake, NC'), 'lake_chatuge_ga');
});
