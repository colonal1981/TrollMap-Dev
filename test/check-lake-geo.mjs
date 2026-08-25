/**
 * check-lake-geo.mjs — a name must map to a lake in the right PLACE.
 *
 *     node test/check-lake-geo.mjs                (or: npm run lint:geo)
 *     node test/check-lake-geo.mjs --self-test    prove the predicate still fires
 *
 * Written 2026-08-04. Names lied three times in one day and coordinates never did:
 *
 *   'Kerr Lake, NC'      -> w_kerr_scott_reservoir   1,280 ac instead of ~50,000
 *   'Lake Robinson, SC'  -> north_saluda_reservoir   160 miles away, wrong county
 *   'Lake Lanier, GA'    -> lake_lanier              an 85-acre pond in SOUTH CAROLINA,
 *                                                    against 38,293 ac in Hall Co, GA
 *
 * Every one of those passed name matching, and two passed name-plus-state.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT CHANGED, 2026-08-14, AND WHY IT TOOK THREE ASKS
 *
 * This lint used to get its coordinates from the 50 hand-placed centres in
 * `registry/curated_lakes.json`, and that dependency was the only reason that file still
 * existed. It was retired on 2026-08-24 -- the last of the three hardcoded water lists -- once
 * this lint no longer needed it and the index built without it lost nothing.
 * Ryan has tried to delete it three times. Each time the answer was "not until this lint is
 * repointed", and each time the repointing did not happen:
 *
 *   2026-08-06  "the centres have to move somewhere that survives ... before lakes.js goes"
 *   2026-08-12  "that lint has to be repointed at the registry's own centroids before the
 *                file goes. That is the last thread."
 *   2026-08-14  offered again, as a question, instead of being done
 *
 * Ryan: *"you have said this at least 3 times in the past when i have tried to get rid of
 * currated lakes and then somehow it still remains lol"*
 *
 * The two standing notes also contradicted each other, which is part of why nothing moved:
 * 08-12 said repoint it at the registry's own centroids, and DELETION_TAB said a lint that
 * checks the registry against the registry proves nothing. DELETION_TAB is right, and that
 * ruled out the only replacement anyone had named — so the thread stayed uncut.
 *
 * AND THE CENTRES WERE NEVER GOOD. Measured 2026-08-14: they are a median 6.91 km from the
 * 3DHP centroids, 28 of 45 over 5 km; the ramps in the same file carry three decimal places or
 * fewer 55% of the time against 2% for agency data. They were typed, not surveyed. They also
 * only ever covered 50 of 457 registry rows — 11% — under a bbox-containment test that a
 * plausible invented centre passes without effort.
 *
 * THE ORACLE THAT ACTUALLY WORKS was sitting in the pipeline the whole time.
 *
 * `registry/_dnr/ramps_*.json` holds every boat ramp the four state agencies publish, keyed by
 * THEIR waterbody name, surveyed to five and six decimal places, produced by people who have
 * never heard of this registry. That is genuinely independent of 3DHP geometry in a way a
 * registry centroid can never be, and it covers 344 waterbody names rather than 50.
 *
 * The test is unchanged in spirit and stronger in fact: if a name resolves to a slug, the ramps
 * the agencies file under that same name must land inside that slug's bounds. Kerr Lake fails
 * it for the same reason it failed in 2026-08-04 — NCWRC's ramps sit on the 50,000-acre
 * reservoir at the Virginia line, and `w_kerr_scott_reservoir` is 200 km west.
 *
 * Containment, not distance, for the reason it always was: distance needs a threshold and a
 * threshold has to be loose enough for a 67,891-acre reservoir. A margin is allowed because a
 * ramp sits on the BANK, outside the water polygon by definition.
 *
 * NOTHING HERE READS curated_lakes.json. That file can be deleted without touching this lint.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Exits 1 on any mismatch, and exits 1 on a run that checked nothing — see the bottom.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveR2Key } from '../js/data/lake-keys.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REG = resolve(ROOT, '..', 'registry');
const SELF_TEST = process.argv.includes('--self-test');

const INDEX = join(REG, 'lake_index.json');
if (!existsSync(INDEX)) {
  console.log('\nlake geo — registry/lake_index.json not beside this checkout, skipped\n');
  process.exit(0);
}
const idx = JSON.parse(readFileSync(INDEX, 'utf8'));

const DNR = join(REG, '_dnr');
if (!existsSync(DNR)) {
  console.log('\nlake geo — registry/_dnr not beside this checkout, skipped\n');
  process.exit(0);
}

// ── The agencies' own answer: waterbody name -> surveyed ramp positions ──────────────────────
//
// Read straight from the feed dumps rather than from `dnr_ramps_by_lake.json`, deliberately.
// That file is the OUTPUT of binding these names to registry slugs, so testing against it would
// be testing the bind against itself — the registry-against-the-registry problem one level over.
// The raw feeds have never seen a slug.
const feeds = new Map();          // waterbody name -> [{lat, lon, name, state}]
let feedFiles = 0;
for (const fn of readdirSync(DNR)) {
  if (!/^ramps_[a-z]{2}\.json$/.test(fn)) continue;
  let doc;
  try { doc = JSON.parse(readFileSync(join(DNR, fn), 'utf8')); } catch { continue; }
  const st = (doc.state || fn.slice(6, 8)).toUpperCase();
  feedFiles++;
  for (const [wb, items] of Object.entries(doc.waterbodies || {})) {
    for (const it of items || []) {
      const lat = Number(it.lat), lon = Number(it.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (!feeds.has(wb)) feeds.set(wb, []);
      feeds.get(wb).push({ lat, lon, name: it.name, state: st });
    }
  }
}
if (!feedFiles) {
  console.log('\nlake geo — registry/_dnr holds no ramps_*.json, skipped\n');
  process.exit(0);
}

// ── The resolver under test is the APP'S, not one written here. ─────────────────────────────
//
// The first cut of this rewrite built its own name index over the registry and tested THAT.
// It reported 24 failures and most of them were manufactured: a state-blind index happily
// mapped Georgia's "Lake Beaver" onto Beaver Lake in Buncombe County NC, 478 km away, which
// `resolveR2Key` would never do. A lint that invents its own resolver is testing itself.
//
// So the question this asks is the one that matters: hand the app's resolver the string the
// app would build for an agency waterbody, and check the answer against coordinates the agency
// surveyed. `displayLakeName()` in access-index.js is what turns "BROAD RIVER" + "NC" into
// "BROAD RIVER, NC", so that shape is reproduced here -- the app never asks resolveR2Key a bare
// waterbody name.
const displayLakeName = (raw, st) => {
  const name = String(raw || '').replace(/\s+/g, ' ')
    .replace(/\b(reservoir|lake)\s+lake\b/ig, 'Lake').trim();
  if (!name || /^unknown/i.test(name)) return '';
  return /\b(SC|NC|GA|TN|AL|VA)\b/.test(name) ? name : `${name}, ${st}`;
};

/**
 * The predicate, isolated so --self-test can run known-bad mappings through the real thing.
 * Returns {inside, outside, worstKm} for a waterbody's ramps against a slug's bounds.
 *
 * MARGIN, because a ramp sits on the bank. 0.01 deg is roughly 1.1 km — generous, and it has
 * to be: this fires on 200 km errors, not on 800 m ones, and a false alarm on a lint nobody
 * can silence is how a lint gets deleted.
 */
