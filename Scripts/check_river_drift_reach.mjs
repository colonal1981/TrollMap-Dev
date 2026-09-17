#!/usr/bin/env node
// check_river_drift_reach.mjs — does each river's centreline actually REACH its own structure?
//
// Ryan, 2026-09-16, on a Congaree bench plan that came back with nothing: "its the routes just like
// i thought." It took a night to find that the water was fine and the OBJECT was wrong. This is the
// same failure shape, caught before it costs another night, on the rivers where it is already true.
//
// THE DRIFT GENERATOR JOINS STRUCTURE BY REAL GEOMETRIC DISTANCE, so a river whose centreline lies
// somewhere the structure is not produces drifts that pass nothing, every window scores zero, and
// selectCandidates() reports `scoreless`. That reads as "this water has nothing worth trolling" and
// it means "the centreline and the structure are in different places". Measured 2026-09-17:
//
//     south_yadkin_river     54 drifts, 0 with any structure, from 171 stamped features
//     pee_dee_river_2        84 drifts, 0 with any structure, from 104
//     nolichucky_river_2     63 drifts, 0 with any structure, from  17
//     congaree_river         96 drifts, 95 with structure, 3,334 hits, from 711
//
// The cause is not the join. `build_river_centrelines.py` records a per-river `snap_cap_m` and the
// bounding boxes simply do not overlap: south_yadkin's centreline runs -81.068 to -80.610 and its
// structure sits -80.594 to -80.394. The 3DHP mainstem thread and the contour-derived structure are
// built from different sources over different extents and NOTHING CHECKED THAT THEY MEET.
//
// A RECURRING QUESTION ASKED BY A PROGRAM MUST BE ANSWERED INSIDE THAT PROGRAM. There are 57 rivers
// and this question is asked of every one of them before it is worth researching or planning.
//
//     node Scripts\check_river_drift_reach.mjs --chartpack "F:\TrollMapPipeline\chartpack"
//     node Scripts\check_river_drift_reach.mjs --chartpack "F:\TrollMapPipeline\chartpack" --json
//     node Scripts\check_river_drift_reach.mjs --chartpack "F:\TrollMapPipeline\chartpack" --only congaree_river
//
// Exits 1 when any river reaches NONE of its structure, because a river in that state cannot be
// planned and a report that names a condition without acting on it reads as a decision.
//
// Personal use only, not for distribution or resale; not for navigation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// THIS FILE SHIPS TO TWO DIRECTORIES AND `../js` IS ONLY RIGHT IN ONE OF THEM. Same resolution
// lake_depth_stats.mjs uses, for the same reason and with the same failure it was written after:
// a static import resolves against THIS FILE, so the pipeline copy would look for
// F:\TrollMapPipeline\js\... and fail identically on every river.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEED = ['js/modules/river-drifts.js', 'js/modules/plan-candidates.js'];
const roots = [path.join(HERE, '..'), path.join(HERE, '..', 'TrollMap-Dev')];
const root = roots.find((r) => NEED.every((m) => fs.existsSync(path.join(r, m))));
if (!root) {
  console.error(`cannot find ${NEED.join(' and ')} -- looked under ${roots.join(' and ')}`);
  process.exit(2);
}
const { riverDriftRuns } = await import(pathToFileURL(path.join(root, NEED[0])).href);
const { structureIndex } = await import(pathToFileURL(path.join(root, NEED[1])).href);

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const CHARTPACK = arg('--chartpack');
const ONLY = arg('--only');
const AS_JSON = argv.includes('--json');
// The two numbers the app plans with, named here rather than re-guessed. maxOffM is the corridor
// half-width selectCandidates() uses and maxM is the longest leg it will cut; both are arguments so
// this can be re-run against whatever they become -- see the corridor-width question in
// FORTY_THREE_OF_FIFTY_SEVEN_RIVERS_HAVE_NO_SIDE_TO_PICK_2026-09-17.md.
const MAX_OFF_M = Number(arg('--max-off-m') || 100);
const MAX_M = Number(arg('--max-m') || 8000);

if (!CHARTPACK) {
  console.error('usage: check_river_drift_reach.mjs --chartpack <dir> [--only <slug>] [--json] '
              + '[--max-off-m 100] [--max-m 8000]');
  process.exit(2);
}
if (!fs.existsSync(CHARTPACK)) {
  console.error(`--chartpack does not exist: ${CHARTPACK}`);
  process.exit(2);
}

const readJson = (p) => {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return { _err: e.message }; }
};

const slugs = fs.readdirSync(CHARTPACK)
  .filter((d) => fs.existsSync(path.join(CHARTPACK, d, 'centreline.geojson')))
  .filter((d) => !ONLY || d === ONLY)
  .sort();

