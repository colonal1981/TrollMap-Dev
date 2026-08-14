// Structure near the plan centre — the function that returned [] from 2026-08-07 to 08-14.
//
// Every assertion here is about a way the old code was wrong, or a way the new code could
// quietly become wrong again: a source silently dropped, a coordinate of 0 discarded, a type
// vanishing because the handover was capped, a lure key invented for a chart type that has none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearbyStructuresFrom } from '../js/modules/smart-plan-context.js';

const LAT = 34.40, LON = -80.70;           // Wateree
const near = (dLat = 0, dLon = 0) => ({ lat: LAT + dLat, lon: LON + dLon });

test('no supplemental data is not a crash and not a lie', () => {
  for (const sup of [undefined, null, {}, { structures: [], docks: [] }]) {
    const r = nearbyStructuresFrom(sup, LAT, LON);
    assert.equal(r.total, 0);
    assert.deepEqual(r.list, []);
    assert.deepEqual(r.lureKeys, []);
  }
});

test('Garmin structure types reach the lure vocabulary', () => {
  const sup = { structures: [
    { poi_type: 'flooded_timber', ...near(0.001), name: 'Timber' },
    { poi_type: 'shallow_area',   ...near(0.002) },
    { poi_type: 'pile',           ...near(0.003) },
    { poi_type: 'creek_bed',      ...near(0.004) },
  ] };
  const r = nearbyStructuresFrom(sup, LAT, LON);
  assert.equal(r.total, 4);
  assert.deepEqual(r.lureKeys.sort(),
    ['bridge_piling', 'channel_ledge', 'laydown', 'shallow_flat']);
});

test('a chart type with no honest lure match maps to null, and still counts', () => {
  const sup = { structures: [
    { poi_type: 'obstruction', ...near(0.001) },
    { poi_type: 'wreck',       ...near(0.002) },
  ] };
  const r = nearbyStructuresFrom(sup, LAT, LON);
  assert.equal(r.total, 2);                      // inventoried
  assert.deepEqual(r.lureKeys, []);              // but never invented
  assert.equal(r.list[0].lureKey, null);
});

test('dock clusters and OSM structures are sources, not decoration', () => {
  const sup = {
    docks: [{ ...near(0.001), count: 24, run_m: 900, bearing: 'N-S' }],
    osmStructures: [{ ...near(0.002), structure_type: 'PIER', name: 'Pier' },
                    { ...near(0.003), structure_type: 'DAM' }],
  };
  const r = nearbyStructuresFrom(sup, LAT, LON);
  assert.equal(r.total, 3);
  assert.deepEqual(r.lureKeys.sort(), ['dam_face', 'dock_edge']);
  const dock = r.list.find(x => x.type === 'dock_cluster');
  assert.equal(dock.count, 24);
  assert.equal(dock.run_m, 900);
  assert.match(dock.name, /24 docks over 900 m N-S/);
});

test('an attractor without coordinates is dropped; one with them is kept', () => {
  // This is the bug in getSupplementalContext that made smart-plan.js:1302 skip every attractor.
  const sup = { attractors: [
    { name: 'positionless', poi_type: 'fish_attractor_buoy' },
    { name: 'real', ...near(0.001) },
  ] };
  const r = nearbyStructuresFrom(sup, LAT, LON);
  assert.equal(r.total, 1);
  assert.equal(r.list[0].name, 'real');
  assert.equal(r.list[0].lureKey, 'brush_pile');
});

test('a coordinate of exactly 0 is a coordinate', () => {
  // The old guard was `if (!sLat || !sLon) return false`.
  const r = nearbyStructuresFrom({ structures: [{ poi_type: 'rock', lat: 0, lon: 0 }] }, 0, 0);
  assert.equal(r.total, 1);
});

test('outside the radius is out', () => {
  const r = nearbyStructuresFrom(
    { structures: [{ poi_type: 'rock', ...near(0.01) }, { poi_type: 'rock', ...near(0.5) }] },
    LAT, LON);
  assert.equal(r.total, 1);
});

test('nearest first', () => {
  const r = nearbyStructuresFrom({ structures: [
    { poi_type: 'rock', ...near(0.010), name: 'far' },
    { poi_type: 'rock', ...near(0.001), name: 'close' },
  ] }, LAT, LON);
  assert.deepEqual(r.list.map(x => x.name), ['close', 'far']);
});

