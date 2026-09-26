// 943 STRUCTURE FEATURES ON THE CONGAREE, UPLOADED AND CURRENT, AND THE MAP DREW NONE OF THEM.
//
// Ryan, 2026-09-20, on the reach the river took over from Lake Marion: "i don't see any structure
// in that area... did the script that marks structure get ran on that part of the river?" It did.
// Counted along the pack's own centreline in 20 slices, upstream to downstream, structure is
// DENSEST in exactly that reach -- 150 then 93 in the last two -- and the R2 manifest matched the
// local file byte for byte, 267,605 B, mtime 09-20 03:45.
//
// Then he handed over both consoles, which is what settled it. Wateree:
//
//     [supplemental] structure markers: 69 humps, 573 ledges, 191 holes for Lake Wateree, SC
//                                       (from the pack)
//
// Congaree and Marion: NO SUCH LINE AT ALL. Not zero -- nothing printed.
//
// I guessed first that they had no research profile. Ryan: "both marion and congaree have
// profiles", and then the question that is the whole finding: "all of that is built by the
// pipeline so why would a profile have anything to do with it?"
//
// It should not, and that was the bug. `renderStructureMarkers()` reads `_garminData.structure`,
// filled by the PREFETCH_LAYERS Promise.all that runs LATER IN THE SAME FUNCTION and is not
// awaited. So the call read `undefined`, `structureFor()` fell back to the profile's
// `habitat.structuralElements` -- empty since structure moved out of profiles on 2026-08-16 --
// found nothing, and returned without a word.
//
// WATEREE WORKED BY ACCIDENT. A second call comes from the `trollmap:profileLoaded` event.
// Wateree's profile had to be fetched, so that event fired late, by which time the prefetch had
// landed. Congaree and Marion had theirs cached: no fetch, no event, no second attempt. The water
// that needed a profile download got a lucky delay; the water that did not got one shot, too
// early. The profile detour was acting as the timer that hid the race.
//
// So what is asserted here is the shape of the fix, not the timing: the layer is AWAITED before
// anything is drawn, the draw does not sit behind a profile test, and the nothing-to-draw case
// says so out loud. Plus the one cross-file spelling that a unit test is the only thing that can
// catch -- the SVG pattern id, which lives in index.html and in the JS and renders as solid grey
// over open water if the two ever drift.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(HERE, '..', ...p), 'utf8');
const SUP  = read('js', 'modules', 'supplemental-layers.js');
const HTML = read('index.html');
const ADAPT = read('js', 'utils', 'structure-markers.js');
const UP   = read('Scripts', 'upload_garmin_to_r2.py');

test('the structure layer is awaited before anything is drawn', () => {
  const i = SUP.indexOf("await ensureData(lakeKey, 'structure')");
  assert.ok(i > 0, 'the lake-load path AWAITS the structure layer. Without it the renderer reads '
                 + '_garminData.structure before the prefetch has filled it, which is the whole '
                 + 'of the Congaree defect');
  const j = SUP.indexOf('renderStructureMarkers(displayName)', i);
  assert.ok(j > i, 'and the draw comes AFTER that await, not before it');
});

