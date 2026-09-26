// PACK'S LANDING IS NOT ON THE CONGAREE, AND RYAN LAUNCHES THERE TO FISH IT.
//
// He said what the map could not: "Packs is lake Marion but there is a canal that runs along
// the railroad tracks that leads directly into the river. I fish the canal as well on my way
// to the river."
//
// Nothing in the pipeline could see that. The ramp binding is NAME-FIRST -- build_dnr_ramps_by_
// lake matches the state feed's waterbody NAME to a slug and uses geometry only as a guard, and
// access-index.js does the same at runtime -- so a landing SCDNR files under "Lake Marion" never
// reached "Congaree River" however close it sat. And when I went looking for a geometric rule to
// fix it, I proposed STRAIGHT-LINE distance, which is wrong in the one direction that matters:
//
//     Pack's Landing   straight 2,367 m      by water 1,801 m
//     Low Falls        straight   330 m      by water   254 m
//
// The water route is SHORTER because it follows the canal instead of cutting across the swamp.
// A straight-line rule puts Pack's 566 m further away than it is.
//
// build_ramp_reach.py walks the charted water outward from the river's own centreline at 25 m
// and writes the distance a boat travels into `launches.json` in the pack. This is the app half:
// the curated river list is hand-written and stops at three or four launches, so those landings
// are APPENDED to it with the distance on the label.
//
// ANNOTATED, NOT FILTERED, and that is Ryan's call twice over: "If you can have these ramps be
// both river and lake I do not see the downside", and then, on whether to cut the list at a
// distance or show the number, "Annotates reads like the better answer". So there is no
// threshold in the app at all. The only bound is the search window in the generator.
//
// What is asserted here: the label, the dedupe against the hand-placed names, and the one thing
// that has already cost a river plan once -- an option's value and its text must be the same
// string, because `onRampChange()` assigns a name straight into this select and a <select> set
// to a value it does not hold SILENTLY BECOMES "".

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(HERE, '..', ...p), 'utf8');
const REACH = read('js', 'data', 'launch-reach.js');          // the one loader
const PLAN  = read('js', 'modules', 'plan-builder.js');       // Plan tab dropdown
const MAP   = read('js', 'modules', 'lake-ramp-select.js');   // map tab dropdown
const MAP2  = MAP;                                            // named for the assertions below
const GEN   = read('Scripts', 'build_ramp_reach.py');         // the generator that writes the file
const IDX   = read('js', 'data', 'access-index.js');          // the live-feed list both tabs start from
const GEN_UP = read('Scripts', 'upload_garmin_to_r2.py');     // what the served path actually is
const SRC = PLAN;

// reachLabel() is module-private, so lift it out of the source and run the real thing rather
// than a copy that can drift away from it.
function loadReachLabel(){
  const m = REACH.match(/export function reachLabel\(r\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'reachLabel() is still in js/data/launch-reach.js');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0].replace('export ', '')}; return reachLabel;`)();
}

function loadSamePlace(){
  const m = REACH.match(/export function samePlace\(a, b\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'samePlace() is still in js/data/launch-reach.js');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0].replace('export ', '')}; return samePlace;`)();
}

function loadListingAt(){
  const a = REACH.match(/export function listingAt\(rows, lat, lon\) \{[\s\S]*?\n\}/);
  const s = REACH.match(/export function samePlace\(a, b\) \{[\s\S]*?\n\}/);
  assert.ok(a && s, 'listingAt() and samePlace() are still in js/data/launch-reach.js');
  // eslint-disable-next-line no-new-func
  return new Function(`${s[0].replace('export ', '')}\n${a[0].replace('export ', '')}\n`
                      + 'return listingAt;')();
}

