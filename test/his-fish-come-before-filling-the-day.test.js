// His fish come before filling the day.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-03, on Lake Marion from Rowland Subdivision: once the canal no longer cut the ramp off,
// the day was one 16.9 mi loop down Wyboo Creek and eight miles into the open lower lake, past 2 of his
// 8 Marion stripers, because a loop that fills the day beat every loop that did not. He drew the loop he
// would troll -- down one side of the creek channel, back up the other, past most of the 7 he caught
// there -- "something like this for a troll lane". So a loop, and a day, past more of his catches wins
// over one that fills more of the time -- but never one that comes home over its own water (his 10/3
// Wateree complaint stands). Between the same number of his fish the old order stands. A day that does
// not fill the time says what filling it would have taken.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trollLoop, fishBeforeFilling } from '../js/modules/plan-troll-loop.js';

// A day: metres trolled, metres of it trolled once, his fish passed, structure passed, and the way home.
const day = (m, newM, fish, structure = 0, backM = m / 2) => ({ m, newM, backM, score: { fish, structure } });
const first = (fillM, ...ts) => ts.slice().sort(fishBeforeFilling(fillM))[0];

test('Rowland: the creek loop past 4 of his stripers beats the open-lake loop that fills the day past 2', () => {
  // The two days the builder tried from Rowland Subdivision, 06:00-15:00, measured 2026-10-03.
  const creek = day(6216, 6216, 4), lake = day(27140, 27140, 2, 50);
  assert.equal(first(26000 * 0.85, lake, creek), creek);
});

test('a loop that comes home over its own water does not win on fish', () => {
  // The loop test's creek, measured: 8362 m, the way home 3794 m of its 4.1 km on the way out, past 2
  // of his fish -- against the channel past none.
  const creek = day(8362, 4568, 2, 0, 4150), channel = day(15500, 15300, 0);
  assert.equal(first(15000, creek, channel), channel);
  // The way out is always new water, so over the whole loop even that creek is more new than old; it
  // is the way home that says so.
  assert.ok(creek.newM > creek.m - creek.newM);
  // The Wateree loops of 10/3, home within 100 m of the way out for 81-88% of the way.
  assert.equal(first(18000, day(9000, 5040, 6, 0, 4500), day(9000, 8800, 1)).score.fish, 1);
  // A loop that comes home on new water for most of the way is not a double back.
  assert.equal(first(18000, day(9000, 7000, 6, 0, 4500), day(9000, 8800, 1)).score.fish, 6);
});

test('between days past as many of his fish, the old order: filled, then structure, then new water', () => {
  assert.equal(first(18000, day(10000, 10000, 3, 40), day(20000, 19000, 3, 5)).m, 20000);
  assert.equal(first(18000, day(20000, 18500, 3, 5), day(20500, 20000, 3, 40)).score.structure, 40);
  assert.equal(first(18000, day(9000, 9000, 3, 40), day(12000, 12000, 3, 5)).m, 12000);
  // With no catches at all, fish is a tie everywhere.
  assert.equal(first(18000, day(9000, 9000, 0, 90), day(19000, 19000, 0, 1)).m, 19000);
});

test('the day says whether it fills the time, and what filling it would take', () => {
  // The loop test's lake: a 16 km channel, no catches -- the day fills, as it always has.
  const src = fs.readFileSync(new URL('./the-day-is-a-loop-from-the-ramp.test.js', import.meta.url), 'utf8');
  assert.ok(src.includes('const BASE = {'));
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
  const r = trollLoop({ ramp: at(8000, W - 10), daFeatures: DA, floorFt: 20, windowMin: 180, stopMin: 0, maxPetals: 1 });
  assert.ok(!r.error, r.error);
  assert.equal(r.fillsDay, true);
  assert.equal(r.fillsTime, true);
  assert.equal(r.fillingDay, null);
  // Nothing trolled twice, so the day trolled once is the day.
  if (r.sharedM === 0) assert.ok(Math.abs(r.onceMinutes - r.minutes) <= 1, `${r.onceMinutes} / ${r.minutes}`);
  assert.ok(r.onceMinutes <= r.minutes + 1);
});

test('the status line says how much of the day the loop is, and what filling it would take', () => {
  const ui = fs.readFileSync(new URL('../js/modules/plan-water-ui.js', import.meta.url), 'utf8');
  assert.ok(ui.includes('loop.fillsDay === false'));
  assert.ok(ui.includes('filling the day would take'));
  assert.ok(ui.includes('the rest of the day is yours to go round it again or turn where you choose'));
  // A day that fills the time with water trolled twice is measured on the water it trolls once, and
  // is not told the rest of the day is his (Moultrie from Short Stay, 10/4: 8 h 53 min of 9 h).
  assert.ok(ui.includes('Trolled once, that is about ${fmtHours(loop.onceMinutes)}'));
  assert.ok(ui.includes("(loop.fillsTime ? '' : ', so the rest of the day is yours"));
});
