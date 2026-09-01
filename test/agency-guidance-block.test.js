/**
 * agency-guidance-block.test.js — the state's own lake page reaches the fisheries agent.
 *
 * registry/agency_lake_facts.json holds 48 waters and 122 species sections read off the TWRA
 * reservoir pages, the SCDNR lake pages and the GA DNR fishing forecasts. Counted 2026-09-01, the
 * whole file was read in ONE place -- deterministic.js taking `page.species[].name` -- and
 * everything else was parsed, published and read by nothing: target 76, prospect 78, technique 74,
 * tips 39, notes 45.
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
  const entries = await mod.agencyGuidanceEntries({}, 'Lake Wateree (Kershaw Co, SC)');
  assert.deepEqual(entries, []);
  assert.equal(mod.agencyGuidanceBlock(entries, ['Striped Bass']), '');
});

test('every water whose page carries a species roster produces a block', async () => {
  let withBlock = 0;
  for (const slug of Object.keys(FACTS.rows)) {
    const row = INDEX[slug];
    if (!row) continue;
    const entries = await mod.agencyGuidanceEntries({}, row.display_name || row.name);
    if (entries.length) withBlock += 1;
  }
  // 25 of the 48 pages carry a species roster; the other 23 are measures and overview only.
  assert.equal(withBlock, 25);
});