function loadRyanName(body){
  const m = REACH.match(/export function ryanName\(lat, lon\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'ryanName() is still in js/data/launch-reach.js');
  // eslint-disable-next-line no-new-func
  return new Function('BODY',
    `const LAUNCH_NAMES = { get: () => BODY }; ${m[0].replace('export ', '')}; return ryanName;`)(body);
}

function loadCollapse(){
  const s = REACH.match(/export function samePlace\(a, b\) \{[\s\S]*?\n\}/);
  const c = REACH.match(/\nfunction collapse\(rows\) \{[\s\S]*?\n\}/);
  const x = REACH.match(/\nfunction isClosed\(r\) \{[\s\S]*?\n\}/);
  const n = REACH.match(/\nfunction sameNamedPlace\(a, b\) \{[\s\S]*?\n\}/);
  const o = REACH.match(/\nconst NAME_SOURCE_ORDER = [^\n]+\n/);
  const k = REACH.match(/\nfunction nameRank\(r\) \{[\s\S]*?\n\}/);
  // offMainWater() joined collapse()'s callees on 2026-09-22 -- the second deliberate filter in
  // that file, after isClosed(). Ryan: "on wateree i am seeing launches that you can't physically
  // get to from wateree... lugoff, debutary".
  const f = REACH.match(/\nfunction offMainWater\(r\) \{[\s\S]*?\n\}/);
  assert.ok(s && c && x && n && o && k && f,
            'collapse() and everything it calls are still there');
  // eslint-disable-next-line no-new-func
  return new Function(`${s[0].replace('export ', '')}\n${c[0]}\n${x[0]}\n${f[0]}\n${n[0]}${o[0]}${k[0]}\n`
                      + 'return collapse;')();
}

test('SCDNR names the landing; Google names whatever is nearest to a point', () => {
  // The live regression, on the Lower Saluda. These two are 29 m apart, so merging them is
  // right -- but the nearer row carried Google's label and the one it absorbed carried SCDNR's
  // name for the landing itself, which is also what Ryan's curated list calls it. Arrival order
  // silently renamed Hope Ferry to J. B. Barker Boat Landing.
  const collapse = loadCollapse();
  const out = collapse([
    { name: 'J. B. Barker Boat Landing', lat: 34.0459994, lon: -81.1909635,
      water_m: 13418, src: ['osm', 'places'] },
    { name: 'Hope Ferry', lat: 34.045998, lon: -81.191278, water_m: 13443, src: ['dnr'] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Hope Ferry');
  assert.equal(out[0].water_m, 13418, 'the nearest water distance still wins -- only the name moved');
});

test("and Ryan's own correction beats the state agency", () => {
  const collapse = loadCollapse();
  const out = collapse([
    { name: 'WT Billy Tolar (US 378)', lat: 33.94721, lon: -80.62891, water_m: 25,
      src: ['dnr', 'ryan'] },
    { name: 'WT Billy Tolar (US 378)', lat: 33.94727, lon: -80.62756, water_m: 25,
      src: ['osm', 'places', 'ryan'] },
  ]);
  // Both records are in the overrides file, so both carry the one name -- and THAT is what
  // merges them, 120 m apart, through sameNamedPlace(). Naming the duplicate is how it is
  // retired; there is no rule anywhere about these two coordinates.
  assert.equal(out.length, 1, 'one ramp at hwy 378, and he said so');
  assert.equal(out[0].name, 'WT Billy Tolar (US 378)');
});

test('an override on only ONE of a pair does not merge them, and says so by not lying', () => {
  // The first cut of the test above named only the OSM record and expected one row. Two rows is
  // correct: 120 m is past samePlace, and two different names are not the same landing as far as
  // anything here can tell. A correction has to name BOTH records, which is why the overrides
  // file carries both positions.
  const collapse = loadCollapse();
  const out = collapse([
    { name: 'WT -Billy- Tolar', lat: 33.94721, lon: -80.62891, water_m: 25, src: ['dnr'] },
    { name: 'WT Billy Tolar (US 378)', lat: 33.94727, lon: -80.62756, water_m: 25,
      src: ['osm', 'places', 'ryan'] },
  ]);
  assert.equal(out.length, 2);
});

test('a Google name still fills a blank -- it is only outranked, never ignored', () => {
  const collapse = loadCollapse();
  const out = collapse([
    { name: null, lat: 33.5, lon: -80.5, water_m: 10, src: ['osm'] },
    { name: 'Poplar Creek Landing', lat: 33.50001, lon: -80.50001, water_m: 15,
      src: ['osm', 'places'] },
  ]);
  assert.equal(out[0].name, 'Poplar Creek Landing');
});

test('one landing recorded three times under one name is one row', () => {
  // Cypress Gardens Boat Landing arrives as three OSM nodes spread over 24 m, and C Alex Harvin
  // III Landing as three. samePlace collapses at 40 m; across the 355 packs there are 54 name
  // groups spread WIDER than that, worth 66 rows that are not a second landing.
  const collapse = loadCollapse();
  const out = collapse([
    { name: 'Cypress Gardens Boat Landing', lat: 33.05760, lon: -79.95788, water_m: 6 },
    { name: 'Cypress Gardens Boat Landing', lat: 33.05766, lon: -79.95775, water_m: 16 },
    { name: 'Cypress Gardens Boat Landing', lat: 33.05776, lon: -79.95786, water_m: 24 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].water_m, 6, 'and the nearest water distance is the one that survives');
});

test('the same ramp under one name 120 m apart is one row -- "1 ramp at hwy 378"', () => {
  // Ryan: "1 ramp at hwy 378 on the wateree", where two feeds recorded two records 120 m apart.
  // Giving both the one name in registry/_launch_name_overrides.json is what merges them; this
  // is the half that does the merging.
  const collapse = loadCollapse();
  const out = collapse([
    { name: 'WT -Billy- Tolar', lat: 33.94721, lon: -80.62891, water_m: 25 },
    { name: 'WT -Billy- Tolar', lat: 33.94727, lon: -80.62756, water_m: 25 },
  ]);
  assert.equal(out.length, 1);
});

test('three ramps called "Boat Ramp" 29 km apart stay three ramps', () => {
  // THE DISTANCE IS WHY THE NAME RULE IS SAFE. Google hands back "Boat Ramp" for ramps with no
  // name of their own, and Richard B. Russell has three of them spread over 29 KILOMETRES.
  // Merging on the name alone would silently delete two launches.
  const collapse = loadCollapse();
  const out = collapse([
    { name: 'Boat Ramp', lat: 34.00, lon: -82.60, water_m: 25 },
    { name: 'Boat Ramp', lat: 34.15, lon: -82.65, water_m: 25 },
    { name: 'Boat Ramp', lat: 34.26, lon: -82.70, water_m: 25 },
  ]);
  assert.equal(out.length, 3);
});

test('two DIFFERENT names at the same spot are still one row, by position', () => {
  // The position rule has to keep working: samePlace is checked first, so two feeds spelling one
  // landing differently 10 m apart still collapse, and the name merge never gets asked.
  const collapse = loadCollapse();
  const out = collapse([
    { name: 'Low Falls', lat: 33.632389, lon: -80.543511, water_m: 254 },
    { name: 'Low Falls Landing', lat: 33.6323542, lon: -80.5432346, water_m: 254 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Low Falls');
});

test("a landing OSM says is private is not offered as a launch", () => {
  // Ryan asked the right question: "are they campgrounds that require a launch fee... are they
  // public launches". OSM's leisure=slipway covers a dock ramp behind a house, and 198 rows
  // across the 355 packs carry an access tag that says he may not use them -- 180 of those on
  // Lake Murray and Charleston Harbor, unnamed, sitting at 0 m of water.
  const collapse = loadCollapse();
  const out = collapse([
    { name: null, lat: 34.0196, lon: -81.43625, water_m: 0, access: 'private' },
    { name: null, lat: 34.02, lon: -81.44365, water_m: 0, access: 'customers' },
    { name: 'Abandon Boat Launch', lat: 35.96111, lon: -83.86583, water_m: 1504, access: 'no' },
    { name: null, lat: 32.77923, lon: -79.95152, water_m: 0, access: 'permit' },
    { name: 'Dreher Island', lat: 34.0900, lon: -81.3000, water_m: 25, access: 'yes' },
  ]);
  assert.deepEqual(out.map((r) => r.name), ['Dreher Island']);
});

test('an absent access tag is not a "no" -- silence keeps the landing', () => {
  // 1,668 of the rows say nothing about access. The tag may only remove a landing it positively
  // rules out, never one it has no opinion on, or the list loses most of what is on it.
  const collapse = loadCollapse();
  const out = collapse([
    { name: 'Bates Bridge', lat: 33.753417, lon: -80.645129, water_m: 25 },
    { name: 'Low Falls', lat: 33.632389, lon: -80.543511, water_m: 254, access: null },
    { name: 'Rimini', lat: 33.659378, lon: -80.51505, water_m: 1801, access: '' },
    { name: 'Somewhere', lat: 33.0, lon: -80.0, water_m: 50, access: 'permissive' },
    { name: 'Elsewhere', lat: 33.1, lon: -80.1, water_m: 50, access: 'unknown' },
  ]);
  assert.equal(out.length, 5, 'no tag, null, empty, permissive and unknown all stay');
});

test('two feeds of one ramp become one row, and that row keeps the name', () => {
  // Cannons Creek, measured on the Congaree: the OSM record is unnamed and 26 m nearer by
  // water, so first-one-wins handed the dropdown "(unnamed launch)" for a ramp with a name.
  const collapse = loadCollapse();
  const out = collapse([
    { name: null, lat: 34.2867319, lon: -81.3625683, water_m: 3424, filed: ['parr_shoals_reservoir'], src: ['osm'] },
    { name: 'Cannons Creek', lat: 34.28687, lon: -81.36268, water_m: 3450, filed: ['parr_shoals_reservoir'], src: ['dnr'] },
    { name: 'Cannons Creek', lat: 34.286853, lon: -81.362674, water_m: 3450, filed: ['parr_shoals_reservoir'], src: ['natl'] },
  ]);
  assert.equal(out.length, 1, 'three records of one ramp are one row');
  assert.equal(out[0].name, 'Cannons Creek');
  assert.equal(out[0].water_m, 3424, 'the NEAREST water distance survives, not the named one');
  assert.deepEqual(out[0].src, ['dnr', 'natl', 'osm'], 'every feed that knows it is recorded');
});

test('collapse never renames a landing that already had a name', () => {
  const collapse = loadCollapse();
  // Low Falls: four records within 40 m, the DNR one first and named. It must stay itself.
  const out = collapse([
    { name: 'Low Falls', lat: 33.632389, lon: -80.543511, water_m: 254, filed: ['lake_marion'], src: ['dnr'] },
    { name: 'Low Falls Landing', lat: 33.6323542, lon: -80.5432346, water_m: 254, filed: ['lake_marion'], src: ['osm'] },
    { name: 'Low Falls Landing', lat: 33.6322304, lon: -80.543286, water_m: 254, filed: ['lake_marion'], src: ['osm'] },
    { name: 'Low Falls', lat: 33.632373, lon: -80.543506, water_m: 254, filed: ['lake_marion'], src: ['natl'] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Low Falls');
});

test('two real ramps on one stretch of bank stay two rows', () => {
  // Barney Jordan and Thomas H Newman are 1.8 km apart on the Congaree and both sit at 51 m and
  // 76 m of water. A dedupe that collapsed these would cost a launch, not a duplicate.
  const collapse = loadCollapse();
  const out = collapse([
    { name: 'Barney Jordan', lat: 33.964896, lon: -81.035702, water_m: 51 },
    { name: 'Thomas H Newman', lat: 33.949147, lon: -81.029515, water_m: 76 },
  ]);
  assert.equal(out.length, 2);
});

test('the Plan tab appends the reach list on EVERY water, not just the curated six', () => {
  // Ryan: "it did not hit the plan tab at all... i think this goes back to the 6 rivers that
  // were hard coded way back when". He was right. The append sat inside `if(curated){...return}`,
  // so 51 rivers and every lake reached the access-index branch below it and got none. Read out
  // of the running app before the fix: Great Pee Dee held 32 reachable landings in the cache and
  // showed 0; the Congaree, curated, showed 15.
  const fn = PLAN.slice(PLAN.indexOf('export function populatePlanRampDropdown'));
  const body = fn.slice(0, fn.indexOf('\ndocument.getElementById(\'planLake\')'));
  assert.equal((body.match(/launchReachFor\(waterbodyName\)/g) || []).length, 1,
               'one place asks for the reach list, not one per branch');
  const curatedAt = body.indexOf('if(curated){');
  const defAt = body.indexOf('const appendReach =');
  assert.ok(defAt >= 0 && defAt < curatedAt,
            'appendReach() is defined BEFORE the branches, so both can reach it');
  // The definition reads `const appendReach = (placed) =>`, so it is not one of these: this
  // counts CALLS, and there must be exactly two -- the curated branch and the access index.
  assert.equal((body.match(/appendReach\(/g) || []).length, 2,
               'called from both branches -- the curated one and the index one');
  // The access-index branch is the one that was missing it, and it is the one every lake and
  // the other 51 rivers take. Its call must come after the options it appends to.
  const keptAt = body.indexOf('kept.forEach(');
  const lastCall = body.lastIndexOf('appendReach(');
  assert.ok(keptAt >= 0 && lastCall > keptAt,
            'the access-index branch appends the reach list after its own rows');
});

test('the loader collapses before it caches, so both dropdowns get the same rows', () => {
  assert.match(REACH, /got\s*=\s*collapse\(d\.landings\)/,
               'launchReach() collapses the landings it caches');
  assert.equal((REACH.match(/\nfunction collapse\(rows\)/g) || []).length, 1,
               'there is one collapse(), not one per caller');
});

test('a landing on the water shows no distance, because every ramp is on the bank', () => {
  const reachLabel = loadReachLabel();
  assert.equal(reachLabel({ name: 'Bates Bridge', water_m: 25 }), 'Bates Bridge');
  assert.equal(reachLabel({ name: 'Barney Jordan', water_m: 51 }), 'Barney Jordan');
  assert.equal(reachLabel({ name: 'Thomas H Newman', water_m: 76 }), 'Thomas H Newman');
});

test("Pack's and Low Falls carry the run, in miles, to one decimal", () => {
  const reachLabel = loadReachLabel();
  assert.equal(reachLabel({ name: 'Rimini', water_m: 1801 }), 'Rimini — 1.1 mi by water');
  assert.equal(reachLabel({ name: 'Low Falls Landing', water_m: 254 }),
               'Low Falls Landing — 0.2 mi by water');
  assert.equal(reachLabel({ name: 'Stumphole Landing', water_m: 989 }),
               'Stumphole Landing — 0.6 mi by water');
});

test('a long one rounds to whole miles, and an unnamed one still reads as a launch', () => {
  const reachLabel = loadReachLabel();
  // 13,393 m is 8.32 mi -- still under ten, so it keeps the decimal. Saluda Shoals is up the
  // Lower Saluda and reaches the Congaree at its head, which is a real run and reads like one.
  assert.equal(reachLabel({ name: 'Saluda Shoals Park', water_m: 13393 }),
               'Saluda Shoals Park — 8.3 mi by water');
  // Past ten miles the tenth is noise against a day's planning.
  assert.equal(reachLabel({ name: 'Somewhere Far', water_m: 20000 }),
               'Somewhere Far — 12 mi by water');
  assert.equal(reachLabel({ name: null, water_m: 2080 }), '(unnamed launch) — 1.3 mi by water');
  assert.equal(reachLabel({ name: 'Somewhere', water_m: null }), 'Somewhere');
});

test('the label is the value, and the text is built FROM the value', () => {
  // This used to read `opt.textContent = opt.value;` -- one expression assigned twice, so the two
  // could not drift, which is the 2026-09-17 failure written as an assertion. The fee note made
  // them differ on purpose, so the assertion moves rather than loosens: the text is DERIVED from
  // the value, the name in the two is still the one string, and the VALUE never carries the note.
  //
  // Why the value has to stay clean: `#planRamp` is restored from a saved plan by assigning that
  // exact string back, and a <select> handed a value none of its options hold SILENTLY BECOMES "".
  // A note appended to the value would have blanked the ramp on every saved plan at a marina.
  assert.match(SRC, /opt\.value = reachLabel\(r\); opt\.textContent = optText\(opt\.value, r\.lat, r\.lon\);/,
               'the reach option assigns its text FROM its value');
  const label = REACH.match(/export function reachLabel\(r\) \{[\s\S]*?\n\}/);
  assert.ok(label, 'reachLabel() is still in js/data/launch-reach.js');
  assert.doesNotMatch(label[0], /listing/, 'the value carries the name and the run, and nothing else');
});

test('EVERY option in the ramp list goes through the one labeller, not just the appended ones', () => {
  // 73 of the 211 semi-private landings across the 355 packs also arrive down the live state
  // feed, so they are already in the dropdown before the reach list is appended and the append
  // skips them. Marking only the appended rows would have left Raysville Marina, Sinclair Marina
  // and Nottely Marina reading like state ramps. Three option-building sites on the Plan tab --
  // the hand-written six, the merged access index, the reach list -- and all three call it.
  const fn = PLAN.slice(PLAN.indexOf('export function populatePlanRampDropdown'));
  const body = fn.slice(0, fn.indexOf("\ndocument.getElementById('planLake')"));
  // The definition reads `const optText = (value, lat, lon) =>`, so it is not one of these:
  // this counts CALLS. I expected four and wrote the definition in by mistake -- the same slip
  // the appendReach count above already carries a comment about.
  assert.equal((body.match(/optText\(/g) || []).length, 3,
               'the curated six, the access index and the reach list, all through one labeller');
  assert.match(body, /const reach = launchReachFor\(waterbodyName\);/,
               'the list is fetched once and read by both the labeller and the append');
  // The map tab asks the same question of the same list, through the same export.
  // (Since 2026-09-24 it asks shallowAt() beside it, in one list of notes.)
  assert.match(MAP2, /listingAt\(reach, Number\(point\.lat\), Number\(point\.lon\)\)/);
  assert.match(MAP2, /shallowAt\(reach, Number\(point\.lat\), Number\(point\.lon\)\)/);
  assert.equal((MAP2.match(/function listingAt\(/g) || []).length, 0,
               'the map tab imports it -- there is no second copy to drift');
});

test('the coordinates ride on the option, or the plan has no launch point', () => {
  // Anchored on appendReach() rather than on the fetch: the fetch moved out to the top of the
  // function when the labeller started reading the same list, and the option is still built here.
  const block = SRC.slice(SRC.indexOf('const appendReach ='));
  assert.match(block.slice(0, 900), /opt\.dataset\.lat\s*=\s*r\.lat;\s*opt\.dataset\.lon\s*=\s*r\.lon;/);
});

test('a landing already listed is not offered twice, on either branch', () => {
  const block = SRC.slice(SRC.indexOf('const appendReach ='));
  // The question is asked through samePlace() and nowhere else, so the Plan tab and the map tab
  // cannot end up disagreeing about whether two records are one landing.
  assert.match(block.slice(0, 900), /placed\.some\(\(p\) => samePlace\(p, r\)\)/);
  // and the appended one joins the list it is checked against, so a second feed's copy of the
  // SAME landing does not become a second row
  assert.match(block.slice(0, 1200), /placed\.push\(r\)/);
  // What `placed` starts as is the branch's own rows -- the hand-written six on one side, the
  // merged access index on the other -- so neither branch can offer a ramp it already listed.
  assert.match(SRC, /appendReach\(getPlanRiverRamps\(curated\)/);
  assert.match(SRC, /appendReach\(kept\.filter\(/);
});

test('the fetch is claimed before it is awaited, so one tick cannot fire two', () => {
  const block = REACH.slice(REACH.indexOf('export function launchReach'));
  const head = block.slice(0, 600);
  assert.ok(head.indexOf('CACHE.set(key, null)') > -1
            && head.indexOf('CACHE.set(key, null)') < head.indexOf('await fetch'),
            'the cache is claimed before the request goes out');
});

test('BOTH dropdowns read the one loader -- this is the thing that was missing', () => {
  // Ryan: "Just to confirm they show on both the plan and map tabs?" They did not: the first
  // cut put the reach list in plan-builder only, and the map tab fills its own dropdown from
  // the access index, which is the same name-first binding the reach list exists to get past.
  for (const [name, src] of [['plan-builder', PLAN], ['lake-ramp-select', MAP]]) {
    assert.match(src, /from ['"]\.\.\/data\/launch-reach\.js['"]/,
                 `${name} imports the shared loader`);
    assert.match(src, /launchReach\(/, `${name} actually calls it`);
  }
  // and neither one keeps a private copy of the label or the match
  for (const [name, src] of [['plan-builder', PLAN], ['lake-ramp-select', MAP]]) {
    assert.doesNotMatch(src, /function reachLabel\s*\(/, `${name} has no second copy of reachLabel`);
    assert.doesNotMatch(src, /function samePlace\s*\(/, `${name} has no second copy of samePlace`);
  }
});

test('the map tab appends AFTER the framing and the coastal refine', () => {
  // A landing 8 miles up the Lower Saluda is a true answer to "can you reach the Congaree from
  // here" and a wrong one to "where is this water". refineCoastalKey() picks a zone by which
  // holds the most access points, and the framing fits the map around them when a water has no
  // registry box -- so the reach list must not be in `accessPoints` while either runs.
  const iRefine = MAP.indexOf('refineCoastalKey(selLakeName');
  const iFit    = MAP.indexOf('accessPoints.map((p) => [p.lat, p.lon])');
  const iAppend = MAP.indexOf('accessPoints = accessPoints.concat(extra)');
  const iFill   = MAP.indexOf('// Populate access dropdown');
  assert.ok(iRefine > 0 && iFit > 0 && iAppend > 0 && iFill > 0, 'found all four');
  assert.ok(iAppend > iRefine, 'appended after the coastal refine');
  assert.ok(iAppend > iFit, 'appended after the map framing');
  assert.ok(iAppend < iFill, 'and before the dropdown is filled');
});

test('the map tab never substitutes -- a feed row keeps its own marker and source', () => {
  const block = MAP.slice(MAP.indexOf('if (reach.length) {'));
  assert.match(block.slice(0, 1200), /accessPoints\.some\(\(p\) => samePlace\(p, r\)\)/,
               'a landing the feed already carries is skipped');
  assert.match(block.slice(0, 1200), /accessPoints\.concat\(extra\)/,
               'and the rest are concatenated, not assigned over');
});

test('there is no distance cutoff anywhere in the app half', () => {
  // The decision was annotate, not filter. If a threshold ever appears it is a choice nobody
  // made -- "arbitrary numbers are an AI problem, not a fishing problem".
  for (const [name, src] of [['launch-reach', REACH], ['plan-builder', PLAN], ['lake-ramp-select', MAP]]) {
    const compares = src.match(/water_m\s*[<>]=?\s*\d+/g) || [];
    assert.deepEqual(compares, [], `${name} hides no launch by its distance`);
  }
});

test('samePlace collapses two feeds on one ramp and keeps two ramps a block apart', () => {
  const samePlace = loadSamePlace();
  // The two Low Falls records, 13 m apart, are one landing under two spellings.
  assert.equal(samePlace({ lat: 33.63235, lon: -80.54323 }, { lat: 33.63223, lon: -80.54329 }), true);
  // So are Bates Bridge and the record filed under wateree_river, 10 m apart -- which is the
  // whole reason this collapses by POSITION and not by name. The 66 m in the reach table is each
  // one's distance to the CENTRELINE, not to the other; I wrote this assertion backwards once
  // and the test caught it.
  assert.equal(samePlace({ lat: 33.75342, lon: -80.64513 }, { lat: 33.75339, lon: -80.64524 }), true);
  // A landing 55 m away is a different landing: 0.0005 deg of latitude, just past the 40 m line.
  assert.equal(samePlace({ lat: 33.63235, lon: -80.54323 }, { lat: 33.63285, lon: -80.54323 }), false);
  assert.equal(samePlace({ lat: 33.63235, lon: -80.54323 }, null), false);
});

test('the county park and the campground at Taw Caw are two places, and one of them charges', () => {
  // Ryan, reading the review deck: *"Taw Caw is not a campground? there is a park there, a boat
  // ramp and a pier i think"*. He is right, and so is the data -- there are three records at Taw
  // Caw and they are three places. Taw Caw Park is Clarendon County's, 155 m from Santee Cooper's
  // Taw Caw Creek ramp; the campground and marina is 1.6 km east and is the only one of the three
  // the national layer types Semi-Private.
  const listingAt = loadListingAt();
  const rows = [
    { name: 'Taw Caw Park', lat: 33.535404, lon: -80.331685, listing: 'Public' },
    { name: 'Taw Caw Creek', lat: 33.534139, lon: -80.331072, listing: 'Public' },
    { name: 'Taw Caw Campground and Marina', lat: 33.529619, lon: -80.314319,
      listing: 'Semi-Private' },
  ];
  assert.equal(listingAt(rows, 33.529619, -80.314319), 'semi-private');
  assert.equal(listingAt(rows, 33.535404, -80.331685), '', 'the county park is not the campground');
  assert.equal(listingAt(rows, 33.534139, -80.331072), '', 'nor is the ramp 155 m from it');
  // 1,451 of the 2,965 landings are typed by nobody, and an absent answer is not a yes.
  assert.equal(listingAt([{ lat: 33.6, lon: -80.3 }], 33.6, -80.3), '');
  assert.equal(listingAt(rows, NaN, NaN), '');
  assert.equal(listingAt(null, 33.529619, -80.314319), '');
});

test('a marina the state also lists is still a marina', () => {
  // 45 of the national layer's 242 Semi-Private rows are ALSO in a state agency's water-access
  // feed: Raysville Marina, Plum Branch Yacht Club, Soap Creek Lodge & Marina, Trade Winds
  // Marina. A state listing a marina as public WATER ACCESS is not the state saying the launch
  // is free, so the restrictive word survives the merge -- in BOTH arrival orders, because which
  // record is nearer the water is an accident.
  const collapse = loadCollapse();
  const a = collapse([
    { name: 'Raysville Marina', lat: 33.7, lon: -82.4, water_m: 20, src: ['dnr'], listing: 'Public' },
    { name: 'Raysville Marina', lat: 33.70005, lon: -82.40005, water_m: 25, src: ['natl'],
      listing: 'Semi-Private' },
  ]);
  assert.equal(a.length, 1);
  assert.equal(a[0].listing, 'Semi-Private');
  const b = collapse([
    { name: 'Raysville Marina', lat: 33.70005, lon: -82.40005, water_m: 25, src: ['natl'],
      listing: 'Semi-Private' },
    { name: 'Raysville Marina', lat: 33.7, lon: -82.4, water_m: 20, src: ['dnr'], listing: 'Public' },
  ]);
  assert.equal(b.length, 1);
  assert.equal(b[0].listing, 'Semi-Private');
});

test('the generator carries the word, and only the two words that mean anything', () => {
  // The national layer types its rows "Public" (1,120) or "Semi-Private" (242). The state feeds
  // also have a `type` and it is the string "Boat Ramp" on all 897 of their rows, which says
  // nothing about who may launch -- so the gate names the two values rather than taking whatever
  // a feed puts in that field.
  assert.match(GEN, /if t in \('Public', 'Semi-Private'\)/);
  assert.match(GEN, /t == 'Semi-Private' or not rec\['listing'\]/,
               'the restrictive word wins a disagreement in the generator too');
  assert.match(GEN, /'listing': rec\.get\('listing'\) or None,/,
               'and it reaches launches.json, or none of the above matters');
});

test('his own names reach the list the live state feed built, not just the reach list', () => {
  // The gap this closes, measured on Lake Marion: he had said Stumphole Landing, Pack's Landing,
  // Taw Caw Creek Boat Ramp and Taw Caw main lake ramp, and the picker still read Calhoun
  // Subdivision, Rimini, Taw Caw Park and Taw Caw Creek -- because his overrides only ever
  // travelled in launches.json, and that is the list APPENDED to the live feed rather than the
  // list itself. A correction on a landing SCDNR also files sat on the row both tabs skip.
  const ryanName = loadRyanName({ names: {
    '33.57890,-80.53166': { name: 'Stumphole Landing' },
    '33.53540,-80.33168': { name: 'Taw Caw Creek Boat Ramp' },
    '34.30607,-81.35785': { drop: true },      // a retired OSM node -- not a rename
  } });
  assert.equal(ryanName(33.5789, -80.53166), 'Stumphole Landing');
  // SCDNR's own row for that landing is 23 m away and inside the 40 m, so it takes his name too.
  assert.equal(ryanName(33.578893, -80.531664), 'Stumphole Landing');
  assert.equal(ryanName(33.5354, -80.33168), 'Taw Caw Creek Boat Ramp');
  // 155 m south is the OTHER Taw Caw ramp and must not be swept up by it.
  assert.equal(ryanName(33.53414, -80.33107), '');
  // A drop is not a name: the access index holds state-agency rows, and deleting one because an
  // OSM slipway ten metres away was retired would remove a real ramp on another record's say-so.
  assert.equal(ryanName(34.30607, -81.35785), '');
  assert.equal(ryanName(NaN, NaN), '');
});

test('the rename happens once, where the index is built, and not at each label', () => {
  // Two label sites patched separately would leave the research engine and Smart Plan reading the
  // feed's spelling while the dropdown showed his. One call, on the built index, before the name
  // list is rebuilt -- so every reader of byLake sees the same name.
  assert.match(IDX, /import \{ primeLaunchNames, ryanName \} from '\.\/launch-reach\.js';/);
  // THE PATH, because getting it wrong is silent. upload_garmin_to_r2.py publishes
  // registry/_launch_name_overrides.json as _registry/launch_name_overrides.json -- the leading
  // underscore is the FOLDER's mark on disk and is stripped on the way to R2. I shipped the disk
  // spelling, the fetch 404'd, registry-loader did what it promises and said nothing, and the
  // dropdown still read Calhoun Subdivision.
  assert.match(REACH, /'\/chartpacks\/_registry\/launch_name_overrides\.json'/,
               'the served name, not the one on the drive');
  assert.doesNotMatch(REACH, /_registry\/_launch_name_overrides/);
  assert.match(GEN_UP, /_registry\/\{_nm\.lstrip\('_'\)\}/,
               'and the uploader is still the thing that strips it');
  assert.equal((IDX.match(/ryanName\(/g) || []).length, 1, 'asked in one place');
  assert.equal((IDX.match(/primeLaunchNames\(/g) || []).length, 1, 'read once');
  // lastIndexOf, not indexOf: `index.lakeNames` is sorted three times in this file and the two
  // earlier ones are the sorts the "rebuild the name list LAST" comment exists because of. I
  // anchored on the first and the assertion failed for the right reason.
  const at = IDX.indexOf('primeLaunchNames(workerBase())');
  const rebuild = IDX.lastIndexOf('index.lakeNames = [...index.byLake.keys()]');
  const manual = IDX.indexOf('for (const ramp of COASTAL_MANUAL_RAMPS)');
  assert.ok(at > 0 && rebuild > at, 'renamed before the pickable name list is rebuilt');
  assert.ok(manual > 0 && at > manual, 'and after every merge, so nothing added later keeps a feed name');
  // and the 40 m rule has one home
  assert.doesNotMatch(IDX, /0\.0004/, 'access-index does not carry a second copy of the 40 m rule');
});

// ── A LANDING ON WATER IT CANNOT LEAVE, RUN THROUGH THE REAL collapse() ────────────────────────
//
// Measured off a fresh build_ramp_reach.py run on Lake Wateree, 2026-09-22: Lugoff water_m 379
// on a 346-acre pool below the dam, Debutary 1605 and Stumpy Pond 1352 on the 1,140-acre Cedar
// Creek pool, against 12,031 acres of lake. Polygon adjacency separates all three; a 26 m raster
// never could, because a dam is narrower than one cell.
test('a landing off the main water is dropped, and an unmeasured one is kept', () => {
  const collapse = loadCollapse();
  const out = collapse([
    { name: 'Lake Wateree State Park', lat: 34.432841, lon: -80.858374, water_m: 0,
      on_main_water: true, pool_acres: 12031.0, src: ['dnr'] },
    { name: 'Lugoff', lat: 34.333456, lon: -80.699733, water_m: 379,
      on_main_water: false, pool_acres: 346.0, src: ['dnr'] },
    { name: 'Debutary', lat: 34.539117, lon: -80.890348, water_m: 1605,
      on_main_water: false, pool_acres: 1140.4, src: ['dnr'] },
    // A pack built before the stamp existed, or one of the ten waters over the 40,000-polygon
    // cap. NOT MEASURED IS NOT BLOCKED -- treating it as blocked would delete every landing on
    // Hartwell, Thurmond, Norris, Lanier, Cherokee and Murray.
    { name: 'Beaver Creek', lat: 34.434081, lon: -80.770029, water_m: 0, src: ['dnr'] },
    { name: 'Clearwater Cove', lat: 34.379271, lon: -80.728814, water_m: 0,
      on_main_water: null, pool_acres: null, src: ['dnr'] },
  ]);
  const names = out.map((r) => r.name).sort();
  assert.deepEqual(names, ['Beaver Creek', 'Clearwater Cove', 'Lake Wateree State Park']);
  // The dropped ones are kept on the side so the LIVE feed's own copy of them can be dropped
  // too: SCDNR files Debutary under Lake Wateree and it never arrives through launches.json.
  assert.deepEqual((out.offMain || []).map((r) => r.name).sort(), ['Debutary', 'Lugoff']);
});