test('the draw does not sit behind a research profile', () => {
  // The old call site was `if (getResearchedProfile(...)) render(); else loadProfile(...).then(
  // render).catch(() => {})`, so a profile that was missing OR cached decided whether pipeline
  // data reached the map. Ryan: "all of that is built by the pipeline so why would a profile
  // have anything to do with it?"
  const gate = /if\s*\(\s*window\.getResearchedProfile\?\.\(displayName\)\s*\)\s*\{\s*\n\s*renderStructureMarkers/;
  assert.ok(!gate.test(SUP),
    'renderStructureMarkers is NOT the body of an `if (getResearchedProfile(...))`. The profile is '
  + 'the fallback for the 43 packs with no structure layer, never the gate on the other 1,700');
  assert.ok(!/\.then\(\(\) => renderStructureMarkers\(displayName\)\)\.catch\(\(\) => \{\}\);?\s*\n\s*\} else \{/.test(SUP),
    'and the only path to the renderer is not through a loadProfile() whose rejection is eaten by '
  + 'an empty catch -- that is why the failure printed nothing at all');
  // A profile arriving later used to re-render here, through the Research tab's loadProfile().
  // The tab was deleted on 2026-09-25 and the humps and ledges it read are retired fields, so
  // nothing on this path reads a profile at all -- and nothing may start to again.
  assert.ok(!/getResearchedProfile|loadProfile\(/.test(SUP.replace(/^\s*\/\/.*$/gm, '')),
    'the structure draw reads no research profile, cached or loaded');
  assert.ok(/structureFor\(_garminData\.structure, null\)/.test(SUP),
    'structureFor() is handed the pack and null for the profile');
});

test('nothing-to-draw is said out loud, not returned in silence', () => {
  const m = SUP.match(/if \(!humps\.length && !ledges\.length && !\(holes \|\| \[\]\)\.length\) \{[\s\S]{0,700}?\n  \}/);
  assert.ok(m, 'the empty case is a block, not a bare `return`');
  assert.ok(/console\.log/.test(m[0]),
    'it LOGS. A silent return is what made 943 features look like a river with no structure: the '
  + 'console showed depth areas, pois, docks, ramps and the boundary loading, and simply no line '
  + 'about structure at all');
  assert.ok(/not loaded|loaded but empty/.test(m[0]),
    'and it distinguishes "the pack layer never arrived" from "the pack layer is empty" -- those '
  + 'are different faults and only one of them is a race');
});

test('the pack is still what structure comes from', () => {
  assert.ok(/PREFETCH_LAYERS = \[[^\]]*'structure'/.test(SUP),
    'structure stays in PREFETCH_LAYERS: Smart Plan and the tap-context panel read it whether or '
  + 'not the markers are drawn');
  assert.ok(/export function structureFor\(packGeo, profileStructuralElements\)/.test(ADAPT),
    'structureFor still takes the pack FIRST and the profile second');
  assert.ok(/"structure":\s*"structure\.geojson"/.test(UP),
    'and the uploader still knows the file, or there is nothing on R2 to draw');
});

test('the not-sounded hatch is spelled the same in both files', () => {
  // THE CLASS OF BUG A UNIT TEST IS THE ONLY THING THAT CATCHES. The overrides file shipped with
  // the disk spelling `_registry/_launch_name_overrides.json` against the uploader's
  // `_registry/launch_name_overrides.json` and 404'd in silence for a day. Same shape here: the
  // <pattern> id is created in the JS and referenced from the stylesheet, and a drift renders as
  // a SOLID GREY WASH over open water -- the one thing this layer must never look like.
  const id = SUP.match(/const NOT_SOUNDED_PATTERN_ID = '([^']+)'/);
  assert.ok(id, 'the pattern id is a named constant in supplemental-layers.js');
  assert.ok(SUP.includes(`<pattern id="${'$'}{NOT_SOUNDED_PATTERN_ID}"`),
    'the <pattern> element is built from that constant, not from a second copy of the string');
  assert.ok(HTML.includes(`url(#${id[1]})`),
    `index.html fills .tm-notsounded with url(#${id[1]}), matching the constant`);
  const cls = SUP.match(/className: '([^']+)'/);
  assert.ok(cls, 'the unsurveyed layer carries a className');
  assert.ok(new RegExp(`path\\.${cls[1]}\\s*\\{`).test(HTML),
    `index.html styles path.${cls[1]}, matching the className the layer is built with`);
  assert.ok(/fill-opacity:\s*1\s*!important/.test(HTML),
    'and it forces fill-opacity, because a pattern fill at 0.22 is invisible');
});

test('the hatch cannot outlive the bands it explains', () => {
  assert.ok(/_depthAreaVisible/.test(SUP.match(/function redrawUnsurveyed\(\)[\s\S]*?\n\}/)[0]),
    'redrawUnsurveyed respects the depth-area toggle: a not-sounded hatch left up over hidden '
  + 'bands claims the whole lake is unsounded');
  assert.ok(/redrawUnsurveyed\(\);\s*\n\s*if \(!_depthAreaLayer\) return;/.test(SUP),
    'and toggleDepthAreas drives both layers -- "how deep is it" and "is there a survey here" '
  + 'are one question asked of one water');
});
