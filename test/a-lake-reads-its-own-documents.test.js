/**
 * test/a-lake-reads-its-own-documents.test.js — /research/get-normalized has no alias table of its own.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * handleResearchGetNormalized() carried a private LEGACY_PROFILE_KEYS, tried when the shared
 * resolver found nothing, and it still held `'lake_russell_ga': 'lake_russell_sc'` three weeks
 * after research-ids.js removed that row. Scripts/research_lakes.py calls get-normalized, so a
 * batch on "Lake Russell, GA" -- 88 acres, Habersham Co -- read Richard B Russell's stored
 * documents as its own. The table is gone. Each of its seven rows is checked here against the
 * shared resolver, and the handler is run against a fake bucket.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleResearchGetNormalized } from '../Worker/research/deterministic.js';
import { researchStorageId, researchStorageIdCandidates } from '../js/data/research-ids.js';

// A bucket holding normalized documents only under the ids given.
function bucket(ids) {
  const asked = [];
  const env = { R2_TROLLMAP_CHARTPACKS: {
    async get(key) {
      asked.push(key);
      const m = /^lake_packages\/([^/]+)\/normalized_documents\.json$/.exec(key);
      if (!m || !ids.includes(m[1])) return null;
      const body = JSON.stringify([{ id: m[1] }]);
      return { text: async () => body, json: async () => JSON.parse(body) };
    },
  } };
  return { env, asked };
}

async function read(ids, lakeName) {
  const { env, asked } = bucket(ids);
  const res = await handleResearchGetNormalized(env, lakeName);
  const body = await res.json();
  return { status: res.status, from: body.ok ? body.documents[0].id : null, asked };
}

test('the handler has no alias table of its own', () => {
  const src = readFileSync(new URL('../Worker/research/deterministic.js', import.meta.url), 'utf8')
    .replace(/\/\/.*$/gm, '');
  assert.ok(!/LEGACY_PROFILE_KEYS\s*=/.test(src), 'LEGACY_PROFILE_KEYS is back in deterministic.js');
});

test('every row the deleted table held is answered the same way by the shared resolver', () => {
  // The seven rows, verbatim, minus the one that was wrong.
  const rows = {
    lake_thurmond_sc: 'clarks_hill_thurmond_sc_ga',
    clarks_hill_lake_ga: 'clarks_hill_thurmond_sc_ga',
    j_strom_thurmond_lake: 'clarks_hill_thurmond_sc_ga',
    thurmond_lake_sc: 'clarks_hill_thurmond_sc_ga',
    richard_b_russell_lake: 'lake_russell_sc',
    lake_russell_sc_ga: 'lake_russell_sc',
  };
  for (const [key, target] of Object.entries(rows)) {
    assert.equal(researchStorageId(key), target, key);
    assert.equal(researchStorageIdCandidates(key)[0], target, `${key} tries ${target} first`);
  }
});

test('Lake Russell, GA reads its own documents, and reaches nothing when it has none', async () => {
  assert.equal(researchStorageId('Lake Russell, GA'), 'lake_russell_ga');
  assert.equal(researchStorageId('LAKE_RUSSELL_GA'), 'lake_russell_ga');
  for (const n of ['Lake Russell, GA', 'Lake Russell (Habersham Co, GA)', 'LAKE_RUSSELL_GA']) {
    // The write rule sanitizes the name as given, so the county form writes under its own raw id;
    // what matters is that no spelling of this lake writes or reads under the reservoir's.
    assert.notEqual(researchStorageId(n), 'lake_russell_sc', n);
    assert.ok(!researchStorageIdCandidates(n).includes('lake_russell_sc'), n);
    // Only the big lake's documents are stored: a 404, not Richard B Russell's corpus.
    const none = await read(['lake_russell_sc'], n);
    assert.equal(none.status, 404, n);
    assert.ok(!none.asked.some((k) => k.includes('lake_russell_sc')), `${n} asked for lake_russell_sc`);
    // Its own, when it has them.
    const own = await read(['lake_russell_sc', 'lake_russell_ga'], n);
    assert.equal(own.from, 'lake_russell_ga', n);
  }
});

test('Richard B Russell still reads its documents under every spelling the table carried it by', async () => {
  for (const n of ['Richard B. Russell Lake', 'Richard B Russell Lake (Abbeville Co, SC/GA)',
    'Lake Russell, SC', 'Lake Richard Russell, GA', 'Lake Russell, SC/GA']) {
    const got = await read(['lake_russell_sc', 'lake_richard_russell_ga'], n);
    assert.equal(got.from, 'lake_russell_sc', n);
  }
});

test('Thurmond still reads its documents under its old spellings', async () => {
  for (const n of ['Lake Thurmond, SC', 'Clarks Hill Lake, GA', 'J Strom Thurmond Lake', 'Thurmond Lake, SC']) {
    const got = await read(['clarks_hill_thurmond_sc_ga'], n);
    assert.equal(got.from, 'clarks_hill_thurmond_sc_ga', n);
  }
});
