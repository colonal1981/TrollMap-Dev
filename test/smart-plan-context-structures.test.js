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
