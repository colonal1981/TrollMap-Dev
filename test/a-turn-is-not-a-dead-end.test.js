// A loop turns where it can turn, and comes home beside its way out only where the water makes it.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-04, on the loops laid live that day: Moultrie from Short Stay, the first loop went
// round the hump south-west of the ramp, turned at its tip and came home within 25 m of its way out
// for 300 m -- "i do not like this part of the purple leg"; Wateree from Clearwater Cove, the third
// loop turned in the pocket at the dam and came back out of it on its own track -- "the cyan leg does
// the same thing as moultrie". The end of a loop the way home may share with the way out grew,
// step by step, at the turn as at the cove mouth (to 1.6 km), until a way home was found; it now
// grows only at the cove mouth, which every loop has to leave by. A turn whose way home can only
// leave on the way out's water is a dead end: the loop is still laid, and comes after every loop
// whose way home kept clear.
//
// And on Marion from Rowland Subdivision: "it stops right before i would want to head towards potato
// creek. But i could easily just go that way and then turn around and come back and then finish the
// leg as planned". The channel toward Potato Creek is 100-190 m wide at that day's 23 ft. Told to
// turn up it, the loop came home on its way out from end to end, up the creek as well; now the way
// home crosses the way out's water only where there is no room for two lines.
//
// The lake is the loop test's: a channel 16 km long and 600 m wide, the ramp on the north bank
// halfway along. North of it, a pocket 100 m wide and 560 m long with three of his catches in it,
// and further east an arm 50 m wide and 2 km long.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trollLoop, sharedWaterM, marksAlong, fishBeforeFilling, SAME_WATER_M } from '../js/modules/plan-troll-loop.js';

const LAT0 = 34.0, KX = 111320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110540;
const at = (x, y) => [-80 + x / KX, LAT0 + y / KY];
const L = 16000, W = 600, MAXFT = 45;
const yOf = (ft) => (Math.asin(Math.min(1, ft / MAXFT)) * W) / Math.PI;
const rect = (x0, y0, x1, y1, ft) => ({ type: 'Feature', properties: { depth_max_ft: ft },
  geometry: { type: 'Polygon', coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]] } });
const xOf = (pt) => (pt[0] + 80) * KX;
const yAt = (pt) => (pt[1] - LAT0) * KY;

// The pocket and the arm are cut through the north bank's shallow bands, 25 ft from the channel's
// 25 ft contour to their heads.
const POCKET = [4950, 5050, 1080], ARM = [10975, 11025, 2600];
const DA = [];
for (let ft = 0; ft < MAXFT; ft += 5) {
  const a = yOf(ft), b = yOf(ft + 5);
  DA.push(rect(0, a, L, b, ft + 5));                                   // south side
  if (ft + 5 >= 25) { DA.push(rect(0, W - b, L, W - a, ft + 5)); continue; }
  DA.push(rect(0, W - b, POCKET[0], W - a, ft + 5));                   // north side, round the cuts
  DA.push(rect(POCKET[1], W - b, ARM[0], W - a, ft + 5));
  DA.push(rect(ARM[1], W - b, L, W - a, ft + 5));
}
DA.push(rect(0, yOf(MAXFT - 0.01), L, W - yOf(MAXFT - 0.01), MAXFT));
DA.push(rect(POCKET[0], W - yOf(25), POCKET[1], POCKET[2], 25));
DA.push(rect(ARM[0], W - yOf(25), ARM[1], ARM[2], 25));
const RAMP = at(8000, W - 10);
const BASE = { ramp: RAMP, daFeatures: DA, floorFt: 20, windowMin: 180, stopMin: 0, maxPetals: 1 };
const inPocket = (pt) => xOf(pt) > POCKET[0] - 30 && xOf(pt) < POCKET[1] + 30 && yAt(pt) > W - yOf(25) + 50;
// His fish are at the head of the pocket, 500 m and more in from its mouth.
const pocketFish = [1060, 1030, 1000].map((y) => ({ at: at(5000, y) }));

