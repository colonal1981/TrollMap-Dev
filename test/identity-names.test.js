/**
 * identity-names.test.js — the two copies of the identity-name rule must agree, and neither may
 * hand one profile to two waters.
 *
 * A research profile lives at `lakes/<sanitized name>.json`, and the name that was sanitized is
 * whatever the water was CALLED the day it was written. The client decides which waters still
 * need researching; the Worker decides where a profile is read from and written to. If those two
 * answer differently, a lake is researched again beside the profile it already had -- which is
 * what happened to four waters on 2026-09-01, every one of them filed under a name the registry
 * had never stopped carrying.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registryMissing, registryPath } from './registry-here.mjs';

// Every test here reads the real index through the loaded registry. Without ../registry they are
// reported as skipped with that reason, never passed.
const SKIP = registryMissing('lake_index.json');
const INDEX = SKIP ? {} : JSON.parse(readFileSync(registryPath('lake_index.json'), 'utf8'));

globalThis.window = globalThis;
globalThis.window.TROLLMAP_WORKER_URL = 'https://identity-names.test.invalid';
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => INDEX });

const client = await import('../js/data/lake-registry.js');
const worker = await import('../Worker/registry.js');
const ids = await import('../js/data/research-ids.js');
if (!SKIP) await client.loadLakeRegistry();

const fold = (list) => list.map((s) => s.toLowerCase()).sort();

test('the two copies of the identity-name rule return the same names for every water', { skip: SKIP }, () => {
  const drift = [];
  for (const rec of client.getLoadedRegistry().list) {
    const a = fold(client.identityNamesForRecord(rec));
    const b = fold(worker.identityNamesForRow(INDEX, INDEX[rec.slug], rec.slug));
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      drift.push(`${rec.slug}: client ${JSON.stringify(a)} vs worker ${JSON.stringify(b)}`);
    }
  }
  assert.deepEqual(drift.slice(0, 5), [],
    'the client and the Worker disagree about what a water is called; a profile written through '
    + 'one will be invisible to the other');
});

test('widening the names adds no claim on a water that is not deliberate', { skip: SKIP }, () => {
  // The question is not whether two waters can ever produce one id -- the display name alone
  // already does that for eight, `lake_robinson` and `broad_river` among them, and those are the
  // reason researchStorageIdCandidates has never been the whole answer. The question is whether
  // the registry names ADD a claim, because that is the one thing this change could break.
  //
  // Two are added and both are written down: DOC_ONLY_NAMES deliberately gives "Lake Lanier" and
  // "Lake Russell" to the reservoirs rather than the ponds.
  //
  // THIS ASSERTED THREE, AND THE THIRD WAS A BUG THAT HAS SINCE BEEN FIXED. `lake_russell_sc` was
  // contested because RESEARCH_CANONICAL_IDS carried `'lake_russell_ga': 'lake_russell_sc'`, and
  // that row handed Lake Russell (Habersham Co, GA) -- an 88-acre Forest Service lake a hundred
  // miles from the Savannah -- the entire profile of Richard B Russell: 24,608 acres, 15 species,
  // its depth and its trolling intelligence, on a lake Ryan could paddle across. It was removed
  // on 2026-09-04 and this file was not opened, so a test has been red ever since guarding a
  // state we deliberately left.
  //
  // The list below is the fixed state. The assertion under it is the one that matters, and it is
  // the guard that row could not have passed.
  const shares = (withIdentity) => {
    const by = new Map();
    for (const rec of client.getLoadedRegistry().list) {
      const names = withIdentity
        ? [rec.displayName, ...client.identityNamesForRecord(rec)] : [rec.displayName];
      for (const n of names) for (const id of ids.researchStorageIdCandidates(n)) {
        if (!by.has(id)) by.set(id, new Set());
        by.get(id).add(rec.slug);
      }
    }
    return new Set([...by.entries()].filter(([, s]) => s.size > 1).map(([id]) => id));
  };
  const before = shares(false);
  const added = [...shares(true)].filter((id) => !before.has(id)).sort();
  assert.deepEqual(added, ['lake_lanier', 'lake_russell']);
});

test('the 88-acre pond does not answer to the 24,608-acre reservoir', { skip: SKIP }, () => {
  // THE CLAIM THE REMOVED ROW BROKE, asserted directly instead of as a count. A canonical map
  // keyed on a name collides when two waters share the name, and "Lake Russell" is shared:
  // Richard B Russell on the Savannah and an 88-acre Forest Service lake in Habersham County.
  // "Lake Richard Russell" is not shared, which is why THAT key is in the table and this one is
  // not. Written as a claim about the two waters, so it cannot be satisfied by a number.
  const claim = (id) => {
    const owners = new Set();
    for (const rec of client.getLoadedRegistry().list) {
      const names = [rec.displayName, ...client.identityNamesForRecord(rec)];
      for (const n of names) {
        if (ids.researchStorageIdCandidates(n).includes(id)) owners.add(rec.slug);
      }
    }
    return [...owners];
  };
  assert.deepEqual(claim('lake_russell_sc'), ['richard_b_russell_lake'],
    'lake_russell_sc must belong to Richard B Russell and to nothing else');
  // And the pond reaches nothing, because it HAS nothing — it is under the research floor.
  assert.ok(!ids.researchStorageIdCandidates('Lake Russell (Habersham Co, GA)')
    .includes('lake_russell_sc'), 'the Habersham Co pond must not reach the reservoir profile');
  // The row itself stays out.
  assert.equal(ids.RESEARCH_CANONICAL_IDS.lake_russell_ga, undefined,
    "the 'lake_russell_ga' row is back in RESEARCH_CANONICAL_IDS");
});

test('the registry ordinal that separates two rivers is never stripped', { skip: SKIP }, () => {
  // `(2)`, `(3)`, `(4)` are consolidate_lake_index.py's handwriting when two rows collide and the
  // only thing telling four Saluda Rivers apart -- the same reason legacyStorageName's regex wants
  // `Co` as a word. A first cut stripped every parenthetical and gave "Nolichucky River (Unicoi
  // Co, TN)" and "Nolichucky River (2) (Greene Co, TN)" the same id.
  // Asserted on the NAMES, not on the ids they sanitize to: stripLakeQualifiers() inside
  // researchStorageIdCandidates() drops every parenthetical and has always folded these two onto
  // `nolichucky_river`. That is the pre-existing behaviour of the candidate function and is not
  // what this rule controls. What this rule controls is whether the ordinal reaches it at all.
  const a = client.identityNamesForRecord(client.lakeBySlug('nolichucky_river'));
  const b = client.identityNamesForRecord(client.lakeBySlug('nolichucky_river_2'));
  const fold = (l) => new Set(l.map((n) => n.toLowerCase()));
  assert.deepEqual([...fold(a)].filter((n) => fold(b).has(n)), [],
    'two rivers must not answer to the same name');
  assert.ok(b.some((n) => /\(2\)/.test(n)), 'the ordinal must survive into at least one name');
});

test('a name that already carries a state does not get a second one', { skip: SKIP }, () => {
  // "Nolichucky River, TN" plus ", TN" is `nolichucky_river_tn_tn`, an id nothing has ever been
  // filed under.
  for (const rec of client.getLoadedRegistry().list) {
    for (const n of client.identityNamesForRecord(rec)) {
      assert.ok(!/(?:,\s*(?:SC|NC|GA|TN))\s*(?:,\s*|\()(?:SC|NC|GA|TN)/i.test(n),
        `${rec.slug} produced a doubled state: ${n}`);
    }
  }
});

test('the four waters that had two profiles can now see the older one', { skip: SKIP }, () => {
  const want = {
    richard_b_russell_lake: 'lake_russell_sc',
    lake_sidney_lanier: 'lake_lanier_ga',
    nottely_lake: 'lake_nottely_ga',
    watauga_lake: 'watauga_tn',
  };
  for (const [slug, id] of Object.entries(want)) {
    const rec = client.lakeBySlug(slug);
    const reach = new Set([rec.displayName, ...client.identityNamesForRecord(rec)]
      .flatMap((n) => ids.researchStorageIdCandidates(n)));
    assert.ok(reach.has(id), `${rec.displayName} cannot reach its July profile ${id}`);
  }
});

test('a county-stamped profile id stays reachable', { skip: SKIP }, () => {
  // Nine of the eighty objects in the bucket are filed under a county-stamped name. An earlier
  // cut of this rule stripped the stamp the way the document-name rule does and made all nine
  // invisible, which is the opposite of the job.
  const rec = client.lakeBySlug('john_h_moss_lake');
  const reach = new Set([rec.displayName, ...client.identityNamesForRecord(rec)]
    .flatMap((n) => ids.researchStorageIdCandidates(n)));
  assert.ok(reach.has('john_h_moss_lake_cleveland_co_nc'));
});
