// The app shell must not be answered from a cache minted five weeks ago.
//
// sw.js served index.html cache-first out of `trollmap-v17-2026-07-12`, and the rule written
// above the constant was "bump CACHE_NAME whenever CORE_ASSETS changes" — which guards the LIST,
// not the CONTENTS. 19 commits and 268 inserted lines had landed in index.html since that date
// and none had ever reached the browser. Ryan picked a lake, saw no conditions strip, and said
// so; the markup was on the server and his shell was from July.
//
// These read sw.js as text rather than executing it, because a service worker needs a
// ServiceWorkerGlobalScope that node --test does not have. What is being pinned is the ROUTING
// DECISION, which is the part that was wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SW = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sw.js'), 'utf8');

/** The body of the fetch handler, so a mention inside a comment cannot satisfy a test. */
const code = SW.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('a navigation request is network-first, not cache-first', () => {
  assert.match(code, /req\.mode\s*===\s*'navigate'/,
    'nothing distinguishes a shell request from an icon');
  const idx = code.indexOf('isShell');
  const netIdx = code.indexOf('caches.match(req)', idx);
  const branchIdx = code.indexOf('fetch(req)', idx);
  assert.ok(branchIdx !== -1 && (netIdx === -1 || branchIdx < netIdx),
    'the shell branch must reach for the network before the cache');
});

test('.html is routed with the JS, not with the icons', () => {
  assert.match(code, /isShell\s*\|\|\s*url\.pathname\.endsWith\('\.js'\)/);
  assert.match(code, /endsWith\('\.html'\)/);
});

test('the cache is still the OFFLINE fallback — this is not a no-cache worker', () => {
  assert.match(code, /\.catch\(\(\)\s*=>\s*caches\.match\(req\)\)/,
    'losing the network must still serve the app');
});

test('the cache name moved off the version that was frozen', () => {
  assert.ok(!/trollmap-v17-2026-07-12/.test(code),
    'clients hold the old cache until the name changes');
  assert.match(code, /const CACHE_NAME = 'trollmap-v\d+-\d{4}-\d{2}-\d{2}'/);
});

test('index.html is still precached, because offline still has to work', () => {
  assert.match(code, /'\.\/index\.html'/);
  assert.match(code, /'\.\/js\/main\.js'/);
});

test('old caches are pruned on activate', () => {
  assert.match(code, /keys\.filter\(k => k !== CACHE_NAME\)\.map\(k => caches\.delete\(k\)\)/);
});

test('the rule that failed is recorded as history, not restated as an instruction', () => {
  // "Bump CACHE_NAME whenever CORE_ASSETS changes" guarded the LIST while the CONTENTS rotted.
  // The phrase should survive in the write-up -- deleting the story loses the lesson -- but it
  // must not stand as a live directive at the top of the file, which is where it was.
  const directive = SW.split('\n').some((l) => /^\s*\/\/\s*Bump CACHE_NAME whenever/.test(l));
  assert.equal(directive, false, 'the failed rule is still stated as the rule to follow');
  assert.match(SW, /used to read/, 'and the history of why it failed should still be here');
});
