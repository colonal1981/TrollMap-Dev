// Personal use only, not for distribution or resale; not for navigation.
//
// THE TACKLE BOX HAS HIS COLOURS AND HIS BAITS BY NAME.
//
// Ryan photographed his box on 2026-11-21 and checked every pin on the review page on 11/22 (claude/
// LURE_REVIEW_CHECKED_2026-11-22.md). Out of it: the colours he has of each lure (tackle-colors.js), the baits he has by
// name ("if an entry doesn't exist why not just make one that matches... dont try to force them into a category if they
// belong in their own"), the maker's dive depth on each named crank, "the plan picks a color from the lure's list",
// "yes to the color on the catch journal", and the lures that are gone ("i think the diamond jig and the marabou are at
// the bottom of a lake and i dont think i ever had the haruki jigs").
import test from 'node:test';
import assert from 'node:assert/strict';
import { TACKLE_INVENTORY, colorsOf, colorInBox, RETIRED_IDS, dropRetired, lureByName } from '../js/data/tackle-inventory.js';
import { COLORS_BY_ID } from '../js/data/tackle-colors.js';
import { ratedDepthOf, depthWindow, leadForDepth, trollsBehindTheBoat, LURE_KNOWLEDGE } from '../js/data/lure-knowledge.js';
import { planArgsFrom, buildPlanRequest } from '../js/modules/plan-prompt.js';
import { connectionFor } from '../js/data/lure-knowledge.js';
import { catchWhen } from '../js/modules/plan-candidates.js';
import { colorChoices } from '../js/utils/lure-choices.js';

const byId = (id) => TACKLE_INVENTORY.find((l) => l.id === id);

test('every colour list belongs to a lure in the box, and every lure carries its list', () => {
  const ids = new Set(TACKLE_INVENTORY.map((l) => l.id));
  assert.deepEqual(Object.keys(COLORS_BY_ID).filter((id) => !ids.has(id)), []);
  for (const l of TACKLE_INVENTORY) {
    assert.ok(Array.isArray(l.colors), l.id);
    for (const c of l.colors) {
      assert.equal(typeof c.name, 'string', l.id);
      assert.ok(c.name.trim().length > 0, l.id);
      assert.ok(c.n === null || (Number.isInteger(c.n) && c.n > 0), `${l.id} ${c.name}`);
    }
  }
  // his Deep Hit Stick 12s, as he said them: "the 4 baits together are all berkeley deep hit stick 12s"
  assert.deepEqual(colorsOf('Berkley Deep Hit Stick 12').map((c) => c.name),
    ['Black Gold', 'Slick Tennessee Shad', 'Pink Lemonade']);
  // the weights carry no colour; they are not a bait
  assert.deepEqual(byId('troll_weight_2oz').colors, []);
});

test('no two lures share a name, and the names a plan resolves are his', () => {
  const names = TACKLE_INVENTORY.map((l) => l.name);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
  for (const n of ['Berkley Flicker Minnow 9D', 'Bandit Walleye Deep', 'Reef Runner Deep Diver 800',
                   'Yo-Zuri Crystal Minnow Deep Diver 130mm', 'Tail Spinner 1/2oz', 'Jitterbug']) {
    assert.ok(lureByName(n), n);
  }
});

test('the lures that are gone are gone, from the list and from a box saved before', () => {
  for (const id of RETIRED_IDS) assert.equal(byId(id), undefined, id);
  assert.deepEqual([...RETIRED_IDS].sort(), ['cb_dd2', 'cb_dd3', 'cb_dd4', 'jig_haruki_21', 'jig_haruki_29',
                                              'marabou_3quarter', 'spoon_casting_dr_fish']);
  const saved = [{ id: 'spoon_casting_dr_fish', name: 'x' }, { id: 'cb_dd1', name: 'DD1' }, { id: 'custom_1', name: 'his own' },
                 { id: 'marabou_3quarter', name: 'y' }, { id: 'cb_dd3', name: 'DD3 Crankbait (20-25ft)' }];
  const r = dropRetired(saved);
  assert.equal(r.dropped, 3);
  assert.deepEqual(r.inventory.map((l) => l.id), ['cb_dd1', 'custom_1']);
});

test('a named crank runs to the depth on its own box, and its type band is for the rest', () => {
  const hs12 = byId('cb_hitstick_12'), bandit = byId('cb_bandit_wd'), noLabel = byId('cb_dd1');
  assert.equal(hs12.type, 'crankbait_dd4');
  assert.equal(bandit.type, 'crankbait_dd4');
  assert.deepEqual(ratedDepthOf(hs12), { min: 26, max: 33 });
  assert.deepEqual(ratedDepthOf(bandit), { min: 23, max: 27 });
  assert.deepEqual(ratedDepthOf(noLabel), LURE_KNOWLEDGE.crankbait_dd1.ratedDepth);
  // the depth window says the box's numbers, and the lead stops at the box's bottom
  const w = depthWindow(bandit, { speedMph: 2, leadFt: 100 });
  assert.equal(w.min, 23);
  assert.equal(w.max, 27);
  assert.equal(leadForDepth(bandit, 40, 2), leadForDepth(bandit, 27, 2));
  // a crank whose maker gives no figure keeps its type's band
  assert.deepEqual(ratedDepthOf(byId('cb_ultradiver_65')), LURE_KNOWLEDGE.crankbait_dd1.ratedDepth);
});

