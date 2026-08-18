// THE TABLES THAT NEVER GREW WHEN THE APP DID.
//
// Ryan, 2026-08-15: *"did we forget to expand something from the original scope that should be
// expanded to all lakes rivers or coastal areas"* — and again on 2026-08-16, after the fourth
// hardcoded nine-lake Duke list turned up in one evening: *"how to fix the hand written and
// expand as needed."*
//
// The app ships 454 waters. Every per-water fact in it is either derived for all 454 or
// hand-listed for a few dozen, and every hand-listed one predates the registry. Finding them by
// reading is how four copies of the same Duke list survived; this file finds them by counting.
//
// WHAT THIS TEST IS FOR, precisely:
//
//   1. Every known hand-written per-water table is DECLARED below with its size and its kind.
//      Change a table and the number here has to change with it, so "6 of 454" is stated in a
//      diff instead of discovered a year later.
//   2. A NEW table keyed by water names, added anywhere in Worker/ or js/ and not declared,
//      FAILS. That is the part that catches the next one.
//   3. `kind` records what can actually be done about each, because they are not the same
//      problem:
//        gate        code REFUSES a water that is not listed. Always a bug. Resolve against
//                    the registry or the live feed instead — that is what killed the Duke
//                    nine-name list.
//        foreign-key an id for somebody else's service. CANNOT be derived. It can be VERIFIED:
//                    check that what comes back names the water you asked about.
//        data        facts that belong in the registry or the research pipeline.
//        alias       a name-to-name map. Legitimate and permanent — it exists precisely
//                    because the world does not agree on names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * file, identifier, top-level key count, kind, and the note that says what to do about it.
 * `count` is the number of TOP-LEVEL keys. A previous audit inflated every figure by counting
 * nested keys with a regex, so this test parses brace depth instead.
 */
