/**
 * test/the-save-erased-what-it-did-not-manage.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * `handleResearchSave` built `master.metadata` as a literal of ten keys, so every save silently
 * deleted any metadata another endpoint owns. Two do:
 *
 *     metadata.limnologyRefreshedAt   Worker/research/limnology.js -- the WQP sweep. The only
 *                                     record of WHEN a profile's limnology was merged, which is
 *                                     exactly what a "has this merge gone stale?" check reads.
 *     metadata.approvedBy             Worker/research/storage.js /research/approve -- WHO approved
 *                                     this profile.
 *
 * MEASURED 2026-09-12. Lake Moultrie's master carried `limnologyRefreshedAt` and its v18 snapshot
 * did not, because the 2026-09-04 batch save had already dropped it once. Same shape as the
 * `meta["status"] = ... or "draft"` defect of 2026-09-04: writing a default over a value someone
 * else set is a write, not a default.
 *
 * THIS IS A SOURCE-CONTRACT TEST AND SAYS SO. `handleResearchSave` needs an R2 get/put/list mock
 * to call, and there is none in test/ -- the save path has no behavioural test at all, which is
 * how two writers erased each other for weeks. A guard on source text is a placeholder for the
 * contract it stands in for, so this asserts the ONE structural property that fixes the class:
 * the spread of the existing metadata comes BEFORE every managed key, which means it can only
 * carry forward a key the save does not own and can never resurrect a managed value.
 *
 *   node --test test/the-save-erased-what-it-did-not-manage.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../Worker/research/storage.js', import.meta.url), 'utf8');

// The ten keys the save legitimately owns and overwrites every time.
const MANAGED = ['version', 'versionNumber', 'status', 'lastUpdated', 'createdAt',
                 'createdBy', 'verified', 'verifiedAt', 'lakeId', 'previousVersion'];

/** The `metadata: { ... }` literal inside the master object, by brace balance. */
function metadataLiteral(src) {
  const at = src.indexOf('    metadata: {');
  assert.notEqual(at, -1, 'the master metadata literal moved -- this guard needs updating');
  let i = src.indexOf('{', at), depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  assert.notEqual(end, -1, 'unbalanced metadata literal');
  return src.slice(i, end + 1);
}

test('the save carries forward metadata keys it does not manage', () => {
  const lit = metadataLiteral(SRC);
  assert.match(lit, /\.\.\.\(existingMeta \|\| \{\}\)/,
    'metadata is rebuilt from a literal, so limnologyRefreshedAt and approvedBy are erased on '
    + 'every save; spread the existing metadata first');
});

test('the spread comes BEFORE every managed key, so it cannot resurrect one', () => {
  const lit = metadataLiteral(SRC);
  const spreadAt = lit.indexOf('...(existingMeta');
  assert.ok(spreadAt > -1, 'no spread present');
  for (const key of MANAGED) {
    const keyAt = lit.indexOf(`${key}:`);
    assert.ok(keyAt > -1, `managed key ${key} vanished from the save`);
    assert.ok(keyAt > spreadAt,
      `${key} is assigned BEFORE the spread, so a stale stored ${key} would win`);
  }
});

test('the two keys other endpoints own are still written by those endpoints', () => {
  // If either of these moves into the literal above, this file's premise is gone and the guard
  // should be deleted rather than left passing for the wrong reason.
  assert.match(SRC, /profile\.metadata\.approvedBy\s*=/,
    '/research/approve no longer writes approvedBy');
  const limn = readFileSync(new URL('../Worker/research/limnology.js', import.meta.url), 'utf8');
  assert.match(limn, /profile\.metadata\.limnologyRefreshedAt\s*=/,
    'the sweep no longer writes limnologyRefreshedAt');
});
