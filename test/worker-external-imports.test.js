/**
 * test/worker-external-imports.test.js — the Worker bundle's reach outside Worker/.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS FILE EXISTS
 *
 * `wrangler deploy` bundles from Worker/, and four modules import across the boundary into
 * js/. That is deliberate and it is the right call -- duplicating `resolveR2Key` or a
 * coercion helper on both sides of the wire is how they drift -- but it has a failure mode
 * that only shows up at deploy time:
 *
 *     ✘ [ERROR] Could not resolve "../../js/utils/geojson-coords.js"
 *
 * That is what a partial upload looks like. Ryan moves files to GitHub by hand through the
 * web uploader, so a shared helper that is new, or that only became shared this week, can be
 * imported by an uploaded Worker file while itself never having been uploaded. Nothing in
 * `npm test` notices, because in a full checkout the path resolves fine.
 *
 * So this test does two things. It asserts every cross-boundary import RESOLVES, which is the
 * cheap half. And it writes down the full transitive set, which is the half that matters:
 * that list is what has to exist wherever the Worker is built from, and it grows silently --
 * lake-keys.js gained an import of water-aliases.js on 2026-08-04, which quietly added a
 * fourth file to the Worker's deploy requirements without anyone touching Worker/.
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every relative import in a file, as absolute paths. */
function importsOf(file) {
  const src = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const out = [];
  for (const m of src.matchAll(/(?:from\s*|import\s*\(?\s*)['"](\.[^'"]+)['"]/g)) {
    out.push({ spec: m[1], abs: resolve(dirname(file), m[1]) });
  }
  return out;
}

function walk(dir, hits = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, hits);
    else if (p.endsWith('.js')) hits.push(p);
  }
  return hits;
}

const WORKER_FILES = walk(join(ROOT, 'Worker'));

/** Transitive closure of everything the Worker pulls in from outside Worker/. */
function externalClosure() {
  const seen = new Set();
  const queue = [];
  for (const f of WORKER_FILES) {
    for (const { abs } of importsOf(f)) {
      if (!abs.startsWith(join(ROOT, 'Worker'))) queue.push(abs);
    }
  }
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f) || !existsSync(f)) { seen.add(f); continue; }
    seen.add(f);
    for (const { abs } of importsOf(f)) {
      if (!seen.has(abs)) queue.push(abs);
    }
  }
  return [...seen].sort();
}

describe('the Worker bundle can be built', () => {
  it('every cross-boundary import resolves to a file that exists', () => {
    const missing = [];
    for (const f of WORKER_FILES) {
      for (const { spec, abs } of importsOf(f)) {
        if (abs.startsWith(join(ROOT, 'Worker'))) continue;
        if (!existsSync(abs)) missing.push(`${relative(ROOT, f)} -> ${spec}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every file those imports pull in transitively also exists', () => {
    const missing = externalClosure().filter((f) => !existsSync(f)).map((f) => relative(ROOT, f));
    expect(missing).toEqual([]);
  });

  it('the deploy set is exactly what is written down here', () => {
    // Not a style rule -- this list IS the deploy requirement. If it changes, whatever the
    // Worker is built from needs the new file, and a deploy done without it fails with
    // "Could not resolve" rather than anything that points at the cause.
    //
    // js/data/water-aliases.js is on this list only because lake-keys.js started importing
    // it. Nothing in Worker/ mentions it.
    //
    // TWO MORE ADDED 2026-09-03, and they had been in the real deploy set for days while this
    // list said four. The test was red the whole time and the redness was being read as
    // background noise -- which is what a stale assertion becomes. Both are genuinely shared:
    //
    //   ga-access-species.js   the 48 Y/N species columns on Georgia's WRD access points, read
    //                          by BOTH runtimes so the browser and the research pass cannot
    //                          disagree about what a Georgia ramp says is in the water
    //   wqp-limnology.js       the Water Quality Portal profile reader, shared for the same
    //                          reason -- the Worker refreshes it on cron and the client shows it
    //
    // TWO MORE ADDED 2026-09-15, and this assertion had been red for days again -- exactly the
    // failure its own comment above describes, a second time. Both arrived with the research
    // pipeline: Worker/research/keys.js imports research-ids.js, and lake-registry.js came in
    // behind it. Being red and ignored is how the list below stopped being the deploy set.
    //
    // TWO MORE ADDED 2026-09-25, in the same commit that made them Worker files: discover.js
    // imports water-scope.js, the rule that searches a shared-name water in its own county, and
    // water-scope.js imports qualifiersOf() from reach-places.js. Both are pure.
    //
    // ONE MORE ADDED 2026-09-25: fact-date.js, the words every prompt uses for a fact's date and the
    // test for two facts that disagree -- shared so plan-prompt.js and the Worker's agents print a
    // date one way, and the dedupe and the prompts mean one thing by "disagree". Pure, no imports.
    //
    // ONE MORE ADDED 2026-09-25: html-text.js, a fetched page as its text with its lines, and a
    // PDF told by its Content-Type or bytes. The app and research_lakes.py convert the batch
    // fallback's HTML with it; the Worker's stripHtml(), stripHtmlPreserveTables() and PDF checks
    // call it rather than keep copies. Pure, no imports.
    const EXPECTED = [
      'js/data/ga-access-species.js',
      'js/data/lake-keys.js',
      'js/data/lake-registry.js',
      'js/data/research-ids.js',
      'js/data/water-aliases.js',
      'js/utils/coerce.js',
      'js/utils/fact-date.js',
      'js/utils/geojson-coords.js',
      'js/utils/html-text.js',
      'js/utils/reach-places.js',
      'js/utils/water-scope.js',
      'js/utils/wqp-limnology.js',
    ];
    expect(externalClosure().map((f) => relative(ROOT, f).replace(/\\/g, '/'))).toEqual(EXPECTED);
  });

  // ── AND THE DEPLOY HAS TO SEE A CHANGE TO ANY OF THEM ────────────────────────────────────────
  //
  // THE WORKER DOES NOT LIVE ONLY IN Worker/, AND ITS WORKFLOW SAID IT DID.
  //
  // deploy-worker.yml carried `paths: ['Worker/**']`, so a push that changed one of the eight
  // files above -- files the Worker imports and RUNS -- did not deploy. Measured 2026-09-14/15:
  // two fixes to js/utils/wqp-limnology.js went to main, a regenerated registry object went to R2,
  // and Ryan ran the limnology refresh three times over four waters. Every run said `ok`. Every
  // profile came back stale, because the code that would have fixed it was never live. The chain
  // was correct end to end and provably correct on his own data, and none of it was running.
  //
  // The filter is gone rather than extended: a list that must track an import graph is the same
  // three-lists problem this file's own EXPECTED list has now drifted from TWICE. This asserts the
  // gate cannot come back, because the next person to add one will not know about the eight.
  it('the deploy workflow does not gate on paths, because the Worker reaches outside Worker/', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/deploy-worker.yml'), 'utf8');
    const active = wf.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(/^\s*paths:/m.test(active)).toBe(false);
    expect(/branches:\s*\[main/.test(active)).toBe(true);
  });
});
