// A RULES CHANGE THAT THE BROWSER NEVER HEARS ABOUT.
//
// build_structure.py carries RULES_VERSION inside its build stamp so that changing what a hump IS
// rebuilds every pack without anybody remembering --force. That was the right mechanism and it
// covered exactly half the distance.
//
// On 2026-08-29 the rules changed three times in a day -- an island stopped being a hump, a loop
// nested inside another stopped being a second one, and a closed contour with nothing inside it
// stopped being one at all, because relief is not measurable without a second ring. Wateree went
// from 7,315 structures to 625. Every pack rebuilt, the upload ran, R2 took the new files, and
// then Ryan opened the map to plan his first trip in two months and every deleted hump was still
// on it.
//
// Nothing was broken. `loadLayer()` answers out of IndexedDB before it ever asks R2, the entry
// lives 24 hours, and its key is `v${CACHE_SCHEMA}/${lakeKey}/${layer}`. CACHE_SCHEMA had not
// moved since the Garmin pack landed in August. The comment above it in supplemental-layers.js
// describes this failure in full and in advance -- "the single most likely way a correct chartpack
// looks broken" -- and the comment was not enough, because a comment asks to be remembered.
//
// So the two versions are tied together and the tie is checked. Bump RULES_VERSION and this test
// fails until somebody decides, out loud, whether the browser has to forget what it is holding.
// Sometimes the honest answer is that it does not: a rules change that alters which features
// survive needs a bump, and one that only renames a build stamp does not. Either way it becomes a
// decision instead of an omission.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = readFileSync(path.join(REPO, 'Scripts/build_structure.py'), 'utf8');
const JS = readFileSync(path.join(REPO, 'js/modules/supplemental-layers.js'), 'utf8');

test('the structure rules and the layer cache agree on which build is current', () => {
  const py = PY.match(/RULES_VERSION\s*=\s*'([^']+)'/);
  assert.ok(py, 'build_structure.py still declares RULES_VERSION');

  const js = JS.match(/STRUCTURE_RULES_AT_BUMP\s*=\s*'([^']+)'/);
  assert.ok(js, 'supplemental-layers.js still records which build CACHE_SCHEMA was bumped for');

  assert.equal(js[1], py[1],
    `build_structure.py is on RULES_VERSION '${py[1]}' and the layer cache was last bumped for `
    + `'${js[1]}'. The packs will rebuild and R2 will take them; the browser will keep drawing the `
    + `old ones out of IndexedDB for a day. If the new rules change which features survive, bump `
    + `CACHE_SCHEMA in supplemental-layers.js and update STRUCTURE_RULES_AT_BUMP to match. If they `
    + `genuinely do not, update STRUCTURE_RULES_AT_BUMP alone and say why in the commit.`);
});

test('the cache key still carries the schema, or the tie above means nothing', () => {
  // If the key ever stops including CACHE_SCHEMA, bumping it orphans nothing and this whole
  // test becomes a comment with an assertion attached.
  assert.match(JS, /const cacheKey = `v\$\{CACHE_SCHEMA\}\//);
  assert.match(JS, /const CACHE_SCHEMA = \d+;/);
});

test('layers are still read from the cache before the network, which is why this matters', () => {
  // The whole failure rests on loadLayer() preferring IndexedDB. If that ever inverts to
  // network-first, the schema tie is belt without braces rather than the only thing holding it
  // up -- worth knowing, and worth this test failing so somebody re-reads the reasoning.
  assert.match(JS, /CACHE_TTL\s*=\s*24 \* 60 \* 60 \* 1000/);
  assert.match(JS, /cache:\s*'no-store'/,
    'fetchSupplemental still bypasses the HTTP cache -- the stale copy comes from IndexedDB, '
    + 'not from the browser cache, and the fix belongs at the schema');
});
