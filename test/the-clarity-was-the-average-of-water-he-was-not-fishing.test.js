// THE PLAN WAS BUILT ON THE MEAN OF SIX ZONES, FIVE OF WHICH HE WAS NOT GOING NEAR.
//
// Ryan, 2026-09-14: "this is probably correct in the creeks or the northern section of the lake but
// i highly doubt it is applicable near clearwater cove... what is it using to calculate the
// clarity??? i thought we made it location aware?"
//
// And on 2026-09-15, holding the next Wateree bench with the same CAUTION on it: the card still
// said "muddy water LAKE-WIDE", and the prompt still carried `"clarity": "Muddy"`.
//
// MY FIRST FIX ANSWERED THE SENTENCE AND NOT THE NUMBER. It added an AT YOUR RAMP line to the
// briefing and left `claritySel.value = d.overall.select` -- the lake-wide mean -- one line below
// it. That select is not a label: smart-plan-v2-wiring.js reads it as `clarity`, it reaches the
// model as `conditions.clarity`, and getLureColor() picks every colour off it. Measured on his
// 2026-09-14 bench, the prompt carried `"clarity": "Muddy"` two lines above the researched
// profile's own `Typical clarity: stained`. Two clarity verdicts for one lake in one prompt, and
// the one that read as TODAY was the average.
//
// AND IT NEVER RAN WHEN HE PICKED THE RAMP. syncClarityIntelData fired on lake change, tab switch,
// app load and the button -- never on planRamp -- so it ran while the ramp select was empty or
// still the previous lake's, and nothing recomputed when he chose Clearwater Cove.
//
// The zones below are Wateree's own, copied from Worker/worker-data.js, with the scores a 0" rain
// day produces: six zones, his in the clearest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { zoneForRamp, clarityForPlan } from '../js/utils/clarity-at-ramp.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INTEL_RAW = readFileSync(path.join(ROOT, 'js/modules/lake-intel.js'), 'utf8');
// COMMENTS QUOTE THE LINE THAT WAS WRONG, and an assertion that the wrong line is gone must not
// match the note recording it. Three source-reading guards in this codebase had already been
// tripped by their own commentary before this one was.
const INTEL = INTEL_RAW.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// Wateree, as /lake-clarity returns it. Names and ramp lists verbatim from worker-data.js:1360-1365.
const WATEREE = {
  lake: 'Lake Wateree',
  zones: [
    { name: 'Upper river / north end', ramps: ['Lugoff / upstream river ramps'],
      score: 24, clarity: 'Muddy', select: 'Muddy' },
    { name: 'Dutchmans Creek / upper west arms', ramps: ['Dutchmans Creek area'],
      score: 22, clarity: 'Muddy', select: 'Muddy' },
    { name: 'Wateree Creek', ramps: ['Wateree Creek Access Area'],
      score: 21, clarity: 'Muddy', select: 'Muddy' },
    { name: 'Beaver Creek / State Park side', ramps: ['Lake Wateree State Park', 'Beaver Creek Access'],
      score: 65, clarity: 'Muddy', select: 'Muddy' },
    { name: 'Colonel / June Creek', ramps: ['Colonel Creek', 'June Creek'],
      score: 65, clarity: 'Muddy', select: 'Muddy' },
    { name: 'Lower main-lake channel / dam basin',
      ramps: ['Clearwater Cove Marina', 'Buck Hill / lower lake ramps'],
      score: 61, clarity: 'Stained', select: 'Stained' },
  ],
  overall: { clarity: 'Muddy', select: 'Muddy', score: 66 },
};

test('his ramp resolves to its zone even though the two lists spell it differently', () => {
  // The clarity profile says "Clearwater Cove Marina"; the plan's ramp select says "Clearwater
  // Cove". Two hand-kept lists of the same places, and neither is the other's canonical spelling.
  const z = zoneForRamp(WATEREE.zones, 'Clearwater Cove');
  assert.ok(z, 'Clearwater Cove must resolve to a zone');
  assert.equal(z.name, 'Lower main-lake channel / dam basin');
  // And the other direction, for a select that carries the longer name.
  assert.equal(zoneForRamp(WATEREE.zones, 'Clearwater Cove Marina').name, z.name);
});

