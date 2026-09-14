/**
 * test/nobody-measured-which-bait-is-best.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-09-14, after an hour of me quoting the app's own lure scorer at him as if it were
 * evidence: "but keep in mind that the entire deterministic pipeline as you call it was built by
 * an LLM named Claude... sooooo". He was right. lure-knowledge.js holds 386 species/season/clarity
 * numbers with no source anywhere and 34 with one.
 *
 * Then: "where do we get the information to build this the right way" and "0 of my catches have a
 * lure attached to them". So there is no source for WHICH BAIT IS BEST -- not published, and not
 * his own log. The app must stop pretending it has one.
 *
 * What IS answerable is which baits can physically do the job, and every input to that has a name
 * attached: the bill off the box, `trollable` out of his inventory, the 120 ft he runs, the rig he
 * ties, and a depth off a vertical cast. On 2026-09-14 that test alone would have thrown out FOUR
 * of the six rods the model rigged.
 *
 *   node --test test/nobody-measured-which-bait-is-best.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baitsThatReach, describeBait } from '../js/data/lure-knowledge.js';
import { TACKLE_INVENTORY, RIGGED_TROLLING_WEIGHT_OZ } from '../js/data/tackle-inventory.js';
import { buildPlanRequest } from '../js/modules/plan-prompt.js';
import { oxygenFloorFt } from '../js/modules/plan-inputs.js';

const BOX = TACKLE_INVENTORY.filter((l) => l.trollable || l.castable);
const WATEREE = { targetFt: 16.4, speedMph: 2.0, maxLeadFt: 120,
                  inlineWeightOz: RIGGED_TROLLING_WEIGHT_OZ };
const gate = () => baitsThatReach(TACKLE_INVENTORY, WATEREE);
const refusalFor = (name) => (gate().refused.find((r) => r.name === name) || {}).why;
const legalNames = () => gate().legal.map((l) => l.name);

// ── THE FOUR THAT WRECKED THE DAY ──────────────────────────────────────────────────────────────
test('the four rods that could not reach the water are refused, each for a sourced reason', () => {
  // The bill, off the box. Ryan: "the only lure i have that has an actual max depth is the
  // crankbaits... it doesn't matter how much line you let out".
  assert.match(refusalFor('Squarebill Crankbait'), /bill runs it 2-5 ft/);
  assert.match(refusalFor('MR Crankbait (6-12ft)'), /bill runs it 6-12 ft/);
  assert.match(refusalFor('Squarebill Crankbait'), /maker's rating, not a guess of ours/);
  // A topwater has no running depth at all.
  assert.match(refusalFor('Whopper Plopper'), /works on top/);
  // `trollable: false`, his own inventory. Ryan: "if it is weightless you think a fluke at 2mph is
  // even going to sink?" It does not.
  assert.match(refusalFor('Fluke / Soft Jerkbait'), /cast only/);
  assert.match(refusalFor('Fluke / Soft Jerkbait'), /planes at trolling speed/);
});

test('and none of them is on the list the model is offered', () => {
  const n = legalNames();
  for (const bad of ['Squarebill Crankbait', 'SR Crankbait (3-5ft)', 'MR Crankbait (6-12ft)',
                     'Whopper Plopper', 'Fluke / Soft Jerkbait']) {
    assert.equal(n.includes(bad), false, `${bad} must not be offered for 16.4 ft`);
  }
});

// ── WHAT DOES SURVIVE ──────────────────────────────────────────────────────────────────────────
test('the baits the guides actually use are there, with the line each one costs', () => {
  const byName = Object.fromEntries(gate().legal.map((l) => [l.name, l]));
  for (const good of ['Nichols Lake Fork Flutter Spoon 3/4oz',
                      'Dr.Fish Diamond Jig / Jigging Spoon 1oz',
                      'SPRO Prime Bucktail Jig 1oz (SBTJ-1)',
                      'DD2 Crankbait (16-20ft)']) {
    assert.ok(byName[good], `${good} reaches 16.4 ft and must be offered`);
    assert.ok(byName[good].reach.leadFt > 0 && byName[good].reach.leadFt <= 120);
  }
});

test('the spoon is offered WITH the weight that makes it fish', () => {
  const sp = gate().legal.find((l) => l.id === 'spoon_3quarter');
  assert.ok(sp, 'the 3/4oz Nichols must reach 16.4 ft behind the rigged weight');
  assert.equal(sp.reach.inlineWeightOz, 2);
});

test('a bait that needs more line than the boat runs is refused, and says so', () => {
  const light = refusalFor('A-Rig Light (~1.65oz) – 3.8" Swimbait');
  assert.match(light, /needs \d+ ft of lead and you run 120 ft/);
});

test('hardware that carries a bait is not offered as one', () => {
  const n = legalNames();
  assert.equal(n.some((x) => /Jighead$/.test(x) && /oz Jighead$/.test(x)), false,
    'a bare jighead is what a paddle tail rides on, not a lure to tie on');
  assert.equal(n.some((x) => /Inline Trolling Weight/.test(x)), false);
  // and not as a REFUSAL either — a refusal is for a bait that could have been considered
  assert.equal(gate().refused.some((r) => r.type === 'jighead' || r.type === 'trolling_weight'),
    false);
});

// ── WHAT IT REFUSES TO DO ──────────────────────────────────────────────────────────────────────
test('IT DOES NOT RANK — no species, season or clarity weight is consulted', () => {
  // The scorer would put the A-Rigs top and the lipless crankbaits nowhere near it. The gate has
  // no opinion: a lipless that reaches the depth is on the list like everything else.
  assert.ok(legalNames().includes('3" Lipless Crankbait'));
  // Ordering is by the LEAD each costs, which is a fact, and the caller sorts. The gate itself
  // returns no score field at all — there is nothing for a reader to mistake for a ranking.
  for (const l of gate().legal) {
    assert.equal('score' in l, false);
    assert.equal('rank' in l, false);
  }
});

test('no measured floor, no gate — an unmeasured lake does not lose its tackle box', () => {
  for (const bad of [null, undefined, 0, -3, NaN]) {
    const r = baitsThatReach(TACKLE_INVENTORY, { ...WATEREE, targetFt: bad });
    assert.equal(r.refused.length, 0, 'refusing a box over a lake nobody cast is inventing a rule');
    assert.ok(r.legal.length > 20);
  }
});

test('the floor comes off a cast and nowhere else', () => {
  assert.equal(oxygenFloorFt({ limnology: { oxygen: { depletionDepthFt: 16.4, anoxicBelowFt: 19.7 } } }),
    16.4, 'depletion first — that is the deepest a fish is comfortable');
  assert.equal(oxygenFloorFt({ limnology: { oxygen: { anoxicBelowFt: 19.7 } } }), 19.7,
    'the harder floor stands in when depletion was not resolved');
  assert.equal(oxygenFloorFt({ limnology: { oxygen: {} } }), null);
  assert.equal(oxygenFloorFt(null), null);
  // the registry record beats the profile's copy, the way every other limnology read does
  assert.equal(oxygenFloorFt({ limnology: { oxygen: { depletionDepthFt: 40 } } },
                             { limnology: { oxygen: { depletionDepthFt: 16.4 } } }), 16.4);
});

// ── DESCRIBED, NOT SCORED ──────────────────────────────────────────────────────────────────────
test('a bait is described by what it physically is', () => {
  const d = describeBait('flutter_spoon');
  assert.match(d, /silent/);
  assert.match(d, /high flash/);
  assert.match(d, /baitfish profile/);
  assert.match(d, /swims lower/);
  assert.match(d, /1\.3-2\.2 mph/);
  assert.doesNotMatch(d, /\b(best|good|top|ideal|recommend)/i, 'descriptions, never a judgement');
  assert.equal(describeBait('nope'), null);
});

// ── AND IT REACHES THE PROMPT ──────────────────────────────────────────────────────────────────
const prompt = (extra = {}) => buildPlanRequest({
  water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-09-14',
  launchTime: '06:00', returnTime: '15:00', species: ['Striped Bass'], conditions: {},
  candidates: [], tackle: BOX.map((l) => l.name),
  trollable: BOX.filter((l) => l.trollable).map((l) => l.name),
  lureByName: (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null,
  inventory: BOX, ...extra,
}).user;

test('the prompt offers the filtered list and says what is missing and why', () => {
  const p = prompt({ oxygenFloorFt: 16.4 });
  assert.match(p, /WHAT CAN ACTUALLY REACH 16\.4 FT/);
  assert.match(p, /THEY ARE NOT RANKED/);
  assert.match(p, /NOT AVAILABLE TODAY, and why:/);
  assert.match(p, /bill runs it 6-12 ft/, 'the refusal is stated, not silent');
  assert.match(p, /ft of lead behind the 2oz inline weight/);
});

test('with no cast, the prompt is exactly what it always was', () => {
  const p = prompt({});
  assert.doesNotMatch(p, /WHAT CAN ACTUALLY REACH/);
  assert.match(p, /Whopper Plopper/, 'the whole box is still offered when nothing was measured');
});
