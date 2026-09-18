// The route between two points on a river day is the river between them.
//
// Ryan, 2026-09-18, after being shown a survey of water graphs: "it is literally keep me in the
// middle of the river let me go over fish holding structure until the app turns me around and then
// i go back to the ramp and i am done for day... why are we making this more complicated than
// that". He was right and the whole graph question was the wrong one for moving water.
//
// A lake day crosses open water between spots and needs a router to find a way round the land. A
// river day does not. So assemblePlan() asking the Worker's MAR graph for every river transit was
// answering a question the river already answers: surveyed across all 57 river packs that day,
// 8 could route as far as one day, the median river could route 21% of its own line, and
// broad_river and pee_dee_river_2 could route nothing at all. Every one of those came back
// `422 no route`, fell to a straight line between two leg ends, and shipped with an understated
// amp-hour figure behind a clean status line.
//
// This is the fixture that would have caught it: a hairpin, where a straight line between two
// points 2 km apart along the water is 200 m across the neck. If the transit is the straight line,
// the distance is wrong by 10x and the track crosses the land inside the bend.
//
// Personal use only, not for distribution or resale; not for navigation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centrelineTransit } from '../js/modules/river-drifts.js';

const STEP = 50;

/** A river with a hairpin: east 1 km, back west 1 km, 200 m to the north. */
function hairpin() {
  const pts = [];
  const dx = STEP / (111320 * Math.cos(33.9 * Math.PI / 180));
  for (let i = 0; i < 21; i++) pts.push([-81 + i * dx, 33.9]);                 // out
  for (let i = 1; i <= 4; i++) pts.push([-81 + 20 * dx, 33.9 + i * (STEP / 111320)]);
  for (let i = 1; i <= 20; i++) pts.push([-81 + (20 - i) * dx, 33.9 + 4 * (STEP / 111320)]);
  const stationM = pts.map((_p, i) => i * STEP);
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: pts },
      properties: { slug: 'test_river', step_m: STEP, station_m: stationM,
                    station_span_m: stationM[stationM.length - 1],
                    bearing_deg: pts.map(() => 90), width_m: pts.map(() => 80) },
    }],
  };
}

const FC = hairpin();
const LINE = FC.features[0].geometry.coordinates;
const STN = FC.features[0].properties.station_m;
const LAST = STN.length - 1;

const metres = (a, b) => {
  const k = Math.PI / 180;
  const x = (b[0] - a[0]) * k * 6371000 * Math.cos(((a[1] + b[1]) / 2) * k);
  const y = (b[1] - a[1]) * k * 6371000;
  return Math.hypot(x, y);
};

test('the route between two ends is the water, not the neck of the bend', () => {
  const t = centrelineTransit(FC);
  assert.equal(typeof t.route, 'function', 'centrelineTransit has to offer a route at all');
  const a = LINE[0], b = LINE[LAST];
  const r = t.route(a, b);
  assert.ok(r, 'a pair on the line has to route');
  const straight = metres(a, b);
  assert.equal(r.distanceM, STN[LAST], 'the distance is river metres, the axis the resampler laid');
  assert.ok(r.distanceM > straight * 4,
            `the river is ${Math.round(r.distanceM)} m and the neck is ${Math.round(straight)} m -- `
            + 'a transit that reported the neck would understate the amp-hours by that ratio');
  assert.equal(r.coordinates.length, STN.length, 'every station between them is on the track');
  assert.deepEqual(r.coordinates[0], a.slice(0, 2), 'it starts where the boat is');
  assert.deepEqual(r.coordinates[r.coordinates.length - 1], b.slice(0, 2), 'and ends where it is going');
});

test('and the same number transit() reports, because a river has one transit distance', () => {
  const t = centrelineTransit(FC);
  const a = LINE[4], b = LINE[30];
  assert.equal(t.route(a, b).distanceM, t(a, b),
               'the geometry and the distance cannot disagree about how far it is');
});

test('upstream is drawn the way the boat goes', () => {
  const t = centrelineTransit(FC);
  const down = t.route(LINE[2], LINE[18]);
  const up = t.route(LINE[18], LINE[2]);
  assert.equal(up.distanceM, down.distanceM, 'the same water either way');
  assert.deepEqual(up.coordinates[0], LINE[18].slice(0, 2), 'upstream starts at the downstream end');
  assert.deepEqual(up.coordinates.slice().reverse(), down.coordinates,
                   'and is the same track reversed, so the GPX reads as a course');
});

test('two reaches that meet have no transit between them', () => {
  // Which on a river day is most of them: the day is one path out and back, so a leg usually
  // starts exactly where the last one finished. A two-point line of zero length there would draw
  // a track the boat never runs.
  const t = centrelineTransit(FC);
  const r = t.route(LINE[10], LINE[10]);
  assert.equal(r.distanceM, 0, 'no hop');
  assert.equal(r.coordinates.length, 2, 'and nothing but the point it is standing on');
});

test('a point beside the line still routes, because the ramp is never exactly on it', () => {
  const t = centrelineTransit(FC);
  // 30 m north of station 6 -- a launch on the bank.
  const off = [LINE[6][0], LINE[6][1] + 30 / 111320];
  const r = t.route(off, LINE[16]);
  assert.ok(r, 'it projects to the nearest station and routes from there');
  assert.equal(r.distanceM, STN[16] - STN[6], 'measured between the two stations it projected to');
});

test('a line with no stations cannot route, and says so rather than guessing', () => {
  const bare = { type: 'FeatureCollection', features: [{ type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[-81, 33.9]] }, properties: {} }] };
  assert.equal(centrelineTransit(bare), null, 'one point is not a river');
});
