// A way home may cross its way out; it may not run beside it.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-04, on Marion from Rowland Subdivision: "it looks like the 28ft line on the north side
// and the 29 ft line on the south side are more than 100m apart... why can't smart plan use those to
// make a loop? is that they come together at the end of it?" Measured on the loop he gets by ticking
// the water toward Potato Creek, the two edges are 106-140 m apart all the way up the channel, and
// where they come together at its head is within the 200 m a turn has. What kept that loop from
// counting as one: the way out swings east round the mouth of Wyboo Creek before it heads west, and
// the way home crosses it to reach the creek's east side (225 m of it within 100 m of the way out);
// and at one place in the channel the 106 m gap lands on the 25 m grid as exactly 100 m. Neither is
// trolling the same water twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { onlyCrosses, SAME_WATER_M } from '../js/modules/plan-troll-loop.js';

// A grid of 25 m cells; the way out runs along row 20 from column 5 to column 55.
const G = { w: 60, h: 40, cellM: 25 };
const cell = (i, j) => j * G.w + i;
const OUT = Array.from({ length: 51 }, (_, k) => cell(5 + k, 20));
// The cells within 100 m of the way out, away from 200 m of either end -- as trollLoop marks them.
const r = SAME_WATER_M / G.cellM, ends = 2 * SAME_WATER_M / G.cellM;
const WITHIN = new Uint8Array(G.w * G.h);
for (const c of OUT) {
  const i = c % G.w, j = (c - i) / G.w;
  if (i - 5 < ends || 55 - i < ends) continue;
  for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
    if (di * di + dj * dj > r * r) continue;
    WITHIN[cell(i + di, j + dj)] = 1;
  }
}
const run = (pts) => pts.map(([i, j]) => cell(i, j));
const line = (i0, j0, i1, j1) => {
  const n = Math.max(Math.abs(i1 - i0), Math.abs(j1 - j0));
  return Array.from({ length: n + 1 }, (_, k) => [Math.round(i0 + ((i1 - i0) * k) / n), Math.round(j0 + ((j1 - j0) * k) / n)]);
};

test('straight across the way out is a crossing', () => {
  assert.equal(onlyCrosses(G, run(line(30, 5, 30, 35)), WITHIN, OUT), true);
  // and at 45 degrees
  assert.equal(onlyCrosses(G, run(line(22, 12, 38, 28)), WITHIN, OUT), true);
});

test('in beside the way out and back out the same side is not', () => {
  const beside = [...line(10, 5, 10, 17), ...line(11, 17, 40, 17).slice(0), ...line(40, 16, 40, 5)];
  assert.equal(onlyCrosses(G, run(beside), WITHIN, OUT), false);
});

test('a long slant across it is beside it for most of the way, and is not a crossing', () => {
  // 12 rows over 40 columns: within 100 m of the way out for 27 columns, 13 from where it crosses.
  assert.equal(onlyCrosses(G, run(line(10, 14, 50, 26)), WITHIN, OUT), false);
  // nor is running beside it for 400 m and then going over it
  const besideThenOver = [...line(10, 5, 10, 17), ...line(11, 17, 26, 17), ...line(27, 18, 27, 35)];
  assert.equal(onlyCrosses(G, run(besideThenOver), WITHIN, OUT), false);
});

test('exactly 100 m off, the corridor\'s edge, is clear', () => {
  const edge = [...line(10, 5, 10, 16), ...line(11, 16, 40, 16), ...line(40, 15, 40, 5)];
  assert.equal(onlyCrosses(G, run(edge), WITHIN, OUT), true);
  // one row nearer is beside it
  const nearer = [...line(10, 5, 10, 17), ...line(11, 17, 40, 17), ...line(40, 16, 40, 5)];
  assert.equal(onlyCrosses(G, run(nearer), WITHIN, OUT), false);
});

test('a way home that never comes near is clear', () => {
  assert.equal(onlyCrosses(G, run(line(5, 5, 55, 5)), WITHIN, OUT), true);
});

test('the loop uses it for the narrow-water step only, counts such a way home as kept, and pairs the lines the other way past each crossing', () => {
  const src = fs.readFileSync(new URL('../js/modules/plan-troll-loop.js', import.meta.url), 'utf8');
  assert.ok(src.includes('const xs = back ? crossingsOf(G, back, within, out, sameM) : null;'));
  assert.ok(src.includes('if (xs) apartM = sameM;'));
  assert.ok(src.includes('why can\'t\n * smart plan use those to make a loop?'));
  // Ryan, 10/4: "why do they have to cross" -- they do not: past the crossing the way out carries on
  // along the way home's line to the turn, and the way home comes back along the way out's.
  assert.ok(src.includes('why do they\n        // have to cross'));
  // since 10/4 at every crossing, not only one: pairAtCrossings(), whose one-crossing case is this
  // pairing exactly (test/a-loop-that-crosses-twice-is-paired-at-both.test.js)
  assert.ok(src.includes('const paired = xs && xs.length ? pairAtCrossings(out, back, xs) : null;'));
});