test('his cast baits stay off the troll rods, by a ruling each', () => {
  for (const id of ['jig_swim', 'arig_mini', 'spoon_small_cast', 'tw_jitterbug', 'cast_shrimp', 'crappie_tube', 'crappie_marabou']) {
    assert.equal(trollsBehindTheBoat(byId(id)), false, id);
    assert.equal(byId(id).trollable, false, id);
  }
  for (const id of ['cb_hitstick_12', 'ts_half', 'tsj_30g', 'tw_plopper_small', 'underspin_painted', 'swimbait_7in']) {
    assert.equal(byId(id).trollable, true, id);
  }
});

test('the two P-Line Laser Minnows are a 2 oz and a 3 oz, one of each', () => {
  // Ryan, 11/22: "the big one is 4 inches and the smaller one looks to be 3.75". P-Line: 2 oz 3-3/4", 3 oz 4-1/4".
  const two = byId('spoon_laser_minnow_2oz'), three = byId('spoon_laser_minnow_3oz');
  assert.equal(two.weightOz, 2);
  assert.equal(three.weightOz, 3);
  assert.deepEqual(two.colors, [{ name: 'Chartreuse Silver Blue', n: 1 }]);
  assert.deepEqual(three.colors, [{ name: 'Chartreuse Silver Blue', n: 1 }]);
});

test('a written colour is read as his, in the box\'s spelling, or not at all', () => {
  // Berkley's names since 11/22 ("i have the black gold, pink lemonade and the last one is slick tennessee shad")
  assert.equal(colorInBox('Berkley Deep Hit Stick 12', 'black gold').name, 'Black Gold');
  assert.equal(colorInBox('Berkley Deep Hit Stick 12', 'Tennessee Shad').name, 'Slick Tennessee Shad');
  assert.equal(colorInBox('Berkley Deep Hit Stick 12', 'gold orange black').name, 'Black Gold');
  // and the smaller one: "the smaller deep hit stick that i have 1 of is a color that berkley calls shake and bake"
  assert.equal(colorInBox('Berkley Deep Hit Stick 9', 'shake and bake').name, 'Shake and Bake');
  assert.equal(colorInBox('Berkley Deep Hit Stick 12', 'PINK LEMONADE').name, 'Pink Lemonade');
  assert.equal(colorInBox('Berkley Deep Hit Stick 12', 'firetiger'), null);
  assert.equal(colorInBox('2oz Inline Trolling Weight', 'chrome'), null);
  assert.equal(colorInBox('Berkley Deep Hit Stick 12', ''), null);
});

const TROLL = TACKLE_INVENTORY.filter((l) => l.trollable).map((l) => l.name);
const conn = (n) => { const l = lureByName(n); return l ? connectionFor(l.type) : null; };

test('the prompt lists the colours he has of each bait and asks for one of them', () => {
  const p = buildPlanRequest({
    water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-11-22', launchTime: '06:00', returnTime: '15:00',
    species: ['Striped Bass'], conditions: {}, tackle: TACKLE_INVENTORY.map((l) => l.name), trollable: TROLL,
    candidates: [{ runId: 'a', depthFt: 20, lengthM: 1500 }],
  }).user;
  assert.doesNotMatch(p, /assume any colour combination is aboard/);
  assert.match(p, /THE COLOURS HE HAS OF EACH/);
  assert.match(p, /- Berkley Deep Hit Stick 12: Black Gold; Slick Tennessee Shad; Pink Lemonade/);
  assert.match(p, /"color": "one of that bait's colours, as listed"/);
});

test('a plan\'s colour is his or it is blank, and a colour he has not got is said', () => {
  const HS = 'Berkley Deep Hit Stick 12', SPOON = 'Nichols Lake Fork Flutter Spoon 3/4oz';
  const res = { loadout: { rods: [
    { id: 'R1', lure: HS, color: 'pink lemonade', role: 'troll', leadFt: 100 },
    { id: 'R5', lure: SPOON, color: 'chrome', role: 'troll', leadFt: 90 },
  ] }, legs: [{ runId: 'w#1', deploy: { port: 'R1', starboard: 'R5' } }] };
  const a = planArgsFrom(res, [{ runId: 'w#1' }], { tackle: TACKLE_INVENTORY.map((l) => l.name), connectionOf: conn });
  const on = (lure) => a.loadout.rods.find((r) => r.lure === lure);
  assert.equal(on(HS).color, 'Pink Lemonade');
  assert.equal(on(SPOON).color, '');
  assert.ok(a.problems.some((p) => /he has no Nichols Lake Fork Flutter Spoon 3\/4oz in "chrome" — he has shattered glass/.test(p)),
    a.problems.join(' | '));
  // and the spoon names its weight, with nothing about a re-tie
  assert.equal(on(SPOON).inlineWeightOz, 2);
  assert.ok(!a.problems.some((p) => /re-tie|tied on now/.test(p)));
});

test('the catch journal keeps the colour and the plan hears it', () => {
  const c = { date: '2026-11-21', time: '7:10 AM', lure: 'Berkley Deep Hit Stick 12', lureColor: 'Pink Lemonade' };
  assert.equal(catchWhen(c).lureColor, 'Pink Lemonade');
  assert.equal(catchWhen({ ...c, lureColor: '' }).lureColor, undefined);
  assert.equal(catchWhen({ ...c, lure: '' }).lureColor, undefined, 'no colour without a lure');
  const html = colorChoices('Pink Lemonade', colorsOf(c.lure).map((x) => x.name));
  assert.equal((html.match(/<option /g) || []).length, 4);
  assert.match(html, /<option value="Pink Lemonade" selected>/);
  // a colour typed at review that is not on file is kept as a choice
  assert.match(colorChoices('purple', ['chartreuse']), /<option value="purple" selected>purple<\/option>/);
});
