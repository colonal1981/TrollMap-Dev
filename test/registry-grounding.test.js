// Ground the identity agent on 454 waters instead of 15.
//
// Ryan, 2026-08-17: *"whats next on the list of hard coded things that never got expanded when the
// app grew"*. `LAKES` in worker-data.js was the biggest of them. Measuring it found its only
// public door, /lake, has no caller, and that `normalPool` is byte-identical to a field the live
// Duke feed already publishes for 35 lakes — so the table was underserving almost nothing.
//
// Almost. `handleResearchAgent` grounded the identity agent with `LAKES[lakeKeyFromName(name)]`,
// which is fifteen waters. The other 439 got `undefined` on the one agent whose whole job is to
// say what the water IS, while its own system prompt says "Never invent values".
//
// Every row below is copied verbatim out of registry/lake_index.json.
import { resolveRegistryRow, identityBaseline, lakeIndex, _resetIndexCache, LAKE_INDEX_KEY }
  from '../Worker/registry.js';

let fails = 0;
const check = (name, cond, got) => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  fails++; console.log(`  FAIL ${name}${got === undefined ? '' : ` — got ${JSON.stringify(got)}`}`);
};

const INDEX = {
  lake_murray: { slug: 'lake_murray', name: 'Lake Murray', state: 'SC',
    display_name: 'Lake Murray (Lexington Co, SC)', legacy_display_name: 'Lake Murray, SC',
    legacy_display_names: ['Lake Murray, SC'], county: 'Lexington', gnis: 'gnis:1224900',
    area_acres: 48761.0, centroid: [-81.453299, 34.085736], feature_type: 'lake' },
  wateree_lake: { slug: 'wateree_lake', name: 'Wateree Lake', state: 'SC',
    display_name: 'Wateree Lake (Kershaw Co, SC)', legacy_display_name: 'Wateree Lake, SC',
    legacy_display_names: ['Wateree Lake, SC', 'Lake Wateree, SC'], county: 'Kershaw',
    gnis: 'gnis:1227425', area_acres: 11756.3, centroid: [-80.818179, 34.437616],
    feature_type: 'lake' },
  congaree_river: { slug: 'congaree_river', name: 'Congaree River (to SC-601)', state: 'SC',
    display_name: 'Congaree River (to SC-601) (Richland Co, SC)',
    legacy_display_names: ['Congaree River (to SC-601), SC', 'Bates Old River',
                           'Congaree River (to SC-601)', 'Bates Old River, SC'],
    county: 'Richland/Calhoun', gnis: 'slug:congaree_river', area_acres: 5548.0,
    centroid: [-80.98814, 34.053631], feature_type: 'river' },
  // TWO LAKE ROBINSONS, 200 km apart, and the registry says so four times over.
  lake_robinson: { slug: 'lake_robinson', name: 'Lake Robinson', state: 'SC',
    display_name: 'Lake Robinson (Chesterfield Co, SC)', legacy_display_name: 'Lake Robinson, SC',
    legacy_display_names: ['Lake Robinson, SC', 'HB Robinson Lake', 'HB Robinson Lake, SC'],
    county: 'Darlington', gnis: 'gnis:1238481', area_acres: 2098.9,
    centroid: [-80.158078, 34.445582], feature_type: 'lake' },
  lake_robinson_greer: { slug: 'lake_robinson_greer', name: 'Lake Robinson', state: 'SC',
    display_name: 'Lake Robinson (Greenville Co, SC)', legacy_display_name: 'Lake Robinson, SC',
    legacy_display_names: ['Lake Robinson, SC'], county: 'Greenville',
    gnis: 'slug:lake_robinson_greer', area_acres: 803.7, centroid: [-82.310015, 35.015572],
    feature_type: 'lake' },
};

console.log('== the four exact ways in ==');
check('slug', resolveRegistryRow(INDEX, 'lake_murray')?.slug === 'lake_murray');
check('slug is case-folded', resolveRegistryRow(INDEX, 'LAKE_MURRAY')?.slug === 'lake_murray');
check('display name with the county parenthetical',
  resolveRegistryRow(INDEX, 'Lake Murray (Lexington Co, SC)')?.slug === 'lake_murray');
