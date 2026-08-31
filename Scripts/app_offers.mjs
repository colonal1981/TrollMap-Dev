/**
 * app_offers.mjs -- write the slug list the pipeline scripts should be scoped to.
 *
 *     node Scripts/app_offers.mjs F:\TrollMapPipeline\registry
 *
 * Writes `<registry>/_app_registry.txt`, one slug per line, for `--only-lakes @...`.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * The first cut of this script imported `PRESETS.planner` from js/data/water-filter.js and wrote
 * a narrower list called `_app_offers.txt`, claiming to be "the waters the picker lists". It was
 * wrong, and wrong in a way that reads as authoritative.
 *
 * `PRESETS.planner` tests `hasRamp`, and hasRamp is a UNION of two sources:
 *
 *     hasRamp: liveLaunches(name) > 0 || has(rec.ramps) || has(rec.ramp_sources) || ...
 *
 * `liveLaunches` reads a source registered at runtime by setLiveAccessSource() -- the Worker's
 * live access index -- which exists precisely because the baked registry field goes stale. It
 * changes 67 rows, and the whole point of it is that the feed can only ADD water to a picker.
 *
 * A node script has no Worker, so liveAccessSource is null, liveLaunches() returns 0 for every
 * water, and the predicate silently degrades to the file alone. It then reported 108 waters as
 * "dropped for having no ramp" -- including Randleman Lake, which has two. Ryan: "Randleman lake
 * has 2 boat ramps... i swear to god i hate having these same conversations."
 *
 * He is right that we had already fixed it: setLiveAccessSource landed 2026-08-14 for this exact
 * class of mistake. Running the predicate blind put it straight back.
 *
 * So this script does not run the predicate at all. What the picker offers is a runtime question
 * and it is answered at runtime, in the browser, with the live feed attached. What this file
 * needs to know is much smaller and fully answerable offline: which slugs are in the registry the
 * app ships, so a pipeline pass is scoped to them and not to 1,709 pack directories.
 *
 * Coastal zones are excluded -- they have their own picker and no trolling runs -- and the six
 * PLAN_RIVERS slugs are added, because the planner lists them in their own optgroup.
 *
 * Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const registry = process.argv[2];
if (!registry) {
  console.error('usage: node Scripts/app_offers.mjs <registry dir>');
  process.exit(2);
}

const idxPath = join(registry, 'lake_index.json');
const raw = JSON.parse(readFileSync(idxPath, 'utf8'));
const rows = Array.isArray(raw) ? raw : (raw.lakes || raw.records || Object.values(raw));

const RIVER_SLUGS = ['wateree_river', 'congaree_river', 'saluda_river_lower_saluda',
                     'broad_river_2', 'santee_river', 'tail_race_canal'];
const isCoastal = (r) => r.feature_type === 'coastal' || String(r.slug || '').startsWith('coast_');

const inland = rows.filter((r) => r && r.slug && !isCoastal(r)).map((r) => r.slug);
const out = [...new Set([...inland, ...RIVER_SLUGS])].sort();

const dest = join(registry, '_app_registry.txt');
writeFileSync(dest, out.join('\n') + '\n');
console.log(`${rows.length} registry rows, ${rows.length - inland.length} coastal excluded, `
          + `${RIVER_SLUGS.length} rivers added`);
console.log(`${out.length} slug(s) -> ${dest}`);
console.log('NOTE: this is the registry, not the picker. What the picker lists depends on the '
          + 'live access feed and is only answerable in the browser.');
