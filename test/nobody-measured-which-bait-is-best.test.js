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
 * WHAT IS ANSWERABLE IS ONLY TWO THINGS, AND THE FIRST TRY AT THIS GOT IT BACKWARDS. It required
 * every bait to REACH the oxygen floor, which deleted every topwater, squarebill and MR crankbait
 * in the box. Ryan, within the hour: "are you saying that topwater for striper is not a viable
 * method... you have now made it impossible for the app to suggest topwater first thing in the
 * morning when that is the best time for striper to be caught on topwater".
 *
 * A measured floor says nothing holds BELOW it. It says nothing at all about where above it the
 * fish are. So two eliminations, both unconditional: a bait that cannot be trolled, and a bait
 * that can ONLY fish below the anoxic depth. Everything else goes in the list with the band it
 * covers, and when to use it is a fishing judgement the app does not own.
 *
 *   node --test test/nobody-measured-which-bait-is-best.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trollableBaits, describeBait } from '../js/data/lure-knowledge.js';
import { TACKLE_INVENTORY, RIGGED_TROLLING_WEIGHT_OZ,
         JIGHEADS_OWNED_OZ } from '../js/data/tackle-inventory.js';
import { buildPlanRequest } from '../js/modules/plan-prompt.js';
import { oxygenFloorFt } from '../js/modules/plan-inputs.js';

const BOX = TACKLE_INVENTORY.filter((l) => l.trollable || l.castable);
const WATEREE = { oxygenFloorFt: 19.7, speedMph: 2.0, maxLeadFt: 120,
                  inlineWeightOz: RIGGED_TROLLING_WEIGHT_OZ };
const gate = (extra) => trollableBaits(TACKLE_INVENTORY, { ...WATEREE, ...extra });
const refusalFor = (name, extra) => (gate(extra).refused.find((r) => r.name === name) || {}).why;
const coverOf = (name, extra) => (gate(extra).legal.find((l) => l.name === name) || {}).covers;

// ── THE REGRESSION THAT MUST NEVER COME BACK ───────────────────────────────────────────────────
test('TOPWATER IS A STRIPER BAIT AND THE APP MAY NOT DELETE IT', () => {
  // Ryan, 2026-09-14: "the best time for striper to be caught on topwater". Two Wateree guides say
  // the same thing about first light. A floor at 19.7 ft has nothing to say about the surface.
  for (const top of ['Whopper Plopper', 'Walking Bait / Spook', 'Prop Bait / Choppo', 'Wake Bait']) {
    assert.deepEqual(coverOf(top), [0, 1], `${top} must be offered, covering the top`);
  }
});

test('and neither may it delete the shallow crankbaits', () => {
  assert.deepEqual(coverOf('Squarebill Crankbait'), [2, 5]);
  assert.deepEqual(coverOf('SR Crankbait (3-5ft)'), [3, 5]);
  assert.deepEqual(coverOf('MR Crankbait (6-12ft)'), [6, 12]);
});

test('a lead bait is reported from the top down — it can always be fished shallower', () => {
  const c = coverOf('Nichols Lake Fork Flutter Spoon 3/4oz');
  assert.equal(c[0], 0, 'a shorter lead is a shallower bait; the top is never the binding end');
  assert.equal(c[1], 19.7, 'and the deep end is capped at the floor, not past it');
});

// ── WHAT IT DOES ELIMINATE, AND ONLY THIS ──────────────────────────────────────────────────────
test('a bait that can ONLY fish below the floor is working dead water', () => {
  assert.match(refusalFor('DD4 Crankbait (25ft+)'), /no oxygen below 19\.7 ft/);
  assert.match(refusalFor('DD3 Crankbait (20-25ft)'), /every pass would be in dead water/);
  // 16-20 straddles it and still fishes. Refusing this one is what eliminating on the DEPLETION
  // depth would have done, which is why oxygenFloorFt() reads the anoxic number.
  assert.deepEqual(coverOf('DD2 Crankbait (16-20ft)'), [16, 19.7]);
});