const DECLARED = [
  // ── gates: code refuses a water that is not here ──────────────────────────────────────────
  ['Worker/worker-data.js', 'LAKES', 15, 'gate',
   'normalPool/usgs/duke/ahq for 15 waters. The duke arm is already bypassed by '
   + 'dukeRowForNames() reading the live 34-lake feed; the rest still gates.'],
  ['js/modules/duke-energy.js', 'STATE_NAME_MAP', 9, 'gate',
   'THE FIFTH COPY of the nine-lake Duke list, found by this test on the day it was written. '
   + 'duke-energy.js has had no importer since main.js switched to conditions-strip.js and the '
   + 'file has no side effects. Deletion tab.'],
  ['Worker/worker-data.js', 'RIVERS', 6, 'gate',
   'gauges, kayak thresholds and dam bindings for 6 rivers of 90 shipped. The river-mile '
   + 'centerline in each entry genuinely exists nowhere else, so this one cannot simply '
   + 'resolve against the registry.'],

  // ── foreign keys: cannot be derived, CAN be verified ──────────────────────────────────────
  ['Worker/worker-data.js', 'LAKEMONSTER_IDS', 5, 'foreign-key',
   "another site's slug, used to build a URL. Nothing in the registry replaces it."],
  ['Worker/worker-data.js', 'CWMS_LOCATIONS', 6, 'foreign-key',
   'Corps location ids. usaceLevels() now picks from the live district roster instead, so '
   + 'this is a candidate for deletion once its last caller goes.'],

  // ── data: belongs in the registry or the research pipeline ────────────────────────────────
  ['Worker/worker-data.js', 'LAKE_INTEL', 9, 'data',
   'superseded field-for-field by the research pipeline, and all 9 have verified profiles. '
   + 'On the deletion tab since 2026-08-15.'],
  ['Worker/worker-data.js', 'LAKE_INTEL_SOURCE_REGISTRY', 11, 'data',
   'per-lake source lists behind LAKE_INTEL. Goes with it.'],
  ['Worker/worker-data.js', 'LAKE_CLARITY_PROFILES', 6, 'data',
   'SPATIAL and not replaceable by the profile schema: per-zone clarity within one lake. '
   + 'The research profile carries one clarity value for the whole water.'],
  ['js/data/species-intel.js', 'SPECIES_BEHAVIOR', 2, 'data',
   'TWO waters — Wateree and Murray. The smallest table in the app and it drives species '
   + 'behaviour text.'],
  // NINE, NOT FOURTEEN. The old scanner ran past the end of this literal and counted five
  // `name:` pairs out of the code below it, so editing checkRegulations() moved the count of a
  // table nobody had touched. Six waters plus Coastal SC Inshore plus lastVerified/source.
  //
  // Six waters gate checkRegulations() for all 454, and plan-preflight and smart-plan both call
  // it before a plan is built. As of 2026-08-17 the statewide half comes from the live digest
  // through /regulations; the closures — notPresent and closedSeason — are still only here,
  // because a size and creel limit is not a closure.
  ['js/data/species-intel.js', 'REGULATIONS', 9, 'data',
   'six waters plus Coastal SC Inshore. The digest now supplies statewide limits for all 454; '
   + 'this table is the only source of CLOSURES.'],
  ['js/modules/contour-data.js', 'CHAIN_DESCRIPTIONS', 30, 'data',
   'prose for 30 named reservoir chains.'],
  ['js/modules/fishing-index.js', 'FISHING_SYSTEMS', 5, 'data',
   'five named systems that group ramps across waters.'],
  ['js/data/coastal-zones.js', 'COASTAL_ZONES', 22, 'data',
   '22 declared, 16 shipped. The 6 extras are out of the region mask.'],

  // ── discovery seeds: superseded by the live agency indexes ────────────────────────────────
  ['Worker/research/discover.js', 'TWRA_LAKE_PAGES', 10, 'data',
   'replaced 2026-08-16 by agency-pages.js reading the live TWRA region indexes.'],
  ['Worker/research/discover.js', 'GADNR_LAKE_PAGES', 31, 'data',
   'Georgia is deliberately absent from AGENCY_INDEXES, so this is still the GA seed list.'],

  // ── aliases: legitimate and permanent ─────────────────────────────────────────────────────
  ['Worker/research/keys.js', 'RESEARCH_CANONICAL_IDS', 12, 'alias',
   'storage-key aliases. Legitimate: the world disagrees about what Thurmond is called.'],
  ['js/data/research-ids.js', 'RESEARCH_CANONICAL_IDS', 12, 'alias',
   'THE SAME TABLE, second copy. Pinned identical below.'],
  ['Worker/research/deterministic.js', 'LEGACY_PROFILE_KEYS', 7, 'alias',
   'profile keys written before the storage-id rules settled. Read-only compatibility.'],
  ['Worker/research/extract.js', 'DOCUMENT_ALIASES', 11, 'alias',
   'names as they appear inside fetched documents, which is not how the registry spells them.'],
  // ONE HUNDRED AND TWENTY-ONE, NOT SIXTY-SEVEN. The old scanner stopped early on a brace inside
  // a nested string and undercounted this by fifty-four. It is the second-largest hand-written
  // table in the app and every audit that quoted 67 was quoting a parser bug.
  ['js/data/lake-keys.js', 'LAKE_NAME_TO_R2_KEY', 121, 'alias',
   'display name to R2 key. Superseded in most paths by the registry, still the fallback.'],
  // 141 since 2026-08-18, down one from 142. gen_water_aliases_js.py drops a name the registry
  // now answers directly, and "Cooper River" graduated the night the Cooper got its own 4,658-acre
  // freshwater pack: it used to point at coast_charleston_sc and now resolves to cooper_river out
  // of lake_index.json. A table that shrinks because the registry grew is this table working.
  ['js/data/water-aliases.js', 'WATER_TO_R2_KEY', 141, 'alias',
   'the biggest of them and the least worrying: 141 water names mapped to R2 keys, which '
   + 'is exactly the job an alias table should have. GENERATED -- do not hand-edit; run '
   + 'Scripts/gen_water_aliases_js.py and update the count here.'],
];

/** Top-level keys of the object literal that starts at `i`. Brace depth, not regex. */
function topLevelKeys(src, i) {
  // STRINGS AND COMMENTS AT EVERY DEPTH, NOT JUST THE FIRST.
  //
  // This skipped quotes only at depth 1, so a brace inside a nested string or a comment threw the
  // depth count off and the scan ran straight out of the literal and on through the rest of the
  // file, counting whatever `name:` pairs it met. REGULATIONS was pinned at 14 while the object
  // actually has 9 keys — the extra five were from code below it, and editing that code changed
  // the count of a table nobody had touched. A pin that moves when an unrelated function is
  // rewritten is not a pin.
  //
  // Template literals matter too: `${x}` is a brace pair inside a string.
  let d = 0; const keys = []; let j = i;
  const skipString = (k, q) => {
    k += 1;
    while (k < src.length) {
      if (src[k] === '\\') { k += 2; continue; }
      if (src[k] === q) return k;
      k += 1;
    }
    return src.length;
  };
  while (j < src.length) {
    const ch = src[j];
    if (ch === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); if (j < 0) break; }
    else if (ch === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j); if (j < 0) break; j += 1; }
    else if (ch === '"' || ch === "'" || ch === '`') {
      const close = skipString(j, ch);
      if (d === 1 && ch !== '`' && /^\s*:/.test(src.slice(close + 1))) {
        keys.push(src.slice(j + 1, close));
      }
      j = close;
    }
    else if (ch === '{') d += 1;
    else if (ch === '}') { d -= 1; if (d === 0) break; }
    else if (d === 1 && /[A-Za-z_$]/.test(ch)) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(src.slice(j));
      if (m) { keys.push(m[1]); j += m[0].length - 1; }
    }
    j += 1;
  }
  return keys;
}

