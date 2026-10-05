// A WATER'S OWN NAME OUTRANKS ANOTHER WATER'S ALIAS.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Found 2026-10-05 by `lint:smoke` (registry_smoke.mjs, "shipped lakes resolve to themselves BY FEED
// NAME") after Ryan's registry rebuild refreshed the names the ramp feeds hang on each water. SCDNR
// files a Charleston ramp under "Goose Creek"; that name went onto coast_charleston_sc as a legacy
// name, normalised to the same key as the 3DHP row actually called Goose Creek Reservoir (normName()
// drops "reservoir"), and won the key by size, because lake-registry.js built its name index in one
// largest-first pass over every name a row carries. So "Goose Creek Reservoir, SC" opened the
// Charleston coastal zone. "Little River" did the same to "Little River Reservoir, NC" from
// pee_dee_river_2. Measured over the 1,817 names the registry and his journal carry: those 8
// answers changed, nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';

const row = (name, display, legacy, acres, state, lon, lat) => ({
  name, state, display_name: display, legacy_display_name: `${name}, ${state}`, legacy_display_names: legacy,
  area_acres: acres, centroid: [lon, lat], shipped: true,
});
const RAW = {
  coast_charleston_sc: row('Charleston Harbor, SC', 'Charleston Harbor, SC (Charleston Co, SC)',
    ['Charleston Harbor, SC', 'Goose Creek', 'Goose Creek, SC'], 120000, 'SC', -79.9, 32.8),
  goose_creek_reservoir: row('Goose Creek Reservoir', 'Goose Creek Reservoir (Berkeley Co, SC)',
    ['Goose Creek Reservoir, SC'], 600, 'SC', -80.0, 32.98),
  lake_robinson: row('Lake Robinson', 'Lake Robinson (Chesterfield Co, SC)', ['Lake Robinson, SC'], 2099, 'SC', -80.16, 34.46),
  lake_robinson_greer: row('Lake Robinson (Greer)', 'Lake Robinson (Greer) (Greenville Co, SC)',
    ['Lake Robinson, SC'], 804, 'SC', -82.2, 35.05),
};
globalThis.window = globalThis;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => RAW });
const R = await import('../js/data/lake-registry.js');
await R.loadLakeRegistry();

test("a row's own name goes to that row, however large the water carrying it as an alias", () => {
  assert.equal(R.lakeRecordFor('Goose Creek Reservoir, SC').slug, 'goose_creek_reservoir');
  assert.equal(R.lakeRecordFor('Goose Creek Reservoir').slug, 'goose_creek_reservoir');
  assert.equal(R.lakeRecordFor('Goose Creek Reservoir (Berkeley Co, SC)').slug, 'goose_creek_reservoir');
});

test('an alias still answers where no row is called that', () => {
  assert.equal(R.lakeRecordFor('Charleston Harbor, SC').slug, 'coast_charleston_sc');
});

test('within the same tier the order is unchanged: shipped, then largest', () => {
  // Both Lake Robinsons carry the legacy "Lake Robinson, SC"; the bigger keeps it, as before.
  assert.equal(R.lakeRecordFor('Lake Robinson, SC').slug, 'lake_robinson');
  assert.equal(R.lakeRecordFor('Lake Robinson (Greer) (Greenville Co, SC)').slug, 'lake_robinson_greer');
});
