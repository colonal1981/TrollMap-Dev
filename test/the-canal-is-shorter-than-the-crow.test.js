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

function loadCollapse(){
  const s = REACH.match(/export function samePlace\(a, b\) \{[\s\S]*?\n\}/);
  const c = REACH.match(/\nfunction collapse\(rows\) \{[\s\S]*?\n\}/);
  assert.ok(s && c, 'samePlace() and collapse() are still in js/data/launch-reach.js');
  // eslint-disable-next-line no-new-func
  return new Function(`${s[0].replace('export ', '')}\n${c[0]}\nreturn collapse;`)();
}

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

test('the label is the value, which is what a select needs to hold a selection', () => {
  // `opt.value = reachLabel(r); opt.textContent = opt.value;` -- one expression, assigned twice,
  // so the two cannot drift. The 2026-09-17 failure was exactly a value and a text that differed.
  assert.match(SRC, /opt\.value\s*=\s*reachLabel\(r\);\s*opt\.textContent\s*=\s*opt\.value;/,
               'the reach option assigns its text FROM its value');
});

test('the coordinates ride on the option, or the plan has no launch point', () => {
  const block = SRC.slice(SRC.indexOf('launchReachFor(waterbodyName).forEach'));
  assert.match(block.slice(0, 700), /opt\.dataset\.lat\s*=\s*r\.lat;\s*opt\.dataset\.lon\s*=\s*r\.lon;/);
});

test('a landing already hand-placed is not offered twice', () => {
  const block = SRC.slice(SRC.indexOf('const placed = getPlanRiverRamps(curated)'));
  // The question is asked through samePlace() and nowhere else, so the Plan tab and the map tab
  // cannot end up disagreeing about whether two records are one landing.
  assert.match(block.slice(0, 900), /placed\.some\(p => samePlace\(p, r\)\)/);
  // and the appended one joins the list it is checked against, so a second feed's copy of the
  // SAME landing does not become a second row
  assert.match(block.slice(0, 1200), /placed\.push\(r\)/);
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
