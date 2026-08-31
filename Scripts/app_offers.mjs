/**
 * app_offers.mjs -- write the list of waters the PLANNER PICKER actually offers.
 *
 *     node Scripts/app_offers.mjs F:\TrollMapPipeline\registry
 *
 * Writes `<registry>/_app_offers.txt`, one slug per line, for `--only-lakes @...`.
 *
 * WHY THIS IS JAVASCRIPT IN A PYTHON PIPELINE
 *
 * Ryan, 2026-08-31: "we only need to do the lakes the app offers... nothing more, nothing less."
 *
 * Which waters those are is decided by ONE rule, `PRESETS.planner` in js/data/water-filter.js:
 * bathymetry is not 'no' AND there is somewhere to launch, minus the coastal zones, minus the six
 * rivers that have their own entries. Writing that rule again in Python would be a second
 * implementation of it, and this codebase has already paid for that twice this week -- four
 * copies of the ship test, one of them broken and matching nothing; two copies of getSeason(),
 * one of them a month behind.
 *
 * So it imports the app's own predicate and asks it. If the picker changes, this changes with it.
 *
 * The six PLAN_RIVERS slugs are appended because the picker lists them in their own optgroup --
 * they are water he can plan a day on and they need fitting like anything else.
 *
 * Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePredicate } from '../js/data/water-filter.js';

const registry = process.argv[2];
if (!registry) {
  console.error('usage: node Scripts/app_offers.mjs <registry dir>');
  process.exit(2);
}

const idxPath = join(registry, 'lake_index.json');
const raw = JSON.parse(readFileSync(idxPath, 'utf8'));
const rows = Array.isArray(raw) ? raw : (raw.lakes || raw.records || Object.values(raw));

// The same three exclusions populatePlanLakeDropdown() applies before the predicate.
const RIVER_SLUGS = ['wateree_river', 'congaree_river', 'saluda_river_lower_saluda',
                     'broad_river_2', 'santee_river', 'tail_race_canal'];
const isCoastal = (r) => r.feature_type === 'coastal' || String(r.slug || '').startsWith('coast_');

const keep = makePredicate('planner', rows);
const offered = new Set(RIVER_SLUGS);
let dropped = 0;
for (const r of rows) {
  if (!r || !r.slug) continue;
  if (isCoastal(r)) continue;
  if (keep(r, r.display_name || r.name || '')) offered.add(r.slug);
  else dropped += 1;
}

const out = [...offered].sort();
const dest = join(registry, '_app_offers.txt');
writeFileSync(dest, out.join('\n') + '\n');
console.log(`${out.length} water(s) the planner offers (${dropped} registry rows filtered out, `
          + `${RIVER_SLUGS.length} rivers added)`);
console.log(`wrote ${dest}`);

// AND THE WIDER LIST, BECAUSE THE NARROW ONE IS ABOUT TO GET WIDER.
//
// Ryan, 2026-08-31: "why is a ramp a show stopper for a kayak fisherman?" It is not. All 108 of
// the waters PRESETS.planner drops are dropped for having no ramp on record -- Randleman at 2,919
// acres among them, charted and shipped -- and a kayak launches where you can park. What the
// filter is standing in for is real (the planner needs a launch COORDINATE, and `ramps` is the
// only registry field that carries one) but the day that is solved, those 108 become plannable
// and their packs need to have been fitted.
//
// Fitting costs about a second a lake. Rebuilding a pack costs minutes. So the wide list is
// written too and the fit runs against it, and nothing has to be re-run later -- which is Ryan's
// own standing rule about not making him run the same thing twice.
const wide = rows.filter((r) => r && r.slug && !isCoastal(r)).map((r) => r.slug);
const all = [...new Set([...wide, ...RIVER_SLUGS])].sort();
const destAll = join(registry, '_app_registry.txt');
writeFileSync(destAll, all.join('\n') + '\n');
console.log(`${all.length} water(s) in the registry, coastal excluded`);
console.log(`wrote ${destAll}`);
