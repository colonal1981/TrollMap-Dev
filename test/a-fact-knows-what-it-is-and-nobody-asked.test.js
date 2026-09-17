// A FACT KNOWS WHAT IT IS, AND NOBODY ASKED IT.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-09-17, on the research profiles: "are those facts or that evidence actually used by
// anything? does it help smartplan be smarter... does smartplan even see that... if not then none
// of that matters" -- and then: "if they will make the plan smarter by being there, then yes they
// should reach the prompt... my point it 2 fold... 1 is to not do things that dont get used but the
// second point is if it should be read then lets read it."
//
// Every `_extractedFacts` entry carries a `category` off an ENUMERATED list written into the
// extraction prompt in Worker/research/extract.js. Nothing outside the research pipeline read it.
// The one reader that existed searched the fact's TEXT for a light word, then hand-patched the
// misfires with a regex for "must|shall|creel".
//
// MEASURED ON THE REAL CARD: all 716 facts across 78 profiles. Eleven carry a light word; all
// eleven were being sent under a heading about light, and four of them are not about light. The
// law regex never had a chance at any of the four, because none of them says "must".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lightFactsFrom, patternFactsFrom, patternFactsBlock } from '../js/modules/plan-prompt.js';

// EVERY FACT BELOW IS VERBATIM off the real profiles, with its real category and real source.
// A fixture I wrote myself would only prove the code agrees with my idea of the corpus.
const WATAUGA = {                                     // watauga_tn.json
  fact: 'Watauga River generation starts at 1 PM Monday–Friday and noon on Saturday.',
  category: 'poolLevel', source: 'Watauga River fishing report', confidence: 95,
};
const MURRELLS_TIDE = {                               // murrells_inlet_pawleys_island_sc.json
  fact: 'Tidal conditions in Murrells Inlet include high tide mid-morning and falling tide after lunch.',
  category: 'tidalRange', source: 'Murrells Inlet - Fishing Report', confidence: 95,
};
const MURRELLS_DRUM = {
  fact: 'Red drum are active in Murrells Inlet during early morning and late afternoon near oyster beds.',
  category: 'predatorSpecies', source: 'Murrells Inlet - Fishing Report', confidence: 99,
};
const CONGAREE_BUZZ = {                               // congaree_river_to_sc_601_richland_co_sc.json
  fact: 'Largemouth bass on the Congaree River can be caught using buzzbaits during the early morning.',
  category: 'seasonalPattern', source: "Hit the Rivers for Carolina's Summer Bass - Game & Fish",
  confidence: 95,
};
const CONGAREE_CURRENT = {
  fact: 'Fish in the Congaree River are heavily influenced by current, becoming more aggressive and '
      + 'more likely to be in shallower water surface-feeding when current is present.',
  category: 'seasonalPattern', source: "Hit the Rivers for Carolina's Summer Bass - Game & Fish",
  confidence: 95,
};
const CONGAREE_HOLES = {
  fact: 'In the upper stretches of the Congaree River, bass hold near deep holes during low-water '
      + 'conditions and make short forays to attack shad and other forage.',
  category: 'seasonalDepth', source: "Hit the Rivers for Carolina's Summer Bass - Game & Fish",
  confidence: 90,
};
const CREEL = {
  fact: 'The daily creel limit is 10 catfish, no more than 2 of which may exceed 36 inches.',
  category: 'creelLimit_lakeSpecific', source: 'SC Rules and Regulations', confidence: 99,
};
const SUMMARY = {
  fact: 'Lake Wateree is a 13,250 acre Duke Energy impoundment on the Catawba River.',
  category: 'summary', source: 'Duke Energy Lake Services', confidence: 99,
};

const profile = (facts) => ({ _extractedFacts: facts });

test('a dam generation schedule is not light guidance, and the law regex never caught it', () => {
  // Three of these were reaching the model under "WHAT THE RESEARCH ON THIS WATER SAYS ABOUT
  // LIGHT". A generation schedule is LIVE in this app -- riverPromptBlock reads the gauge and says
  // whether it is generating right now -- so a written copy arriving as light guidance is wrong
  // twice: wrong heading, and able to contradict a reading taken this morning.
  assert.ok(/noon/i.test(WATAUGA.fact), 'it really does carry a light word');
  assert.ok(!/\b(must|shall|creel)\b/i.test(WATAUGA.fact), 'and the old regex really would miss it');
  assert.deepEqual(lightFactsFrom(profile([WATAUGA])), []);
});

