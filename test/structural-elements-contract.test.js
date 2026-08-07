import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_ROOT = path.join(REPO, 'js');
const ENGINE = path.join(REPO, 'js/modules/lake-research-engine.js');

// ---------------------------------------------------------------------------
// Why this test exists
//
// 2026-08-07. `deriveGeospatialStructureFacts()` was rewired to read
// structure.geojson off the pack instead of grid-bucketing contour centroids in
// the browser. The replacement emitted `humps` and `ledges` as summary prose
// and dropped `humpCoordinates` / `ledgeCoordinates`, which are what
//
//     supplemental-layers.js  renderStructureMarkers()  -> map markers
//     smart-plan.js           stop candidates           -> casting stops
//
// actually read. Nothing errored. Both consumers use `|| []` and simply drew
// nothing. The bug was invisible for a further reason: the map kept showing the
// STALE cached research profile, so the old 8 humps / 8 ledges were still on
// screen while the new code path produced none. It would have surfaced the next
// time research was re-run, as markers quietly disappearing.
//
// The contract: every key any module reads off `habitat.structuralElements`
// must be a key `lake-research-engine.js` can actually write.
// ---------------------------------------------------------------------------

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'vendor') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

// Keys the engine can emit. Over-approximated on purpose: every `out.key =` and
// every `key:` inside the structuralElements literal counts as produced. An
// over-approximation only ever makes this test quieter, never louder.
function producedKeys(engineSrc) {
  const keys = new Set();
  for (const m of engineSrc.matchAll(/\bout\.([A-Za-z_$][\w$]*)\s*=/g)) keys.add(m[1]);
  const lit = /const structuralElements = \{([\s\S]*?)\n {2}\};/.exec(engineSrc);
  if (lit) {
    for (const m of lit[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) keys.add(m[1]);
  }
  return keys;
}

// Keys some module reads. Two shapes: `structuralElements.foo` directly, and
// `const se = <something>.structuralElements ...` followed by `se.foo`.
function consumedKeys(source) {
  const hits = [];

  for (const m of source.matchAll(/\bstructuralElements(?:\s*\|\|\s*\{\})?\.([A-Za-z_$][\w$]*)/g)) {
    hits.push({ key: m[1], via: 'structuralElements' });
  }

  // An alias only counts when the assignment ENDS at `.structuralElements`
  // (optionally `|| {}`). `Object.entries(h.structuralElements)` binds a list of
  // pairs, not the object, and its `.join` is not a key.
  const aliases = new Set();
  for (const m of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*?\.structuralElements\s*(?:\|\|\s*\{\s*\})?\s*[;\n]/g
  )) {
    aliases.add(m[1]);
  }
  for (const alias of aliases) {
    const re = new RegExp(`\\b${alias}\\.([A-Za-z_$][\\w$]*)`, 'g');
    for (const m of source.matchAll(re)) hits.push({ key: m[1], via: alias });
  }

  // Object.keys(...) style iteration reads no specific key.
  return hits.filter(h => !['length', 'map', 'filter', 'forEach', 'find'].includes(h.key));
}

describe('structuralElements: every key read is a key the engine writes', () => {
  const engineSrc = readFileSync(ENGINE, 'utf8');
  const produced = producedKeys(engineSrc);

  it('the engine produces a non-trivial set of keys', () => {
    expect(produced.size > 5).toBe(true);
  });

  it('humps and ledges ship COORDINATES, not only prose', () => {
    // Named explicitly because losing these is the exact regression above, and
    // the generic check below would pass if both producer and consumer were
    // deleted together.
    expect(produced.has('humpCoordinates')).toBe(true);
    expect(produced.has('ledgeCoordinates')).toBe(true);
  });

  it('coordinate entries carry lat and lon', () => {
    const block = engineSrc.slice(
      engineSrc.indexOf('out.humpCoordinates'),
      engineSrc.indexOf('return out;', engineSrc.indexOf('out.humpCoordinates'))
    );
    expect(/lat:/.test(block) && /lon:/.test(block)).toBe(true);
  });

  for (const file of jsFiles(JS_ROOT)) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    if (rel.endsWith('lake-research-engine.js')) continue;
    const source = readFileSync(file, 'utf8');
    if (!source.includes('structuralElements')) continue;

    it(`${rel} reads only keys the engine can write`, () => {
      const missing = consumedKeys(source)
        .filter(h => !produced.has(h.key))
        .map(h => `${h.via}.${h.key}`);
      const unique = [...new Set(missing)];
      expect(unique.length === 0 ? 'ok' : `not produced: ${unique.join(', ')}`).toBe('ok');
    });
  }
});