check('legacy display name',
  resolveRegistryRow(INDEX, 'Wateree Lake, SC')?.slug === 'wateree_lake');
// The name the app has always called it, which is NOT the registry's `name`.
check('a second legacy spelling', resolveRegistryRow(INDEX, 'Lake Wateree, SC')?.slug === 'wateree_lake');
check('bare registry name', resolveRegistryRow(INDEX, 'Wateree Lake')?.slug === 'wateree_lake');
check('Ryan’s curated oxbow alias still lands on the Congaree',
  resolveRegistryRow(INDEX, 'Bates Old River')?.slug === 'congaree_river');

console.log('\n== the county suffix exists because two lakes share a name ==');
{
  // BOTH Robinsons carry name "Lake Robinson" AND legacy "Lake Robinson, SC". An earlier draft of
  // resolveRegistryRow used rows.find() on those fields and would have returned whichever came
  // first in the file — a coin toss written into a baseline labelled authoritative.
  check('the bare name is REFUSED, not guessed',
    resolveRegistryRow(INDEX, 'Lake Robinson') === null, resolveRegistryRow(INDEX, 'Lake Robinson')?.slug);
  check('the shared legacy spelling is refused too',
    resolveRegistryRow(INDEX, 'Lake Robinson, SC') === null,
    resolveRegistryRow(INDEX, 'Lake Robinson, SC')?.slug);
  check('ambiguity stops the search rather than falling through to something looser',
    resolveRegistryRow(INDEX, 'lake robinson') === null);
  // The county parenthetical is what tells them apart, and it still works.
  check('Chesterfield resolves',
    resolveRegistryRow(INDEX, 'Lake Robinson (Chesterfield Co, SC)')?.slug === 'lake_robinson');
  check('Greenville resolves',
    resolveRegistryRow(INDEX, 'Lake Robinson (Greenville Co, SC)')?.slug === 'lake_robinson_greer');
  // A spelling only ONE of them carries is not ambiguous.
  check('a legacy name unique to one of them still resolves',
    resolveRegistryRow(INDEX, 'HB Robinson Lake')?.slug === 'lake_robinson');
}

console.log('\n== nothing matches on a fragment ==');
{
  // resolveLakeKey() in trollmap-worker.js is a substring matcher and handed Lake Wateree's pool
  // config to the Wateree RIVER, and Lake Marion's to Graves Lake in Marion COUNTY. None of that
  // is reachable here because no pass tests a fragment.
  check('a river is not the lake it drains', resolveRegistryRow(INDEX, 'Wateree River') === null);
  check('a longer name containing a shorter one does not match',
    resolveRegistryRow(INDEX, 'Lower Lake Murray Tailrace') === null);
  check('an empty name is nothing', resolveRegistryRow(INDEX, '') === null);
  check('null name', resolveRegistryRow(INDEX, null) === null);
  check('null index', resolveRegistryRow(null, 'Lake Murray') === null);
  check('an unknown water is null, not the first row',
    resolveRegistryRow(INDEX, 'Some Pond Nobody Shipped') === null);
}