function judge(slug, pts, marginDeg = 0.01) {
  const b = (idx[slug] || {}).bounds_wsen;
  if (!Array.isArray(b) || b.length !== 4) return null;
  const [w, s, e, n] = b;
  let inside = 0, outside = 0, worst = 0;
  for (const p of pts) {
    const dLon = Math.max(0, w - marginDeg - p.lon, p.lon - e - marginDeg);
    const dLat = Math.max(0, s - marginDeg - p.lat, p.lat - n - marginDeg);
    const out = Math.hypot(dLon, dLat);
    if (out <= 0) inside++; else { outside++; worst = Math.max(worst, out); }
  }
  return { inside, outside, worstKm: worst * 111 };
}

if (SELF_TEST) {
  // A LINT THAT CANNOT FAIL IS NOT A LINT, and this file has twice been exactly that: once
  // importing a module that had been deleted, once reading the curated JSON one level too high
  // and printing "0 curated centres checked ... ok". Both times every assertion held vacuously.
  //
  // So: drive the real predicate with the three historical failures. If the feeds ever stop
  // carrying the names these depend on, this says so instead of going quiet.
  const CASES = [
    ['KERR LAKE', 'w_kerr_scott_reservoir', 'the 1,280 ac namesake 200 km west'],
    ['Lake Robinson', 'north_saluda_reservoir', '160 miles away, wrong county'],
    ['Lake Lanier', 'lake_lanier', 'an 85-acre pond in South Carolina'],
  ];
  let fails = 0, ran = 0;
  console.log('\nlake geo --self-test — the predicate against the three names that lied\n');
  for (const [wb, badSlug, why] of CASES) {
    const norm = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const hit = [...feeds.entries()].find(([k]) => norm(k) === norm(wb));
    if (!hit) { console.log(`  skip  no feed carries "${wb}"`); continue; }
    if (!idx[badSlug]) { console.log(`  skip  ${badSlug} is not in the index any more`); continue; }
    const v = judge(badSlug, hit[1]);
    ran++;
    const fires = v && v.inside === 0;
    console.log(`  ${fires ? 'ok  ' : 'FAIL'}  ${wb} -> ${badSlug}: `
      + `${v.inside} of ${v.inside + v.outside} ramps inside, worst ${Math.round(v.worstKm)} km out  (${why})`);
    if (!fires) fails++;
  }
  if (!ran) {
    console.error('\n  FAIL  no self-test case could run. The predicate is unproven.\n');
    process.exit(1);
  }
  console.log(fails ? `\n  ${fails} case(s) no longer detected\n` : '\n  ok    every historical failure still detected\n');
  process.exit(fails ? 1 : 0);
}


