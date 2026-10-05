// With his fish within reach, the day is lines between the places he caught them -- not a depth line.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-04, on Moultrie: "if you draw a line from the dam where those 4 fish are clustered and go
// straight north to where the other 4 fish are clustered that is where i troll", "i didn't mean the
// depth... i meant the locations and drawing lines between them", and "there is no 1 depth that gets all
// of them... because they are all in different sections". Then 2026-10-05: "we already know that the one
// depth line is wrong... It should never have been built around 1 depth... that is implying that fish
// are only at 1 singular depth".
//
// What these hold (plan-troll-loop.js fishLines()):
//   1. no loop rides a depth line: the day goes through the places he caught them, across water of any
//      depth between them, near the straight line between two places where the water is open;
//   2. a catch within 100 m of a place's first catch is that place, and a place's water is the
//      shallowest of its fish's;
//   3. the order is the shortest way round the most of his fish the time holds;
//   4. where the way between two places passes the ramp anyway, the day is two loops;
//   5. the way home keeps 100 m off the way out where the water has room;
//   6. a loop never goes under its edge -- the shallowest water its fish came out of less his 5 ft;
//   7. a pocket full of his fish is where the lines go, in and back out the only way there is;
//   8. a turn he clicks is a place the day goes to;
//   9. with none of his catches within reach, the day is the contour loop from the research's water;
//  10. the status line and the bar say the places, not a line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trollLoop, placesOf, bestOrder, loopsOf, turnsReached, SAME_WATER_M } from '../js/modules/plan-troll-loop.js';
import { metresBetween } from '../js/modules/plan-candidates.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const LAT0 = 34.0, KX = 111320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110540;
const at = (x, y) => [-80 + x / KX, LAT0 + y / KY];
const xOf = (pt) => (pt[0] + 80) * KX;
const yOf = (pt) => (pt[1] - LAT0) * KY;
const rect = (x0, y0, x1, y1, ft) => ({ type: 'Feature', properties: { depth_max_ft: ft },
  geometry: { type: 'Polygon', coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]] } });
const lineM = (c) => c.slice(1).reduce((a, p, i) => a + metresBetween(c[i], p), 0);

// A BASIN like Moultrie's: 6 km square, deepening from 10 ft at the bank in 5 ft rings 300 m wide to
// 55 ft in the middle. The ramp on the east bank. His fish in three sections at two depths: a pair over
// 25 ft in the north-west, one over 55 ft in the middle, a pair over 25 ft in the south.
const B = 6000, RING = 300;
const sq = (i) => [at(i, i), at(B - i, i), at(B - i, B - i), at(i, B - i), at(i, i)];
const BASIN = [];
for (let k = 0; k < 10; k++) {
  BASIN.push({ type: 'Feature', properties: { depth_max_ft: 10 + 5 * k },
    geometry: { type: 'Polygon', coordinates: k < 9 ? [sq(k * RING), sq((k + 1) * RING)] : [sq(k * RING)] } });
}
const depthOf = (x, y) => {
  const inset = Math.min(x, y, B - x, B - y);
  return inset < 0 ? null : 10 + 5 * Math.min(9, Math.floor(inset / RING));
};
const fishAt = (x, y) => ({ at: at(x, y), chartFt: depthOf(x, y) });
const RAMP_B = at(B - 20, 3000);
const NW = [fishAt(1000, 5000), fishAt(1050, 5040)], MID = [fishAt(3000, 3000)], S = [fishAt(3000, 900), fishAt(3060, 880)];
const BASE_B = { ramp: RAMP_B, daFeatures: BASIN, windowMin: 540, stopMin: 0, minM: 805 };

test('1. with his fish, no loop rides a depth line: lines through the places he caught them', () => {
  const r = trollLoop({ ...BASE_B, catches: [...NW, ...MID, ...S] });
  assert.ok(!r.error, r.error);
  assert.equal(r.mode, 'fish');
  assert.equal(r.lineFt, null);
  for (const p of r.petals) assert.equal(p.lineFt, null);
  // every fish, in three sections at three depths
  assert.equal(r.score.fish, 5);
  assert.equal(r.places.length, 3);
  // the water under the day runs from the shallowest of them to the deepest -- no one depth
  const depths = r.legs.flatMap((l) => l.coords.map((c) => depthOf(xOf(c), yOf(c)))).filter((d) => d != null);
  assert.ok(Math.max(...depths) - Math.min(...depths) >= 25, `${Math.min(...depths)}-${Math.max(...depths)} ft under the day`);
  // across open water a line between two places is the straight line, near enough: the whole day is no
  // longer than a tenth over the straight lines from the ramp's water through the places and back
  const st = r.start, P = r.places.map((p) => p.at);
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const straight = Math.min(...perms.map((o) => lineM([st, ...o.map((i) => P[i]), st])));
  assert.ok(r.trolledM <= 1.1 * straight, `${r.trolledM} m against ${straight.toFixed(0)} m straight`);
});