test('a bait that cannot be trolled is a rod fishing nothing', () => {
  // Reworded 2026-09-14 when Ryan's rule replaced the flag: the reason is now WHERE THE ACTION
  // COMES FROM, not an assumption about buoyancy. See the ACTION_SOURCE block below.
  assert.match(refusalFor('Stick Bait (Senko)'), /cast only/);
  assert.match(refusalFor('Stick Bait (Senko)'), /action comes from the rod/);
});

test('the reasons are a closed set — nothing is eliminated for a reason nobody stated', () => {
  const reasons = new Set(gate().refused.map((r) => r.why));
  for (const w of reasons) {
    assert.ok(/cast only|no oxygen below|until that type is split/.test(w),
      `unexpected elimination reason: ${w}`);
  }
});

test('no cast, no elimination by depth — the deep divers come back', () => {
  for (const bad of [null, undefined, 0, -3, NaN]) {
    const r = gate({ oxygenFloorFt: bad });
    assert.ok(r.legal.some((l) => l.name === 'DD4 Crankbait (25ft+)'),
      'refusing a bait over a lake nobody cast is inventing a rule');
    assert.equal(r.refused.some((x) => /no oxygen below/.test(x.why)), false,
      'with no floor, nothing may be cut for depth');
  }
});

test('hardware that carries a bait is not offered as one, or refused as one', () => {
  const g = gate();
  assert.equal(g.legal.some((l) => /oz Jighead$/.test(l.name)), false);
  assert.equal(g.legal.some((l) => /Inline Trolling Weight/.test(l.name)), false);
  assert.equal(g.refused.some((r) => r.type === 'jighead' || r.type === 'trolling_weight'), false);
});

test('the spoon is offered WITH the weight that makes it fish', () => {
  const sp = gate().legal.find((l) => l.id === 'spoon_3quarter');
  assert.equal(sp.inlineWeightOz, 2);
});

// ── IT STILL RANKS NOTHING ─────────────────────────────────────────────────────────────────────
test('no species, season or clarity weight is consulted, and no score is returned', () => {
  for (const l of gate().legal) {
    assert.equal('score' in l, false);
    assert.equal('rank' in l, false);
  }
  assert.ok(gate().legal.some((l) => l.name === '3" Lipless Crankbait'),
    'a bait the scorer would rank low is on the list like everything else');
});

test('the floor comes off a cast, and it is the ANOXIC number', () => {
  // Eliminating on depletion would delete a DD2 that fishes. The deeper number is the safe one
  // precisely because the only thing it may do is eliminate.
  assert.equal(oxygenFloorFt({ limnology: { oxygen: { depletionDepthFt: 16.4, anoxicBelowFt: 19.7 } } }),
    19.7);
  assert.equal(oxygenFloorFt({ limnology: { oxygen: { depletionDepthFt: 16.4 } } }), 16.4,
    'depletion stands in only when no anoxic depth was resolved');
  assert.equal(oxygenFloorFt({ limnology: { oxygen: {} } }), null);
  assert.equal(oxygenFloorFt(null), null);
  assert.equal(oxygenFloorFt({ limnology: { oxygen: { anoxicBelowFt: 40 } } },
                             { limnology: { oxygen: { anoxicBelowFt: 19.7 } } }), 19.7);
});

