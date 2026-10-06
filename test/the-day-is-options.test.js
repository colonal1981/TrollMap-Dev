// With his fish within reach, the day is options: Option 1 from the ramp over the water his fish came
// from, then loops over water like it -- numbered on the map and in the GPX.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-05: "what if these are more like options for me while on the water...a loop that goes
// through the way you just drew them... but if those don't produce fish here are some loops that are
// similar over similar features of water for you try... it can be laid out in the gpx and in the plan as
// like option 1,2,3". His three rules for Option 1, answered "ok lets redraw with those rules", and on
// the pictures "go ahead and build it like you have it":
//   1. it starts at the ramp and is trolled the whole way, holding his depth: his sounder at his own fish
//      with his 5 ft either side, or the deepest water on a river;
//   2. it goes along the edge his fish are on, round or along what they are by, and back on the other side;
//   3. no option goes on water more open than water he has fished on that lake.
//
// What these hold (plan-options.js lakeOptions(), the map in loop-on-map.js, the unit in plan-tracks.js):
//   1. fish round an island: Option 1 goes all the way round it, from the ramp and back;
//   2. on a river: down the deepest water, turning at the shallow spot past his farthest fish, and back up;
//   3. on a flat: a lap past his fish, out one side and back the other;
//   4. his sounder at his fish sets the depth; a mark the same day beside a fish counts, another day's does not;
//   5. water like his is offered only where it is no more open than water he has fished there;
//   6. with none of his catches within reach, the day is the contour loop as before;
//   7. every option but the first goes on the unit as its own track and flag, named to fit;
//   8. the map draws and numbers them, a click is not a turn, and the plan is built from Option 1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trollLoop } from '../js/modules/plan-troll-loop.js';
import { readingsFor } from '../js/modules/plan-options.js';
import { materialisePlan, optionTrackName, optionTracks, optionWaypoints, optionOfTrack, optionColor, UNIT_CHARS,
         OPTION_SYMBOL } from '../js/modules/plan-tracks.js';
import { state } from '../js/core/state.js';
import { metresBetween } from '../js/modules/plan-candidates.js';
import { buildGPX } from '../js/utils/parsers.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const LAT0 = 34.0, KX = 111320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110540;
const at = (x, y) => [-80 + x / KX, LAT0 + y / KY];
const xOf = (pt) => (pt[0] + 80) * KX;
const yOf = (pt) => (pt[1] - LAT0) * KY;
const ring = (x0, y0, x1, y1) => [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)];
const area = (ft, outer, ...holes) => ({ type: 'Feature', properties: { depth_max_ft: ft },
  geometry: { type: 'Polygon', coordinates: [outer, ...holes] } });
const DAY = { windowMin: 180, stopMin: 0, minM: 805 };

// How many times a closed line goes round a point: the sum of the angles it turns through, over 2 pi.
const windings = (line, p) => {
  let a = 0;
  for (let k = 1; k < line.length; k++) {
    const a0 = Math.atan2(yOf(line[k - 1]) - p[1], xOf(line[k - 1]) - p[0]);
    const a1 = Math.atan2(yOf(line[k]) - p[1], xOf(line[k]) - p[0]);
    let d = a1 - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    a += d;
  }
  return Math.abs(a) / (2 * Math.PI);
};

// AN ISLAND LAKE: 3000 x 2000 m, 10 ft within 100 m of the bank and 30 ft beyond; an island 800 x 200 m
// in the middle ringed by 20 ft water 100 m wide -- Counts Island on Murray, in a box. His fish round it.
const ISLAND = [area(10, ring(0, 0, 3000, 2000), ring(100, 100, 2900, 1900)),
  area(30, ring(100, 100, 2900, 1900), ring(1000, 800, 2000, 1200)),
  area(20, ring(1000, 800, 2000, 1200), ring(1100, 900, 1900, 1100))];
const ISLAND_FT = (x, y) => {
  if (x < 0 || y < 0 || x > 3000 || y > 2000) return null;
  if (x > 1100 && x < 1900 && y > 900 && y < 1100) return null;
  if (x > 1000 && x < 2000 && y > 800 && y < 1200) return 20;
  return x < 100 || y < 100 || x > 2900 || y > 1900 ? 10 : 30;
};
const ROUND = [[1050, 1000], [1500, 850], [1700, 1150], [1950, 1000]]
  .map(([x, y]) => ({ at: at(x, y), chartFt: 20, date: '2026-06-20' }));