test('2. a place is his catches within 100 m of its first, and its water is the shallowest of theirs', () => {
  const fish = [{ at: at(0, 0), ft: 30 }, { at: at(60, 0), ft: 22 }, { at: at(95, 20), ft: 27 }, { at: at(400, 0), ft: 40 }];
  const pl = placesOf(fish, (m) => m.ft, SAME_WATER_M);
  assert.equal(pl.length, 2);
  assert.equal(pl[0].fish.length, 3);
  assert.equal(pl[0].ft, 22);
  // it stands at the catch nearest the middle of its catches
  assert.deepEqual(pl[0].at, at(60, 0));
  assert.equal(pl[1].ft, 40);
});

test('3. the order is the shortest way round the most of his fish the time holds', () => {
  // Four places on a square 1 km a side, the ramp end at one corner (0), and one more 5 km out with a
  // single fish.
  const P = [[0, 0], [1000, 0], [1000, 1000], [0, 1000], [6000, 0]];
  const D = P.map((a) => P.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1])));
  const value = [0, 2, 3, 2, 1];
  const all = bestOrder(D, value, 1e9);
  assert.equal(all.fish, 8);
  const round = bestOrder(D, value, 4100);
  assert.equal(round.fish, 7, 'the far one does not fit in 4.1 km');
  assert.equal(round.m, 4000);
  assert.deepEqual(round.order.slice(1, -1).sort(), [1, 2, 3]);
  // 3.5 km holds two of the three corners: the 3-fish corner and a 2-fish one, the far corner and back
  const two = bestOrder(D, value, 3500);
  assert.equal(two.fish, 5);
  assert.equal(Math.round(two.m), 3414);
  assert.ok(two.order.includes(2));
  // a turn he clicked is on the day whatever it costs in fish
  const withTurn = bestOrder(D, value, 12100, [4]);
  assert.ok(withTurn.order.includes(4));
});

test('4. where the way between two places passes the ramp anyway, the day is two loops', () => {
  // On a line: a place 2 km west of the ramp end and one 2 km east.
  const P = [[0, 0], [-2000, 0], [2000, 0]];
  const D = P.map((a) => P.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1])));
  assert.deepEqual(loopsOf([0, 1, 2, 0], D), [[1], [2]]);
  // two places beside each other out east are one loop
  const Q = [[0, 0], [2000, 0], [2000, 800]];
  const D2 = Q.map((a) => Q.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1])));
  assert.deepEqual(loopsOf([0, 1, 2, 0], D2), [[1, 2]]);
});

// A CHANNEL: 16 km long, 600 m wide, 45 ft in the middle, shoaling to both banks in 5 ft bands; the ramp
// on the north bank halfway along (the loop test's lake).
const L = 16000, W = 600, MAXFT = 45;
const yAtFt = (ft) => (Math.asin(Math.min(1, ft / MAXFT)) * W) / Math.PI;
const DA = [];
for (let ft = 0; ft < MAXFT; ft += 5) {
  const a = yAtFt(ft), b = yAtFt(ft + 5);
  DA.push(rect(0, a, L, b, ft + 5), rect(0, W - b, L, W - a, ft + 5));
}
DA.push(rect(0, yAtFt(MAXFT - 0.01), L, W - yAtFt(MAXFT - 0.01), MAXFT));
const RAMP = at(8000, W - 10);
const BASE = { ramp: RAMP, daFeatures: DA, windowMin: 300, stopMin: 0, minM: 400 };

test('4b. his fish west of the ramp and east of it: two loops, each out and back on its own side', () => {
  const fish = [at(5000, W - yAtFt(25)), at(11000, W - yAtFt(25))].map((a) => ({ at: a, chartFt: 25 }));
  const r = trollLoop({ ...BASE, catches: fish });
  assert.ok(!r.error, r.error);
  assert.equal(r.petals.length, 2);
  const sides = r.petals.map((p) => Math.sign(xOf(p.out[p.out.length - 1]) - 8000)).sort();
  assert.deepEqual(sides, [-1, 1]);
});

test('5. the way home keeps 100 m off the way out where the water has room', () => {
  // His fish along the north edge east of the ramp only: out along them, home on other water.
  const fish = [9000, 10000, 11000].map((x) => ({ at: at(x, W - yAtFt(25)), chartFt: 25 }));
  const r = trollLoop({ ...BASE, catches: fish });
  assert.ok(!r.error, r.error);
  assert.equal(r.score.fish, 3);
  assert.ok(r.sharedM < 0.1 * r.trolledM, `${r.sharedM} m of ${r.trolledM} m trolled twice`);
  assert.ok(r.petals.every((p) => p.kept));
});