/**
 * KNOWN WRONG MAPPINGS AS OF 2026-08-14 — DEBT, NOT PERMISSION.
 *
 * Repointing this lint at agency coordinates immediately found 24 names `resolveR2Key` sends to
 * the wrong water. They are real and some are serious: Old Hickory Reservoir in Tennessee, with
 * 38 TWRA ramps on it, resolves to Lake Hickory in Catawba County NC, 580 km away. That is the
 * exact Kerr Lake failure this lint was written for in 2026-08-04, live and unnoticed since,
 * because the 50 hand-placed centres could not see a mapping they were not one of.
 *
 * They are listed rather than fixed because fixing them means changing `lake-keys.js`'s fuzzy
 * passes, which DELETION_TAB already has queued for deletion on their own merits ("5
 * bidirectional substring matchers ... a short name claims any longer one containing it") and
 * which are not something to start rewriting inside a lint change.
 *
 * SHRANK FROM 24 TO 14 THE SAME DAY, and that is the list working. Pass 4 in lake-keys.js
 * gained a state guard -- it already refused to match flowing water to standing water, and now
 * refuses to match a Tennessee name to a North Carolina lake. Ten went, including every one
 * that mattered: Old Hickory Reservoir and its 38 TWRA ramps, both Normandys, Great Falls TN,
 * Lake Cherokee SC.
 *
 * The 13 left are a different defect and want a different fix. They are Pass 3.5 -- the coastal
 * pointers generated into water-aliases.js -- filing small Georgia creeks onto 340,000-acre
 * coastal zones. Same state, so the state guard cannot see them; they are wrong DATA in a
 * generated table, not a wrong RULE.
 *
 * IT WAS 14 UNTIL 2026-08-25, and the fourteenth is why this list reports its own stale rows.
 * `Waccamaw River|coast_brunswick_nc` was filed here as same-state and is not: the river is SC
 * and Brunswick County is NC. The state guard kills it, and it only looked like Pass 3.5 debt
 * because the guard was not running when this list was written down. An allowance that cannot
 * report its own dead rows becomes the bug's hiding place.
 *
 * THIS LIST MAY ONLY EVER SHRINK. A new pair fails the run. A pair that stops firing is
 * reported so it gets deleted from here rather than quietly padding the allowance. That is the
 * whole difference between a baseline and an excuse, and the reason this is dated in the name.
 */
const KNOWN_2026_08_14 = new Set([
  'Clarks Creek|coast_murrells_inlet_sc',
  'Ebenezer Creek|coast_savannah_ga',
  'Gunters Lake|coast_murrells_inlet_sc',
  'HYCO LAKE|hyco_lake',
  'Holbrook Pond|coast_ossabaw_st_catherines_ga',
  'Jones Creek|coast_ossabaw_st_catherines_ga',
  'Louis Scott Stell Lake|coast_savannah_ga',
  'New River|coast_topsail_new_river_nc',
  'Riceboro Creek|coast_ossabaw_st_catherines_ga',
  'Richmond Hill Pond, West|coast_ossabaw_st_catherines_ga',
  'South Newport River|coast_ossabaw_st_catherines_ga',
  'Tybee Creek|coast_savannah_ga',
  'Wacammaw River|coast_murrells_inlet_sc',
]);

