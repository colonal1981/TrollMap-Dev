// After the first loop, the day goes round the same water again a steering band shallower or deeper.
// His fish count only on this water and within reach of the ramp. There is no floor.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-04, on the single loop Rowland Subdivision gave him down Wyboo Creek: "i still don't
// understand why you picked the middle range and subtracted 5ft... this sounds like AI math not any real
// fishing strategy? that sounds like an excuse to keep it at one loop instead of concentric loops around
// the same creek which is what i would actually fish". And: "just a fish being caught somewhere on that
// lake shouldn't count... it needs to be within reach from a landing... a fish in the congaree river
// above lake marion is a totally different fish than one caught in wyboo creek".
//
// The synthetic channel of the-day-is-a-loop-from-the-ramp.test.js: 16 km long, 600 m wide, 45 ft in
// the middle, shoaling to both banks in 5 ft bands, the ramp on the north bank halfway along.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trollLoop, fishBeforeFilling, linesSaid, SAME_WATER_M } from '../js/modules/plan-troll-loop.js';
import { metresBetween } from '../js/modules/plan-candidates.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
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
const RAMP = at(8000, W - 10);
// Six of his fish in the first mile and a half east of the ramp, on both edges, over 25 ft of chart.
const FISH = [8600, 9000, 9400].flatMap((x) => [at(x, yOf(25)), at(x, W - yOf(25))]).map((a) => ({ at: a, chartFt: 25 }));
const turnOf = (p) => p.out[p.out.length - 1];

test('the first loop rides the depth with the most of his fish; the next goes round the same water a band over', () => {
  const r = trollLoop({ ramp: RAMP, daFeatures: DA, windowMin: 300, stopMin: 0, catches: FISH, minM: 400 });
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.line, { lineFt: 25, from: 'catches', n: 6, inBand: 6, rangeFt: [25, 25] });
  assert.ok(r.petals.length >= 2, `${r.petals.length} loops`);
  const [first, second] = r.petals;
  assert.equal(first.lineFt, 25);
  assert.equal(Math.abs(second.lineFt - 25), 5, `second loop on ${second.lineFt} ft`);
  // round the same water: it turns where the first did, within the distance a turn is looked for in
  assert.ok(metresBetween(turnOf(first), turnOf(second)) <= 3 * SAME_WATER_M + 50,
    `turns ${metresBetween(turnOf(first), turnOf(second)).toFixed(0)} m apart`);
  // past his fish again: each fish once in the day, every time past it in passes
  assert.equal(r.score.fish, 6);
  assert.ok(r.score.passes >= 12, `${r.score.passes} times past them`);
  // and mostly new water, the rule the day stops on
  for (const p of r.petals.slice(1)) assert.ok(p.sharedM <= p.m - p.sharedM, `${p.sharedM} of ${p.m} m twice`);
  assert.match(linesSaid(r), /^the 25 ft line; loop 2 round the same water on (20|30) ft/);
});

test('a loop on another line may cross the first; what the two share is counted instead', () => {
  const src = read('../js/modules/plan-troll-loop.js');
  // closed to the loops after it only on its own line
  assert.ok(src.includes('if (p.lineFt !== lineFt) continue;'));
  // shared within his wander, and a double back judged on its own line only
  assert.ok(src.includes('withinM: q.lineFt === lineFt ? sameM : wanderM'));
  assert.ok(src.includes('const own = Number.isFinite(t.cleanSharedM) ? t.cleanSharedM : t.m - t.newM;'));
});

test('his catches count only on this water and within reach of the ramp by water', () => {
  const offChart = { at: at(9000, W / 2), chartFt: null };          // a pin the chart does not hold
  const beyond = { at: at(13600, W / 2), chartFt: 45 };              // on the chart, 5.6 km out by water
  const offGrid = { at: at(15800, W / 2), chartFt: 45 };             // past the grid altogether
  // a fish on another lake: off this chart, and far away -- off the water, not "out of reach"
  const otherLake = { at: at(200, W / 2), chartFt: null };
  const r = trollLoop({ ramp: RAMP, daFeatures: DA, windowMin: 180, stopMin: 0, minM: 400,
                        catches: [...FISH, offChart, beyond, offGrid, otherLake] });
  assert.ok(!r.error, r.error);
  // 180 min at 2 mph is 9.7 km trolled: half of it, 4.8 km, is as far as any loop gets
  assert.equal(r.catches.reachM, 4828);
  assert.deepEqual({ used: r.catches.used, offWater: r.catches.offWater, outOfReach: r.catches.outOfReach },
                   { used: 6, offWater: 2, outOfReach: 2 });
  // the 45 ft fish out of reach did not move the line
  assert.equal(r.lineFt, 25);
});