test('1. fish round an island: Option 1 goes all the way round it, from the ramp and back', () => {
  const ramp = at(-10, 1000);
  const r = trollLoop({ ...DAY, ramp, daFeatures: ISLAND, catches: ROUND, allCatches: ROUND });
  assert.ok(!r.error, r.error);
  assert.equal(r.mode, 'options');
  const o1 = r.options[0];
  assert.equal(o1.n, 1);
  assert.equal(o1.shape, 'around');
  assert.equal(o1.fish, 4);
  assert.equal(r.score.fish, 4);
  // the lap goes round the island once, and every point of it holds his water less his 5 ft
  assert.ok(windings(o1.ring, [1500, 1000]) > 0.9, `round the island ${windings(o1.ring, [1500, 1000]).toFixed(2)} times`);
  for (const p of o1.ring) {
    const ft = ISLAND_FT(xOf(p), yOf(p));
    assert.ok(ft == null || ft >= 15, `${ft} ft at ${xOf(p).toFixed(0)}, ${yOf(p).toFixed(0)}`);
  }
  // from the ramp, and back to it: the day is two legs of one loop, the way out and the way home
  assert.deepEqual(r.legs.map((l) => [l.petal, l.half]), [[0, 'out'], [0, 'back']]);
  assert.ok(metresBetween(r.legs[0].coords[0], ramp) < 60);
  const home = r.legs[1].coords;
  assert.ok(metresBetween(home[home.length - 1], ramp) < 60);
});

// A RIVER: 4000 m long and 100 m wide, 6 ft for 25 m at each bank and 14 ft between, with a shoal of 8 ft
// across the channel from 2350 to 2600 m -- Bates's shallow spot. His fish every 200 m up to 2300 m.
const RIVER = [area(6, ring(0, 0, 4000, 100), ring(0, 25, 4000, 75)), area(14, ring(0, 25, 2350, 75)),
  area(8, ring(2350, 25, 2600, 75)), area(14, ring(2600, 25, 4000, 75))];
const UPRIVER = [500, 700, 900, 1100, 1300, 1500, 1700, 1900, 2100, 2300]
  .map((x) => ({ at: at(x, 50), chartFt: 14, date: '2026-09-27' }));

test('2. on a river: down the deepest water, turning at the shallow spot past his farthest fish, and back up', () => {
  const r = trollLoop({ ...DAY, ramp: at(0, 50), daFeatures: RIVER, catches: UPRIVER, allCatches: UPRIVER });
  assert.ok(!r.error, r.error);
  const o1 = r.options[0];
  assert.equal(o1.shape, 'river');
  assert.equal(o1.bandFrom, 'deepest');
  assert.equal(o1.info.turnFt, 8);
  assert.equal(r.score.fish, UPRIVER.length);
  // the way out turns on the shoal, and nothing of the day goes past it
  const out = r.legs[0].coords, turn = out[out.length - 1];
  assert.ok(xOf(turn) > 2300 && xOf(turn) < 2600, `turned at ${xOf(turn).toFixed(0)} m`);
  assert.ok(r.legs.every((l) => l.coords.every((c) => xOf(c) < 2600)));
  // down the middle, in the deepest water, except where the bank comes to it
  const inMiddle = out.filter((c) => yOf(c) >= 25 && yOf(c) <= 75).length;
  assert.ok(inMiddle >= 0.9 * out.length, `${inMiddle} of ${out.length} points in the 14 ft`);
});

// A FLAT: a basin 3 km square, 10 ft for 150 m at the bank and 25 ft beyond. Two fish together in the middle.
const FLAT = [area(10, ring(0, 0, 3000, 3000), ring(150, 150, 2850, 2850)), area(25, ring(150, 150, 2850, 2850))];
const PAIR = [[1500, 1500], [1560, 1520]].map(([x, y], i) => ({ at: at(x, y), chartFt: 25, date: '2026-05-16',
  time: i ? '7:40 AM' : '7:10 AM' }));

test('3. on a flat: a lap past his fish, out one side and back the other', () => {
  const r = trollLoop({ ...DAY, ramp: at(-10, 1500), daFeatures: FLAT, catches: PAIR, allCatches: PAIR });
  assert.ok(!r.error, r.error);
  const o1 = r.options[0];
  assert.equal(o1.shape, 'flat');
  for (const f of PAIR) assert.ok(o1.ring.some((c) => metresBetween(c, f.at) <= 200), 'the lap passes each fish');
  // a lap, not a line: it turns at both ends and comes back beside itself
  assert.ok(windings(o1.ring, [1530, 1510]) > 0.9);
});