// ── The run ──────────────────────────────────────────────────────────────────────────────────
const problems = [];
const known = [];
const marginal = [];
const stillKnown = new Set();
let checked = 0, unmatched = 0, noBounds = 0;

for (const [wb, pts] of feeds) {
  const asked = displayLakeName(wb, pts[0].state);
  const slug = asked ? resolveR2Key(asked) : null;
  if (!slug || !idx[slug]) { unmatched++; continue; }
  const v = judge(slug, pts);
  if (!v) { noBounds++; continue; }
  checked++;
  const rec = idx[slug];
  // EVERY ramp outside is the alarm. Some outside is normal and is what the per-point rule in
  // the binder exists for -- a river's name spans two registry rows, a reservoir's name covers
  // an arm the boundary does not reach. A name whose agency ramps are ALL somewhere else is a
  // name pointing at the wrong water.
  if (v.inside === 0 && v.outside > 0) {
    const pair = `${wb}|${slug}`;
    const line = `${wb} (${pts[0].state})\n      -> ${slug}  (${rec.display_name}, ${Math.round(rec.area_acres || 0)} ac)\n` +
      `      all ${v.outside} agency ramp(s) fall outside it, the furthest by ${Math.round(v.worstKm)} km`;
    if (KNOWN_2026_08_14.has(pair)) { stillKnown.add(pair); known.push(line); }
    else problems.push(line);
  } else if (v.outside > v.inside) {
    marginal.push(`${wb} -> ${slug}: ${v.outside} of ${v.inside + v.outside} ramps outside, worst ${Math.round(v.worstKm)} km`);
  }
}

console.log(`\nlake geo — ${checked} agency waterbody names checked against the lake they resolve to`);
console.log(`  source: registry/_dnr/ramps_*.json, ${feeds.size} names, surveyed by four state agencies`);
if (unmatched) console.log(`  note: ${unmatched} agency name(s) resolve to nothing — out of region, or an alias gap`);
if (noBounds) console.log(`  note: ${noBounds} mapped lake(s) carry no bounds in the index`);
for (const m of marginal.slice(0, 12)) console.log(`  note: ${m}`);
if (marginal.length > 12) console.log(`  note: ... ${marginal.length - 12} more partial`);

// The debt, printed every run. A baseline nobody sees is a baseline that grows.
if (known.length) {
  console.log(`\n  ${known.length} KNOWN wrong mapping(s) from 2026-08-14 — debt, see KNOWN_2026_08_14:`);
  for (const k of known) console.log(`    ${k.split('\n')[0]} ${k.split('\n')[1].trim()}`);
}
const fixed = [...KNOWN_2026_08_14].filter((p) => !stillKnown.has(p));
if (fixed.length) {
  console.log(`\n  ${fixed.length} known mapping(s) no longer fire — DELETE THEM from`);
  console.log('  KNOWN_2026_08_14 so the allowance shrinks with the bugs:');
  for (const f of fixed) console.log(`    ${f}`);
}
if (problems.length) {
  console.error('');
  for (const p of problems) console.error(`  FAIL  ${p}`);
  console.error(`\n${problems.length} name(s) map to a lake in the wrong place\n`);
  process.exit(1);
}
// A run that checked NOTHING is a failure, not a pass.
//
// On 2026-08-06 this printed "0 curated centres checked" followed by "ok", because the source
// file had been re-shaped and the reader was looking one level too high. Every assertion held
// vacuously. A lint whose only failure mode is "I found something wrong" cannot tell you that
// it stopped looking — and this one exists to catch `Lake Lanier -> an 85-acre SC pond`.
if (!checked) {
  console.error('\n  FAIL  0 waterbody names were checked.\n'
              + '        The feeds parsed but nothing resolved to a registry row, so every\n'
              + '        check below passed by not running. Look at registry/_dnr/ramps_*.json\n'
              + '        and at the name keys above before trusting this lint.\n');
  process.exit(1);
}
console.log(`  ok    no NEW wrong mapping; ${known.length} known from 2026-08-14 still outstanding\n`);
