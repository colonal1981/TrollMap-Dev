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
const SRC = fs.readFileSync(path.join(HERE, '..', 'js', 'modules', 'plan-builder.js'), 'utf8');

// reachLabel() is module-private, so lift it out of the source and run the real thing rather
// than a copy that can drift away from it.
function loadReachLabel(){
  const m = SRC.match(/function reachLabel\(r\)\{[\s\S]*?\n\}/);
  assert.ok(m, 'reachLabel() is still in plan-builder.js');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}; return reachLabel;`)();
}

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
  // 0.0004 deg is about 40 m: two feeds' copies of one ramp collapse, two ramps on one lot do not.
  assert.match(block.slice(0, 900), /Math\.abs\(p\.lat - r\.lat\) < 0\.0004/);
  assert.match(block.slice(0, 900), /Math\.abs\(p\.lon - r\.lon\) < 0\.0004/);
  // and the appended one joins the list it is checked against, so a second feed's copy of the
  // SAME landing does not become a second row
  assert.match(block.slice(0, 1200), /placed\.push\(r\)/);
});

test('the fetch is claimed before it is awaited, so one tick cannot fire two', () => {
  const block = SRC.slice(SRC.indexOf('function launchReachFor'));
  const head = block.slice(0, 500);
  assert.ok(head.indexOf('LAUNCH_REACH.set(key, null)') < head.indexOf('await fetch') ||
            head.indexOf('await fetch') === -1,
            'the map is claimed before the request goes out');
  assert.match(block.slice(0, 1600), /lakeSel\.value === waterbodyName/,
               'it only redraws if the user is still on that water');
});

test('there is no distance cutoff anywhere in the app half', () => {
  // The decision was annotate, not filter. If a threshold ever appears here it is a choice
  // nobody made -- "arbitrary numbers are an AI problem, not a fishing problem".
  const from = SRC.indexOf('const LAUNCH_REACH = new Map()');
  const to = SRC.indexOf('// THE ACCESS INDEX IS FOR EVERY WATER');
  const region = SRC.slice(from, to);
  assert.ok(from > 0 && to > from, 'found the reach region');
  const compares = region.match(/water_m\s*[<>]=?\s*\d+/g) || [];
  // The one comparison allowed is the on-the-water case in reachLabel, and it is on `m`.
  assert.deepEqual(compares, [], 'no launch is hidden by its distance');
});
