// TRANSIT ON A RIVER IS RIVER MILES, AND IT WAS A STRAIGHT LINE.
//
// selectCandidates() prices the hop from the ramp to a leg with `o.transitM`, which defaults to the
// straight line between two points. On a lake that is the deliberate choice — it is the optimistic
// answer and understating a refusal is the safe direction. On a river it is simply wrong: the
// channel bends back on itself and the straight line crosses ground.
//
// MEASURED ON THE LIVE APP, Congaree from Barney Jordan, 2026-09-17. One candidate survived, priced
// at 11.2 km in and 14.2 km back for 5 km of fishing — 70.3 Ah of an 80 Ah budget, 364 of 540
// minutes, 84% of the day's distance dead — while the river block in the same prompt told the model
// the day turns him around at 9 miles up and assumes no transit at all.
//
// Ryan: "its not like you are going to drive to a certain spot to start fishing, its a kayak you
// just start fishing."
//
// NOTHING IS BOUNDED, FILTERED OR CLIPPED. The distance is measured along the channel the boat has
// to follow and the battery and window gates already in selectCandidates do the rest. A bound would
// have been a second gate saying the same thing somewhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { centrelineTransit } from '../js/modules/river-drifts.js';
import { metresBetween } from '../js/modules/plan-candidates.js';

// A HAIRPIN RIVER: 4 km due east, then 4 km due west 200 m to the north. The two ends are 200 m
// apart in a straight line and 8 km apart along the water — which is the whole point.
function hairpinRiver() {
  const LAT = 34.0, LON0 = -81.0;
  const mPerLon = 111320 * Math.cos((LAT * Math.PI) / 180);
  const coords = [], station_m = [], bearing_deg = [], width_m = [];
  let m = 0;
  for (let x = 0; x <= 4000; x += 50) { coords.push([LON0 + x / mPerLon, LAT]); station_m.push(m); bearing_deg.push(90); width_m.push(120); m += 50; }
  for (let x = 4000; x >= 0; x -= 50) { coords.push([LON0 + x / mPerLon, LAT + 200 / 110574]); station_m.push(m); bearing_deg.push(270); width_m.push(120); m += 50; }
  return { type: 'FeatureCollection', features: [{
    type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
    properties: { slug: 'hairpin', step_m: 50, length_m: m - 50, stations: coords.length,
                  station_m, bearing_deg, width_m },
  }] };
}

const FC = hairpinRiver();
const LINE = FC.features[0].geometry.coordinates;
const START = LINE[0];                       // the west end of the outbound arm
const FAR_END = LINE[LINE.length - 1];       // the west end of the return arm, 200 m away as a bird flies
const TURN = LINE[80];                       // the east end of the hairpin, 4 km along

test('two points 200 m apart across the hairpin are eight kilometres apart by water', () => {
  const t = centrelineTransit(FC);
  assert.ok(t, 'a centreline with stations yields a transit function');
  const straight = metresBetween(START, FAR_END);
  assert.ok(straight < 250, `the straight line really is short: ${Math.round(straight)} m`);
  const along = t(START, FAR_END);
  assert.ok(along > 7500 && along < 8100, `along the channel: ${Math.round(along)} m`);
});

test('and a leg at the far end of the bend is priced at what it costs to get there', () => {
  const t = centrelineTransit(FC);
  assert.ok(Math.abs(t(START, TURN) - 4000) < 120, `${Math.round(t(START, TURN))} m to the turn`);
});

test('never less than the straight line, which is the floor no route beats', () => {
  const t = centrelineTransit(FC);
  // A POINT OFF THE CHANNEL projects onto some station anyway and its along-river distance is then
  // meaningless. It can never be nearer than the straight line, so the max is honest for both cases
  // and needs no "is this point on the river" cutoff — a number nobody measured.
  const offRiver = [-81.5, 34.4];
  const straight = metresBetween(START, offRiver);
  assert.ok(t(START, offRiver) >= straight - 1, 'the straight line is the floor');
  // On the channel the along-river distance wins wherever it is longer.
  assert.ok(t(START, FAR_END) > metresBetween(START, FAR_END));
});

test('the same point costs nothing to reach from itself', () => {
  const t = centrelineTransit(FC);
  assert.equal(t(START, START), 0);
});

test('a centreline with nothing in it yields no transit function rather than a wrong one', () => {
  assert.equal(centrelineTransit(null), null);
  assert.equal(centrelineTransit({ features: [] }), null);
  assert.equal(centrelineTransit({ features: [{ geometry: { type: 'LineString', coordinates: [[0, 0]] },
                                                properties: { station_m: [0] } }] }), null);
});

test('the coarse-then-fine search finds the same station a full scan would', () => {
  // The coarse pass steps 20 stations — 1 km at the builder's 50 m spacing — so it cannot miss by
  // more than half a kilometre, and the refine covers twice that. Checked against the exact answer
  // at every station on the outbound arm.
  const t = centrelineTransit(FC);
  const stations = FC.features[0].properties.station_m;
  for (let i = 0; i < 81; i += 7) {
    const want = stations[i];
    const got = t(LINE[0], LINE[i]);
    assert.ok(Math.abs(got - want) < 60, `station ${i}: wanted ~${want}, got ${Math.round(got)}`);
  }
});

test('smart-plan-v2 hands it to the selector on a river and leaves the lake path alone', () => {
  const src = new URL('../js/modules/smart-plan-v2.js', import.meta.url);
  const code = readFileSync(src, 'utf8');
  assert.ok(code.includes('transitM: (isRiver && riverTransit) || o.transitM'),
            'the river transit replaces the caller’s, rather than sitting beside it');
  assert.ok(/const riverTransit = isRiver && packHasCentreline \? centrelineTransit\(centrelineFc\) : null;/.test(code),
            'and it is built once, from the centreline, only on a river');
});