// WITH HIS FISH IN THE POCKET the day is options from them (2026-10-05): see the-day-is-options.test.js.
// The rules here are the contour loop's, on water where none of his catches are within reach, where a
// click on the map is where a loop turns.
test('the head of a pocket is not where a contour loop turns, if it has to come back out on its own track', () => {
  const r = trollLoop({ ...BASE });
  assert.ok(!r.error, r.error);
  const p = r.petals[0];
  const turn = p.out[p.out.length - 1];
  // A turn has 2 x 100 m where the way home may come back beside the way out, and no more: a loop may
  // dip that far into the pocket (and cross its own way in at the mouth), not run up to its head.
  assert.ok(!inPocket(turn) || yAt(turn) < POCKET[2] - 2 * SAME_WATER_M,
    `turned at ${xOf(turn).toFixed(0)}, ${yAt(turn).toFixed(0)} -- at the head of the pocket`);
  assert.equal(r.score.fish, 0);
  // and it comes home on other water, as every loop that turns in open water does
  assert.ok(r.sharedM < 0.1 * r.trolledM, `${r.sharedM} m of ${r.trolledM} m trolled twice`);
});

test('the order: a loop whose way home kept clear comes before one that turned in a dead end', () => {
  const day = (fish, kept) => ({ m: 9000, newM: 8900, backM: 4500, kept, score: { fish, structure: 0 } });
  assert.equal([day(3, false), day(0, true)].sort(fishBeforeFilling(8000))[0].score.fish, 0);
  // a day built by the old rules, with no word on it, is as it was
  assert.equal([day(3, undefined), day(0, true)].sort(fishBeforeFilling(8000))[0].score.fish, 3);
});

test('a turn he ticked in the pocket is where the loop turns, and only the pocket is trolled twice', () => {
  const r = trollLoop({ ...BASE, via: [at(5000, 1040)] });
  assert.ok(!r.error, r.error);
  const p = r.petals[0];
  assert.ok(inPocket(p.out[p.out.length - 1]));
  assert.equal(marksAlong(p.out, pocketFish, SAME_WATER_M).length, 3);
  assert.ok(r.sharedM < POCKET[2] - W, `${r.sharedM} m trolled twice; the pocket is ${POCKET[2] - W} m`);
});

test('ticked up an arm too narrow for two lines, the way home shares the arm and not the channel', () => {
  const r = trollLoop({ ...BASE, via: [at(11000, 2500)] });
  assert.ok(!r.error, r.error);
  const p = r.petals[0];
  assert.ok(yAt(p.out[p.out.length - 1]) > 2000, 'turned up the arm');
  const armM = ARM[2] - W;
  // The way home up the channel is the channel's other edge, not the way out again.
  const inChannel = (pt) => yAt(pt) < W;
  const outCh = p.out.filter(inChannel), backCh = p.back.filter(inChannel);
  assert.ok(outCh.length > 1 && backCh.length > 1);
  const chShared = sharedWaterM(outCh, backCh);
  assert.ok(chShared < 0.25 * armM, `${chShared.toFixed(0)} m of the channel trolled twice`);
  // All that is trolled twice is the arm, which has room for one line.
  assert.ok(r.sharedM < armM + 2 * SAME_WATER_M, `${r.sharedM} m trolled twice; the arm is ${armM} m`);
});

test('what the code says, in his words', () => {
  const src = fs.readFileSync(new URL('../js/modules/plan-troll-loop.js', import.meta.url), 'utf8');
  assert.ok(src.includes('near(c, S, ends * sameM) || near(c, T, 2 * sameM)'));
  assert.ok(src.includes("i do not like this part"));
  assert.ok(src.includes('just go that way and then turn around and come back and then finish the leg'));
  assert.ok(!src.includes('[o.wanderM || 25, 2], [0, 0]'));
});
