/**
 * registry_smoke.mjs -- run the REAL lake_index.json through the REAL lake-registry.js and
 * exercise every consumer path the refactor created.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 *   node registry_smoke.mjs <lake_index.json> <candidate js tree>
 *
 * WHY: `node --check` proves the file parses, undef_check proves every name exists,
 * import_check proves every import resolves. None of the three prove the thing RETURNS
 * anything. The default-filter bug -- shippedOnly hiding two lakes Ryan fishes -- passed all
 * the static checks and was only caught by asking the loaded registry for those two names.
 *
 * The only thing stubbed is `fetch`. Everything else is the shipped module.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const _here = new URL('.', import.meta.url).pathname;
const _repo = _here.replace(/\/test\/$/, '/');
const [indexPath = process.env.LAKE_INDEX || _repo + '../registry/lake_index.json',
       treeRoot  = _repo + 'js'] = process.argv.slice(2);
const SMOKE_NAME = 'registry_smoke';
// The registry is a pipeline OUTPUT, not a repo file -- it sits next to the checkout on the
// machine that runs the extraction. Anywhere else (a fresh clone, CI, a review sandbox)
// `npm run check` used to die on a bare ENOENT stack trace, which reads as "the test suite
// is broken" rather than "this check needs an artifact you do not have".
//
// Skipping is only correct for a MISSING file. A registry that exists and will not parse is
// a real failure and still throws.
import { existsSync } from 'node:fs';
if (!existsSync(indexPath)) {
  console.log(`SKIP  ${SMOKE_NAME}: no lake_index.json at ${indexPath}`);
  console.log('      This check needs the pipeline registry. Point LAKE_INDEX at it, or pass');
  console.log('      the path as the first argument, to run it.');
  process.exit(0);
}

const raw = JSON.parse(readFileSync(indexPath, 'utf8'));

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => raw });
globalThis.window = globalThis;

const reg = await import(pathToFileURL(`${treeRoot}/data/lake-registry.js`).href);
const R = await reg.loadLakeRegistry();

let fails = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`); }
  else { console.log(`  FAIL  ${name}  ${detail}`); fails++; }
};

console.log(`registry: ${R.list.length} records, ${R.bySlug.size} slugs, ${R.byName.size} names`);
const stats = reg.registryStats();
console.log(`stats: ${JSON.stringify(stats)}\n`);

console.log('-- lakeRecordFor: slug / display name / loose name / junk --');
check('by slug', !!reg.lakeRecordFor('kentucky_lake'), reg.lakeRecordFor('kentucky_lake')?.displayName);
const wat = reg.lakeRecordFor('Wateree');
check('loose name "Wateree"', !!wat, wat && `${wat.displayName} ${wat.areaAcres} ac charted=${wat.charted}`);
check('exact display name', !!reg.lakeRecordFor(wat?.displayName || ''), wat?.displayName);
check('junk returns null, does not guess', reg.lakeRecordFor('Absolutely Not A Lake 12345') === null);
check('empty string returns null', reg.lakeRecordFor('') === null);
check('non-string returns null', reg.lakeRecordFor(null) === null);

console.log('\n-- lakeDbEntryFor: the LAKE_DB-shaped view plan-builder/smart-plan/utility-sync read --');
const e = reg.lakeDbEntryFor('Wateree');
check('entry returned', !!e);
check('center is [lat,lon,zoom] finite', !!e && [e.center[0], e.center[1], e.center[2]].every(Number.isFinite),
  e && JSON.stringify(e.center));
check('center lat/lon not swapped (SE US: lat 30..37, lon -85..-75)',
  !!e && e.center[0] > 30 && e.center[0] < 37 && e.center[1] > -85 && e.center[1] < -75);
check('bounds is [[s,w],[n,e]] or null', !e?.bounds || (e.bounds[0][0] < e.bounds[1][0]),
  e && JSON.stringify(e.bounds));
check('ramps is a plain object of name -> [lat,lon]',
  !!e && typeof e.ramps === 'object' && Object.values(e.ramps).every(v => Array.isArray(v) && v.length === 2),
  e && `${Object.keys(e.ramps).length} ramps`);

console.log('\n-- lakeNamesForPicker: the dropdown that replaced Object.keys(LAKE_DB) --');
const names = reg.lakeNamesForPicker();
check('non-empty', names.length > 0, `${names.length} names`);
check('no duplicates', new Set(names).size === names.length,
  `${names.length - new Set(names).size} dupes`);
check('all strings, none blank', names.every(n => typeof n === 'string' && n.trim()));
console.log(`  first 5: ${names.slice(0, 5).join(' | ')}`);

console.log('\n-- no two shipped lakes may share a display name --');
// This replaces "the acreage fallback must be a NO-OP now that county names the lakes",
// which asserted disambiguateDisplayNames() never fires. County does NOT resolve every
// collision: Lake Wallace (Marlboro Co, SC) is 273 ac and 155 ac, Long Pond (Baker Co, GA)
// is 159 and 66, McLaurins Millpond (Marlboro Co, SC) is 57 and 46 — same name, same
// county, different water. The acreage suffix is the only thing that tells them apart, so
// the fallback firing is correct behaviour and asserting it never fires forbade the fix.
//
// The invariant that actually matters is uniqueness. How it was reached — county, or
// county plus acreage — is an implementation detail.
{
  const seen = new Map();
  const dupes = [];
  for (const r of R.list.filter(r => r.shipped)) {
    if (seen.has(r.displayName)) dupes.push(`${r.displayName}  [${seen.get(r.displayName)} vs ${r.slug}]`);
    else seen.set(r.displayName, r.slug);
  }
  check('shipped display names are unique', dupes.length === 0, dupes.slice(0, 4).join(' | '));
  const renamed = R.list.filter((r) => / \([\d,]+ ac\)$/.test(r.displayName));
  console.log(`  info  ${renamed.length} needed the acreage suffix: ${renamed.map(r => r.displayName).join(' | ') || '(none)'}`);
}

// A coastal zone is a sound, a bay or an inlet. Its centroid is open water and falls
// outside every county polygon, so it can never carry a county and must not be required
// to. Requiring it is what let `Pamlico Sound / Neuse River, NC, NC` through — the name
// already ended in the state and the fallback appended it again.
check('every shipped freshwater name carries a county', R.list.filter(r => r.shipped && !r.slug.startsWith('coast_'))
  .every(r => / \(.+ Co, [A-Z/]+\)( \([\d,]+ ac\))?$/.test(r.displayName)),
  R.list.filter(r => r.shipped && !r.slug.startsWith('coast_')
                  && !/ \(.+ Co, [A-Z/]+\)( \([\d,]+ ac\))?$/.test(r.displayName))
        .slice(0,4).map(r => r.displayName).join(' | '));

// Fixed in consolidate_lake_index.py on 2026-08-04 (display_with_county no longer
// appends a suffix the name already ends with). The INDEX still carries the old strings
// until it is regenerated, so this failing means "the index is stale", not "the code is
// broken" — re-run consolidate_lake_index.py and it clears.
{
  const dbl = R.list.filter(r => /,\s*([A-Z]{2})(\/[A-Z]{2})?,\s*\1(\/[A-Z]{2})?$/.test(r.displayName));
  check('no display name doubles its state suffix', dbl.length === 0,
    dbl.slice(0, 5).map(r => r.displayName).join(' | ')
    + (dbl.length ? '   <-- STALE INDEX: re-run consolidate_lake_index.py' : ''));
}

console.log('\n-- legacy names from saved plans and catches still resolve --');
for (const q of ['Wateree Lake, SC', 'Lake Wateree, SC', 'Forest Lake, SC', 'Lake Lanier, GA',
                 'Jordan Lake, NC', 'Lake Wylie, NC/SC', 'Lake Hartwell, SC/GA']) {
  const r = reg.lakeRecordFor(q);
  check(`"${q}"`, !!r, r ? `-> ${r.displayName}  [${r.slug}]` : 'UNRESOLVED');
}

console.log('\n-- the two lakes the default filter hid last time --');
for (const q of ['Wittee', 'Ferry', 'Dawhoo', 'Bates Old River', 'Wateree']) {
  const r = reg.lakeRecordFor(q);
  const inPicker = r && names.includes(r.displayName);
  check(`"${q}" resolves and is offered`, !!r && !!inPicker,
    r ? `${r.displayName}  shipped=${r.shipped} access=${r.access} inPicker=${inPicker}` : 'NOT FOUND');
}

console.log('\n-- catch-journal nearest-centroid fallback (its new db shape) --');
const db = Object.fromEntries(R.list.map(r => [r.displayName, r]));
check('db keyed by display name', Object.keys(db).length > 0, `${Object.keys(db).length} keys`);
check('every value has finite lat/lon', Object.values(db).every(v => Number.isFinite(v.lat) && Number.isFinite(v.lon)));

console.log('\n-- every picker name round-trips back to a record --');
const broken = names.filter(n => !reg.lakeRecordFor(n));
check('no picker name fails lookup', broken.length === 0, broken.slice(0, 5).join(' | '));

console.log('\n-- every shipped lake is resolvable by its own display name --');
const shipped = R.list.filter(r => r.shipped);
const unresolvable = shipped.filter(r => reg.lakeRecordFor(r.displayName)?.slug !== r.slug);
check('shipped lakes resolve to themselves', unresolvable.length === 0,
  `${shipped.length} shipped, ${unresolvable.length} resolve to a DIFFERENT slug: ` +
  unresolvable.slice(0, 5).map(r => r.displayName).join(' | '));

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall checks passed');
process.exit(fails ? 1 : 0);
