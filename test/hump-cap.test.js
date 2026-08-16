// The profile carried every hump on the lake, and the lake decided how big that was.
//
// COUNTED OFF THE REAL PACKS, 2026-08-16, from chartpack/<slug>/structure.geojson:
//
//     wateree_lake                  392 humps  ->  humpCoordinates  60,490 bytes
//     hartwell_lake               1,751 humps  ->                  272,525 bytes
//     j_strom_thurmond_reservoir  3,531 humps  ->                  549,450 bytes
//
// storage.js writes the profile with JSON.stringify(master, null, 2), so those are the bytes
// that land in R2. Thurmond's saved profile warned at 810,424 against its own 250KB limit, and
// the profile rides into every agent prompt — which is why habitat's prompt measured 402,757
// characters in wrangler tail, and why truncating extracted facts could not shrink it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capHumps, HUMP_MARKER_CAP } from '../js/utils/structure-markers.js';

const hump = (i, relief, area) => ({
  id: `h${i}`, lat: 34.0 + i * 0.001, lon: -82.5 + i * 0.001,
  depth_ft: 20 + (i % 30), area_acres: area, relief_ft: relief, levels: 3,
});
const humps = (n, reliefOf = (i) => (i % 17) + 1) =>
  Array.from({ length: n }, (_, i) => hump(i, reliefOf(i), 5 + (i % 40)));

test("Wateree's 392 humps are untouched — the cap sits just above the size this was built at", () => {
  const r = capHumps(humps(392));
  assert.equal(r.coordinates.length, 392);
  assert.equal(r.total, 392);
  assert.equal(r.note, null, 'nothing was dropped, so nothing is claimed');
});

test("Thurmond's 3,531 are capped, and the count survives the cut", () => {
  const r = capHumps(humps(3531));
  assert.equal(r.coordinates.length, HUMP_MARKER_CAP);
  // The lake still reports how many it has. A capped list that also reported 400 as the total
  // would turn a display limit into a fact about the water.
  assert.equal(r.total, 3531);
  assert.match(r.note, /3531 humps mapped/);
  assert.match(r.note, new RegExp(`${HUMP_MARKER_CAP} with the most relief`));
});

test('the ones kept are the ones worth stopping on, not the first ones in the file', () => {
  // Relief ascends with index, so a naive slice would keep the 400 flattest humps on the lake.
  const r = capHumps(humps(1000, (i) => i + 1));
  const kept = r.coordinates.map((h) => h.reliefFt);
  assert.equal(kept.length, HUMP_MARKER_CAP);
  assert.equal(kept[0], 1000, 'the highest-relief hump must be first');
  assert.ok(Math.min(...kept) > 500, `expected the top by relief, got a minimum of ${Math.min(...kept)}`);
  for (let i = 1; i < kept.length; i += 1) assert.ok(kept[i] <= kept[i - 1], 'relief must descend');
});

test('area breaks a relief tie — a 30-acre flat top beats a 5-acre one at the same rise', () => {
  const tied = [hump(1, 6, 5), hump(2, 6, 30), hump(3, 6, 12)];
  const r = capHumps(tied, 3);
  assert.deepEqual(r.coordinates.map((h) => h.areaAcres), [30, 12, 5]);
});

test('the serialised block is bounded no matter how many the lake has', () => {
  // 3,531 humps used to serialise to ~549 KB inside a pretty-printed profile.
  const big = JSON.stringify(capHumps(humps(3531)).coordinates, null, 2);
  assert.ok(big.length < 100000, `capped block should be well under 100 KB, was ${big.length}`);
});

test('empty and malformed input do not throw', () => {
  assert.equal(capHumps([]).coordinates.length, 0);
  assert.equal(capHumps(null).total, 0);
  assert.equal(capHumps([{ id: 'x', lat: 1, lon: 2 }]).coordinates[0].reliefFt, null);
});