test('4. his sounder at his fish sets the depth; a mark the same day beside a fish counts, another day\'s does not', () => {
  const fish = [{ at: at(0, 0), date: '2026-09-27', time: '2:53 PM', sounderFt: 9.6 },
                { at: at(1000, 0), date: '2026-09-27', time: '4:06 PM' },
                { at: at(2000, 0), date: '2026-09-27', time: '5:00 PM' }];
  const marks = [{ at: at(1100, 0), date: '2026-09-27', datetime: '2026-09-27T16:10:00', depthFt: 12.5 },
                 { at: at(1050, 0), date: '2026-09-27', datetime: '2026-09-27T11:00:00', depthFt: 30 },
                 { at: at(2000, 10), date: '2026-09-26', datetime: '2026-09-26T17:00:00', depthFt: 20 }];
  assert.deepEqual(readingsFor(fish, marks), [{ from: 'waypoint', ft: 9.6 }, { from: 'mark', ft: 12.5 }]);
  // and the day holds the middle of them, his 5 ft either side
  const r = trollLoop({ ...DAY, ramp: at(-10, 1500), daFeatures: FLAT, allCatches: PAIR,
                        catches: PAIR.map((f, i) => ({ ...f, sounderFt: i ? 21 : 23 })) });
  assert.ok(!r.error, r.error);
  assert.equal(r.kinds[0].bandFrom, 'sounder');
  assert.equal(r.kinds[0].readings, 2);
  assert.deepEqual(r.options[0].band, [17, 27]);
});

// TWO ARMS OF ONE CROSS-SECTION -- 400 m wide, 10 ft for 100 m at each bank and 25 ft in the middle --
// joined at their east ends: the short arm 3 km long, where he has fished; the long one 12 km, its water as
// like his as water can be, and open to four times the fetch along it.
const arm = (x0, x1, y0) => [area(10, ring(x0, y0, x1, y0 + 400), ring(x0, y0 + 100, x1, y0 + 300)),
  area(25, ring(x0, y0 + 100, x1, y0 + 300))];
const ARMS = [...arm(0, 3000, 0), ...arm(-6000, 6000, 1400), area(25, ring(2800, 400, 3000, 1400))];
const HEAD = [[1000, 200], [1080, 220], [1150, 190]].map(([x, y]) => ({ at: at(x, y), chartFt: 25, date: '2026-05-16' }));

test('5. water like his is offered only where it is no more open than water he has fished there', () => {
  const r = trollLoop({ ...DAY, windowMin: 360, ramp: at(-10, 200), daFeatures: ARMS, catches: HEAD, allCatches: HEAD });
  assert.ok(!r.error, r.error);
  assert.equal(r.fishedPoints, 3);
  for (const o of r.options.filter((x) => !x.own)) assert.ok(o.openM <= r.openLimitM, `option ${o.n} open ${o.openM}`);
  assert.ok(r.dropped.length > 0);
  for (const d of r.dropped) assert.ok(d.openM >= r.openLimitM);   // both rounded to the metre
  // the long arm is like his and more open, so none of it is an option
  assert.ok(r.dropped.some((d) => yOf(d.at) > 1400));
  assert.ok(r.options.every((o) => o.ring.every((c) => yOf(c) < 1400)));
});

test('6. with none of his catches within reach, the day is the contour loop as before', () => {
  const r = trollLoop({ ...DAY, ramp: at(-10, 1500), daFeatures: FLAT, lineFt: 25, lineFrom: 'research', maxPetals: 1,
                        catches: [] });
  assert.ok(!r.error, r.error);
  assert.notEqual(r.mode, 'options');
  assert.equal(r.petals[0].lineFt, 25);
});

const OPTS = [
  { n: 1, kind: 0, own: true, shape: 'around', band: [22, 25], bandFrom: 'chart', coords: [at(0, 0), at(100, 0)] },
  { n: 2, kind: 0, own: false, top: 0.42, band: [17.5, 27.5], bandFrom: 'like', coords: [at(500, 0), at(600, 0), at(500, 0)], lengthM: 200 },
  { n: 3, kind: 1, own: true, band: [9.6, 14.6], bandFrom: 'sounder', coords: [at(900, 0), at(1000, 50), at(900, 0)], lengthM: 230 },
  { n: 12, kind: 0, own: false, band: [100.4, 110], bandFrom: 'like', coords: [at(0, 900), at(50, 900)], lengthM: 50 },
  { n: 4, kind: 0, own: true, band: [3, 9], bandFrom: 'deepest', coords: [at(0, 1900), at(50, 1900)], lengthM: 50 },
];

