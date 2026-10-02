// Personal use only, not for distribution or resale; not for navigation.
//
// A RAMP PLANS THE WATER IT CAN REACH -- item 50.
//
// Ryan, 2026-10-02, on Lake Monticello: "the subimpoundment (recreation area) boat ramp isn't listed
// so there is no way to fish the subimpoundment area with the app", then "the app needs to be
// prevented from running plans from a ramp on a part of the lake the ramp can't access... beyond
// that the ramp needs to be listed so that i can choose to launch from the ramp and plan/fish the
// accessible area from that ramp", and "there is not room in the dropdown for you to put all of that
// info about it being a separate lake... and it would just show as noise to me".
//
// The fixture is Monticello's own pools.json, built by Scripts/build_pools.py from its pack on
// 2026-10-02: the 285-acre Recreational Lake behind SC-99 is pool 1.
//
//   node --test test/a-ramp-plans-the-water-it-can-reach.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { poolIndex, poolAt, rampPool, featurePool, rampWater, sameWaterLandings }
  from '../js/data/lake-pools.js';

const read = (...p) => readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8');
const MON = JSON.parse(read('test', 'fixtures', 'monticello-pools-2026-10-02.json'));
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// Positions from the pack's own launches.json and depth areas.
const REC_RAMP = [-81.313542, 34.379239];     // Recreation Lake Boat Ramp (SCDNR "Subimpoundment")
const RAMP_99 = [-81.317874, 34.376271];      // 99 Boat Ramp, main lake, 651 m away by the water graph
const RAMP_EAST = [-81.285632, 34.327565];    // Monticello Boat Ramp (Hwy 215), main lake
const IN_REC = [-81.30513, 34.38403];         // inside the Recreational Lake
const IN_MAIN = [-81.31295, 34.33727];        // inside the main lake
const pt = (c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } });
const line = (a, b, n = 10) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString',
  coordinates: Array.from({ length: n + 1 }, (_, i) => [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]) } });

test('the Recreational Lake is its own pool, and the main lake is pool 0', () => {
  const ix = poolIndex(MON);
  const rec = ix.pools.find((p) => p.acres > 250 && p.acres < 300);
  assert.ok(rec, `a pool of about 285 acres: ${ix.pools.map((p) => p.acres)}`);
  assert.equal(poolAt(ix, ...IN_REC), rec.id);
  assert.equal(poolAt(ix, ...IN_MAIN), 0);
});

test('each ramp launches onto its own pool; a ramp the file does not list is on the main pool', () => {
  const ix = poolIndex(MON);
  const rec = poolAt(ix, ...IN_REC);
  assert.equal(rampPool(ix, REC_RAMP), rec);
  assert.equal(rampPool(ix, RAMP_99), 0);
  assert.equal(rampPool(ix, RAMP_EAST), 0);
  // The OSM node for the 215 ramp, 13 m from SCDNR's: within 40 m, the same landing.
  assert.equal(rampPool(ix, [-81.2857677, 34.3275271]), 0);
  assert.equal(rampPool(ix, [-81.0, 34.0]), 0, 'not in the file: the main pool, as before this');
  assert.equal(rampPool(null, RAMP_99), null);
});

test('from the 99 ramp nothing on the Recreational Lake is offered; from its own ramp nothing else is', () => {
  const recLane = line(IN_REC, [IN_REC[0] + 0.004, IN_REC[1] + 0.001]);
  const mainLane = line(IN_MAIN, [IN_MAIN[0] + 0.004, IN_MAIN[1] + 0.002]);
  const fc = { type: 'FeatureCollection', features: [recLane, mainLane, pt(IN_REC), pt(IN_MAIN)] };

  const main = rampWater(MON, RAMP_99);
  assert.equal(main.pool, 0);
  assert.deepEqual(main.fc(fc).features, [mainLane, pt(IN_MAIN)]);
  assert.equal(main.dropped(), 2);
  assert.equal(main.keepAt(...IN_REC), false);

  const rec = rampWater(MON, REC_RAMP);
  assert.ok(rec.pool > 0);
  assert.ok(rec.acres > 250 && rec.acres < 300, String(rec.acres));
  assert.deepEqual(rec.fc(fc).features, [recLane, pt(IN_REC)]);
  assert.equal(rec.keepAt(...IN_MAIN), false);
});

test('a lane is in the pool most of its points are in', () => {
  const ix = poolIndex(MON);
  // 7 of 11 points in the Recreational Lake, the last 4 past it.
  const a = IN_REC, b = [IN_REC[0] + 0.01, IN_REC[1]];
  const f = line(a, b);
  const pools = f.geometry.coordinates.map((c) => poolAt(ix, c[0], c[1]));
  const counts = pools.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
  const most = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
  assert.equal(featurePool(ix, f), most);
});