test('THE PLAN IS BUILT ON HIS ZONE, NOT ON THE MEAN', () => {
  const got = clarityForPlan(WATEREE, 'Clearwater Cove');
  assert.equal(got.select, 'Stained', 'the value the model and the colour engine are handed');
  assert.equal(got.source, 'ramp');
  assert.notEqual(got.select, WATEREE.overall.select, 'the mean is what this bug was');
  assert.match(got.why, /Clearwater Cove is in Lower main-lake channel/);
});

test('a ramp in a dirty arm gets the dirty answer, so this is not a way of always saying clearer', () => {
  const got = clarityForPlan(WATEREE, 'Dutchmans Creek area');
  assert.equal(got.select, 'Muddy');
  assert.equal(got.source, 'ramp');
  assert.equal(got.zone.name, 'Dutchmans Creek / upper west arms');
});

test('and the lake-wide mean is still the answer when no zone names the launch', () => {
  const got = clarityForPlan(WATEREE, 'Some Landing Nobody Listed');
  assert.equal(got.select, 'Muddy');
  assert.equal(got.source, 'lake');
  assert.match(got.why, /no zone in this lake's model names/);
  assert.match(got.why, /mean of 6 zones/);
});

test('a two-letter ramp value is not a wildcard', () => {
  // Containment either way is what makes the two spellings agree; unbounded, "SC" is inside a
  // dozen ramp names and would resolve to whichever zone happened to be first.
  assert.equal(zoneForRamp(WATEREE.zones, 'SC'), null);
  assert.equal(zoneForRamp(WATEREE.zones, ''), null);
  assert.equal(zoneForRamp(WATEREE.zones, null), null);
  assert.equal(clarityForPlan(WATEREE, '').source, 'lake');
});

test('a failed forecast leaves the select alone rather than guessing Clear', () => {
  const got = clarityForPlan({ zones: [], overall: null }, 'Clearwater Cove');
  assert.equal(got.select, null, 'null means "do not write anything", not "Clear"');
  assert.equal(got.source, 'none');
  assert.equal(clarityForPlan(null, 'Clearwater Cove').source, 'none');
});

// ── AND THE TWO READERS IN lake-intel.js ────────────────────────────────────────────────────────
//
// The resolution is only worth having if the SELECT reads it. Asserted against the source because
// lake-intel.js touches the DOM at module scope and cannot be imported here; the behaviour it
// guards is the one that shipped wrong.
test('the select is written from the resolution, not from the lake-wide mean', () => {
  assert.match(INTEL_RAW, /import \{ clarityForPlan \} from '\.\.\/utils\/clarity-at-ramp\.js'/);
  assert.match(INTEL, /if \(claritySel && forPlan\.select\) claritySel\.value = forPlan\.select;/);
  assert.ok(!/claritySel\.value\s*=\s*d\.overall/.test(INTEL),
    'the lake-wide mean must not be written into the plan\'s clarity input');
});

test('the conditions badge names the water its verdict is about', () => {
  assert.match(INTEL, /At \$\{esc\(rampNow\)\}/, 'with a zone resolved the badge says where');
  assert.match(INTEL, /Predicted \(lake-wide\)/, 'and without one it says lake-wide, not "Predicted"');
  assert.ok(!/>Predicted: <b>\$\{esc\(d\.overall/.test(INTEL),
    'the bare lake-wide mean must not be labelled just "Predicted"');
});

test('and the forecast recomputes when he picks a ramp, with that ramp passed in', () => {
  assert.match(INTEL, /rampSel\.addEventListener\('change'/,
    'no planRamp listener means the ramp-aware answer never runs for the ramp he chose');
  assert.match(INTEL, /syncClarityIntelData\?\.\(\{ rampName \}\)/,
    'the ramp must be passed, not re-read out of the DOM by the function');
  assert.match(INTEL, /export async function syncClarityIntelData\(o = \{\}\)/);
});
