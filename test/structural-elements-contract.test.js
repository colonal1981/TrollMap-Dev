import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_ROOT = path.join(REPO, 'js');
// THE PRODUCER MOVED AGAIN, 2026-09-04: the pack derivations are in js/utils/pack-facts.js so
// the planners can run them without importing the research engine. Same code, same keys.
const ENGINE = path.join(REPO, 'js/utils/pack-facts.js');
const PACK_ADAPTER = path.join(REPO, 'js/utils/structure-markers.js');

// ---------------------------------------------------------------------------
// Why this test exists
//
// 2026-08-07. `deriveGeospatialStructureFacts()` was rewired to read
// structure.geojson off the pack instead of grid-bucketing contour centroids in
// the browser. The replacement emitted `humps` and `ledges` as summary prose
// and dropped `humpCoordinates` / `ledgeCoordinates`, which are what
//
//     supplemental-layers.js  renderStructureMarkers()  -> map markers
//     plan-candidates.js      stop candidates           -> casting stops
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
  // TWO ACCUMULATOR NAMES, NOT ONE. The helpers that build this block do not agree on what to
  // call the object they fill: structuresFromPack and waterFeaturesFromPack use `out`,
  // derivePoiStructures uses `result`. Reading only `out.` made this guard report
  // `chartedStructurePois` as a key plan-inputs.js reads and the engine cannot write, which is
  // false -- derivePoiStructures writes it on every run. A guard that cannot see a producer
  // reports a failure that is about the guard. Found 2026-09-04; the test was red at HEAD.
  for (const m of engineSrc.matchAll(/\b(?:out|result)\.([A-Za-z_$][\w$]*)\s*=/g)) keys.add(m[1]);
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

  // ── THE PRODUCER MOVED, 2026-08-16. THE GUARD MOVES WITH IT. ──────────────
  //
  // This suite was written on 08-07 because the coordinates were dropped from the profile and
  // both consumers failed soft. They are now deliberately NOT in the profile: structure.geojson
  // is served from the pack, uncapped, because humps are SmartPlan's casting stops and a
  // research document is the wrong place to ration them. Ryan, 2026-08-16: "how can i do all
  // casting stops instead of trolling lanes if i want to if you cap everything out
  // arbitrarily."
  //
  // So the assertion is not deleted, it is repointed. Losing the coordinates is still the
  // regression this suite exists to catch; the file that must produce them is now the adapter.
  it('humps and ledges ship COORDINATES, from the pack adapter', () => {
    const adapter = readFileSync(PACK_ADAPTER, 'utf8');
    expect(/export function humpsFromPack/.test(adapter)).toBe(true);
    expect(/export function ledgesFromPack/.test(adapter)).toBe(true);
    // and both consumers must go through it rather than reading the profile directly
    // smart-plan.js was the second consumer; it was deleted with v1 on 2026-08-20.
    for (const rel of ['js/modules/supplemental-layers.js']) {
      const src = readFileSync(path.join(REPO, rel), 'utf8');
      expect(/structure-markers\.js/.test(src) ? 'ok' : `${rel} does not use the adapter`).toBe('ok');
    }
  });

  it('coordinate entries carry lat and lon', () => {
    const adapter = readFileSync(PACK_ADAPTER, 'utf8');
    expect(/lat:/.test(adapter) && /lon:/.test(adapter)).toBe(true);
  });

  it('the profile still says HOW MANY, which is what a research document is for', () => {
    expect(produced.has('humpCount')).toBe(true);
    expect(produced.has('ledgeCount')).toBe(true);
  });

  for (const file of jsFiles(JS_ROOT)) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    // The PRODUCER is not a consumer of itself. It moved to pack-facts.js on 2026-09-04.
    if (rel.endsWith('pack-facts.js') || rel.endsWith('lake-research-engine.js')) continue;
    const source = readFileSync(file, 'utf8');
    if (!source.includes('structuralElements')) continue;

    it(`${rel} reads only keys the engine can write`, () => {
      // Read off profiles SAVED BEFORE 2026-08-16, when the engine still wrote them. The
      // adapter's fallback exists for those and for the 43 packs with no structure layer, so
      // these two are legitimately consumed by a producer that is no longer the engine.
      const LEGACY_PROFILE_KEYS = new Set(['humpCoordinates', 'ledgeCoordinates']);
      const missing = consumedKeys(source)
        .filter(h => !produced.has(h.key) && !LEGACY_PROFILE_KEYS.has(h.key))
        .map(h => `${h.via}.${h.key}`);
      const unique = [...new Set(missing)];
      expect(unique.length === 0 ? 'ok' : `not produced: ${unique.join(', ')}`).toBe('ok');
    });
  }
});
