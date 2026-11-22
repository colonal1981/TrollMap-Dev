// Personal use only, not for distribution or resale; not for navigation.
//
// THE DD NAMES WERE PLACEHOLDERS, AND TWO OF THE SMALL SPOONS WERE JIGS.
//
// Ryan, 2026-11-22, of 'DD1 Crankbait (14-18ft)' to 'DD4 Crankbait (25ft+)': "Either have it as an alias or remove the
// dd markings. Those were created because I don't know the brand of every crankbait. More of a place holder / guess".
// DD2, DD3 and DD4 had no bait behind them and are gone, from the box and from a box saved before; DD1 held his five
// unlabelled ~3" long-lip cranks and is named for them, with the old name kept as an alias. And the same night, with the
// maker's picture of a 2.56", 1.16 oz metal jig on a feathered treble: "some of the "small spoons" on the saltwater
// lures pic were these".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TACKLE_INVENTORY, RETIRED_IDS, dropRetired, replaceShippedBuiltins, lureByName, colorsOf } from '../js/data/tackle-inventory.js';
import { LURE_KNOWLEDGE, connectionFor } from '../js/data/lure-knowledge.js';
import { LURE_PRESETS } from '../js/modules/spread-builder.js';
import { promptSafeTackleName } from '../js/utils/tackle-name.js';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const byId = (id) => TACKLE_INVENTORY.find((l) => l.id === id);
const NO_LABEL = 'Deep Crankbait ~3", long lip (no label)';

test('no lure in his box, and no name the app shows him, carries a DD placeholder', () => {
  assert.deepEqual(TACKLE_INVENTORY.filter((l) => /\bDD\d/.test(l.name)).map((l) => l.name), []);
  for (const id of ['cb_dd2', 'cb_dd3', 'cb_dd4']) {
    assert.equal(byId(id), undefined, id);
    assert.ok(RETIRED_IDS.includes(id), id);
  }
  assert.deepEqual(LURE_PRESETS.filter((n) => /\bDD\d/.test(n)), []);
  for (const t of ['crankbait_dd1', 'crankbait_dd2', 'crankbait_dd3', 'crankbait_dd4']) {
    assert.doesNotMatch(LURE_KNOWLEDGE[t].label, /\bDD\d/, t);
  }
  assert.doesNotMatch(read('../js/modules/tackle-inventory-ui.js').match(/export const TYPE_LABELS = \{[\s\S]*?\};/)[0], /'DD\d/);
});

test('the five unlabelled long-lip cranks keep their colours under a name that says what they are', () => {
  const l = byId('cb_dd1');
  assert.equal(l.name, NO_LABEL);
  assert.equal(l.type, 'crankbait_dd1');
  assert.equal(colorsOf(l.name).reduce((n, c) => n + c.n, 0), 5);
  assert.equal(promptSafeTackleName(l.name), 'Deep Crankbait ~3in, long lip (no label)');
});

test('the old DD1 name still finds them; the retired ones find nothing', () => {
  assert.equal(lureByName('DD1 Crankbait (14-18ft)').id, 'cb_dd1');
  assert.equal(lureByName('dd1 crankbait').id, 'cb_dd1');
  assert.equal(lureByName('DD1 Crankbait (14-18ft) @ 60ft').id, 'cb_dd1');
  assert.equal(lureByName(NO_LABEL).id, 'cb_dd1');
  assert.equal(lureByName('DD3 Crankbait (20-25ft)'), null);
  assert.equal(lureByName('DD4 Crankbait (25ft+)'), null);
});

test('a box saved before takes the new name and drops the empty three; one he renamed is his', () => {
  const saved = [{ id: 'cb_dd1', name: 'DD1 Crankbait (14-18ft)', type: 'crankbait_dd1', weightOz: 0.75, colors: [] },
                 { id: 'cb_dd2', name: 'DD2 Crankbait (16-20ft)' }, { id: 'cb_dd4', name: 'DD4 Crankbait (25ft+)' }];
  const kept = dropRetired(saved);
  assert.equal(kept.dropped, 2);
  const r = replaceShippedBuiltins(kept.inventory);
  assert.equal(r.changed, 1);
  assert.equal(r.inventory[0].name, NO_LABEL);
  assert.deepEqual(r.inventory[0].colors, []);
  const his = replaceShippedBuiltins([{ id: 'cb_dd1', name: 'My chartreuse crank', weightOz: 0.75 }]);
  assert.equal(his.changed, 0);
  assert.equal(his.inventory[0].name, 'My chartreuse crank');
});

test('the 1.16 oz metal jig is its own entry, with the two feathered colours off the small spoons', () => {
  const j = byId('jig_metal_116');
  assert.equal(j.name, 'Metal Jig 2.56" 1.16oz (feathered treble)');
  assert.equal(j.type, 'spoon_casting');
  assert.equal(j.weightOz, 1.16);
  assert.equal(j.lengthIn, 2.56);
  assert.equal(connectionFor(j.type), 'snap');
  assert.equal(j.trollable, byId('tsj_30g').trollable, 'trolls as the 30 g jig does');
  assert.deepEqual(colorsOf(j.name).map((c) => c.name), ['silver/blue', 'red head/silver']);
  const spoons = colorsOf(byId('spoon_small_cast').name).map((c) => c.name);
  assert.equal(spoons.length, 6);
  assert.ok(!spoons.some((c) => /feather/.test(c)), spoons.join('; '));
});
