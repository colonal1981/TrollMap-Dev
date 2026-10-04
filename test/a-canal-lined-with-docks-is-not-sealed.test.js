// A canal lined with docks is not sealed.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-03, on Lake Marion from Rowland Subdivision, a Wyboo Creek day: "No loop: no water 23 ft
// deep can be reached from the ramp." The ramp is up a canal 40-60 m wide, and Garmin draws the docks
// down both its banks in the shoreline layer (4-41 m each). Every cell a shore line touches is closed
// -- right for the Pinopolis wall -- so at 25 m the canal closed solid and the nearest open water was
// one cell cut off from the lake, 583 m from 23 ft water. When that happens the run out of the cove is
// found on the depth bands alone and the loop says so; the loops stay on the grid with the shore in it.
//
// A synthetic lake (the one the loop test uses): a channel 16 km long and 600 m wide, 45 ft in the
// middle, and a canal 50 m wide and 300 m long off its north bank, 5 ft deep, with a ramp at its head
// and docks across it from both banks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { trollLoop } from '../js/modules/plan-troll-loop.js';
import { metresBetween } from '../js/modules/plan-candidates.js';

const LAT0 = 34.0, KX = 111320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110540;
const at = (x, y) => [-80 + x / KX, LAT0 + y / KY];
const L = 16000, W = 600, MAXFT = 45;
const yOf = (ft) => (Math.asin(Math.min(1, ft / MAXFT)) * W) / Math.PI;
const rect = (x0, y0, x1, y1, ft) => ({ type: 'Feature', properties: { depth_max_ft: ft },
  geometry: { type: 'Polygon', coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]] } });
const DA = [];
for (let ft = 0; ft < MAXFT; ft += 5) {
  const a = yOf(ft), b = yOf(ft + 5);
  DA.push(rect(0, a, L, b, ft + 5));
  DA.push(rect(0, W - b, L, W - a, ft + 5));
}
DA.push(rect(0, yOf(MAXFT - 0.01), L, W - yOf(MAXFT - 0.01), MAXFT));
DA.push(rect(7975, W - 5, 8025, W + 300, 5));                     // the canal
const line = (pts) => ({ type: 'Feature', properties: { layer: 'shoreline' },
                         geometry: { type: 'LineString', coordinates: pts.map(([x, y]) => at(x, y)) } });
// Docks out from both banks every 40 m down the canal, each 30 m: at 25 m they close it across.
const DOCKS = [];
for (let y = W + 40; y < W + 280; y += 40) {
  DOCKS.push(line([[7975, y], [8005, y]]));
  DOCKS.push(line([[8025, y], [7995, y]]));
}
const BASE = { daFeatures: DA, floorFt: 20, windowMin: 180, stopMin: 0, maxPetals: 1 };
const RAMP_UP_CANAL = at(8000, W + 290);

test('docks across the canal no longer cut the ramp off: the loop is laid, and says how it got out', () => {
  const open = trollLoop({ ...BASE, ramp: RAMP_UP_CANAL });
  assert.ok(!open.error, open.error);
  assert.equal(open.coveCrossesShore, false);

  const docked = trollLoop({ ...BASE, ramp: RAMP_UP_CANAL, shoreFeatures: DOCKS });
  assert.ok(!docked.error, `with the docks: ${docked.error}`);
  assert.equal(docked.coveCrossesShore, true);
  // The way out still starts at the ramp and runs down the canal to the water the loops start on.
  assert.ok(metresBetween(docked.cove[0], RAMP_UP_CANAL) < 1);
  assert.ok(metresBetween(docked.cove[docked.cove.length - 1], docked.start) < 30);
  assert.ok(docked.coveM < 600, `out of the cove ${docked.coveM} m`);
  // And the loops are the same loops: the docks are in the canal, not on the water they fish.
  assert.equal(docked.trolledM, open.trolledM);
});

test('a ramp the shore does not cut off keeps the shore on its way out', () => {
  const onBank = trollLoop({ ...BASE, ramp: at(4000, W - 10), shoreFeatures: DOCKS });
  assert.ok(!onBank.error, onBank.error);
  assert.equal(onBank.coveCrossesShore, false);
});

test('with no water deep enough anywhere, it still says so', () => {
  const r = trollLoop({ ...BASE, ramp: RAMP_UP_CANAL, shoreFeatures: DOCKS, floorFt: 60 });
  assert.match(String(r.error), /no water 60 ft deep can be reached from the ramp/);
});