test('the handover is capped but the count is not, and no type falls out', () => {
  const piers = Array.from({ length: 20 }, (_, i) => ({
    structure_type: 'PIER', ...near(0.0001 * (i + 1)),
  }));
  const sup = { osmStructures: [...piers, { structure_type: 'DAM', ...near(0.02) }] };
  const r = nearbyStructuresFrom(sup, LAT, LON);
  assert.equal(r.total, 21);
  assert.equal(r.counts.PIER, 20);
  assert.equal(r.list.filter(x => x.type === 'PIER').length, 12);   // PER_TYPE_CAP
  // The dam is further away than every pier. If capping worked by slicing the sorted list it
  // would be gone; it must survive, because it is a whole pattern the plan would otherwise miss.
  assert.ok(r.list.some(x => x.type === 'DAM'));
  assert.ok(r.lureKeys.includes('dam_face'));
});

// ── the pack layers and the DNR feed, added 2026-08-13 ───────────────────────────────

test('water_features kinds reach the lure vocabulary', () => {
  const wf = (kind, dLat, extra = {}) => ({
    type: 'Feature', properties: { kind, ...extra },
    geometry: { type: 'Point', coordinates: [LON, LAT + dLat] },
  });
  const r = nearbyStructuresFrom({}, LAT, LON, 2.0, {
    waterFeatures: [wf('point', 0.001, { relief: 'channel_edge', deep_side_ft: 13.3 }),
                    wf('cove', 0.002, { relief: 'steep_bank' }),
                    wf('creek_mouth', 0.003, { name: 'Crooked Creek' })],
  });
  assert.equal(r.total, 3);
  assert.deepEqual(r.lureKeys.sort(), ['creek_arm', 'creek_mouth', 'point']);
  // The measurements ride along — the planner is handed the chart, not a category name.
  assert.equal(r.list.find(x => x.type === 'point').relief, 'channel_edge');
  assert.equal(r.list.find(x => x.type === 'point').deep_side_ft, 13.3);
  assert.equal(r.list.find(x => x.type === 'creek_mouth').name, 'Crooked Creek');
});

test('ledges and humps are handed over best-scored, not nearest', () => {
  // Wateree has 6,926 ledges. The twelve nearest to a ramp are close to twelve at random;
  // build_structure.py already ranked them, so that ranking is what gets used.
  const led = (id, score, dLat) => ({
    type: 'Feature', properties: { kind: 'ledge', id, score, depth_ft: 32.2 },
    geometry: { type: 'Point', coordinates: [LON, LAT + dLat] },
  });
  const r = nearbyStructuresFrom({}, LAT, LON, 2.0, {
    structure: [led('ledge_near_bad', 10, 0.0001), led('ledge_far_good', 100, 0.004),
                led('ledge_mid', 55, 0.002)],
  });
  assert.deepEqual(r.list.map(x => x.name),
    ['ledge_far_good', 'ledge_mid', 'ledge_near_bad']);
  assert.equal(r.list[0].score, 100);
  assert.equal(r.list[0].depth_ft, 32.2);
});

test('a DNR attractor and the Garmin buoy on top of it are one attractor', () => {
  const r = nearbyStructuresFrom(
    { attractors: [{ lat: LAT + 0.00010, lon: LON, name: 'garmin buoy' }] },   // ~11 m away
    LAT, LON, 2.0,
    { dnrAttractors: [{ lat: LAT, lon: LON, name: 'SCDNR brush pile', source: 'SCDNR' }] });
  assert.equal(r.total, 1);
  assert.equal(r.list[0].name, 'SCDNR brush pile');   // the authority wins
  assert.equal(r.list[0].source, 'SCDNR');
});

test('two attractors far enough apart are two attractors', () => {
  const r = nearbyStructuresFrom(
    { attractors: [{ lat: LAT + 0.002, lon: LON, name: 'garmin buoy' }] },
    LAT, LON, 2.0,
    { dnrAttractors: [{ lat: LAT, lon: LON, name: 'SCDNR brush pile' }] });
  assert.equal(r.total, 2);
  assert.equal(r.counts.fish_attractor, 2);
});

test('a DNR row with junk coordinates does not become an attractor at null island', () => {
  const r = nearbyStructuresFrom({}, LAT, LON, 2.0, {
    dnrAttractors: [{ lat: 'n/a', lon: undefined, name: 'bad row' },
                    { lat: LAT, lon: LON, name: 'good row' }] });
  assert.equal(r.total, 1);
  assert.equal(r.list[0].name, 'good row');
});
