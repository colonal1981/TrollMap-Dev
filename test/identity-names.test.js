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
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = JSON.parse(readFileSync(path.join(ROOT, '..', 'registry', 'lake_index.json'), 'utf8'));

globalThis.window = globalThis;
globalThis.window.TROLLMAP_WORKER_URL = 'https://identity-names.test.invalid';
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => INDEX });

const client = await import('../js/data/lake-registry.js');
const worker = await import('../Worker/registry.js');
const ids = await import('../js/data/research-ids.js');
await client.loadLakeRegistry();

const fold = (list) => list.map((s) => s.toLowerCase()).sort();

test('the two copies of the identity-name rule return the same names for every water', () => {
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

test('widening the names adds no claim on a water that is not deliberate', () => {
  // The question is not whether two waters can ever produce one id -- the display name alone
  // already does that for eight, `lake_robinson` and `broad_river` among them, and those are the
  // reason researchStorageIdCandidates has never been the whole answer. The question is whether
  // the registry names ADD a claim, because that is the one thing this change could break.
  //
  // Three are added and all three are written down: DOC_ONLY_NAMES deliberately gives "Lake
  // Lanier" and "Lake Russell" to the reservoirs rather than the ponds. `lake_russell_sc` was
  // already shared before any of this -- RESEARCH_CANONICAL_IDS maps `lake_russell_ga` onto it,
  // and the pond is under the 1,000-acre research floor with no profile of its own to lose.
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
  assert.deepEqual(added, ['lake_lanier', 'lake_russell', 'lake_russell_sc']);
});

test('the registry ordinal that separates two rivers is never stripped', () => {
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

test('a name that already carries a state does not get a second one', () => {
  // "Nolichucky River, TN" plus ", TN" is `nolichucky_river_tn_tn`, an id nothing has ever been
  // filed under.
  for (const rec of client.getLoadedRegistry().list) {
    for (const n of client.identityNamesForRecord(rec)) {
      assert.ok(!/(?:,\s*(?:SC|NC|GA|TN))\s*(?:,\s*|\()(?:SC|NC|GA|TN)/i.test(n),
        `${rec.slug} produced a doubled state: ${n}`);
    }
  }
});

test('the four waters that had two profiles can now see the older one', () => {
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

test('a county-stamped profile id stays reachable', () => {
  // Nine of the eighty objects in the bucket are filed under a county-stamped name. An earlier
  // cut of this rule stripped the stamp the way the document-name rule does and made all nine
  // invisible, which is the opposite of the job.
  const rec = client.lakeBySlug('john_h_moss_lake');
  const reach = new Set([rec.displayName, ...client.identityNamesForRecord(rec)]
    .flatMap((n) => ids.researchStorageIdCandidates(n)));
  assert.ok(reach.has('john_h_moss_lake_cleveland_co_nc'));
});
