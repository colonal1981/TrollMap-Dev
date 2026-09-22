// FIVE SURFACES READ FOUR FEEDS THROUGH THREE DEDUPERS, AND TWO OF THEM WERE WRONG.
//
// Ryan, 2026-09-22: "right now i have a button that says garmin POI that shows what you are
// seeing... another that says ramps... and then the ramp dropdown... and none of that reads
// from the same source".
//
// He was right. Measured in his running app and on the drive that day:
//
//   #btnPOI      supplemental-layers.js  mergeDnrRamps() looped EVERY state, EVERY waterbody
//                and EVERY ramp in the /ramps feed with no filter on which lake a row belonged
//                to. Lake Wateree's pack has 552 Garmin POIs; the layer drew 2,309 symbols
//                because 2,024 four-state DNR ramps were injected into it. 87.7% of a button
//                marked "Garmin POI" was not Garmin.
//   #btnRamps    utils/dedupe.js treated any two ramps within 0.006 deg (~667 m) as duplicates
//                REGARDLESS OF NAME. Re-running it against the live feed: 2,026 rows in, 91
//                removed, 85 of them carrying a different name from the row that killed them.
//                The Monticello Subimpoundment, Taw Caw Park, Bushy Park - Fresh Water and
//                Saluda Shoals Park were all silently missing from the map.
//   #btnPaddle   /paddle, fetched separately, deduped against nothing.
//   #btnBankPier /bank-pier, fetched separately, deduped against nothing -- and it carries
//                "Lake Wateree State Park Bank" 52 m from /ramps' "Lake Wateree State Park",
//                plus "Molly Creek Access Area Boat Ramp" at the IDENTICAL coordinate.
//   #rampSelect  the only one that was right, and only because it is the only reader that
//                calls collapse() in js/data/launch-reach.js.
//
// And the pack itself shipped the duplicates: across all 354 launches.json on the drive, 3,501
// landing rows for 2,087 distinct landings -- 40.4% of every row thrown away by the browser on
// load.
//
// What is asserted here is the shape of the fix, not the numbers: ONE rule for "is this the
// same landing", one index behind every surface, and no second copy of either.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));

const IDX    = read('js', 'data', 'access-index.js');
const LAYER  = read('js', 'modules', 'ramps.js');
const GIS    = read('js', 'modules', 'gis-toggles.js');
const SUPP   = read('js', 'modules', 'supplemental-layers.js');
const SELECT = read('js', 'modules', 'lake-ramp-select.js');
const REACH  = read('js', 'data', 'launch-reach.js');
const GEN    = read('Scripts', 'build_ramp_reach.py');
const MAIN   = read('js', 'main.js');

// Comments in this repo quote the defects by name, so every assertion below reads CODE only.
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

test('the two deleted modules are gone and nothing imports them', () => {
  assert.equal(exists('js', 'utils', 'dedupe.js'), false,
    'utils/dedupe.js deletes 85 real named ramps; it must not come back');
  assert.equal(exists('js', 'data', 'ramps-loader.js'), false,
    'ramps-loader.js was a second copy of the /ramps feed');
  for (const [name, src] of [['main.js', MAIN], ['ramps.js', LAYER], ['gis-toggles.js', GIS],
                             ['supplemental-layers.js', SUPP], ['access-index.js', IDX]]) {
    assert.doesNotMatch(code(src), /utils\/dedupe\.js|ramps-loader\.js/,
      `${name} still references a deleted module`);
    assert.doesNotMatch(code(src), /\bdedupeLaunchesList\b|\bTRISTATE_MASTER_RAMPS\b/,
      `${name} still references the deleted ramp blob`);
  }
});

