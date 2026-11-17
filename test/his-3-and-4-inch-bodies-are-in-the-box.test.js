// Personal use only, not for distribution or resale; not for navigation.
//
// HIS 3" AND 4" BODIES ARE IN THE BOX.
//
// 2026-11-16, Bass Pro Shops in Miami: BioBait Shadow Swimmers in 3" and 4" and Bass Assassin 4"
// Sea Shads. The box had swimbaits at 3.8", 4.6", 5" and 6" and none at his sizes. His word on
// adding them: "Sure makes sense to have them in there".
//
//   node --test test/his-3-and-4-inch-bodies-are-in-the-box.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { jigheadRangeOz, jigheadForSwimbait } from '../js/data/lure-knowledge.js';
import { TACKLE_INVENTORY, JIGHEADS_OWNED_OZ, lureByName } from '../js/data/tackle-inventory.js';

const byId = (id) => TACKLE_INVENTORY.find((l) => l.id === id);

test('the 3" and the 4" are paddle tails on a jighead, with no weight of their own', () => {
  for (const [id, len] of [['swimbait_3_0in', 3.0], ['swimbait_4_0in', 4.0]]) {
    const l = byId(id);
    assert.ok(l, `${id} is in the box`);
    assert.equal(l.type, 'swimbait_paddle');
    assert.equal(l.lengthIn, len);
    assert.equal(l.weightOz, null);
    assert.equal(l.trollable, true);
    assert.equal(l.castable, true);
  }
});

test('the 3" takes a 1/4-1/2 oz head and the 4" a 1/2-1 oz head', () => {
  assert.deepEqual(jigheadRangeOz(3.0), { startOz: 0.25, maxOz: 0.5 });
  assert.deepEqual(jigheadRangeOz(4.0), { startOz: 0.5, maxOz: 1.0 });
});

test('the fitter never puts more than a 1/2 oz head on the 3"', () => {
  for (const depth of [10, 20, 30, 40]) {
    const fit = jigheadForSwimbait(byId('swimbait_3_0in'), depth, 1.8, { jigheads: JIGHEADS_OWNED_OZ });
    assert.ok(fit && fit.weightOz <= 0.5, `${depth} ft: ${fit && fit.weightOz} oz`);
  }
});

test('each name finds its own bait, and the 3.8" and 4.6" still find theirs', () => {
  assert.equal(lureByName('Swimbait 3" – Jighead').id, 'swimbait_3_0in');
  assert.equal(lureByName('Swimbait 4" – Jighead').id, 'swimbait_4_0in');
  assert.equal(lureByName('Swimbait 3.8" – Jighead').id, 'swimbait_3in');
  assert.equal(lureByName('Swimbait 4.6" – Jighead').id, 'swimbait_4in');
});

test('no id or name is in the box twice', () => {
  const ids = TACKLE_INVENTORY.map((l) => l.id);
  const names = TACKLE_INVENTORY.map((l) => l.name.toLowerCase());
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(names).size, names.length);
});
