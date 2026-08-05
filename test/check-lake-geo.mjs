/**
 * check-lake-geo.mjs — a curated name must map to a lake in the right PLACE.
 *
 *     node test/check-lake-geo.mjs        (or: npm run lint:geo)
 *
 * Written 2026-08-04. Names lied three times in one day and coordinates never did:
 *
 *   'Kerr Lake, NC'      -> w_kerr_scott_reservoir   1,280 ac instead of ~50,000
 *   'Lake Robinson, SC'  -> north_saluda_reservoir   160 miles away, wrong county
 *   'Lake Lanier, GA'    -> lake_lanier              an 85-acre pond in SOUTH CAROLINA,
 *                                                    against 38,293 ac in Hall Co, GA
 *
 * Every one of those passed name matching, and two passed name-plus-state. LAKE_DB
 * carries a hand-placed centre for 50 curated lakes — Ryan's own coordinates — and
 * that is a fact about geography no amount of string similarity can contradict.
 *
 * The test is containment, not distance: the centre must fall inside the mapped
 * lake's own bounding box. Distance needs a threshold, and a threshold has to be
 * loose enough for a 67,891-acre reservoir like Thurmond, where the hand-picked
 * centre sits 0.257 deg from the computed centroid and is still perfectly correct.
 * Containment is exact and scales itself.
 *
 * Exits 1 on any mismatch.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveR2Key } from '../js/data/lake-keys.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = resolve(ROOT, '..', 'registry', 'lake_index.json');
if (!existsSync(INDEX)) {
  console.log('\nlake geo — registry/lake_index.json not beside this checkout, skipped\n');
  process.exit(0);
}
const idx = JSON.parse(readFileSync(INDEX, 'utf8'));

// The 50 hand-placed centres used to come from `js/data/lakes.js`, which was deleted on
// 2026-08-04 with its data moved verbatim to registry/curated_lakes.json. This file kept
// importing the deleted module, so `npm run lint` has been dying on ERR_MODULE_NOT_FOUND on a
// clean checkout ever since -- which also means the geo check that exists to catch
// `Lake Lanier -> an 85-acre SC pond` has not run since the day it was written.
//
// It reads the JSON directly now, and REFUSES AN EMPTY FILE rather than passing. A curated
// file that lost its contents would otherwise make this lint succeed trivially, which is the
// exact shape of failure it exists to catch.
const CURATED = resolve(ROOT, '..', 'registry', 'curated_lakes.json');
if (!existsSync(CURATED)) {
  console.log('\nlake geo — registry/curated_lakes.json not beside this checkout, skipped\n');
  process.exit(0);
}
const curatedRaw = JSON.parse(readFileSync(CURATED, 'utf8'));
// The entries live under `lakes`. The file also carries `_README` and `_note_coastal`, and
// reading the whole document instead iterates those three string keys, finds no `center` on
// any of them, and reports "0 curated centres checked" as a PASS. Same accessor order as
// consolidate_lake_index.py:305, so the two cannot disagree about where the data is.
const LAKE_DB = (curatedRaw && (curatedRaw.lakes || curatedRaw.lake_db)) || curatedRaw;
if (!LAKE_DB || typeof LAKE_DB !== 'object' || !Object.keys(LAKE_DB).length) {
  console.error('\nlake geo — registry/curated_lakes.json is empty or unreadable.\n'
              + 'That is a failure, not a skip: this lint is the only thing checking that a\n'
              + 'curated name maps to a lake in the right PLACE.\n');
  process.exit(1);
}

const problems = [];
let checked = 0, unresolved = 0, noBounds = 0;
const marginal = [];

for (const [name, v] of Object.entries(LAKE_DB)) {
  if (!Array.isArray(v.center) || v.center.length < 2) continue;
  const [lat, lon] = v.center;
  const slug = resolveR2Key(name);
  if (!slug) { unresolved++; continue; }
  const rec = idx[slug];
  if (!rec) { problems.push(`${name}\n      -> ${slug} — NOT IN lake_index.json`); continue; }
  const b = rec.bounds_wsen;
  if (!Array.isArray(b) || b.length !== 4) { noBounds++; continue; }
  const [w, s, e, n] = b;
  checked++;
  // How far outside its own box the centre falls, measured against the box's own
  // size. A hand-placed centre can sit on a ramp just off the water, or be rounded
  // to two decimals — Lake Oconee's is 0.04 deg south of a lake 0.32 deg tall, which
  // is the same lake with an imprecise pin. Lake Lanier's was 1.96 deg from an
  // 85-acre pond, which is a different lake in a different state.
  //
  // Scaling by the lake's own diagonal separates those without a tuned constant, and
  // without letting a big lake hide a big error: Thurmond is 67,891 acres and its
  // centre still lands inside its box.
  const outLon = Math.max(0, w - lon, lon - e);
  const outLat = Math.max(0, s - lat, lat - n);
  const out = Math.hypot(outLon, outLat);
  const diag = Math.hypot(e - w, n - s) || 0.01;
  if (out > diag) {
    problems.push(
      `${name}\n      -> ${slug}  (${rec.display_name}, ${Math.round(rec.area_acres || 0)} ac)\n` +
      `      centre ${lat},${lon} falls ${out.toFixed(2)} deg outside a lake only ${diag.toFixed(2)} deg across`);
  } else if (out > 0) {
    marginal.push(`${name} -> ${slug}: centre ${out.toFixed(3)} deg outside a ${diag.toFixed(2)} deg box`);
  }
}

console.log(`\nlake geo — ${checked} curated centres checked against their mapped lake's bounds`);
if (unresolved) console.log(`  note: ${unresolved} curated name(s) resolve to nothing (refused or unbuilt)`);
if (noBounds) console.log(`  note: ${noBounds} mapped lake(s) carry no bounds in the index`);
for (const m of marginal) console.log(`  note: ${m}`);
if (problems.length) {
  console.error('');
  for (const p of problems) console.error(`  FAIL  ${p}`);
  console.error(`\n${problems.length} name(s) map to a lake in the wrong place\n`);
  process.exit(1);
}
// A run that checked NOTHING is a failure, not a pass.
//
// On 2026-08-06 this printed "0 curated centres checked" followed by "ok", because the curated
// file had been re-shaped and the reader was looking one level too high. Every assertion below
// held vacuously. A lint whose only failure mode is "I found something wrong" cannot tell you
// it stopped looking -- and this one exists to catch `Lake Lanier -> an 85-acre SC pond`.
if (!checked) {
  console.error('\n  FAIL  0 curated centres were checked.\n'
              + '        The curated file parsed but yielded no usable {center: [lat, lon]}\n'
              + '        entries, so every check below passed by not running. Look at the\n'
              + '        shape of registry/curated_lakes.json before trusting this lint.\n');
  process.exit(1);
}
console.log('  ok    every curated name maps to a lake containing its own centre\n');
