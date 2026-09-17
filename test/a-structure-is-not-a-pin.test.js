// A STRUCTURE IS NOT A PIN.
//
// kindHits() measured the line to a feature's recorded position and every reader since treated that
// as the distance to the thing itself. A hole 40 m off the line that is 30 m across is water the
// bait crosses; a hole 40 m off the line that is 5 m across is not. They scored identically, and the
// flat `maxOffM` was doing the work of "centroid distance minus how big it is" with one number for
// every kind of thing.
//
// Ryan gave the corridor — rods five feet each side of a 3.5 ft kayak, "i might drift at the most
// 50ft to each side of the line", so 15 m — and then, on being told it was being left to something
// he might never notice on the water: "Something that i may or may not ever see when on the water is
// not something that should be left indefinitely to me."
//
// He is right, and the centroid question does not need his eyes: it is arithmetic, and the sizes are
// already on the features.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { featureReachM, structureIndex, kindHits, cumulative }
  from '../js/modules/plan-candidates.js';

const LAT = 34.0, LON0 = -81.0;
const mPerLon = 111320 * Math.cos((LAT * Math.PI) / 180);
const mPerLat = 110574;
const east = (m) => LON0 + m / mPerLon;
const north = (m) => LAT + m / mPerLat;
// A straight line running due east, so an offset north is exactly the distance off the line.
const LINE = [[east(0), LAT], [east(1000), LAT], [east(2000), LAT]];
const CUM = cumulative(LINE);

const hole = (id, atM, offM, acres) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [east(atM), north(offM)] },
  properties: { kind: 'hole', id, depth_ft: 14, ...(acres == null ? {} : { area_acres: acres }) },
});
// A circle of area A has radius sqrt(A/pi); an acre is 4046.8564224 m^2.
const acresFor = (radiusM) => (Math.PI * radiusM * radiusM) / 4046.8564224;

test('an acre of hole is about thirty-six metres of reach', () => {
  const r = featureReachM('hole', { area_acres: 1 });
  assert.ok(Math.abs(r - 35.9) < 0.2, `${r.toFixed(2)} m`);
  // And it round-trips, which is the property every assertion below leans on.
  assert.ok(Math.abs(featureReachM('hole', { area_acres: acresFor(30) }) - 30) < 0.01);
});

test('no area is no claim, and it is zero rather than a guess', () => {
  assert.equal(featureReachM('hole', {}), 0);
  assert.equal(featureReachM('hole', { area_acres: 0 }), 0);
  assert.equal(featureReachM('hole', { area_acres: -3 }), 0);
  assert.equal(featureReachM('hole', { area_acres: 'big' }), 0);
  assert.equal(featureReachM('dock', {}), 0);
});

test('`bulge_m` is NOT a radius, and using it would have been wrong', () => {
  // build_water_features.py measures bulge_m from the midpoint of a 200 m chord to the vertex — how
  // far the shoreline bulges INLAND on a point — and records the feature AT THE TIP. A point with a
  // 221 m bulge does not hold fish 221 m out into the lake; a boat 80 m off the tip is 80 m off the
  // point. Same family for `cove_m`. A ledge's `run_ft` is the run of the fall, across the slope.
  assert.equal(featureReachM('point', { bulge_m: 221 }), 0);
  assert.equal(featureReachM('cove', { bulge_m: 158 }), 0);
  assert.equal(featureReachM('creek_mouth', { cove_m: 90 }), 0);
  assert.equal(featureReachM('ledge', { run_ft: 40 }), 0);
});

test('the distance reported is to the edge, not to the middle', () => {
  const idx = structureIndex([hole('big', 1000, 60, acresFor(30))]);
  const [hit] = kindHits(LINE, CUM, idx, 100, 'hole');
  assert.ok(hit, 'the hole is found');
  assert.ok(Math.abs(hit.d - 30) < 1.5, `60 m to the middle of a 30 m hole is ${hit.d.toFixed(1)} m to its edge`);
});

test('two holes the same distance off score differently, which is the whole point', () => {
  const idx = structureIndex([hole('wide', 600, 40, acresFor(30)), hole('nub', 1400, 40, acresFor(3))]);
  const hits = kindHits(LINE, CUM, idx, 100, 'hole').sort((a, b) => a.d - b.d);
  assert.equal(hits.length, 2);
  assert.ok(Math.abs(hits[0].d - 10) < 1.5, `the 30 m hole reads ${hits[0].d.toFixed(1)} m`);
  assert.ok(Math.abs(hits[1].d - 37) < 1.5, `the 3 m one reads ${hits[1].d.toFixed(1)} m`);
});

test('a line inside a hole is ON it, and zero is what that means', () => {
  // Never negative. A negative would walk straight into scoreWindow's `1 - d/maxOffM` and score
  // ABOVE a direct hit, which is worse than the bug it was meant to fix.
  const idx = structureIndex([hole('over', 1000, 10, acresFor(40))]);
  const [hit] = kindHits(LINE, CUM, idx, 100, 'hole');
  assert.equal(hit.d, 0);
});

test('a big thing whose middle is outside the corridor is still passed', () => {
  // 120 m to the centre of a 60 m hole is 60 m to its edge, and the boat crosses it.
  const far = structureIndex([hole('reaches', 1000, 120, acresFor(60))]);
  assert.equal(kindHits(LINE, CUM, far, 100, 'hole').length, 1);
  // The same distance to something small is still out.
  const nub = structureIndex([hole('doesnt', 1000, 120, acresFor(5))]);
  assert.equal(kindHits(LINE, CUM, nub, 100, 'hole').length, 0);
});

test('it reaches the drift path and NOT the lake runs, which carry baked distances', () => {
  // A lake trolling run arrives with `near` already computed by build_trolling_runs.py, and
  // selectCandidates reads `p.near` rather than joining anything — kindHits is used there only for
  // docks and attractors. So this correction lands on river drifts (which join every hit at plan
  // time) and on those two layers, and NOT on a lake's structure distances. Measured 2026-09-17:
  // Congaree passes within 15 m went 47 of 384 to 95 of 379; Wateree did not move at all.
  // Re-running build_trolling_runs.py is what would carry it to the packs.
  const src = new URL('../js/modules/plan-candidates.js', import.meta.url);
  const code = readFileSync(src, 'utf8');
  assert.ok(/const near = p\.near \|\| \[\];/.test(code),
            'a lake run still reads the distances the pipeline baked in');
  assert.ok(code.includes('const edge = Math.max(0, best - (r.reachM || 0));'),
            'and everything joined at plan time measures to the edge');
});
