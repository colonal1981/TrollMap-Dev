// ONE WATER IS ONE ENTRY, WHATEVER NAME A CATCH CARRIES.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-04, on the catch GPX picker: "we need to fix the multiple name thing... both bates and
// ashwood are listed under 2 different names... they are the same lake... same with wittee and wee
// tee". His journal names a water two ways because two import paths do: the access index's feed
// spelling ("Lake Ashwood, SC", "Wee Tee Lake, SC") and the registry's display name ("Ashwood Lake
// (Lee Co, SC)", "Wittee Lake (Williamsburg Co, SC)"), plus an older registry name ("Bates Old River
// (Richland/Calhoun Co, SC)", 46 catches). resolveR2Key() knew only the names access-index.js
// registered, one per water, so the rest resolved to nothing and the picker listed each spelling as
// a water of its own. Its last pass is now the registry's own resolver, lakeRecordFor().
//
// The rows below are the live registry's, 2026-10-04: name, display name and legacy names as served.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const row = (name, display, legacy, acres, lon, lat, county) => ({
  name, state: 'SC', display_name: display, legacy_display_names: legacy, county,
  area_acres: acres, centroid: [lon, lat], shipped: true,
});
const RAW = {
  bates_old_river: row('Bates Old River', 'Bates Old River (Richland Co, SC)', ['Bates Old River, SC'], 66.5, -80.63984, 33.77597, 'Richland'),
  wittee_lake: row('Wittee Lake', 'Wittee Lake (Williamsburg Co, SC)', ['Wittee Lake, SC', 'Wee Tee Lake', 'Wee Tee Lake, SC'], 114.7, -79.78478, 33.38463, 'Williamsburg'),
  ashwood_lake: row('Ashwood Lake', 'Ashwood Lake (Lee Co, SC)', ['Ashwood Lake, SC', 'Lake Ashwood', 'Lake Ashwood, SC'], 57.1, -80.31786, 34.10355, 'Lee'),
  lowthers_lake: row('Lowthers Lake', 'Lowthers Lake (Darlington Co, SC)', ['Lowthers Lake, SC', 'Louthers Lake', 'Louthers Lake, SC'], 132, -79.70748, 34.3177, 'Darlington'),
  wateree_river: row('Wateree River', 'Wateree River (Richland Co, SC)', ['Wateree River, SC'], 4915, -80.63261, 34.0397, 'Richland'),
  lake_marion: row('Lake Marion', 'Lake Marion (Clarendon Co, SC)', ['Lake Marion, SC'], 80918.9, -80.38416, 33.56141, 'Clarendon'),
  cedar_creek_reservoir_2: row('Cedar Creek Reservoir', 'Cedar Creek Reservoir (Chester Co, SC)', [], 662, -81.0, 34.6, 'Chester'),
  cedar_creek: row('Cedar Creek', 'Cedar Creek (Richland Co, SC)', ['Cedar Creek, SC'], 275.8, -80.8312, 34.01217, 'Richland'),
  falls_lake: { ...row('Falls Lake', 'Falls Lake (Wake Co, NC)', ['Falls Lake, NC'], 11240, -78.68, 36.01, 'Wake'), state: 'NC' },
};

globalThis.window = globalThis;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => RAW });

const { resolveR2Key } = await import('../js/data/lake-keys.js');
const { loadLakeRegistry } = await import('../js/data/lake-registry.js');
const { catchWaters, catchesGpx } = await import('../js/utils/catch-gpx.js');

// What resolveR2Key() answers with no registry -- the curated map and the fuzzy pass alone.
const NAMES = ['Lake Marion, SC', 'Lake Marion (Clarendon Co, SC)', 'Ashwood Lake (Lee Co, SC)', 'Lake Ashwood, SC',
  'Bates Old River (Richland/Calhoun Co, SC)', 'Bates Old River (Richland Co, SC)', 'Wittee Lake (Williamsburg Co, SC)',
  'Wee Tee Lake, SC', 'Lowthers Lake (Darlington Co, SC)', 'Louthers Lake, SC', 'Wateree River', 'Lake Juniper, SC',
  'Falls Lake (Wake Co, NC)', 'Great Falls Reservoir'];
const before = Object.fromEntries(NAMES.map((n) => [n, resolveR2Key(n)]));
await loadLakeRegistry();

