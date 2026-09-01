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
  // STATE_NAME_MAP was here until 2026-08-23 -- the FIFTH copy of the nine-lake Duke list,
  // found by this test on the day it was written. The whole file is gone. Nothing in js/,
  // Worker/, test/ or index.html imported it; its exports `parseDukeText` and `fetchDamLevels`
  // were named only inside comments describing what they used to do, one of which called it
  // "Vestigial"; and STATE_NAME_MAP was reached by nothing but this row. `audit.json` said
  // three files imported it and audit.json was written 2026-08-14, before main.js moved to
  // conditions-strip.js -- a dependency graph is a measurement with a date on it.
  // check_start_here.py asserts the file's absence now, because a list like this comes back.
  ['Worker/worker-data.js', 'RIVERS', 6, 'gate',
   'gauges, kayak thresholds and dam bindings for 6 rivers of 90 shipped. The river-mile '
   + 'centerline in each entry genuinely exists nowhere else, so this one cannot simply '
   + 'resolve against the registry.'],

  // ── foreign keys: cannot be derived, CAN be verified ──────────────────────────────────────
  ['Worker/worker-data.js', 'LAKEMONSTER_IDS', 5, 'foreign-key',
   "another site's slug, used to build a URL. Nothing in the registry replaces it."],
  // GONE, 2026-08-25. Was CWMS_LOCATIONS, then CWMS_PROJECT: six typed rows naming the Corps
  // project behind five lakes, reachable only through `path === "/lake"` -- a route with no
  // caller anywhere in js/. Ryan, the same day: *"nothing hand written... everything
  // expandable... if i decide to add every single lake that garmin has in the US into the app
  // tomorrow this stuff should be able to expand with it"*. Six rows could not.
  //
  // `/conditions` had already been doing it properly and derived: usaceLevels() intersects the
  // binding's own usace[].cwms_name list with the district's published roster of conservation
  // pools, so the project is discovered per water and a Corps lake added tomorrow is covered.
  // usaceRelease() now reads that same derived project for the release. Nothing typed remains.

  // ── data: belongs in the registry or the research pipeline ────────────────────────────────
  ['Worker/worker-data.js', 'LAKE_INTEL', 9, 'data',
   'superseded field-for-field by the research pipeline, and all 9 have verified profiles. '
   + 'On the deletion tab since 2026-08-15.'],
  ['Worker/worker-data.js', 'LAKE_INTEL_SOURCE_REGISTRY', 11, 'data',
   'per-lake source lists behind LAKE_INTEL. Goes with it.'],
  ['Worker/worker-data.js', 'LAKE_CLARITY_PROFILES', 6, 'data',
   'SPATIAL and not replaceable by the profile schema: per-zone clarity within one lake. '
   + 'The research profile carries one clarity value for the whole water.'],
  // SPECIES_BEHAVIOR was here until 2026-08-20 — two waters, hand-written, and its only reader
  // was smart-plan.js, which was v1 and unreachable. Deleted with v1. depthBandFor() in
  // plan-inputs.js is the expandable path: researched profile first, V2 table second, generic
  // third, and it says in `source` which one answered.
  // EIGHT SINCE 2026-08-20, down one: 'Coastal SC Inshore' is gone. Every display name, legacy
  // name and slug in lake_index.json — 1,363 strings — was run through resolveLakeKey() against
  // this table; six resolve and they are the six waters, and zero ever reached that key. It held
  // three species of numbers, one of which its own note called SUPERSEDED.
  //
  // REGULATIONS IS GONE -- 2026-08-27, and this row is its headstone rather than its count.
  //
  // It gated `legal: false` on six waters for all 358 and its own entry here said why it stayed
  // alive: "this table is the only source of CLOSURES". That stopped being true when
  // registry/regulations.json landed -- 74 waters parsed out of the four state books with no LLM
  // in the path -- and Ryan put the remaining question plainly: "what is the point of having all
  // of this information if we just have hand written tables that cover slightly more than 1% of
  // our water".
  //
  // Eleven of thirteen rows were duplicates. The two that were not said a lake has no striped
  // bass, and on 2026-08-28 they stopped gating anything at all: Ryan, "i do not want to block
  // the plan based on our species lists". The sourced sentences stay in
  // registry/_water_notes.json as facts about what an agency published; nothing carries them
  // onto an index row and nothing refuses a trip on them. See the block comment where the table
  // used to be, and the contract test in test/regulations-closures.test.js.
  // 24 since 2026-08-19, down six. The map is slug -> label and the six out-of-region zones
  // no longer have slugs: cutting them from coastal_catalog.py without cutting them here would
  // leave six labels for water the picker cannot offer.
  // 21, 13, 98 and 130 since 2026-09-01. a4bfd02 cut the three NC coastal zones --
  // coast_brunswick_nc, coast_cape_fear_nc, coast_topsail_new_river_nc -- along with the
  // hand-typed NCDMF regulation table behind them, and left these four counts declaring
  // the zones that went. Every one of the four is a row ABOUT those zones: a chain
  // description each, a zone entry each, an R2 key each, and the alias rows pointing at
  // them. The ratchet caught all four the next time it ran, which is what it is for.
  ['js/modules/contour-data.js', 'CHAIN_DESCRIPTIONS', 21, 'data',
   'prose for 21 named reservoir chains and coastal zones.'],
  ['js/modules/fishing-index.js', 'FISHING_SYSTEMS', 5, 'data',
   'five named systems that group ramps across waters.'],
  // 16 since 2026-08-19. This row used to read "22 declared, 16 shipped" -- it had been
  // recording the discrepancy rather than closing it. The six extras are gone from
  // Scripts/coastal_catalog.py, so declared and shipped are now the same number.
  ['js/data/coastal-zones.js', 'COASTAL_ZONES', 13, 'data',
   '13 declared, 13 shipped. Every zone in the table is a zone the picker offers.'],

  // ── discovery seeds: superseded by the live agency indexes ────────────────────────────────
  // NOT DEAD, and this note said it was. Corrected 2026-08-23 while auditing the ledger for
  // things that could be cut: what agency-pages.js replaced on 2026-08-16 is the PRIMARY path,
  // not the table. discover.js still reads it twice -- `agencyTableHit(TWRA_LAKE_PAGES)` and
  // again as `staticHit` -- so it is the fallback underneath the live index, which is a
  // different thing from superseded. A row that reads "replaced" invites a deletion.
  ['Worker/research/discover.js', 'TWRA_LAKE_PAGES', 10, 'data',
   'the FALLBACK under agency-pages.js, which reads the live TWRA region indexes since '
   + '2026-08-16. Still read twice in discover.js. Do not cut it on the strength of the word '
   + '"replaced" -- what was replaced is the path that runs first.'],
  ['Worker/research/discover.js', 'GADNR_LAKE_PAGES', 31, 'data',
   'Georgia is deliberately absent from AGENCY_INDEXES, so this is still the GA seed list.'],

  // ── aliases: legitimate and permanent ─────────────────────────────────────────────────────
  ['Worker/research/keys.js', 'RESEARCH_CANONICAL_IDS', 12, 'alias',
   'storage-key aliases. Legitimate: the world disagrees about what Thurmond is called.'],
  ['js/data/research-ids.js', 'RESEARCH_CANONICAL_IDS', 12, 'alias',
   'THE SAME TABLE, second copy. Pinned identical below.'],
  ['Worker/research/deterministic.js', 'LEGACY_PROFILE_KEYS', 7, 'alias',
   'profile keys written before the storage-id rules settled. Read-only compatibility.'],
  // DOCUMENT_ALIASES was here until 2026-09-01, eleven waters, and NOT ONE OF ITS KEYS COULD
  // MATCH. It was keyed by base name and `baseName` reaches extract.js with "Lake ", " Lake" and
  // " Reservoir" already stripped by cleanLakeBaseName(); every key still carried one of those
  // words. Computed across all 358 registry rows: of the 350 distinct keys the code can produce,
  // zero are in the table. It had never fired for any water, which is why Lanier, Russell and
  // Thurmond kept losing facts to documents calling them exactly what it listed. It also mapped
  // 'Lake Tillery' onto Blewett Falls Lake -- separate rows 30 km apart on the Pee Dee.
  // Replaced by documentNamesFromRecord(), which derives the same names from the registry for all
  // 358 rows instead of eleven, and by DOC_ONLY_NAMES below for the two it cannot derive.
  ['js/data/lake-registry.js', 'DOC_ONLY_NAMES', 2, 'alias',
   'the two names no rule can derive and the index cannot hold, because a pond already answers '
   + 'to each: "Lake Lanier" for Lake Sidney Lanier and "Lake Russell" for Richard B Russell '
   + 'Lake. Everything else is generated. This grows only when a reservoir is found sharing a '
   + 'name with a water nobody writes about -- and if that water ever enters the research set, '
   + 'its line comes out first.'],
  ['Worker/registry.js', 'IDENTITY_DOC_ONLY_NAMES', 2, 'alias',
   'THE SAME TWO NAMES, second copy. The client decides which waters still need researching and '
   + 'the Worker decides where a profile is read from and written to; they must agree about what '
   + 'a water is called or a lake is researched again beside the profile it already had. '
   + 'test/identity-names.test.js pins the whole rule, not just this table, by running both '
   + 'copies over all 358 rows.'],
  // ONE HUNDRED AND TWENTY-ONE, NOT SIXTY-SEVEN. The old scanner stopped early on a brace inside
  // a nested string and undercounted this by fifty-four. It is the second-largest hand-written
  // table in the app and every audit that quoted 67 was quoting a parser bug.
  // 115 since 2026-08-19, down six: the display names of the six cut coastal zones. A name
  // here that resolves to a slug the picker will not offer is a lake that appears in the list
  // and then fails to load, which is the exact failure LAKE_NAMES_WITHOUT_PACK exists to prevent.
  ['js/data/lake-keys.js', 'LAKE_NAME_TO_R2_KEY', 98, 'alias',
   'display name to R2 key. Superseded in most paths by the registry, still the fallback.'],
  // 141 since 2026-08-18, down one from 142. gen_water_aliases_js.py drops a name the registry
  // now answers directly, and "Cooper River" graduated the night the Cooper got its own 4,658-acre
  // freshwater pack: it used to point at coast_charleston_sc and now resolves to cooper_river out
  // of lake_index.json. A table that shrinks because the registry grew is this table working.
  // 138 since 2026-08-19, down three. The Ashley, the Sampit and the Waccamaw were cut as
  // freshwater boundaries this week and now carry their own packs, so the rows pointing
  // them at coastal zones are superseded -- the same graduation the Cooper made above.
  // They were already inert: resolveR2Key's registry pass runs first and THE REGISTRY SLUG
  // WINS, so the alias could not have answered for water lake_index.json offers. Checked
  // before regenerating rather than assumed, because a stale alias that CAN answer is a
  // lake loading the wrong water and this file has that failure recorded twice already.
  ['js/data/water-aliases.js', 'WATER_TO_R2_KEY', 130, 'alias',
   'the biggest of them and the least worrying: 130 water names mapped to R2 keys, which '
   + 'is exactly the job an alias table should have. GENERATED -- do not hand-edit; run '
   + 'Scripts/gen_water_aliases_js.py and update the count here.'],

  // ── the two the parser could not see until 2026-08-19 ─────────────────────────────────────
  //
  // Both are Set/Array literals, so `tablesIn` skipped them entirely. LAKE_NAMES_WITHOUT_PACK
  // went 6 -> 20 in one change with nothing here moving, which is what exposed the gap.
  //
  // NOT 'gate' -- and the distinction matters, because the gate test is a ratchet that treats
  // growth as a bug. This one is SUPPOSED to grow: a name enters when its water leaves the app
  // and leaves when a pack is built for it. It is part of the name-resolution surface, and it
  // exists because deleting a mapping does not stop a name answering, it re-points it.
  ['js/data/lake-keys.js', 'LAKE_NAMES_WITHOUT_PACK', 20, 'alias',
   'names refused before any matching runs. 13 of the 20 arrived 2026-08-19 with nine waters '
   + 'outside the region polygon; one more is North Fork Reservoir, which is inside it and was '
   + 'never charted by Garmin. lake-keys.test.js asserts every member resolves to null.'],
  // Also not a gate: a preset hiding water is the bug, and this is the list that catches it.
  // Ryan adding a home water here is the table doing its job, not a regression.
  ['js/data/water-filter.js', 'KEEP_ALWAYS', 11, 'data',
   'water that must never be hidden whatever a map preset says -- its own docstring calls it '
   + '"the test that a preset has not eaten the water the app exists for". The first cut of that '
   + 'filter hid Wittee and Ferry, the two lakes it was built for. Eleven of Ryan\'s home waters, '
   + 'and no registry field says "never hide this", so it is legitimately hand-written.'],
];