test('of two days past as many of his fish, the one past them more often wins; then the one that fills', () => {
  const order = fishBeforeFilling(10000);
  const day = (fish, passes, newM, structure = 0) => ({ m: newM, newM, backM: newM / 2, kept: true, score: { fish, passes, structure } });
  const round = day(4, 8, 8000), far = day(4, 4, 12000, 50), more = day(5, 5, 6000);
  assert.deepEqual([far, round].sort(order), [round, far]);    // round his fish again, not miles out
  assert.deepEqual([round, more].sort(order), [more, round]);  // a fish more beats going round again
  assert.deepEqual([day(4, 4, 8000), day(4, 4, 12000)].sort(order).map((t) => t.newM), [12000, 8000]);
  // and a double back is still last, whatever it passes
  const back = { ...day(6, 12, 8000), newM: 2000, backM: 4000 };
  assert.deepEqual([back, round].sort(order), [round, back]);
});

test('a loop after the first is one he would fish: his shortest pass at least, and mostly new water', () => {
  const r = trollLoop({ ramp: RAMP, daFeatures: DA, windowMin: 300, stopMin: 0, catches: FISH, minM: 3000 });
  assert.ok(!r.error, r.error);
  for (const p of r.petals.slice(1)) assert.ok(p.m >= 6000, `a ${p.m} m loop under two 3 km passes`);
  const src = read('../js/modules/plan-troll-loop.js');
  assert.ok(src.includes('const minLegM = Number(o.minM) > 0 ? Number(o.minM) : 0;'));
  assert.ok(src.includes('&& q.sharedM <= q.newM;'));
});

test('the status line and the bar say each loop\'s line and its alarm edge, not one floor for the day', () => {
  const ui = read('../js/modules/plan-water-ui.js');
  const lom = read('../js/modules/loop-on-map.js');
  assert.doesNotMatch(ui, /never over water under/);
  assert.doesNotMatch(lom, /never over water `/);
  assert.ok(ui.includes('the depth with the most of your ${ln.n} ${sp} catch'));
  assert.ok(lom.includes("`${p.edgeFt != null ? `, never under ${Math.round(p.edgeFt)} ft` : ''}: ${mi(out)} out, ${mi(back)} home`"));
  assert.ok(ui.includes('no loop goes shallower than the shallow edge of its own Contour alarm'));
  // the planned lake's chart goes under its loop, so the catch markers are judged against it
  assert.ok(lom.includes('if (now.lake) window.loadSupplementalForLake?.(now.lake);'));
});

test('a loop does not cut across water shallower than its alarm edge to reach a turn: it goes round', () => {
  // Ryan, 10/4, a turn clicked on the east-west channel west of Wyboo Creek, on the first build with no
  // edge: "the loops went from following the correct depth to cutting straight across that shallow
  // spot... so the route that is supposed to be over 28 ft of water now runs through 14ft".
  // Two channels side by side, a 10 ft flat between them for 14 km, joined deep at the east end.
  const W2 = 1000;
  const DA2 = [];
  const J = 14000;                            // the banks between them stop here, and it is all deep east of it
  for (let ft = 0; ft < MAXFT; ft += 5) {
    const a = yOf(ft), b = yOf(ft + 5);
    DA2.push(rect(0, a, L, b, ft + 5), rect(0, W - b, J, W - a, ft + 5));                  // channel 1
    DA2.push(rect(0, W2 + a, J, W2 + b, ft + 5), rect(0, W2 + W - b, L, W2 + W - a, ft + 5)); // channel 2
  }
  DA2.push(rect(0, yOf(MAXFT - 0.01), L, W - yOf(MAXFT - 0.01), MAXFT));
  DA2.push(rect(0, W2 + yOf(MAXFT - 0.01), L, W2 + W - yOf(MAXFT - 0.01), MAXFT));
  DA2.push(rect(0, W, J, W2, 10));                                          // the flat
  DA2.push(rect(J, W - yOf(MAXFT - 0.01), L, W2 + yOf(MAXFT - 0.01), MAXFT)); // the deep join
  const ramp = at(8000, 10);
  const via = [at(8000, W2 + yOf(25))];
  const catches = [{ at: at(8500, yOf(25)), chartFt: 25 }];
  const r = trollLoop({ ramp, daFeatures: DA2, windowMin: 720, stopMin: 0, catches, via, maxPetals: 1 });
  assert.ok(!r.error, r.error);
  const p = r.petals[0];
  assert.equal(p.lineFt, 25);
  // nothing of the loop is over the flat west of the join
  const yOfPt = (pt) => (pt[1] - LAT0) * KY, xOfPt = (pt) => (pt[0] + 80) * KX;
  for (const half of [p.out, p.back]) for (const pt of half) {
    const x = xOfPt(pt), y = yOfPt(pt);
    assert.ok(!(y > W + 30 && y < W2 - 30 && x < 13900), `over the flat at x ${x.toFixed(0)}, y ${y.toFixed(0)}`);
  }
  // it went round by the join
  assert.ok(Math.max(...p.out.concat(p.back).map(xOfPt)) > 14000);
});