test('every name his journal gives one water resolves to that water', () => {
  const same = [
    ['bates_old_river', 'Bates Old River (Richland/Calhoun Co, SC)', 'Bates Old River (Richland Co, SC)'],
    ['ashwood_lake', 'Lake Ashwood, SC', 'Ashwood Lake (Lee Co, SC)'],
    ['wittee_lake', 'Wee Tee Lake, SC', 'Wittee Lake (Williamsburg Co, SC)'],
    ['lowthers_lake', 'Louthers Lake, SC', 'Lowthers Lake (Darlington Co, SC)'],
    ['lake_marion', 'Lake Marion, SC', 'Lake Marion (Clarendon Co, SC)'],
    ['wateree_river', 'Wateree River', 'Wateree River (Richland Co, SC)'],
  ];
  for (const [slug, ...names] of same) for (const n of names) assert.equal(resolveR2Key(n), slug, n);
  // A full display name reaches the smaller of two same-state namesakes, not the bigger one.
  assert.equal(resolveR2Key('Cedar Creek (Richland Co, SC)'), 'cedar_creek');
  // A name no registry row carries still resolves to nothing.
  assert.equal(resolveR2Key('Lake Juniper, SC'), null);
});

test('once the registry has loaded it answers before the fuzzy pass, and its answer is final', () => {
  // Ryan, 10/5: "Lake name lookup you can work on". Measured over the 3,396 names the app holds, the
  // fuzzy pass's own answers were a different water from the registry's 27 times and a water the
  // registry does not know 18 times -- 44 of the 45 wrong. See Pass 5 in lake-keys.js.
  //
  // The exact passes above it are untouched: a name the curated map answers reads the same.
  assert.equal(before['Lake Marion, SC'], 'lake_marion');
  assert.equal(resolveR2Key('Lake Marion, SC'), 'lake_marion');
  // The fuzzy pass, alone, sends Falls Lake's own display name to Blewett Falls ("blewett falls"
  // contains "falls" and is the longer key) -- the live defect. The registry knows the water.
  assert.equal(before['Falls Lake (Wake Co, NC)'], 'blewett_falls_lake');
  assert.equal(resolveR2Key('Falls Lake (Wake Co, NC)'), 'falls_lake');
  // A name the registry does not carry resolves to nothing, not to the nearest-sounding water:
  // Great Falls is on the Catawba in South Carolina, Falls Lake is near Raleigh.
  assert.equal(before['Great Falls Reservoir'], 'falls_lake');
  assert.equal(resolveR2Key('Great Falls Reservoir'), null);
  // The order, in the code: the registry is asked before the fuzzy loop, only once it has loaded.
  const src = fs.readFileSync(new URL('../js/data/lake-keys.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function resolveR2Key('));
  const reg = body.indexOf('if (reg && reg.loaded) {');
  assert.ok(reg > 0 && reg < body.indexOf('for (const [kn, v, kStates] of _NORM_MAP)'));
  assert.match(body, /if \(reg && reg\.loaded\) \{\s*const rec = lakeRecordFor\(trimmed\);\s*return \(rec && rec\.slug\) \|\| null;\s*\}/);
});

test('the GPX picker lists each water once, under the spelling he used most', () => {
  const at = (lat, lon, i) => ({ lat: String(lat), lon: String(lon), date: '2024-01-15', time: `${8 + i}:00 AM`, species: 'Crappie' });
  const J = [
    { ...at(34.1017, -80.3202, 0), lake: 'Lake Ashwood, SC' },
    { ...at(34.1003, -80.3168, 1), lake: 'Lake Ashwood, SC' },
    { ...at(34.0968, -80.3542, 2), lake: 'Ashwood Lake (Lee Co, SC)' },
    { ...at(33.776, -80.640, 0), lake: 'Bates Old River (Richland/Calhoun Co, SC)' },
    { ...at(33.777, -80.641, 1), lake: 'Bates Old River (Richland/Calhoun Co, SC)' },
    { ...at(33.778, -80.642, 2), lake: 'Bates Old River (Richland Co, SC)' },
    { ...at(33.385, -79.785, 0), lake: 'Wee Tee Lake, SC' },
    { ...at(33.386, -79.786, 1), lake: 'Wittee Lake (Williamsburg Co, SC)' },
    { ...at(33.10, -80.10, 0), lake: 'Lake Juniper, SC' },
  ];
  assert.deepEqual(catchWaters(J).map((w) => [w.name, w.n, w.key]), [
    ['Bates Old River (Richland/Calhoun Co, SC)', 3, 'bates_old_river'],
    ['Lake Ashwood, SC', 3, 'ashwood_lake'],
    ['Wee Tee Lake, SC', 2, 'wittee_lake'],
    ['Lake Juniper, SC', 1, 'name:lake juniper, sc'],
  ]);
  // and the file for a water holds every spelling's fish
  assert.equal(catchesGpx(J, { key: 'ashwood_lake', name: 'Lake Ashwood, SC' }).n, 3);
});