test('nor is a tide, for the same reason and off the same measurement', () => {
  assert.deepEqual(lightFactsFrom(profile([MURRELLS_TIDE])), []);
});

test('a regulation is still refused, and now because of what it IS rather than how it reads', () => {
  // The old rule was a word search for "must|shall|prohibited|creel". A fact whose category says
  // creelLimit_lakeSpecific does not need to be read to be recognised.
  assert.deepEqual(lightFactsFrom(profile([CREEL])), []);
});

test('and the light guidance that IS light guidance still goes, with its source', () => {
  const out = lightFactsFrom(profile([MURRELLS_DRUM, WATAUGA, CONGAREE_BUZZ]));
  assert.equal(out.length, 2);
  assert.ok(out[0].includes('early morning and late afternoon near oyster beds'));
  assert.ok(out[0].includes('[Murrells Inlet - Fishing Report]'), 'a fact without its source is not one');
  assert.ok(out[1].includes('buzzbaits'));
});

test('a fact with no source says so rather than arriving bare', () => {
  const out = lightFactsFrom(profile([{ fact: 'They bite at dawn.', category: 'seasonalPattern' }]));
  assert.equal(out.length, 1);
  assert.ok(/source not recorded with the fact/.test(out[0]));
});

test('where the fish sit had no way into the prompt at all unless it mentioned the light', () => {
  // seasonalDepth, waterDepthUnderFish, holdingPattern and seasonalPattern are the four categories
  // with no structured home. The extraction prompt calls them first-class -- "a sentence naming a
  // species, a depth and a time of year is worth more than any morphometry in the document" -- and
  // researchIntel() prints none of them, because there is no field for them to be printed off.
  const out = patternFactsFrom(profile([CONGAREE_CURRENT, CONGAREE_HOLES]));
  assert.equal(out.length, 2);
  assert.ok(out[0].includes('more aggressive and more likely to be in shallower water'));
  assert.ok(out[1].includes('bass hold near deep holes'));
  assert.ok(out.every((f) => /Game & Fish/.test(f)));
});

test('and no fact appears under two headings', () => {
  // CONGAREE_BUZZ is seasonalPattern AND names the early morning. It goes to the light block,
  // because that block sits beside the computed hour-by-hour light table, which is the thing such a
  // fact has to be read against. The pattern reader must not send it again.
  const facts = profile([CONGAREE_BUZZ, CONGAREE_CURRENT]);
  const light = lightFactsFrom(facts);
  const pattern = patternFactsFrom(facts);
  assert.equal(light.length, 1);
  assert.ok(light[0].includes('buzzbaits'));
  assert.equal(pattern.length, 1);
  assert.ok(!pattern[0].includes('buzzbaits'));
});

test('what researchIntel already prints off the structured profile is not sent again as prose', () => {
  // `summary` is the largest category in the corpus at 147 facts, and researchIntel() prints
  // `Summary:` off the profile's own field. Duplication in a prompt reads as emphasis.
  assert.deepEqual(patternFactsFrom(profile([SUMMARY, CREEL, MURRELLS_DRUM])), []);
});

test('an absent profile, an empty list and a fact with no text are all just nothing', () => {
  for (const p of [null, undefined, {}, profile([]), profile([null, 'x', { category: 'seasonalDepth' }])]) {
    assert.deepEqual(lightFactsFrom(p), []);
    assert.deepEqual(patternFactsFrom(p), []);
  }
  assert.equal(patternFactsBlock([]), '');
  assert.equal(patternFactsBlock(null), '');
});

test('the block says these are the sentences behind the numbers, not a second opinion on them', () => {
  const block = patternFactsBlock(patternFactsFrom(profile([CONGAREE_CURRENT, CONGAREE_HOLES])));
  assert.ok(block.includes('WHERE THE FISH SIT HERE'));
  assert.ok(block.includes('not a second opinion'));
  // A striper run in April is a fact about April. The model is told to check it against the date
  // rather than plan September on it.
  assert.ok(/check it against today's date/.test(block));
  assert.ok(block.includes('deep holes'));
});

test('eight is the cap, and the cap says it is a cap', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    fact: `Bass hold at ${10 + i} feet in the fall.`, category: 'seasonalDepth', source: 'a report',
  }));
  const out = patternFactsFrom(profile(many));
  assert.equal(out.length, 9, 'eight facts and the line that says how it was cut');
  assert.equal(out[8], '(first 8 of them)');
});