// ── DESCRIBED, NOT SCORED ──────────────────────────────────────────────────────────────────────
test('a bait is described by what it physically is', () => {
  const d = describeBait('flutter_spoon');
  assert.match(d, /silent/);
  assert.match(d, /high flash/);
  assert.match(d, /swims lower/);
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

test('the prompt states the floor as a floor and hands the top of the column over', () => {
  const p = prompt({ oxygenFloorFt: 19.7 });
  assert.match(p, /AND THE FLOOR IS 19\.7 FT/);
  assert.match(p, /That is ALL that number says/);
  assert.match(p, /at first light they may be on top/);
  assert.match(p, /Whopper Plopper — covers 0-1 ft/, 'topwater is offered, not deleted');
  assert.match(p, /THEY ARE NOT\s*\n?RANKED/);
  assert.match(p, /no oxygen below 19\.7 ft/, 'and the refusals are stated, not silent');
});

test('with no cast the list is still offered, just with nothing ruled out by depth', () => {
  const p = prompt({});
  assert.doesNotMatch(p, /AND THE FLOOR IS/);
  assert.match(p, /DD4 Crankbait/);
});

test('no bait is quoted more line than the boat runs', () => {
  // The 1/8oz Road Runner printed "138 ft of lead" against the 120 ft budget that produced the
  // depth, and the A-Rig Medium 128 ft to reach a floor it cannot reach. A number he cannot let
  // out is not an instruction.
  for (const l of gate().legal) {
    if (l.leadIsSetback) continue;
    assert.ok(l.leadFt <= 120, `${l.name} quoted ${l.leadFt} ft of lead against a 120 ft budget`);
  }
});

test('a topwater is quoted a setback, not a lead-to-depth', () => {
  const t = gate().legal.find((l) => l.name === 'Whopper Plopper');
  assert.equal(t.leadIsSetback, true, 'it rides behind the boat; it is not being sunk to 80 ft');
});

// ── RYAN'S RULE, REPLACING NINE FLAGS NOBODY JUSTIFIED ─────────────────────────────────────────
//
// 2026-09-14: "here is the thing about the fluke... rig it up with either a belly weight or a
// jighead and now it does troll... hell you can troll a senko if you put weight with it... the only
// things that really do not troll well are things that have to have a varied retrieve or ones you
// have to use twitches or pulls to make move correctly" — and then the rule itself: "if it needs a
// varied or specific type of retrieve or rod motion then it probably needs to be cast only".
//
// `trollable` had been nine hand-set booleans, six of which justified themselves with a `technique`
// string reading "Cast only", which is the flag restated. And the app already contradicted itself:
// every paddle tail is trollable with `weightOz: null` because the jighead is the weight, and a
// fluke is the same object with a different tail.
import { ACTION_SOURCE, actionSourceFor, trollsBehindTheBoat,
         unruledActionTypes } from '../js/data/lure-knowledge.js';

const named = (n) => TACKLE_INVENTORY.find((l) => l.name === n);

test('the rule is keyed by BAIT, because one entry was covering two objects', () => {
  // Senko, worm, creature and fluke were ALL `cast_only` — a type named after the conclusion. Ryan
  // ruled them differently, so a type-keyed table could not hold his answer. Three of them are
  // still that type and are still cast-only; what changed is that the ones that DO troll moved to
  // the type that models their behaviour instead of needing a new one.
  const stillCastOnly = ['cast_stickbait', 'cast_worm_straight', 'cast_creature'];
  assert.equal(new Set(stillCastOnly.map((i) =>
    TACKLE_INVENTORY.find((l) => l.id === i).type)).size, 1);
  for (const i of stillCastOnly) assert.equal(actionSourceFor(i), 'the rod');
  for (const i of ['cast_fluke_5in', 'cast_worm_speed_7in']) {
    assert.equal(actionSourceFor(i), 'the pull');
    assert.equal(TACKLE_INVENTORY.find((l) => l.id === i).type, 'swimbait_paddle',
      'a ballasted fluke or speedworm IS a soft plastic on a head — no new type invented');
  }
});

test('his rulings, one for one', () => {
  assert.equal(named('Buzzbait').trollable, true, '"The buzzbait definitely trollable"');
  for (const n of ['Fluke 3.5" – Jighead', 'Fluke 4" – Jighead', 'Fluke 5" – Jighead']) {
    assert.equal(named(n).trollable, true,
      '"rig it up with either a belly weight or a jighead and now it does troll"');
  }
  for (const n of ['Speedworm 6" – Jighead', 'Speedworm 7" – Jighead']) {
    assert.equal(named(n).trollable, true, '"they actually make paddletail style worms"');
  }
  assert.equal(named('Straight Tail Worm 6-7"').trollable, false,
    'no swimming tail, no keel — it barrel-rolls bare and does nothing on a head');
  assert.equal(named('Stick Bait (Senko)').trollable, false,
    '"the action of the claws or tails when the rod tip moves is what really makes them work same '
    + 'as the stick bait"');
  assert.equal(named('Creature Bait / Craw').trollable, false, 'same ruling');
  assert.equal(named('Ned Rig / Finesse Jig').trollable, false,
    '"ned rig and football jigs are for casting primarily i agree there"');
  assert.equal(named('Football Jig (Craw/Bluegill Trailer)').trollable, false, 'same ruling');
  assert.equal(named('Popper / Chugger').trollable, false, 'a pop is a rod stroke');
  assert.equal(named('Hollow Body Frog').trollable, false, 'a walk is a rhythm');
});

test('the one he could not rule on was one ENTRY covering two baits', () => {
  // "the worm it depends... they actually make paddletail style worms so i argue those could be
  // trollable", then "but honestly i am not sure lol". He was not undecided — `Plastic Worm` was
  // one row standing for a straight tail AND a swimming tail, and no single ruling is right for
  // both. Splitting it answered the question without anybody guessing.
  assert.equal('cast_worm' in ACTION_SOURCE, false, 'the ambiguous entry is gone, not ruled on');
  assert.equal(TACKLE_INVENTORY.some((l) => l.id === 'cast_worm'), false);
  assert.deepEqual(unruledActionTypes(TACKLE_INVENTORY), [],
    'and nothing is left sitting on the default');
});

test('a T-rigged worm is not in the box, and the reason is written down anyway', () => {
  // "i do have the stuff to texas rig creatures and worms and have both but it is not something
  // that is really used for striper or for trolling obviously so i have never put them into the
  // inventory". An entry nothing uses is a dead object; the rule for it lives in ACTION_SOURCE's
  // own comment so a future add has an answer waiting.
  assert.equal(TACKLE_INVENTORY.some((l) => /texas|t-rig/i.test(l.name)), false);
});

test('trollable is DERIVED — there is one answer, not a flag and a rule', () => {
  for (const l of TACKLE_INVENTORY) assert.equal(l.trollable, trollsBehindTheBoat(l));
});

test('hardware is not governed by the rule', () => {
  // A jighead is what a paddle tail rides on; a trolling weight is what a spoon swims behind.
  assert.equal(actionSourceFor('jighead_1oz'), null);
  assert.equal(named('1oz Jighead').trollable, true, 'unchanged by the rule');
  assert.equal(named('2oz Inline Trolling Weight').trollable, false);
});

test('the refusal quotes the rule instead of guessing about buoyancy', () => {
  // It used to say "it planes at trolling speed instead of sinking" about everything cast-only,
  // which is true of a weightless fluke and false of a popper — a popper FLOATS on purpose.
  const g = gate();
  const why = (n) => g.refused.find((r) => r.name === n).why;
  assert.match(why('Popper / Chugger'), /its action comes from the rod/);
  assert.doesNotMatch(why('Popper / Chugger'), /planes at trolling speed/);
  assert.match(why('Straight Tail Worm 6-7"'), /action comes from the rod/);
});

test('the buzzbait is now offered, on top where it belongs', () => {
  const b = gate().legal.find((l) => l.name === 'Buzzbait');
  assert.ok(b, 'a steady retrieve is how one is fished; the blade turns off the pull');
  assert.equal(b.covers[0], 0);
});

test('THE GAP IS CLOSED — the fluke is offered, and every length gets its own head', () => {
  // It used to be refused with "its depth is filed under the shared 'cast_only' type". Filing it
  // where its behaviour actually lives closed that without minting a type or a single new number.
  //
  // And each length is priced separately, which is the point of routing it through the head fitter:
  // a 3.5" fluke will not carry what a 7" speedworm will, so one lead for both would be wrong in
  // the direction Ryan reads.
  const g = gate({ jigheads: JIGHEADS_OWNED_OZ });
  const lead = (n) => g.legal.find((l) => l.name === n);
  const small = lead('Fluke 3.5" – Jighead');
  const big = lead('Speedworm 7" – Jighead');
  assert.ok(small, 'the fluke is on the list now');
  assert.ok(small.jigheadOz < big.jigheadOz, 'a small fluke takes a lighter head');
  assert.ok(small.leadFt > big.leadFt, 'so it needs MORE line to reach the same depth');
  for (const l of g.legal) {
    if (l.jigheadOz) assert.ok(l.leadFt <= 120, `${l.name} quoted ${l.leadFt} ft`);
  }
});