test('the POI layer names Garmin ramps from the agency and never adds one', () => {
  assert.doesNotMatch(code(SUPP), /\bmergeDnrRamps\b/,
    'mergeDnrRamps() put 2,024 four-state ramps in one lake\u2019s Garmin POI layer');
  assert.doesNotMatch(code(SUPP), /\brampsReady\b/,
    'nothing in the POI layer reads a ramp feed of its own any more');
  // The rename half is legitimate and was over-deleted on 2026-09-22. Ryan: "are you sure you
  // kept the most accurate one if you changed that?" It is back, reading the one index.
  const fn = code(SUPP).match(/function nameDnrRamps\([\s\S]*?\n\}/);
  assert.ok(fn, 'nameDnrRamps() is still in supplemental-layers.js');
  assert.match(fn[0], /allAccessPoints\(\)/, 'it must read the one index, not a feed of its own');
  assert.doesNotMatch(fn[0], /features\.push/,
    'naming a POI must never ADD one -- that is the 2,024-ramp defect coming back');
  assert.match(fn[0], /row\.launch === false/, 'a fishing pier does not get to name a ramp');
  // markFeatureLabels() can only suppress a chart name that duplicates a NAMED feature, so the
  // rename has to happen first or two labels are drawn loose beside the feature they label.
  assert.match(code(SUPP), /nameDnrRamps\(lakeKey\)[\s\S]{0,260}markFeatureLabels\(/,
    'the rename must run before the labels are marked');
});

test('every map launch button draws the one access index, not a feed of its own', () => {
  assert.match(LAYER, /from '\.\.\/data\/access-index\.js'/,
    'the launch layer must read the same index the dropdown reads');
  assert.match(LAYER, /allAccessPoints/);
  for (const btn of ['btnRamps', 'btnPaddle', 'btnBankPier']) {
    assert.match(code(LAYER), new RegExp(btn), `${btn} is no longer wired to the launch layer`);
    assert.doesNotMatch(code(GIS), new RegExp(btn),
      `${btn} is still drawn by gis-toggles.js, which is a second source`);
  }
  assert.doesNotMatch(code(GIS), /'\/paddle'|'\/bank-pier'/,
    'gis-toggles.js must not fetch a launch feed of its own');
  // /attractors is not access and stays where it is.
  assert.match(code(GIS), /'\/attractors'/);
});

test('there is exactly one answer to "is this the same landing"', () => {
  // The layer must not carry its own distance test. It imports the index’s.
  assert.match(LAYER, /import \{[^}]*\bsameLanding\b[^}]*\} from '\.\.\/data\/access-index\.js'/);
  assert.equal((code(IDX).match(/export function sameLanding\(/g) || []).length, 1);
  assert.doesNotMatch(code(LAYER), /function\s+sameLanding|function\s+samePlace\s*\(/,
    'the launch layer defines its own dedupe again');
  // allAccessPoints() collapses ACROSS lakes with that same function.
  const fn = code(IDX).match(/export function allAccessPoints\([\s\S]*?\n\}/);
  assert.ok(fn, 'allAccessPoints() is still in access-index.js');
  assert.match(fn[0], /sameLanding\(/);
  assert.match(fn[0], /mergeLanding\(/);
});

test('bank/pier is drawn but is never offered as a launch', () => {
  assert.match(code(IDX), /path: '\/bank-pier'[^}]*launch: false/,
    "/bank-pier reads through the index so the map can dedupe it, flagged as not a launch");
  // Ryan's ruling: "a bank/pier point is not a launch and would make lakes look reachable by
  // boat when they are not." Three places have to honour it.
  assert.match(code(SELECT), /\.filter\(\(p\) => p\.launch !== false\)/,
    'the launch dropdown must drop bank/pier rows');
  const live = code(IDX).match(/export function liveAccessFor\([\s\S]*?\n\}/);
  assert.ok(live, 'liveAccessFor() is still in access-index.js');
  assert.match(live[0], /p\.launch === false/,
    'the picker badge must not count a fishing pier as access');
  // ...and a bank row that IS a landing keeps the launch it earned from the other feed.
  assert.match(code(IDX), /existing\.launch = !!existing\.launch \|\| !!item\.launch/);
});

test('the producer collapses with the reader’s numbers, not numbers of its own', () => {
  assert.match(GEN, /_collapse_landings/, 'build_ramp_reach.py must collapse before it writes');
  // samePlace() in launch-reach.js is 0.0004 deg; sameNamedPlace() is 250 m. Both are argued
  // from measurement THERE. A third number here would be a third answer.
  assert.match(REACH, /Math\.abs\(a\.lat - b\.lat\) < 0\.0004/);
  assert.match(REACH, /<= 250/);
  const col = GEN.match(/def _collapse_landings\([\s\S]*?\n\ndef /);
  assert.ok(col, '_collapse_landings() is still in build_ramp_reach.py');
  assert.match(col[0], /0\.0004/, 'the producer must use the reader’s position gate');
  assert.match(col[0], /250\.0/, 'the producer must use the reader’s same-name gate');
  // The override files are keyed by coordinate; collapsing changes which key survives.
  assert.match(col[0], /alias/, 'an alias map keeps Ryan’s corrections resolving');
  assert.match(GEN, /alias\.get\(\(round\(la, 5\), round\(lo, 5\)\)\)/);
});

test('one landing is drawn by exactly one button', () => {
  // Molly Creek Access Area is a ramp AND a pier AND is filed by two feeds. With three
  // independent layers it got three pins the moment two buttons were on.
  const fn = code(LAYER).match(/function drawnBy\([\s\S]*?\n\}/);
  assert.ok(fn, 'drawnBy() is still in ramps.js');
  assert.match(fn[0], /isVisible\(/, 'precedence has to read which buttons are actually on');
  assert.match(code(LAYER), /const KINDS = \['ramp', 'paddle', 'bank'\]/);
  // Turning one button off hands its shared landings down to the next, so all of them redraw.
  assert.match(code(LAYER), /onHide: \(\) => redrawAll\(\)/);
});

// ── A LANDING ON WATER IT CANNOT LEAVE ─────────────────────────────────────────────────────────
//
// Ryan, 2026-09-22, reading the live Wateree list: "on wateree i am seeing launches that you
// can't physically get to from wateree... lugoff, debutary". Measured off a fresh producer run
// the same day: Lugoff water_m 379 on a 346-acre pool below the dam, Debutary 1605 and Stumpy
// Pond 1352 on the 1,140-acre Cedar Creek pool, against 12,031 acres of Lake Wateree. He chose
// the drop over the annotation, which makes it the SECOND deliberate exception in launch-reach.js
// after isClosed(), and chose null (not measured) to read as reachable rather than as blocked.

const REACHSRC = read('js', 'data', 'launch-reach.js');
const PLAN = read('js', 'modules', 'plan-builder.js');
const SPV2W = read('js', 'modules', 'smart-plan-v2-wiring.js');

test('a landing on water it cannot leave is dropped, and null is not false', () => {
  const fn = code(REACHSRC).match(/function offMainWater\([\s\S]*?\n\}/);
  assert.ok(fn, 'offMainWater() is still in launch-reach.js');
  // === false, never a truthy test: null means the component stamp could not run, and on the ten
  // waters over the 40,000-polygon cap that is EVERY landing on Hartwell, Thurmond and Norris.
  assert.match(fn[0], /on_main_water === false/);
  assert.doesNotMatch(fn[0], /!r\.on_main_water|on_main_water\s*\?/,
    'a falsy test would delete every landing on a lake that was never measured');
  assert.match(code(REACHSRC), /if \(offMainWater\(r\)\)/, 'collapse() must apply it');
});

test('both of collapse\u2019s drops are counted, not silent', () => {
  // A removal nobody can see is how a wrong rule survives. pool_acres is the reason the off-main
  // ones went, so it is what gets printed -- which is also the only thing in the app that reads
  // that field.
  assert.match(code(REACHSRC), /dropped\.closed/);
  assert.match(code(REACHSRC), /pool_acres/,
    'pool_acres is written by the producer and has to be read by something');
});

test('the agency\u2019s own rows get the same verdict in every dropdown', () => {
  // Lugoff and Stumpy Pond arrive through launches.json and collapse() handles them. Debutary
  // does not -- SCDNR files it under Lake Wateree and it reaches the list through access-index.
  assert.match(code(REACHSRC), /export function offMainAt\(/);
  for (const [name, src] of [['lake-ramp-select', SELECT], ['plan-builder', PLAN]]) {
    assert.match(code(src), /offMainAt\(/, `${name} must apply the off-main verdict`);
    assert.match(code(src), /launch !== false/, `${name} must also drop bank/pier rows`);
  }
  // Resolving a PICKED ramp is a different question and must not be filtered to nothing -- but it
  // must prefer a launch, or "Lake Wateree State Park" resolves to the fishing platform 52 m away.
  assert.match(code(SPV2W), /launches\.filter|\.filter\(\(p\) => p\.launch !== false\)/);
  assert.match(code(SPV2W), /\? launches : all/, 'it must fall back rather than resolve nothing');
});
