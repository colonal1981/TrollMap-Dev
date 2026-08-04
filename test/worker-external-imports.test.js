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
    const EXPECTED = [
      'js/data/lake-keys.js',
      'js/data/water-aliases.js',
      'js/utils/coerce.js',
      'js/utils/geojson-coords.js',
    ];
    expect(externalClosure().map((f) => relative(ROOT, f).replace(/\\/g, '/'))).toEqual(EXPECTED);
  });
});