test('6. a loop never goes under its edge: the shallowest water its fish came out of less his 5 ft', () => {
  // Ryan, 10/4: "the route that is supposed to be over 28 ft of water now runs through 14ft". Two
  // channels, a 10 ft flat between them for 14 km, joined deep at the east end; his fish in one, a turn
  // in the other.
  const W2 = 1000, J = 14000;
  const D2 = [];
  for (let ft = 0; ft < MAXFT; ft += 5) {
    const a = yAtFt(ft), b = yAtFt(ft + 5);
    D2.push(rect(0, a, L, b, ft + 5), rect(0, W - b, J, W - a, ft + 5));
    D2.push(rect(0, W2 + a, J, W2 + b, ft + 5), rect(0, W2 + W - b, L, W2 + W - a, ft + 5));
  }
  D2.push(rect(0, yAtFt(MAXFT - 0.01), L, W - yAtFt(MAXFT - 0.01), MAXFT));
  D2.push(rect(0, W2 + yAtFt(MAXFT - 0.01), L, W2 + W - yAtFt(MAXFT - 0.01), MAXFT));
  D2.push(rect(0, W, J, W2, 10));
  D2.push(rect(J, W - yAtFt(MAXFT - 0.01), L, W2 + yAtFt(MAXFT - 0.01), MAXFT));
  const r = trollLoop({ ramp: at(8000, 10), daFeatures: D2, windowMin: 720, stopMin: 0,
                        catches: [{ at: at(8500, yAtFt(25)), chartFt: 25 }], via: [at(8000, W2 + yAtFt(25))], maxPetals: 1 });
  assert.ok(!r.error, r.error);
  const p = r.petals[0];
  assert.equal(p.edgeFt, 20);
  for (const pt of p.out.concat(p.back)) {
    assert.ok(!(yOf(pt) > W + 30 && yOf(pt) < W2 - 30 && xOf(pt) < 13900), `over the flat at ${xOf(pt).toFixed(0)}, ${yOf(pt).toFixed(0)}`);
  }
  assert.ok(Math.max(...p.out.concat(p.back).map(xOf)) > 14000, 'round by the join');
});

test('7. a pocket full of his fish is where the lines go, in and back out the only way there is', () => {
  // The dead-end test's pocket: 100 m wide, 560 m long, off the north bank; his three fish at its head.
  const POCKET = [4950, 5050, 1080];
  const DP = [];
  for (let ft = 0; ft < MAXFT; ft += 5) {
    const a = yAtFt(ft), b = yAtFt(ft + 5);
    DP.push(rect(0, a, L, b, ft + 5));
    if (ft + 5 >= 25) { DP.push(rect(0, W - b, L, W - a, ft + 5)); continue; }
    DP.push(rect(0, W - b, POCKET[0], W - a, ft + 5), rect(POCKET[1], W - b, L, W - a, ft + 5));
  }
  DP.push(rect(0, yAtFt(MAXFT - 0.01), L, W - yAtFt(MAXFT - 0.01), MAXFT));
  DP.push(rect(POCKET[0], W - yAtFt(25), POCKET[1], POCKET[2], 25));
  const fish = [1060, 1030, 1000].map((y) => ({ at: at(5000, y) }));
  const r = trollLoop({ ramp: RAMP, daFeatures: DP, windowMin: 180, stopMin: 0, catches: fish });
  assert.ok(!r.error, r.error);
  assert.equal(r.score.fish, 3);
  const p = r.petals[0];
  const turn = p.out[p.out.length - 1];
  assert.ok(yOf(turn) > 950, `turned at y ${yOf(turn).toFixed(0)}, short of his fish at the head`);
  // and the water trolled twice is the pocket, measured and said
  assert.ok(r.sharedM > 0);
});

test('8. a turn he clicks is a place the day goes to', () => {
  const fish = [at(9000, W - yAtFt(25))].map((a) => ({ at: a, chartFt: 25 }));
  const via = [at(11500, yAtFt(25))];
  const r = trollLoop({ ...BASE, catches: fish, via });
  assert.ok(!r.error, r.error);
  const passes = r.legs.some((l) => l.coords.some((c) => metresBetween(c, via[0]) < 150));
  assert.ok(passes, 'the day goes to the turn');
  const t = turnsReached(via, r);
  assert.equal(t[0].reached, true);
  assert.equal(r.score.fish, 1);
});

test('9. with none of his catches within reach, the day is the contour loop on the research\'s water', () => {
  // three hours trolled reach 4.8 km by water; his one fish is 7.9 km out
  const r = trollLoop({ ...BASE, windowMin: 180, maxPetals: 1, lineFt: 25, lineFrom: 'research', catches: [{ at: at(15900, 300), chartFt: 45 }] });
  assert.ok(!r.error, r.error);
  assert.notEqual(r.mode, 'fish');
  assert.equal(r.petals[0].lineFt, 25);
  assert.equal(r.catches.used, 0);
});

test('10. the status line and the bar say the places, not a line', () => {
  const ui = read('../js/modules/plan-water-ui.js');
  const lom = read('../js/modules/loop-on-map.js');
  assert.ok(ui.includes("if (loop.mode === 'fish') {"));
  assert.ok(ui.includes('the shortest way round them by water, '));
  assert.ok(ui.includes('No line between two places goes shallower than the water the fish at either end came out of, less the ${steer} ft '));
  assert.ok(lom.includes("loop.mode === 'fish' ? 'on lines between the places you caught them'"));
  assert.ok(lom.includes("' through the places you caught them'"));
});
