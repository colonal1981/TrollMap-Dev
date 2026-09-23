/**
 * test/a-deleted-export-broke-the-deploy-not-a-test.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * 2026-09-23, 11:00. `91d8ce0` deleted `handleResearchApprove` from Worker/research/storage.js and
 * the deploy failed:
 *
 *     ✘ No matching export in "research/storage.js" for import "handleResearchApprove"
 *       worker-research.js:2:101
 *
 * `worker-research.js` is a one-line barrel that re-exports eleven handlers, and nothing looked at
 * it: the greps that found every caller ran over `Worker/trollmap-worker.js` and `js/`, and
 * `node --check` passes a file whose named imports resolve to nothing, because that is a linker
 * question and not a syntax one. 4,123 green tests said nothing either. THE BUILD WAS THE ONLY
 * READER, and a build Ryan is not watching is a reader that reports to nobody.
 *
 * 00_START_HERE already carries the rule this broke -- a grep is only as wide as the tree it runs
 * against -- and the answer to a barrel is not a wider grep. It is to actually load the graph.
 * `import()` resolves every named specifier; that is the exact check wrangler does.
 *
 * WHY THIS IS CHEAP. These modules are pure ESM with no top-level side effects that need a
 * binding -- `trollmap-worker.js` only defines `export default { fetch }` -- so importing them
 * costs milliseconds and needs no R2, KV or env.
 *
 *   node --test test/a-deleted-export-broke-the-deploy-not-a-test.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const WORKER = fileURLToPath(new URL('../Worker/', import.meta.url));

/** Every .js under Worker/, including research/ and any other subfolder added later. */
function modules(dir = WORKER, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { modules(full, out); continue; }
    if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const FILES = modules().sort();

test('there are Worker modules to check', () => {
  // A walk that silently finds nothing would make every test below pass for the wrong reason.
  assert.ok(FILES.length > 10, `only found ${FILES.length} Worker modules`);
});

for (const file of FILES) {
  const rel = path.relative(WORKER, file).replace(/\\/g, '/');
  test(`Worker/${rel} resolves every name it imports`, async () => {
    try {
      await import(`file://${file.replace(/\\/g, '/')}`);
    } catch (e) {
      assert.fail(`Worker/${rel} will not load, so the deploy will fail: ${e.message}`);
    }
  });
}