if (!slugs.length) {
  console.error(ONLY ? `no centreline.geojson under ${path.join(CHARTPACK, ONLY)}`
                     : `no river carries a centreline.geojson under ${CHARTPACK}`);
  process.exit(2);
}

// A LONG READ-ONLY RUN MUST SAY WHERE IT IS. 57 rivers, and the Waccamaw alone is 2,065 features.
const progress = !AS_JSON && process.stderr.isTTY;
const rows = [];
let n = 0;
for (const slug of slugs) {
  n++;
  if (progress) process.stderr.write(`\r  ${n}/${slugs.length}  ${slug}${' '.repeat(30)}`);
  const dir = path.join(CHARTPACK, slug);
  const cl = readJson(path.join(dir, 'centreline.geojson'));
  if (!cl || cl._err) { rows.push({ slug, error: cl ? cl._err : 'unreadable centreline' }); continue; }
  const st = readJson(path.join(dir, 'structure.geojson')) || { features: [] };
  const wf = readJson(path.join(dir, 'water_features.geojson')) || { features: [] };
  const feats = [...(st.features || []), ...(wf.features || [])];
  let drifts;
  try {
    drifts = riverDriftRuns(cl, { slug, structures: structureIndex(feats), maxOffM: MAX_OFF_M, maxM: MAX_M });
  } catch (e) { rows.push({ slug, error: e.message, features: feats.length }); continue; }
  const withNear = drifts.filter((d) => (d.properties.near || []).length).length;
  const hits = drifts.reduce((s, d) => s + (d.properties.near || []).length, 0);
  // THE STAMP'S OWN LIMIT, NOT AN INVENTED ONE. `snap_cap_m` is what the builder allowed itself; a
  // feature beyond it could not be placed, and `bend_side` is the one field that admits so.
  const cap = Number((cl.features?.[0]?.properties || {}).snap_cap_m);
  const offs = feats.map((f) => Math.abs(Number(f.properties && f.properties.off_m)))
                    .filter(Number.isFinite);
  const beyondCap = Number.isFinite(cap) ? offs.filter((o) => o > cap).length : null;
  rows.push({
    slug,
    features: feats.length,
    drifts: drifts.length,
    driftsWithStructure: withNear,
    hits,
    snapCapM: Number.isFinite(cap) ? cap : null,
    beyondCap,
    reaches: drifts.length ? withNear / drifts.length : 0,
  });
}
if (progress) process.stderr.write(`\r${' '.repeat(60)}\r`);

const dead = rows.filter((r) => !r.error && r.features > 0 && r.driftsWithStructure === 0);
const thin = rows.filter((r) => !r.error && r.driftsWithStructure > 0 && r.reaches < 0.25);
const broke = rows.filter((r) => r.error);

if (AS_JSON) {
  process.stdout.write(JSON.stringify({
    chartpack: CHARTPACK, maxOffM: MAX_OFF_M, maxM: MAX_M,
    rivers: rows.length, dead: dead.map((r) => r.slug), thin: thin.map((r) => r.slug), rows,
  }, null, 2));
  process.exit(dead.length ? 1 : 0);
}

console.log(`\n=== river drift reach, ${rows.length} rivers, corridor ${MAX_OFF_M} m, legs to ${MAX_M} m ===\n`);
console.log('river                             feats  drifts   with    hits   reach   beyond cap');
for (const r of rows.sort((a, b) => (a.reaches ?? 0) - (b.reaches ?? 0))) {
  if (r.error) { console.log(`${r.slug.padEnd(33)} ERROR  ${r.error}`); continue; }
  console.log(
    r.slug.padEnd(33),
    String(r.features).padStart(5),
    String(r.drifts).padStart(7),
    String(r.driftsWithStructure).padStart(6),
    String(r.hits).padStart(7),
    `${(100 * r.reaches).toFixed(0)}%`.padStart(7),
    (r.beyondCap == null ? '-' : `${r.beyondCap}/${r.features}`).padStart(12),
  );
}

if (broke.length) console.log(`\n  ${broke.length} river(s) could not be read`);
if (thin.length) {
  console.log(`\n  THIN — under a quarter of the drifts touch anything (${thin.length}):`);
  for (const r of thin) console.log(`    ${r.slug}  ${r.driftsWithStructure}/${r.drifts} drifts, ${r.hits} hits`);
}
if (dead.length) {
  console.log(`\n  NO REACH AT ALL — the centreline and the structure are in different places (${dead.length}):`);
  for (const r of dead) console.log(`    ${r.slug}  ${r.features} stamped features, ${r.drifts} drifts, ZERO touched`);
  console.log('\n  A river in this state plans to nothing and reports `scoreless`, which reads as');
  console.log('  "no water worth trolling" and means "the centreline is not where the structure is".');
  console.log('  Compare the two bounding boxes before researching or planning any of them.');
  process.exit(1);
}
console.log('\n  ok    every river\u2019s drifts reach some of its own structure');