/**
 * Top-level keys of the object, array or Set literal that starts at `i`. Depth, not regex.
 *
 * IT USED TO OPEN ONLY ON `{`, and that made a whole SHAPE of table invisible. `tablesIn` matched
 * `= {`, so a per-water list written as `new Set([...])` or `[...]` was seen by neither the size
 * ledger nor the "a NEW table keyed by water names must be declared here" guard below -- the one
 * check whose entire job is noticing a new per-water table appearing.
 *
 * Found 2026-08-19 by growing one: LAKE_NAMES_WITHOUT_PACK went 6 -> 20 entries in a single
 * change and nothing here moved. Ninety-six UPPER_SNAKE Set/Array tables across Worker/ and js/
 * were invisible the same way, and one of them -- KEEP_ALWAYS in js/data/water-filter.js -- is a
 * hand-written list of eleven of Ryan's home waters the guard had never once looked at.
 *
 * A guard that cannot see a shape does not report that shape as unchecked. It reports nothing,
 * which reads exactly like a clean pass.
 */
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
  // '{' -> object: a depth-1 string FOLLOWED BY ':' is a key.
  // '[' -> array or Set: a depth-1 string IS an entry, and one followed by ':' is not -- that is
  //        an object nested in the array, whose keys belong to it rather than to this table.
  const isArray = src[i] === '[';
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
      if (d === 1 && ch !== '`') {
        const looksLikeKey = /^\s*:/.test(src.slice(close + 1));
        if (isArray ? !looksLikeKey : looksLikeKey) keys.push(src.slice(j + 1, close));
      }
      j = close;
    }
    else if (ch === '{' || ch === '[') d += 1;
    else if (ch === '}' || ch === ']') { d -= 1; if (d === 0) break; }
    else if (!isArray && d === 1 && /[A-Za-z_$]/.test(ch)) {
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
  // `= {`, `= [` and `= new Set([` -- see topLevelKeys for why the last two were missing.
  for (const m of src.matchAll(/(?:const|var|let)\s+([A-Z][A-Z0-9_]{3,})\s*=\s*(?:new Set\(\s*)?[{[]/g)) {
    const i = m.index + m[0].length - 1;
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
