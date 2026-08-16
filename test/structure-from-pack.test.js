// Humps and ledges come from the pack, uncapped, not from the research profile.
//
// FIXTURE PROPERTIES ARE REAL — the exact shape chartpack/<slug>/structure.geojson carries,
// read off wateree_lake on 2026-08-16:
//
//   {"kind":"hump","id":"hump_1","score":82.9,"depth_ft":18.0,"area_acres":5.6,
//    "relief_ft":14.1,"levels":15}
//   {"kind":"ledge","id":"ledge_1","score":100.0,"depth_ft":32.2,
//    "slope_ft_per_100ft":38.4,"drop_ft":6.3,"run_ft":16.0}
//
// Counted the same day: wateree_lake 392 humps / 6,926 ledges,
// j_strom_thurmond_reservoir 3,531 humps / 45,876 ledges. As profile fields those were 549 KB
// of an 810 KB document. Ryan, on capping them instead of moving them: "how can i do all
// casting stops instead of trolling lanes if i want to if you cap everything out arbitrarily".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humpsFromPack, ledgesFromPack, structureFor } from '../js/utils/structure-markers.js';

const hump = (i, relief, area) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-80.733055 - i * 0.001, 34.376457 + i * 0.001] },
  properties: { kind: 'hump', id: `hump_${i}`, score: 80, depth_ft: 18, area_acres: area, relief_ft: relief, levels: 15 },
});
const ledge = (i, slope) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-80.70235 - i * 0.001, 34.34317 + i * 0.001] },
  properties: { kind: 'ledge', id: `ledge_${i}`, score: 100, depth_ft: 32.2, slope_ft_per_100ft: slope, drop_ft: 6.3, run_ft: 16 },
});
const pack = (nh, nl) => ({
  type: 'FeatureCollection',
  features: [
    ...Array.from({ length: nh }, (_, i) => hump(i, (i % 40) + 1, 5 + (i % 30))),
    ...Array.from({ length: nl }, (_, i) => ledge(i, (i % 60) + 1)),
  ],
});

test("every hump on the lake comes through — Thurmond's 3,531, not a cap", () => {
  const p = pack(3531, 45876);
  assert.equal(humpsFromPack(p).length, 3531);
  assert.equal(ledgesFromPack(p).length, 45876);
});

test('humps are ordered by relief, ledges by slope, so the best candidates come first', () => {
  const h = humpsFromPack(pack(200, 0));
  assert.equal(h[0].reliefFt, 40);
  for (let i = 1; i < h.length; i += 1) assert.ok(h[i].reliefFt <= h[i - 1].reliefFt);
  const l = ledgesFromPack(pack(0, 200));
  assert.equal(l[0].slopeFtPer100Ft, 60);
  for (let i = 1; i < l.length; i += 1) assert.ok(l[i].slopeFtPer100Ft <= l[i - 1].slopeFtPer100Ft);
});

test('the real property names are read, not guessed', () => {
  const h = humpsFromPack(pack(1, 0))[0];
  assert.deepEqual(
    { id: h.id, depth: h.depth, areaAcres: h.areaAcres, reliefFt: h.reliefFt, levels: h.levels },
    { id: 'hump_0', depth: 18, areaAcres: 5, reliefFt: 1, levels: 15 });
  assert.equal(h.lat, 34.376457);
  assert.equal(h.lon, -80.733055);
  const l = ledgesFromPack(pack(0, 1))[0];
  assert.equal(l.slopeFtPer100Ft, 1);
  assert.equal(l.dropFt, 6.3);
  assert.equal(l.runFt, 16);
});

test('kinds do not bleed into each other', () => {
  const p = pack(3, 5);
  assert.equal(humpsFromPack(p).length, 3);
  assert.equal(ledgesFromPack(p).length, 5);
  assert.ok(humpsFromPack(p).every((h) => h.slopeFtPer100Ft === undefined));
});

test('the pack wins when it has one', () => {
  const r = structureFor(pack(12, 30), { humpCoordinates: [{ id: 'old', lat: 1, lon: 2 }] });
  assert.equal(r.source, 'pack');
  assert.equal(r.humps.length, 12);
  assert.ok(!r.humps.some((h) => h.id === 'old'));
});

test('a pack with no structure layer falls back to the profile it used to ship in', () => {
  // 43 of the 454 shipped packs have no structure.geojson, and profiles saved before today
  // still carry coordinates. Losing those silently would be the same class of bug as the one
  // that dropped the coordinates in the first place.
  const r = structureFor(null, {
    humpCoordinates: [{ id: 'hump_1', lat: 34.1, lon: -80.7, reliefFt: 9 }],
    ledgeCoordinates: [{ id: 'ledge_1', lat: 34.2, lon: -80.8 }],
  });
  assert.equal(r.source, 'profile');
  assert.equal(r.humps.length, 1);
  assert.equal(r.ledges.length, 1);
});

test('neither one available says so rather than looking like a flat lake', () => {
  const r = structureFor(null, null);
  assert.equal(r.source, 'none');
  assert.equal(r.humps.length, 0);
  assert.equal(r.ledges.length, 0);
});

test('a feature with no usable point is skipped, not shipped as NaN', () => {
  const broken = { type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: null, properties: { kind: 'hump', id: 'x' } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: { kind: 'hump', id: 'y' } },
    hump(1, 5, 5),
  ] };
  assert.equal(humpsFromPack(broken).length, 1);
});
