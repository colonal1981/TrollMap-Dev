// audit_pool_binds.mjs -- bindings that disagree with the water they are filed under.
//
// Personal use only, not for distribution or resale; not for navigation.
//
//     node .\Scripts\audit_pool_binds.mjs --registry "F:\TrollMapPipeline\registry"
//     node .\Scripts\audit_pool_binds.mjs --registry "F:\TrollMapPipeline\registry" --json out.json
//
// WHY THIS EXISTS
//
// `pool` is the gauge every level, flow and go/no-go answer comes off. It is bound offline by
// build_water_bindings.py, name first with geometry as a guard, and a bad bind is invisible
// afterwards: the card shows a stage and a flow, they are real numbers, and they are about
// another river.
//
// Found 2026-09-23 while reading why the Broad River came back with four species:
//
//     broad_river_2   "Broad River (2) (Union Co, SC)"   pool: "Enoree River near Woodruff"
//
// The Enoree is a TRIBUTARY of the Broad, gauged in Spartanburg County, and the water is Union
// County. `confidence: name+geom` and `km_outside: 0`, so both halves of the bind agreed.
//
// IT COMPARES THE WHOLE GAUGE NAME, NOT ITS RIVER PART, AND THAT IS THE WHOLE DESIGN.
//
// `gaugeRiverPart()` cuts a gauge name at its locative -- "Santee River near Eloree at Lake
// Marion" -> "Santee River" -- which is right for basin matching and wrong here. A reservoir is
// correctly gauged on the river that feeds it, and its OWN name lives in the half that gets cut.
// Comparing river parts flagged 63 of 139 bindings, 54 of them lakes that are bound correctly.
// Against the whole name it is 16.
//
// IT IS A REVIEW LIST, NOT A DEFECT LIST. A dam gauge legitimately shares no word with its lake
// -- Davy Crockett Lake is gauged at Nolichucky Dam, Lake Rabun at MATHIS-TERRORA DAM -- and
// those are right. What the list does is put the sixteen worth a human glance in front of one,
// with the confidence and the distance the binder recorded, instead of none.
//
// WHAT WAS TRIED AND THROWN AWAY, so it is not rebuilt. A second check -- "this gauge shares no
// word with the water it is filed under, but DOES match some other water the registry knows" --
// looked like the sharper question and is unusable. Over every gauge it returns 220 rows;
// restricted to `pool` and `tailwater`, and requiring the other water to match EVERY token of the
// gauge's river part, still 49 -- and almost all of them correct, because a reservoir's pool gauge
// is on the river that feeds it and that river is usually its own row. "Lake Norman <- Catawba
// River at Lake Norman/Cowans Ford Dam, is: catawba_river" is a right answer dressed as a finding.
// Weak tokens make it worse: "SOUTH TYGER RIVER" matches south_yadkin_river on `south`, "Little
// Tennessee" matches little_pee_dee_river on `little`. Name tokens cannot separate "gauged on its
// feeder" from "bound to the wrong water". The check above can, because sharing nothing with its
// water ANYWHERE in the name is the narrow case.
//
// Imports the app's own tokeniser rather than restating it: waterBasinEvidence() is what
// dukeBasinFor() matches basins with, including the stopword list that stops "river" and "creek"
// agreeing with everything.
import fs from 'node:fs';
import path from 'node:path';
import { waterBasinEvidence } from '../Worker/conditions.js';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const REG = arg('--registry', 'F:\\TrollMapPipeline\\registry');
const OUT = arg('--json', '');

const file = path.join(REG, 'water_bindings.json');
if (!fs.existsSync(file)) {
  console.error(`no water_bindings.json at ${file}`);
  process.exit(2);
}
const bindings = JSON.parse(fs.readFileSync(file, 'utf8')).bindings || {};

let withPool = 0;
const rows = [];
for (const [slug, v] of Object.entries(bindings)) {
  const pool = v && v.pool;
  if (!pool || !pool.name) continue;
  withPool++;
  const want = waterBasinEvidence(v.display_name || slug);
  const have = waterBasinEvidence(pool.name);
  // NO EVIDENCE IS NOT A MISMATCH. A water whose whole name is stopwords, or a gauge named only
  // for a road, gives an empty set; saying those disagree would be asserting something neither
  // name supports.
  if (!want.size || !have.size) continue;
  if ([...have].some((t) => want.has(t))) continue;
  rows.push({
    slug,
    feature_type: v.feature_type || null,
    water: v.display_name || slug,
    gauge: pool.name,
    lid: pool.lid || null,
    usgs_site: pool.usgs_site || null,
    confidence: pool.confidence || null,
    km_outside: pool.km_outside ?? null,
  });
}
rows.sort((a, b) => String(a.feature_type).localeCompare(String(b.feature_type))
                 || a.slug.localeCompare(b.slug));