function tablesIn(rel) {
  const src = readFileSync(path.join(ROOT, rel), 'utf8');
  const out = new Map();
  for (const m of src.matchAll(/(?:const|var|let)\s+([A-Z][A-Z0-9_]{3,})\s*=\s*\{/g)) {
    const i = src.indexOf('{', m.index);
    out.set(m[1], topLevelKeys(src, i));
  }
  return out;
}

function walk(dir, acc = []) {
  for (const e of readdirSync(path.join(ROOT, dir))) {
    const rel = path.posix.join(dir, e);
    if (e === 'node_modules' || e.startsWith('.')) continue;
    if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, acc);
    else if (e.endsWith('.js')) acc.push(rel);
  }
  return acc;
}

test('every declared table still has the size it is declared with', () => {
  const wrong = [];
  for (const [file, name, count] of DECLARED) {
    const keys = tablesIn(file).get(name);
    if (!keys) { wrong.push(`${file}:${name} — GONE (delete its row here too)`); continue; }
    if (keys.length !== count) wrong.push(`${file}:${name} — declared ${count}, found ${keys.length}`);
  }
  assert.deepEqual(wrong, [],
    'a hand-written per-water table changed size. Update the count AND ask whether it should '
    + 'have been a registry lookup instead.');
});

test('no gate has quietly grown a new arm — a gate is a bug, not a size', () => {
  // Growing a gate is the failure mode: someone adds a lake to LAKES rather than deleting the
  // reason LAKES is consulted. The declared counts above are the ratchet.
  const gates = DECLARED.filter(([, , , kind]) => kind === 'gate');
  assert.ok(gates.length >= 2, 'the gate list should not silently empty out');
  for (const [file, name, count] of gates) {
    assert.equal(tablesIn(file).get(name).length, count, `${name} grew or shrank`);
  }
});

test('a NEW table keyed by water names must be declared here', () => {
  // The signal: two or more top-level keys that name a shipped water. Read off the sample index
  // rather than a hand-written word list, so the detector cannot rot in the same way its
  // subject matter does.
  const idx = JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/lake_index.sample.json'), 'utf8'));
  const waterWords = new Set();
  for (const r of Object.values(idx)) {
    for (const n of [r.name, r.display_name, ...(r.legacy_display_names || [])]) {
      for (const w of String(n || '').toLowerCase().split(/[^a-z]+/)) {
        if (w.length > 4 && !['lake', 'river', 'creek', 'reservoir', 'north', 'south'].includes(w)) {
          waterWords.add(w);
        }
      }
    }
  }
  const declared = new Set(DECLARED.map(([f, n]) => `${f}:${n}`));
  const undeclared = [];
  for (const rel of [...walk('Worker'), ...walk('js')]) {
    for (const [name, keys] of tablesIn(rel)) {
      if (declared.has(`${rel}:${name}`)) continue;
      const hits = keys.filter((k) => String(k).toLowerCase().split(/[^a-z]+/).some((w) => waterWords.has(w)));
      if (hits.length >= 2) undeclared.push(`${rel}:${name} (${keys.length} keys, e.g. ${hits.slice(0, 3).join(', ')})`);
    }
  }
  assert.deepEqual(undeclared, [],
    'a new per-water table appeared. Declare it above with its kind — and if the kind is '
    + '"gate", resolve against the registry instead of listing waters.');
});

test('the two copies of RESEARCH_CANONICAL_IDS are identical', () => {
  // One lives in the Worker and one in the client and nothing keeps them in step. The storage
  // key they build is what broke on 2026-08-16 when a display name gained a county suffix; two
  // copies means that fix has to land twice.
  const a = tablesIn('Worker/research/keys.js').get('RESEARCH_CANONICAL_IDS');
  const b = tablesIn('js/data/research-ids.js').get('RESEARCH_CANONICAL_IDS');
  assert.deepEqual(a, b, 'the Worker and client alias tables have drifted');
});

test('the manifest itself is well formed', () => {
  const kinds = new Set(['gate', 'foreign-key', 'data', 'alias']);
  for (const [file, name, count, kind, note] of DECLARED) {
    assert.ok(kinds.has(kind), `${name}: unknown kind ${kind}`);
    assert.ok(Number.isInteger(count) && count > 0, `${name}: bad count`);
    assert.ok(note && note.length > 20, `${name}: say what to do about it, not just that it exists`);
  }
});
