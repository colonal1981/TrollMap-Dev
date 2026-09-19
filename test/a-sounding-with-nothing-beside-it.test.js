// A SOUNDING WITH NOTHING BESIDE IT IS THE EDGE OF THE CHART, NOT A DEPTH.
//
// Ryan, on a Congaree plan that put every lipped bait on `cannotUse` for 8.3 km: "i want to know
// why the route goes anywhere near what is charted 1 ft water... i would bet real money that what
// we say is 1 ft deep is probably 2 ft or more above ground at the moment".
//
// The route did not go near 1 ft water. The leg's `maxRunDepthFt: 1` -- which wrote four of that
// plan's eleven warnings -- came off TWO stations 50 m apart whose entire cross-section is one
// column:
//
//     125150   [ -, -, -, 1, 3, 6, -, -, -]     three samples, the 1 has a neighbour
//     125200   [ -, -, -, -, 1, -, -, -, -]     ONE sample, nothing either side
//     125250   [ -, -, -, -, 2, -, -, -, -]     ONE sample, nothing either side
//     125300   [ -, -, -, 4, 7, 8, -, -, -]     three again
//
// A river 135 m wide, neighbouring stations reading 6, 9, 11 and 13 ft, and the chart has least to
// say exactly where it claims the shallowest water. That is what the inside edge of a surveyed area
// looks like.
//
// The rule has no number in it: a sample is an edge reading when it has no charted NEIGHBOUR. The
// envelope's whole job is the shallowest water BESIDE the line, and with nothing either side there
// is no beside. A real bank shoal keeps its depth because it keeps its neighbour.
//
// Measured on congaree_river: reach @119500 goes from a 1 ft floor to a 5 ft floor, 7 isolated
// samples dropped of 161 stations; @111500 keeps its 4 ft, because that 4 has water charted next
// to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolatedSample, riverDriftRuns, LATERALS } from '../js/modules/river-drifts.js';

test('one sample with nothing either side is the edge of the chart', () => {
  assert.equal(isolatedSample([null, null, null, null, 1, null, null, null, null], 4), true);
  assert.equal(isolatedSample([null, null, null, null, 2, null, null, null, null], 4), true);
});

test('but a bank reading with charted water inboard keeps its depth', () => {
  // The real shoal 300 m upstream of those two. The 1 at column 2 has a 2 beside it.
  assert.equal(isolatedSample([null, null, 1, 2, 4, 9, 12, null, null], 2), false);
  assert.equal(isolatedSample([null, null, null, 1, 3, 6, null, null, null], 3), false);
});

test('an edge sample at column 0 is still an edge sample', () => {
  // No left neighbour to have, so the test is whether anything is charted inboard of it.
  assert.equal(isolatedSample([3, null, null], 0), true);
  assert.equal(isolatedSample([3, 7, null], 0), false);
});

test('it says nothing about a column that was never charted', () => {
  // Only a CHARTED sample can be an edge reading; a null is already handled by the -1 convention.
  assert.equal(isolatedSample([null, null, null], 1), false);
  assert.equal(isolatedSample([null, 0, null], 1), false, '0 is uncharted, not a 0 ft sounding');
  assert.equal(isolatedSample(null, 1), false);
  assert.equal(isolatedSample([1, 2, 3], -1), false);
});

test('the rule is about neighbours, not about how many columns are charted', () => {
  // Two samples side by side both survive -- sparse is not the same as isolated. A threshold on
  // the COUNT would have thrown these away and it would have been a number nobody measured.
  const row = [null, null, 4, 5, null, null, null, null, null];
  assert.equal(isolatedSample(row, 2), false);
  assert.equal(isolatedSample(row, 3), false);
});

test('a drift built over an isolated sample reports the station uncharted, not shallow', () => {
  // End to end: a straight river whose middle station has a single 1 ft column, with real water
  // either side of it. The leg must not come back with a 1 ft floor.
  const stations = 60, per = 1 / 111320;
  const station_m = [], bearing_deg = [], width_m = [], depth_profile_ft = [], coords = [];
  for (let i = 0; i < stations; i++) {
    station_m.push(i * 50); bearing_deg.push(90); width_m.push(120);
    coords.push([-81.0 + (i * 50) / (111320 * Math.cos(34 * Math.PI / 180)), 34.0]);
    depth_profile_ft.push(i === 30
      ? [null, null, null, null, 1, null, null, null, null]      // the lone sample
      : [18, 15, 13, 11, 9, 6, 4, 2, null]);
  }
  const fc = { type: 'FeatureCollection', features: [{
    type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
    properties: { slug: 'test_river', step_m: 50, length_m: (stations - 1) * 50, stations,
                  station_m, bearing_deg, width_m, depth_profile_ft,
                  profile_fractions: [0, .125, .25, .375, .5, .625, .75, .875, 1] } }] };
  const runs = riverDriftRuns(fc, { slug: 'test_river', laterals: LATERALS });
  assert.ok(runs.length > 0, 'the river produced a reach');
  for (const r of runs) {
    const env = r.properties.envelope_line_ft || [];
    assert.ok(!env.some((ft) => ft >= 0 && ft <= 2),
              `no station reports 2 ft or less; got ${env.filter((f) => f >= 0 && f <= 2)}`);
    assert.ok(env.includes(-1), 'and the lone sample is marked uncharted instead');
    assert.ok(!(r.properties.shallowest_ft <= 2),
              `shallowest_ft is ${r.properties.shallowest_ft}, not the edge reading`);
  }
});
