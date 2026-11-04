// Personal use only, not for distribution or resale; not for navigation.
//
// HIS A-RIG RUNS WHERE IT SNAGGED.
//
// 2026-11-02, lower Marion. Ryan: "so i snagged in 30 feet of water monday with an a-rig with about
// 100 ft of line out going 1.5 mph... and i only snagged once i got that slow... remember with
// a-rigs the slower the speed the lower the bait will drop". His sonar has it: six minutes slowing
// from about 2.0 to 1.3-1.6 mph over 27.6-28.3 ft, the kayak stopped at 3:35:20 PM over 27.6 ft,
// and no stop over the same 28 ft at about 2.0 mph before and after.
//
// The rig, his words of 11/4: a 1.6 oz frame, 4 blades, 5 baits, "with 5 3/8 oz jig heads on it";
// "this is the only a-rig i buy"; the heaviest "4 3/4oz weights with a 1oz in the middle"; and,
// asked for a third, five 1/2 oz heads. The app had put that 3/8 oz rig at 20.7 ft.
//
//   node --test test/his-a-rig-runs-where-it-snagged.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { leadForDepth, depthWindow } from '../js/data/lure-knowledge.js';
import { TACKLE_INVENTORY, replaceShippedBuiltins } from '../js/data/tackle-inventory.js';

const rig = (id) => TACKLE_INVENTORY.find((l) => l.id === id);
const middle = (w) => (w.min + w.max) / 2;

test('the three A-rigs are his one frame with its five heads', () => {
  const arigs = TACKLE_INVENTORY.filter((l) => l.type === 'umbrella_rig');
  assert.deepEqual(arigs.map((l) => l.id), ['arig_light', 'arig_medium', 'arig_heavy']);
  assert.ok(Math.abs(rig('arig_light').weightOz - 3.475) < 1e-9, 'five 3/8 oz heads on 1.6 oz');
  assert.ok(Math.abs(rig('arig_medium').weightOz - 4.1) < 1e-9, 'five 1/2 oz heads on 1.6 oz');
  assert.ok(Math.abs(rig('arig_heavy').weightOz - 5.6) < 1e-9, 'four 3/4 oz and a 1 oz on 1.6 oz');
  for (const l of arigs) assert.match(l.name, /^A-Rig – /);
});

test('the 3/8 oz rig on about 100 ft at about 1.4 mph is at the 28 ft he snagged', () => {
  assert.equal(leadForDepth(rig('arig_light'), 28, 1.4), 100);
  assert.equal(middle(depthWindow(rig('arig_light'), { speedMph: 1.4, leadFt: 100 })), 28);
});

test('at about 2.0 mph the same 100 ft stays off the 28 ft bottom he did not snag', () => {
  assert.ok(depthWindow(rig('arig_light'), { speedMph: 2.0, leadFt: 100 }).max < 28);
});

test('heavier heads run deeper on the same line', () => {
  const at = (id) => middle(depthWindow(rig(id), { speedMph: 1.4, leadFt: 100 }));
  assert.ok(at('arig_light') < at('arig_medium'), 'five 1/2 oz below five 3/8 oz');
  assert.ok(at('arig_medium') < at('arig_heavy'), 'the 5.6 oz rig below five 1/2 oz');
});

test('a saved box still as it shipped takes his rigs; one he edited is left as he left it', () => {
  const saved = [
    { id: 'arig_light', name: 'A-Rig Light (~1.65oz) – 3.8" Swimbait', type: 'umbrella_rig',
      weightOz: 1.65, sizes: ['3.8"'], note: 'his own note' },
    { id: 'arig_medium', name: 'My medium rig', type: 'umbrella_rig', weightOz: 2.65 },
    { id: 'dd2', name: 'DD2 Crankbait (16-20ft)', type: 'crankbait_deep' },
  ];
  const { inventory, changed } = replaceShippedBuiltins(saved);
  assert.equal(changed, 1);
  assert.equal(inventory[0].name, rig('arig_light').name);
  assert.equal(inventory[0].weightOz, rig('arig_light').weightOz);
  assert.equal(inventory[0].sizes, undefined, 'the old swimbait size goes with the old rig');
  assert.equal(inventory[0].note, 'his own note', 'anything else on it is kept');
  assert.deepEqual(inventory[1], saved[1], 'an edited entry is his');
  assert.deepEqual(inventory[2], saved[2]);
});