test('no pools file, or a landing with no pool, plans everything as it did', () => {
  const fc = { type: 'FeatureCollection', features: [pt(IN_REC), pt(IN_MAIN)] };
  for (const w of [rampWater(null, RAMP_99), rampWater({ pools: [], landings: [] }, RAMP_99),
                   rampWater({ ...MON, landings: [{ lat: REC_RAMP[1], lon: REC_RAMP[0], pool: null }] }, REC_RAMP)]) {
    assert.equal(w.pool, null);
    assert.equal(w.fc(fc), fc);
    assert.equal(w.keepAt(...IN_REC), true);
    assert.equal(w.dropped(), 0);
  }
});

test('the closer-landing check only offers landings on the same pool', () => {
  const landings = MON.landings.map((l) => ({ ...l }));
  const fromRec = sameWaterLandings(MON, REC_RAMP, landings).map((l) => l.name);
  const from99 = sameWaterLandings(MON, RAMP_99, landings).map((l) => l.name);
  assert.equal(fromRec.length, 1);
  assert.ok(!from99.some((n) => fromRec.includes(n)), `${from99} / ${fromRec}`);
  assert.equal(from99.length, landings.length - 1);
  assert.deepEqual(sameWaterLandings(null, RAMP_99, landings), landings);
  for (const [name, src] of [['plan-water-ui', read('js', 'modules', 'plan-water-ui.js')],
                             ['smart-plan-v2-wiring', read('js', 'modules', 'smart-plan-v2-wiring.js')]]) {
    assert.match(code(src), /landings: sameWaterLandings\(await poolsFor\(/, `${name} offers other pools' landings`);
  }
});

test('a cut-off ramp is listed on the water it is filed under, and dropped only from another', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ landings: [
    // Monticello: the Recreation Lake ramp is off the main pool and filed under Monticello.
    { name: 'Recreation Lake Boat Ramp', lat: 34.379239, lon: -81.313542, on_main_water: false,
      filed: ['test_monticello'], pool_acres: 285.6 },
    // Wateree's 9/22 drop stands: Lugoff is filed under the Wateree River.
    { name: 'Lugoff', lat: 34.2, lon: -80.7, on_main_water: false, filed: ['wateree_river'], pool_acres: 346 },
    { name: '99 Boat Ramp', lat: 34.376271, lon: -81.317874, on_main_water: true, filed: ['test_monticello'] },
    // null is "not measured", which has always been reachable.
    { name: 'Unmeasured', lat: 34.3, lon: -81.3, on_main_water: null, filed: ['wateree_river'] },
  ] }) });
  try {
    const { landingsFor } = await import('../js/data/launch-reach.js');
    const rows = await landingsFor('test_monticello');
    assert.deepEqual(rows.map((r) => r.name).sort(), ['99 Boat Ramp', 'Recreation Lake Boat Ramp', 'Unmeasured']);
    assert.deepEqual((rows.offMain || []).map((r) => r.name), ['Lugoff']);
  } finally {
    globalThis.fetch = saved;
  }
});

test('both planners cut every layer to the ramp’s pool where the layers land', () => {
  const sp = code(read('js', 'modules', 'smart-plan-v2.js'));
  assert.match(sp, /\/pools\.json`\)\)\.catch\(\(\) => null\)/);
  assert.match(sp, /const water = rampWater\(poolsFile, o\.ramp\)/);
  assert.match(sp, /\[runsAll, structAll, waterAll, docksAll, poisAll, osmAll\]\.map\(water\.fc\)/);
  assert.match(sp, /\.filter\(water\.keep\)\);/, 'the state attractors too');
  const pw = code(read('js', 'modules', 'plan-water-ui.js'));
  assert.match(pw, /get\(`\/\$\{r2Key\}\/pools\.json`\)\.catch\(\(\) => null\)/);
  assert.match(pw, /const water = rampWater\(poolsFile, ramp\)/);
  assert.match(pw, /\[fcAll, wfAll, stAll, poAll, dkAll\]\.map\(water\.fc\)/);
  assert.match(pw, /\.filter\(water\.keep\)\s*\.map\(/, 'the state attractors too');
});

test('the dropdown says nothing about pools, and his names reach the reach rows', () => {
  const reach = code(read('js', 'data', 'launch-reach.js'));
  const label = reach.match(/export function reachLabel\(r\) \{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(label, /pool|acre|separate/i);
  assert.match(label, /ryanName\(Number\(r\.lat\), Number\(r\.lon\)\)/);
  const up = read('Scripts', 'upload_garmin_to_r2.py');
  assert.match(up, /"pools":\s+"pools\.json"/);
});