test('7. every option but the first goes on the unit as its own track and flag, named to fit', () => {
  const names = OPTS.map(optionTrackName);
  assert.deepEqual(names, ['Option 1 · 22-25 ft', 'Option 2 · 18-28 ft', 'Option 3 · 10-15 ft', 'Option 12 100-110ft', 'Option 4 · deepest']);
  for (const nm of names) { assert.ok(nm.length <= UNIT_CHARS.track, nm); assert.ok(!nm.includes('.'), nm); }
  const tracks = optionTracks(OPTS, 'r1');
  assert.deepEqual(tracks.map((t) => t.option), [2, 3, 12, 4]);
  assert.deepEqual(tracks.map((t) => t.like), [true, false, true, false]);
  assert.equal(tracks[0].color, optionColor(OPTS[0]));
  assert.notEqual(tracks[1].color, tracks[0].color);
  assert.deepEqual(tracks[0].pts[0], [OPTS[1].coords[0][1], OPTS[1].coords[0][0]]);
  const flags = optionWaypoints(OPTS, 'r1');
  assert.deepEqual(flags.map((w) => w.name), ['Option 2', 'Option 3', 'Option 12', 'Option 4']);
  for (const w of flags) {
    assert.ok(w.name.length <= UNIT_CHARS.name && w.cmt.length <= UNIT_CHARS.comment, `${w.name} / ${w.cmt}`);
    assert.equal(w.sym, OPTION_SYMBOL);
  }
  assert.equal(optionOfTrack('Option 12 100-110ft', OPTS).n, 12);
  assert.equal(optionOfTrack('L1 · 22 ft', OPTS), null);
  // written beside the plan's own legs, which are Option 1, and out to the GPX
  state.DATA = { tracks: [{ name: 'his own', pts: [[34, -80], [34.001, -80]] }], waypoints: [], routes: [] };
  const plan = { legs: [{ id: 'L1', type: 'troll', depthFt: 23, coordinates: [at(0, 0), at(100, 0)], startM: 0, lengthM: 100, stops: [] }] };
  const out = materialisePlan(plan, { launch: at(0, 0), win: {}, options: OPTS });
  assert.equal(out.tracks, 1 + 4);
  assert.deepEqual(state.DATA.tracks.map((t) => t.name),
    ['his own', 'L1 · 23 ft', 'Option 2 · 18-28 ft', 'Option 3 · 10-15 ft', 'Option 12 100-110ft', 'Option 4 · deepest']);
  const gpx = buildGPX(state.DATA);
  assert.ok(gpx.includes('<name>Option 2</name>') && gpx.includes(`<sym>${OPTION_SYMBOL}</sym>`));
  assert.ok(gpx.includes('<name>Option 2 · 18-28 ft</name>') || gpx.includes('Option 2'));
  // and a day that is not options writes none
  materialisePlan(plan, { launch: at(0, 0), win: {} });
  assert.deepEqual(state.DATA.tracks.map((t) => t.name), ['his own', 'L1 · 23 ft']);
});

test('8. the map draws and numbers them, a click is not a turn, and the plan is built from Option 1', () => {
  const ui = read('../js/modules/plan-water-ui.js');
  const lom = read('../js/modules/loop-on-map.js');
  const init = read('../js/core/map-init.js');
  const builder = read('../js/modules/plan-builder.js');
  // his sounder under each fish, every place he has fished, and his marks go to the options
  assert.ok(ui.includes("c.depthSource === 'sounder_at_waypoint' ? Number(c.depth) : NaN"));
  assert.ok(ui.includes('...(T.packLayers || {}), allCatches, sounderMarks,'));
  assert.ok(ui.includes("get(`/${r2Key}/channels.json`).catch(() => null)"));
  assert.ok(ui.includes("if (loop.mode === 'options') {"));
  assert.ok(ui.includes("const laid = T.lastLoop && T.lastLoop.mode === 'options' && trollOrderOf(picked)"));
  assert.ok(ui.includes('materialisePlan(r.plan, { launch: T.ramp, win: window, marks: true, options: laid })'));
  // the main map
  assert.ok(lom.includes("S.options = loop.mode === 'options';"));
  assert.ok(lom.includes('These options are laid from your fish, so a click is not a turn.'));
  assert.ok(lom.includes("'Build Option 1</button></div>'"));
  assert.ok(lom.includes('html: optionBadge(op.n, color)'));
  // the plan's map, and a saved plan drawn again
  assert.ok(init.includes('} else if (t.option) {'));
  assert.ok(builder.includes('optionOfTrack(t.name, p.plan.options)'));
});
