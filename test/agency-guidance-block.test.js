/**
 * agency-guidance-block.test.js — the state's own lake page reaches the fisheries agent.
 *
 * registry/agency_lake_facts.json held 48 waters and 122 species sections read off the TWRA
 * reservoir pages, the SCDNR lake pages and the GA DNR fishing forecasts. Counted 2026-09-01, the
 * whole file was read in ONE place -- deterministic.js taking `page.species[].name` -- and
 * everything else was parsed, published and read by nothing: target 76, prospect 78, technique 74,
 * tips 39, notes 45.
 *
 * ── AND THEN THE SCRAPE GREW UNDER A HARDCODED COUNT ──────────────────────────────────────────
 *
 * This file was written on 2026-09-01 with `assert.equal(withBlock, 25)` in it. Over the next two
 * days ten commits widened what the builder reads, every one of them deliberate:
 *
 *   12f1981  SCDNR names the fish in sentences and sc_page() returned an empty list
 *   499cd82  SCDNR writes a species account for every saltwater fish and we had none of them
 *   b5237ef  North Carolina, read out of its survey pdfs
 *   16b46fe  Georgia publishes one document that is all lake and no species page
 *   ff93ee2  An index can be the document
 *   ecbb217, eab8eb2, 386bccb, 39a5f9e, 93331f5
 *
 * The registry is 87 waters now and 46 of them produce a block -- SCDNR 24, GA DNR 16, TWRA 9,
 * NCWRC 2. Not one of those ten commits touched the 25. A number typed into a test is a claim about
 * data that the pipeline is free to change, so the count is DERIVED from the registry now and
 * asserted in both directions: a water with a usable section gets a block, a water without gets
 * none. That claim cannot go stale, and it is the claim the 25 was standing in for.
 *
 * Ryan, of what the plan gave him instead: "15-40ft is almost the entire depth profile... this
 * doesn't say upper or lower lake... coves or open lake... the rest of that is just noise."
 * Russell's page says Beaverdam Creek, Coldwater Creek and Pickens Creek.
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
const INDEX = JSON.parse(readFileSync(path.join(REG, 'lake_index.json'), 'utf8'));
const FACTS = JSON.parse(readFileSync(path.join(REG, 'agency_lake_facts.json'), 'utf8'));

// The two functions are lifted out of the shipped file rather than reimplemented, so this tests
// the text the model will actually be sent. agents.js itself pulls in the whole Worker.
const SRC = readFileSync(path.join(ROOT, 'Worker', 'research', 'agents.js'), 'utf8');
const lift = (name) => {
  const start = SRC.indexOf(`${name}(`, SRC.indexOf(`function ${name}`));
  const from = SRC.lastIndexOf('\n', SRC.lastIndexOf('function ' + name, start + name.length + 1));
  const head = SRC.indexOf(`function ${name}`, from);
  const end = SRC.indexOf('\n}\n', head) + 3;
  return SRC.slice(SRC.lastIndexOf('async function', head) === head - 6 ? head - 6 : head, end);
};
const mod = await import('data:text/javascript,' + encodeURIComponent(
  `export ${lift('agencyGuidanceEntries')}\nexport ${lift('agencyGuidanceBlock')}\n`
    .replace('await lakeIndex(env)', 'globalThis.__AG_INDEX')
    .replace('resolveRegistryRow(', '(globalThis.__AG_RESOLVE)(')
    .replace('(await agencyLakeFacts(env))', 'globalThis.__AG_FACTS.rows')
    .replace('canonicalizeResearchSpecies(n)', '(globalThis.__AG_CANON)(n)')));

globalThis.__AG_INDEX = INDEX;
globalThis.__AG_FACTS = FACTS;
globalThis.__AG_RESOLVE = (index, name) => {
  for (const [slug, r] of Object.entries(index)) {
    if ((r.display_name || r.name) === name) return { ...r, slug };
  }
  return null;
};
// The real canon lives in facts-util; the only fold this test needs is the page-vs-plan one.
globalThis.__AG_CANON = (n) => String(n || '').replace(/^(Black|White)\s+Crappie$/i, 'Crappie');

const RUSSELL = 'Richard B Russell Lake (Abbeville Co, SC/GA)';

test('the agency page reaches the prompt, with the creeks it names', async () => {
  const entries = await mod.agencyGuidanceEntries({}, RUSSELL);
  const block = mod.agencyGuidanceBlock(entries, null);
  for (const creek of ['Beaverdam Creek', 'Coldwater Creek', 'Pickens Creek']) {
    assert.ok(block.includes(creek), `the block must carry ${creek} verbatim`);
  }
  assert.ok(block.includes('Lake Hartwell tailrace'), 'and the striper tailrace');
  assert.ok(/GA DNR/.test(block), 'attributed to the agency that published it');
});

test('a species group is sent only its own species sections', async () => {
  const entries = await mod.agencyGuidanceEntries({}, RUSSELL);
  const bass = mod.agencyGuidanceBlock(entries, ['Largemouth Bass', 'Spotted Bass']);
  assert.ok(bass.includes('Largemouth Bass') && bass.includes('Spotted Bass'));
  assert.ok(!bass.includes('Black Crappie'), 'a bass call must not carry the crappie section');
  const crappie = mod.agencyGuidanceBlock(entries, ['Crappie']);
  assert.ok(crappie.includes('Black Crappie'),
    '"Black Crappie" on the page is "Crappie" in the plan vocabulary and must still match');
});

test('a water with no agency page gets no block, and nothing throws', async () => {
  // THIS PASSED FOR TWO WEEKS ON A TYPO. It asked for 'Lake Wateree (Kershaw Co, SC)'; the registry
  // display name is 'Wateree Lake (Kershaw Co, SC)', so the resolver returned null and the empty
  // array proved a misspelling rather than the absence of a page -- and by then Wateree HAD one,
  // added by 12f1981. A test about "no page" has to stand on a name that resolves, or it is testing
  // its own string.
  const noPage = Object.entries(INDEX).find(([slug, r]) => !FACTS.rows[slug] && (r.display_name || r.name));
  assert.ok(noPage, 'the registry must hold at least one water with no agency page');
  const name = noPage[1].display_name || noPage[1].name;
  assert.ok(globalThis.__AG_RESOLVE(INDEX, name), `${name} must resolve, or this tests nothing`);
  const entries = await mod.agencyGuidanceEntries({}, name);
  assert.deepEqual(entries, [], `${name} has no agency page and must produce no entries`);
  assert.equal(mod.agencyGuidanceBlock(entries, ['Striped Bass']), '');

  // And a name that resolves to nothing is still silent rather than throwing, which is what the
  // typo was accidentally covering.
  assert.deepEqual(await mod.agencyGuidanceEntries({}, 'Not A Lake (Nowhere Co, SC)'), []);
});

// What a page HAS, computed off the registry with the shipped function's own rules -- the >20 char
// filter and the five keys -- so the expectation moves with the data instead of being retyped.
const KEYS = ['target', 'technique', 'prospect', 'tips', 'notes'];
const usable = (v) => (Array.isArray(v) ? v : [v])
  .map((x) => String(x || '').replace(/\s+/g, ' ').trim()).filter((x) => x.length > 20);
const pageHasGuidance = (pages) => (pages || []).some((p) => (p.species || [])
  .some((sp) => String((sp && sp.name) || '').trim() && KEYS.some((k) => usable(sp[k]).length)));

test('a block appears for exactly the waters whose page carries usable guidance', async () => {
  const missing = [];
  const spurious = [];
  let withBlock = 0;
  for (const slug of Object.keys(FACTS.rows)) {
    const row = INDEX[slug];
    if (!row) continue;
    const entries = await mod.agencyGuidanceEntries({}, row.display_name || row.name);
    if (entries.length) withBlock += 1;
    const expected = pageHasGuidance(FACTS.rows[slug]);
    if (expected && !entries.length) missing.push(slug);
    if (!expected && entries.length) spurious.push(slug);
  }
  assert.deepEqual(missing, [], 'these waters have agency guidance the block does not carry');
  assert.deepEqual(spurious, [], 'these waters produce a block from nothing');
  // A floor, not an equality: it says the feature is alive on real data without pinning a count
  // the pipeline owns. It was 25 of 48 waters on 2026-09-01 and is 46 of 87 now.
  assert.ok(withBlock > 20, `only ${withBlock} waters produce a block — the scrape or the reader broke`);
});

// ── THE ROSTER SENTENCE WAS FOUR PSEUDO-RECOMMENDATIONS, AND WATEREE IS THE ONE HE FISHES ──────
//
// SC_ROSTER in build_agency_lake_facts.py reads the species NAMES out of a sentence like "Popular
// sport fish on Lake Wateree include black crappie, striped bass, largemouth bass and catfish" --
// which is how Wateree has a species list at all -- and stores that sentence as each name's
// `notes`, correctly, as the quote the name came from. Reading `notes` as guidance turned one
// published sentence into four identical per-species NOTES under a heading that tells the model
// "this is the strongest source you have" and "where this disagrees, this wins".
test('a sentence every species on the page shares is stated once, about the water', async () => {
  const entries = await mod.agencyGuidanceEntries({}, 'Wateree Lake (Kershaw Co, SC)');
  const roster = entries.filter((e) => /Popular sport fish on Lake Wateree/.test(e.text));
  assert.equal(roster.length, 1, 'the roster sentence must appear once, not once per species');
  assert.equal(roster[0].species, null, 'and as a statement about the water, not about a fish');
  assert.match(roster[0].text, /THIS WATER — SCDNR/);
  // AND IT REACHES EVERY GROUP, because it is as true in a catfish call as in a crappie one.
  for (const group of [['Striped Bass'], ['Catfish'], ['Crappie']]) {
    assert.match(mod.agencyGuidanceBlock(entries, group), /Popular sport fish on Lake Wateree/);
  }
});

// A page whose species sections genuinely differ must not be hoisted -- the detector is "identical
// on every named species", and Russell's page is the case that proves it stays per-species.
test('and a page whose sections really are per-species is left alone', async () => {
  const entries = await mod.agencyGuidanceEntries({}, RUSSELL);
  assert.ok(entries.some((e) => e.species), 'Russell has per-species sections');
  const bass = mod.agencyGuidanceBlock(entries, ['Largemouth Bass', 'Spotted Bass']);
  assert.ok(!bass.includes('Black Crappie'), 'the hoist must not leak the crappie section');
});
