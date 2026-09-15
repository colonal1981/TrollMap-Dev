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

test('with no launch selected the briefing says so, instead of going quiet', () => {
  // Both ramp branches were skipped when `rampNow` was empty, so the briefing carried no line about
  // the launch at all and the lake-wide figure read as the only answer there was. Ryan's 2026-09-15
  // briefing had NEITHER the AT YOUR RAMP line nor the "no zone lists this ramp" line, which is how
  // the empty ramp was identified: unmatched and unselected looked identical on the page.
  assert.match(INTEL, /No launch was selected when this was modelled, so everything below is LAKE-WIDE/);
  // And the three cases are genuinely three branches, not two.
  assert.match(INTEL, /\} else if\(rampNow\)\{[\s\S]{0,400}?\} else \{/);
});

// ── THE BRIEFING IS A SNAPSHOT, AND NOTHING USED TO REGENERATE IT AT PLAN TIME ─────────────────
//
// Ryan, with Clearwater Cove selected the whole time: "I did have a ramp selected". He did — and the
// briefing still carried no line about it. #planClarityIntel is written whenever syncClarityIntelData
// last ran, saved into the plan from there and read back onto the card; it runs on lake change, tab
// switch, app load and a button, and a RESTORED form fires no change event. So on a reload the only
// run is the one at +1000ms, while the ramp dropdown is still being filled from the access index.
// Selected-but-not-yet-rendered and never-selected produce the same page.
test('the planners re-render the briefing with the ramp before collecting the plan', () => {
  for (const [who, src] of [['Smart Plan', SP], ['Pick Water', PW]]) {
    assert.match(src, /await syncClarityIntelData\(\{ rampName: inp\.rampName, payload: clarityAtRamp\.payload \}\)/,
      `${who} must refresh the briefing with the ramp on the request`);
    assert.match(src, /import \{ syncClarityIntelData \} from '\.\/lake-intel\.js'/, `${who} import`);
  }
  // AWAITED, because collectPlan() reads that textarea — a fire-and-forget refresh would land after
  // the snapshot and the card would show the old text anyway.
  for (const src of [SP, PW]) assert.ok(!/(?<!await )syncClarityIntelData\(\{ rampName/.test(src));
});

test('and it re-renders from the payload already fetched, not a second request', () => {
  // Two requests for one answer is wasteful; two requests straddling a forecast update is two
  // different answers on one card.
  assert.match(INTEL, /let d = o\.payload \|\| null;/);
  assert.match(INTEL, /if \(!d\) \{[\s\S]{0,300}?await fetch\(`\$\{worker\}\/lake-clarity/);
  assert.match(PRE, /payload: res,/, 'the resolver has to hand the payload back for that to work');
});

test('and the forecast recomputes when he picks a ramp, with that ramp passed in', () => {
  assert.match(INTEL, /rampSel\.addEventListener\('change'/,
    'no planRamp listener means the ramp-aware answer never runs for the ramp he chose');
  assert.match(INTEL, /syncClarityIntelData\?\.\(\{ rampName \}\)/,
    'the ramp must be passed, not re-read out of the DOM by the function');
  assert.match(INTEL, /export async function syncClarityIntelData\(o = \{\}\)/);
});

// ── AND THE THIRD ATTEMPT: IT CANNOT DEPEND ON WHICH RENDER FINISHED FIRST ──────────────────────
//
// His 22:22 bench on 2026-09-15 ran seven minutes after the ramp-aware select shipped, with it live
// — the AHQ renderer from the same commit was visibly working — and still sent `"clarity": "Muddy"`.
//
// Because the briefing that writes that select is produced by syncClarityIntelData(), which fires on
// lake change, tab switch, app load and a button. On a RELOAD with the ramp already set, no change
// event fires at all, and the app-load run at +1000ms reads a `planRamp` the access index has not
// finished filling. The select held the mean and the plan read the select.
//
// So the plan stopped reading the select. fetchClarityAtRamp() resolves it from the ramp ON THE
// REQUEST at the moment the plan is built, and both wirings call it before conditionsFrom().
const PRE = readFileSync(path.join(ROOT, 'js/modules/plan-preflight.js'), 'utf8');
const INPUTS = readFileSync(path.join(ROOT, 'js/modules/plan-inputs.js'), 'utf8');
const SP = readFileSync(path.join(ROOT, 'js/modules/smart-plan-v2-wiring.js'), 'utf8');
const PW = readFileSync(path.join(ROOT, 'js/modules/plan-water-ui.js'), 'utf8');
const BUILDER = readFileSync(path.join(ROOT, 'js/modules/plan-builder.js'), 'utf8');

test('the resolver asks the Worker and answers from the ramp on the request', async () => {
  const { fetchClarityAtRamp } = await import('../js/modules/plan-preflight.js');
  const asked = [];
  const got = await fetchClarityAtRamp('Lake Wateree, SC', '2026-09-15', {
    worker: 'https://w', rampName: 'Clearwater Cove',
    fetchJson: async (u) => { asked.push(u); return WATEREE; },
  });
  assert.equal(asked.length, 1, 'one request');
  assert.match(asked[0], /\/lake-clarity\?lake=Lake%20Wateree%2C%20SC&date=2026-09-15/);
  assert.equal(got.select, 'Stained');
  assert.equal(got.source, 'ramp');
  assert.equal(got.zoneName, 'Lower main-lake channel / dam basin');
  // The mean rides along as the different fact it is — a mudline upstream is worth knowing about
  // while launching in clear water.
  assert.equal(got.lakeWide, 'Muddy');
  assert.equal(got.zoneCount, 6);
});

test('and a failed forecast answers null, so the form value stands rather than becoming Clear', async () => {
  const { fetchClarityAtRamp } = await import('../js/modules/plan-preflight.js');
  assert.equal(await fetchClarityAtRamp('Lake Wateree, SC', '2026-09-15',
    { worker: 'https://w', rampName: 'Clearwater Cove', fetchJson: async () => null }), null);
  assert.equal(await fetchClarityAtRamp('Lake Wateree, SC', '2026-09-15',
    { worker: 'https://w', rampName: 'X', fetchJson: async () => { throw new Error('502'); } }), null);
  // And with no worker there is nothing to ask.
  assert.equal(await fetchClarityAtRamp('Lake Wateree, SC', '2026-09-15', { rampName: 'X' }), null);
});

test('the clarity that reaches the model says which water it is about', async () => {
  const { conditionsFrom } = await import('../js/modules/plan-inputs.js');
  const { clarityForPlan } = await import('../js/utils/clarity-at-ramp.js');
  const resolved = { ...clarityForPlan(WATEREE, 'Clearwater Cove'), rampName: 'Clearwater Cove',
                     zoneName: 'Lower main-lake channel / dam basin', lakeWide: 'Muddy', zoneCount: 6 };
  const c = conditionsFrom({ clarity: resolved.select }, null, null, null, resolved);
  assert.equal(c.clarity, 'Stained');
  assert.equal(c.clarityScope, 'at the launch');
  assert.match(c.clarityAt, /Clearwater Cove — Lower main-lake channel/);
  assert.equal(c.clarityLakeWide, 'Muddy', 'the mean is kept beside it, not dropped');

  // And when nothing named the ramp, the word LAKE-WIDE is in the scope rather than implied.
  const lake = { ...clarityForPlan(WATEREE, 'Nowhere Landing'), rampName: 'Nowhere Landing',
                 zoneName: null, lakeWide: 'Muddy', zoneCount: 6 };
  const c2 = conditionsFrom({ clarity: lake.select }, null, null, null, lake);
  assert.equal(c2.clarity, 'Muddy');
  assert.match(c2.clarityScope, /LAKE-WIDE MEAN of 6 zones/);
  assert.equal(c2.clarityAt, undefined, 'nothing may claim a ramp the model did not name');

  // With no resolution at all the shape is exactly what it was before, so an old caller is unharmed.
  assert.deepEqual(conditionsFrom({ clarity: 'Clear' }, null, null, null), { clarity: 'Clear' });
});

test('both planners resolve it before they build conditions, not one of them', () => {
  for (const [who, src] of [['Smart Plan', SP], ['Pick Water', PW]]) {
    assert.match(src, /fetchClarityAtRamp\(inp\.lakeName, inp\.dateStr/, `${who} must resolve it`);
    assert.match(src, /if \(clarityAtRamp && clarityAtRamp\.select\) inp\.clarity = clarityAtRamp\.select;/,
      `${who} must use it`);
    assert.match(src, /conditionsFrom\(inp, ramp, sol[^)]*, forecast,?\s*\n?\s*(clarityAtRamp|clarityAtRamp\))|conditionsFrom\(inp, ramp, solunarFor\([^)]*\), forecast,\s*\n?\s*clarityAtRamp\)/,
      `${who} must pass the provenance to conditionsFrom`);
  }
  assert.match(PRE, /export async function fetchClarityAtRamp/);
});

test('the card reads the verdict off the plan instead of grepping the briefing', () => {
  const live = BUILDER.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(live, /cond\.clarityAt/, 'the resolved field is what decides the CAUTION now');
  // The regex survives ONLY as a fallback for plans saved before this shipped.
  assert.match(live, /const atRamp = fromPlan \|\| \(m2 \?/);
});

// ── AND IT HAS TO READ THE HALF OF THE OBJECT THE CONDITIONS ARE ON ────────────────────────────
//
// The reader went in as `p.conditions || {}` and there is no such field. collectPlan() returns the
// FORM's view at the top level and the v2 plan under `.plan`, so the resolved conditions live at
// `p.plan.conditions` — which meant the card skipped both new branches on every caller and fell
// through to the briefing-text fallback the change existed to replace. Ryan, on a fresh plan,
// reloaded, on a different computer: "still getting this... did i miss something?"
//
// Asserted from BOTH ends so a grep alone cannot be the whole guard: the shape that collectPlan and
// benchReportPlan really produce, and the address the card really reads.
test('the conditions are under `plan`, and that is where the card looks', async () => {
  const { benchReportPlan } = await import('../js/utils/bench-export.js');
  const run = { plan: { planVersion: 2, meta: {}, conditions: { clarity: 'Stained',
                        clarityAt: 'Clearwater Cove — Lower main-lake channel / dam basin' },
                        loadout: {}, legs: [], changes: [] } };
  const p = benchReportPlan(run, { meta: { name: 'x' } }, null);
  // The shape, measured rather than assumed.
  assert.equal(p.conditions, undefined, 'there is no top-level conditions and never was');
  assert.equal(p.plan.conditions.clarityAt, 'Clearwater Cove — Lower main-lake channel / dam basin');

  const live = BUILDER.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(live, /const cond = \(p\.plan && p\.plan\.conditions\) \|\| p\.conditions \|\| \{\};/,
    'the card must read p.plan.conditions, which is where conditionsFrom wrote them');
});

// The branch logic itself, lifted out and run, so "which sentence does this plan produce" is tested
// by EXECUTING it rather than by looking at it. Three plans, three answers.
test('a plan carrying a resolved ramp verdict produces the ramp sentence, not the lake-wide one', () => {
  // The same three-way decision the card makes, against the same field names.
  const verdict = (p) => {
    const cond = (p.plan && p.plan.conditions) || p.conditions || {};
    const fromPlan = cond.clarityAt && /^Clear|^Stained|^Muddy/i.test(String(cond.clarity || ''))
      ? { where: String(cond.clarityAt), cls: String(cond.clarity).toLowerCase() } : null;
    if (fromPlan) return `at ${fromPlan.where}: ${fromPlan.cls}`;
    if (cond.clarityScope && /lake-wide/i.test(String(cond.clarityScope))) return 'lake-wide, said so';
    return 'fell through to the briefing text';
  };
  assert.equal(
    verdict({ plan: { conditions: { clarity: 'Stained', clarityAt: 'Clearwater Cove — dam basin' } } }),
    'at Clearwater Cove — dam basin: stained');
  assert.equal(
    verdict({ plan: { conditions: { clarity: 'Muddy',
              clarityScope: 'LAKE-WIDE MEAN of 6 zones — no zone in the model names X' } } }),
    'lake-wide, said so');
  // And the shape that was actually shipping: conditions present, but read from the wrong half.
  assert.equal(verdict({ meta: {}, plan: null }), 'fell through to the briefing text');
});

test('and the report date is the calendar day the page states, not a timezone shift of it', () => {
  const live = BUILDER.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // `new Date('2026-09-03')` is UTC midnight; rendered in UTC-4 it printed "Sep 2, 2026" beside an
  // age of 12 days, so the line disagreed with itself. This file's own idiom for a date-only string
  // is `+ 'T12:00:00'`, already used for p.meta.date twice.
  assert.match(live, /const reportDate = \(v\) => \{/);
  assert.match(live, /\$\{t\}T12:00:00/);
  assert.ok(!/new Date\(it\.published\)\.toLocaleDateString/.test(live),
    'the feed renderer must go through the shared formatter');
  assert.ok(!/new Date\(u\.published\)\.toLocaleDateString/.test(live),
    'and so must the page renderer');
});

// ── AND THE WHOLE CHAIN, RUN, WITH THE CARD'S OWN SHIPPED SOURCE AS THE LAST STEP ──────────────
//
// Every test above checks one hop. `p.conditions` got through all of them because the hop it broke
// -- does the sentence the angler reads come out right, given the payload the Worker returns -- was
// the one nobody ran. Three rounds of "still getting this" is what that costs.
//
// So this runs the real resolver, the real conditionsFrom, the real assemblePlan, and then LIFTS
// THE CARD'S DECISION OUT OF plan-builder.js AND EXECUTES IT. Not a copy of the logic -- the shipped
// bytes -- because a copy is exactly what would have agreed with itself while the app was wrong.
test('END TO END: the Worker payload becomes the sentence on his card', async () => {
  const { fetchClarityAtRamp } = await import('../js/modules/plan-preflight.js');
  const { conditionsFrom } = await import('../js/modules/plan-inputs.js');
  const { assemblePlan } = await import('../js/modules/plan-assemble.js');

  const resolved = await fetchClarityAtRamp('Lake Wateree, SC', '2026-09-15',
    { worker: 'https://w', rampName: 'Clearwater Cove', fetchJson: async () => WATEREE });
  const conditions = conditionsFrom({ clarity: resolved.select }, null, null, null, resolved);

  // THE HOP NOBODY HAD TESTED: assemblePlan carrying `conditions` onto the plan unchanged.
  const plan = assemblePlan({
    candidates: [{ runId: 'wateree_lake#216', lengthM: 2400, depthFt: 26, depthMinFt: 24,
                   depthMaxFt: 29, maxRunDepthFt: 24, start: [-80.70, 34.35], end: [-80.68, 34.36],
                   coordinates: [[-80.70, 34.35], [-80.68, 34.36]], passes: [], speedMph: 2.0 }],
    launch: [-80.71, 34.348], loadout: { rods: [] }, deploy: {},
    stops: [], changes: [], launchTime: '06:00', returnTime: '15:00', usableAh: 80, conditions,
  });
  assert.equal(plan.conditions.clarityAt, 'Clearwater Cove — Lower main-lake channel / dam basin');
  assert.equal(plan.conditions.clarity, 'Stained');

  // The card's decision, sliced out of the shipped file and run against the real plan object.
  const i = BUILDER.indexOf('const cond = (p.plan && p.plan.conditions)');
  const j = BUILDER.indexOf('// If Open-Meteo failed but the weather text field', i);
  assert.ok(i > 0 && j > i, 'the card decision block moved — repoint this slice');
  const risks = []; const goods = []; const notes = [];
  const decide = new Function('p', 'addRisk', 'addPositive', 'addNote',
    BUILDER.slice(i, j).replace(/^\s*\/\/.*$/gm, ''));
  decide({ plan: { conditions: plan.conditions }, meta: { clarityIntel: '' } },
         (m) => risks.push(m), (m) => goods.push(m), (m) => notes.push(m));

  const said = risks.concat(goods).concat(notes).join(' | ');
  assert.match(said, /Water at Clearwater Cove — Lower main-lake channel \/ dam basin: STAINED/);
  assert.ok(!/LAKE-WIDE/.test(said), 'the mean must not be the verdict when his zone answered');
  assert.equal(risks.length + goods.length + notes.length, 1, 'one clarity line, not two');

  // ── AND IT IS A NOTE, NOT A RISK ────────────────────────────────────────────────────────────
  //
  // Ryan, 2026-09-15: "wateree is typically stained... that is its normal operating level... so
  // caution for stained is wrong." Measured on his own water: the secchi baseline is 2.4 ft, the
  // profile's own line is "Typical clarity: stained", and on a day with 0" of rain in 72 hours
  // every zone still scored 61-69 — Stained at his ramp and Muddy lake-wide FROM THE BASELINE
  // ALONE. A caution on a lake's normal state fires on nearly every trip there, and `noGoReasons`
  // is what sets the verdict, so it was dropping every Wateree day to CAUTION.
  assert.equal(risks.length, 0, 'clarity must not push the trip to CAUTION');
  assert.equal(notes.length, 1, 'it is a condition, printed and counted toward nothing');
});

test('no clarity, at any level, is a risk — the verdict is about the trip, not the water colour', () => {
  const i = BUILDER.indexOf('const cond = (p.plan && p.plan.conditions)');
  const j = BUILDER.indexOf('// If Open-Meteo failed but the weather text field', i);
  const block = BUILDER.slice(i, j);
  assert.ok(!/addRisk\(/.test(block),
    'the clarity block must raise no risks at all — Clear, Stained, Muddy or the top band');
  assert.ok(!/addPositive\(/.test(block),
    'nor call any of them good: "stained" is not a blessing either, it is a condition');
  assert.match(block, /addNote\(/);

  // Every level, executed, on the three shapes that reach it.
  const run = (p) => { const r = [], n = [];
    new Function('p', 'addRisk', 'addPositive', 'addNote', block.replace(/^\s*\/\/.*$/gm, ''))
      (p, (m) => r.push(m), () => {}, (m) => n.push(m));
    return { r, n }; };
  for (const cls of ['Clear', 'Stained', 'Muddy']) {
    const got = run({ plan: { conditions: { clarity: cls, clarityAt: 'X — Y' } }, meta: {} });
    assert.equal(got.r.length, 0, `${cls} at the ramp must not be a risk`);
    assert.equal(got.n.length, 1, `${cls} at the ramp must be a note`);
  }
  // And the top band, whose NAME claims debris off a turbidity score.
  const top = run({ plan: null, meta: { clarityIntel: 'Overall predicted clarity: Muddy / debris risk' } });
  assert.equal(top.r.length, 0, 'the app must not assert debris it cannot measure');
  assert.match(top.n.join(' '), /measures no debris/);
});