console.log(`bindings with a pool gauge: ${withPool}`);
console.log(`pool gauge shares no word with its water: ${rows.length}\n`);
for (const r of rows) {
  console.log(`  ${String(r.feature_type).padEnd(8)} ${r.slug.padEnd(28)} `
    + `${r.water.slice(0, 38).padEnd(39)}<- ${r.gauge.slice(0, 44).padEnd(45)}`
    + ` [${r.confidence}${r.km_outside != null ? ` ${r.km_outside}km` : ''}]`);
}
// ── SECOND CHECK: the row's STATE against the states of its own gauges ─────────────────────
//
// Ryan, 2026-09-23: *"there is no Broad River in Cherokee County, North Carolina... the Broad
// River originates in the Blue Ridge Mountains of North Carolina and flows southward into
// Cherokee County, South Carolina."* The index row reads `Broad River (Cherokee Co, NC)`,
// `county: Cherokee`, `state: NC`. The county is South Carolina's. The picker, which offers it as
// "Broad River, SC", was the half that was right.
//
// So county and state in these rows come from different places and can disagree, and nothing
// checked. This does, WITHOUT a county database: USGS and NWPS stamp their own gauges with a
// state, so a row whose state appears in NONE of its gauges' states is asserting a state its own
// measurements do not support. Seven of 207:
//
//     chattooga_river       SC / Rabun      gauges GA x4     Rabun is Georgia
//     chatuge_lake          GA / Towns      gauges NC x4
//     lake_wylie            NC / York       gauges SC x2     York is South Carolina
//     savannah_river        GA / Aiken      gauges SC x2     Aiken is South Carolina
//     south_fork_new_river  NC / Grayson    gauges VA x1     Grayson is Virginia
//     tugaloo_lake          SC / Rabun      gauges GA x2
//     yonah_lake            SC / Habersham  gauges GA x3     Habersham is Georgia
//
// IT CANNOT CATCH A BORDER WATER, and that is worth saying because the case that started this is
// one. `broad_river` is gauged on both sides -- Blacksburg SC and Oak Grove NC -- so its stated
// NC is among its gauges' states and it passes. The rows this finds are the ones where every
// measurement is in one state and the row names another; a river that genuinely runs the line
// needs a human, which is what Ryan just did.
function stateDisagreements(bindings, index) {
  const out = [];
  for (const [slug, v] of Object.entries(bindings)) {
    const row = index[slug];
    const stated = row && row.state;
    if (!stated) continue;
    const seen = new Map();
    for (const g of [v.pool, v.tailwater, ...(v.gauges || [])]) {
      if (!g) continue;
      const add = (st) => { if (st) seen.set(st, (seen.get(st) || 0) + 1); };
      add(g.state);
      const m = /,\s*([A-Z]{2})\.?\s*$/.exec(String(g.name || '').trim());
      if (m) add(m[1]);
    }
    if (!seen.size || seen.has(stated)) continue;
    out.push({ slug, stated, county: (row && row.county) || null,
               gauge_states: Object.fromEntries(seen), pool: (v.pool && v.pool.name) || null });
  }
  return out;
}

const indexFile = path.join(REG, 'lake_index.json');
const stateRows = fs.existsSync(indexFile)
  ? stateDisagreements(bindings, JSON.parse(fs.readFileSync(indexFile, 'utf8')))
  : [];
console.log(`\nrows whose state appears in none of their own gauges' states: ${stateRows.length}\n`);
for (const r of stateRows.sort((a, b) => a.slug.localeCompare(b.slug))) {
  console.log(`  ${r.slug.padEnd(26)} index=${r.stated}  county=${String(r.county).padEnd(12)}`
    + ` gauges=${JSON.stringify(r.gauge_states).padEnd(14)} pool=${String(r.pool).slice(0, 40)}`);
}

if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString().slice(0, 10),
                                         bindings_with_pool: withPool, rows,
                                         state_disagreements: stateRows }, null, 2));
  console.log(`\n-> ${OUT}`);
}
process.exit(0);