console.log('\n== the baseline says what it knows and no more ==');
{
  const b = identityBaseline(INDEX.lake_murray);
  check('county, which the agent must not leave null when it exists', b.county === 'Lexington');
  check('acres as a number, so nobody hands back km²', b.surfaceAreaAcres === 48761, b.surfaceAreaAcres);
  check('the registry display name', b.displayName === 'Lake Murray (Lexington Co, SC)');
  check('gnis kept when it is a real gnis id', b.gnis === 'gnis:1224900');
  check('no pool without a live source', b.normalPoolFt === null && b.normalPoolSource === null);
  // The old baseline spread the whole LAKES row: duke "wateree", river "02148000", ahq
  // "lake-wateree". A USGS site number in a baseline labelled "TrollMap curated" is an invitation
  // to write it into a field that wants something else.
  for (const k of ['duke', 'river', 'ahq', 'pool', 'sepa', 'dominion', 'normalPool', 'lakeKey']) {
    check(`no foreign key leaks as a fact: ${k}`, !(k in b));
  }
  check('it says it is not a measurement', /not a measurement/i.test(b.note));

  // "slug:congaree_river" is what consolidate_lake_index.py writes where no GNIS feature exists.
  // Passing that off as a federal identifier is how a model comes to cite one.
  const r = identityBaseline(INDEX.congaree_river);
  check('a slug wearing a gnis label is dropped', r.gnis === null, r.gnis);
  check('but the rest of the row survives', r.county === 'Richland/Calhoun' && r.featureType === 'river');

  const withPool = identityBaseline(INDEX.wateree_lake, { ft: 225.5, source: 'Duke Energy live feed' });
  check('a live pool is carried', withPool.normalPoolFt === 225.5);
  check('with the feed that published it', /Duke/.test(withPool.normalPoolSource));
  // Number(null) IS 0 AND SO IS Number(''). This assertion failed on the first run of this file
  // and the bug was in identityBaseline, written ten minutes earlier, in the same session as four
  // other instances of the same family. A pool of null must not become a full pond at sea level,
  // and a lake with no acreage must not become a lake of zero acres.
  for (const bad of [null, undefined, '', '   ', '\t', 'NA', {}, [], [7], NaN, true]) {
    const b2 = identityBaseline(INDEX.wateree_lake, { ft: bad, source: 'x' });
    check(`a pool ft of ${JSON.stringify(bad)} is not a pool`, b2.normalPoolFt === null, b2.normalPoolFt);
  }
  check('and no source is claimed for a pool there is none of',
    identityBaseline(INDEX.wateree_lake, { ft: null, source: 'x' }).normalPoolSource === null);
  check('a null acreage is null, not zero',
    identityBaseline({ ...INDEX.wateree_lake, area_acres: null }).surfaceAreaAcres === null,
    identityBaseline({ ...INDEX.wateree_lake, area_acres: null }).surfaceAreaAcres);
  check('an empty acreage string is null, not zero',
    identityBaseline({ ...INDEX.wateree_lake, area_acres: '' }).surfaceAreaAcres === null);
  check('zero acres, if a row ever really said so, is still zero',
    identityBaseline({ ...INDEX.wateree_lake, area_acres: 0 }).surfaceAreaAcres === 0);
  check('no row is no baseline', identityBaseline(null) === null);
}

console.log('\n== the index read ==');
{
  _resetIndexCache();
  let gets = 0;
  const bucket = { get: async (k) => {
    gets++;
    return k === LAKE_INDEX_KEY ? { text: async () => JSON.stringify(INDEX) } : null;
  } };
  const env = { R2_TROLLMAP_CHARTPACKS: bucket };
  const a = await lakeIndex(env, { now: 1000 });
  check('reads the registry object', a.lake_murray?.slug === 'lake_murray');
  await lakeIndex(env, { now: 1000 + 3599_000 });
  check('cached for the hour', gets === 1, gets);
  await lakeIndex(env, { now: 1000 + 3601_000 });
  check('and re-read after it', gets === 2, gets);
  await lakeIndex(env, { now: 1000 + 3601_000, fresh: true });
  check('fresh bypasses the cache', gets === 3, gets);

  _resetIndexCache();
  let msg = '';
  try {
    await lakeIndex({ R2_TROLLMAP_CHARTPACKS: { get: async () => null } });
  } catch (e) { msg = String(e.message); }
  // A MISSING OBJECT IS NOT AN EMPTY REGISTRY. Naming the script that writes it is the difference
  // between a five-minute fix and an afternoon.
  check('a missing object throws and names the uploader', /upload_garmin_to_r2/.test(msg), msg);

  _resetIndexCache();
  msg = '';
  try { await lakeIndex({}); } catch (e) { msg = String(e.message); }
  check('no bucket bound says so', /R2_TROLLMAP_CHARTPACKS/.test(msg), msg);

  _resetIndexCache();
  msg = '';
  try {
    await lakeIndex({ R2_TROLLMAP_CHARTPACKS: { get: async () => ({ text: async () => '[]' }) } });
  } catch (e) { msg = String(e.message); }
  check('an array is not an index keyed by slug', /keyed by slug/.test(msg), msg);
  _resetIndexCache();
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`);
process.exit(fails ? 1 : 0);
