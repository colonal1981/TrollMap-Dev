// Personal use only, not for distribution or resale; not for navigation.
//
// THE WHITE BAITS IN HIS SMALL CONTAINERS.
//
// Ryan, 2026-11-22: "there are plenty of white baits in the small plastic containers that I didn't show you", then a
// photo of them (PXL_20261122_163822100): "I have added a pic of what white smaller paddle tails and flukes i actually
// have on hand", "the baits closest to the start of the tape measure are less gold than what is pictured", and of the
// bottom group, "that bottom group is all one color... some stained or bad picture taking on my part". Each goes on the
// size entry it measures to, as a loose bag, so the plan and the packing list can name it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TACKLE_INVENTORY, colorsOf, colorInBox, trailersFor } from '../js/data/tackle-inventory.js';

const name = (id) => TACKLE_INVENTORY.find((l) => l.id === id).name;
const has = (id, color) => colorsOf(name(id)).find((c) => c.name === color);

test('each row of the photo is on the entry its length puts it on, as a loose bag', () => {
  const rows = [
    ['swimbait_4_0in', 'clear/gold flake', 3], ['swimbait_4_0in', 'white, silver glitter', 2], ['swimbait_4_0in', 'white', 1],
    ['swimbait_4_0in', 'pearl/clear, silver flake', 2], ['cast_fluke_4in', 'clear/gold flake', 5],
    ['cast_fluke_5in', 'pearl', 2], ['cast_fluke_5in', 'bone', 1], ['cast_fluke_5in', 'smoke, black back', 1],
    ['swimbait_3in', 'pearl/bone', 12],
  ];
  for (const [id, color, n] of rows) {
    const c = has(id, color);
    assert.ok(c, `${id}: ${color}`);
    assert.equal(c.n, n, `${id}: ${color}`);
    assert.match(c.bag, /^loose \(.*small containers\)$/, `${id}: ${color}`);
  }
  assert.equal(rows.reduce((t, r) => t + r[2], 0), 29);
});

test('a plan that says "white" gets the plain white, not the glitter one', () => {
  assert.equal(colorInBox(name('swimbait_4_0in'), 'white').name, 'white');
  assert.equal(colorInBox(name('swimbait_4_0in'), 'white silver glitter').name, 'white, silver glitter');
  assert.equal(colorInBox(name('swimbait_3in'), 'pearl bone').name, 'pearl/bone');
});

test('the white paddle tails are A-rig trailers: the 12 for the light heads, the 4" whites for the heavier', () => {
  const on = (oz, entry) => (trailersFor(oz).find((t) => t.name === name(entry)) || { colors: [] }).colors.map((c) => c.name);
  for (const oz of [0.25, 0.375, 0.5]) assert.ok(on(oz, 'swimbait_3in').includes('pearl/bone'), `${oz} oz`);
  for (const oz of [0.5, 0.75, 1]) assert.ok(on(oz, 'swimbait_4_0in').includes('white'), `${oz} oz`);
  // and the 12 are enough for all five arms of a rig
  assert.ok(has('swimbait_3in', 'pearl/bone').n >= 5);
});
