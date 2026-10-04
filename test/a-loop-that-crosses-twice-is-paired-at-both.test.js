// Past every crossing, the way out and the way home are paired the other way -- not only past one.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-04, on a striper loop from Rowland Subdivision turned just west of Green Island:
// "my marion doesn't look like yours... mine crosses itself twice", then "this is fishable... i am just
// being picky now". `88a35cd` paired the lines the other way past a single crossing; this is that rule
// at any number of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pairAtCrossings } from '../js/modules/plan-troll-loop.js';

// Point ids stand for cells: the way out 0..9 (ramp to turn), the way home 19..10 (turn to ramp).
const out = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const back = [19, 18, 17, 16, 15, 14, 13, 12, 11, 10];

test('one crossing: the same pairing 88a35cd made', () => {
  const k = 4, x = 6;
  const r = pairAtCrossings(out, back, [{ x, k }]);
  assert.deepEqual(r.out, out.slice(0, k + 1).concat(back.slice(0, x + 1).reverse()));
  assert.deepEqual(r.back, out.slice(k).reverse().concat(back.slice(x)));
});

test('two crossings: the stretch between them is traded, the ends kept', () => {
  // The home line crosses the way out at out[7] first (back[2]), then again at out[3] (back[7]).
  const r = pairAtCrossings(out, back, [{ x: 2, k: 7 }, { x: 7, k: 3 }]);
  // out: its own line to the first crossing, the home line's middle, its own line to the turn
  assert.deepEqual(r.out, [0, 1, 2, 3, 12, 13, 14, 15, 16, 17, 7, 8, 9]);
  // home: its own line to the first crossing it meets, the way out's middle, its own line to the ramp
  assert.deepEqual(r.back, [19, 18, 17, 7, 6, 5, 4, 3, 12, 11, 10]);
  // still ramp to turn and turn to ramp, and nothing lost or invented
  assert.equal(r.out[0], 0); assert.equal(r.out[r.out.length - 1], 9);
  assert.equal(r.back[0], 19); assert.equal(r.back[r.back.length - 1], 10);
  assert.deepEqual([...new Set(r.out.concat(r.back))].sort((a, b) => a - b), [...new Set(out.concat(back))].sort((a, b) => a - b));
});

test('crossings out of the order a loop makes them are left alone', () => {
  assert.equal(pairAtCrossings(out, back, [{ x: 2, k: 3 }, { x: 7, k: 7 }]), null);
  assert.equal(pairAtCrossings(out, back, []), null);
  assert.equal(pairAtCrossings(out, back, null), null);
});

test('the loop pairs at every crossing it finds, not only at one', () => {
  const src = fs.readFileSync(new URL('../js/modules/plan-troll-loop.js', import.meta.url), 'utf8');
  assert.ok(src.includes('const paired = xs && xs.length ? pairAtCrossings(out, back, xs) : null;'));
  assert.ok(!src.includes('if (xs && xs.length === 1) {'));
});
