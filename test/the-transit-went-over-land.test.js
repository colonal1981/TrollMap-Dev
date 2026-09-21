// T1 WAS FOUR POINTS AND TWO OF THEM WERE OVER SWAMP.
//
// Ryan, 2026-09-21, reading the GPX of a plan he had just run from Pack's Landing:
//
//     <trk><name>T1 · transit</name>
//       33.6593780 -80.5150500   the ramp
//       33.6441550 -80.5330110
//       33.6437180 -80.5328940
//       33.6437043 -80.5333599   where L1 starts fishing
//
// A rubber band from the ramp to the canal's south end, 2.2 km across open lake and swamp.
// "and yes that transit is over land... so that will need to be fixed of course". And what he
// wants instead, in his own words: "i should be able to fish the railroad tracks from packs all
// the way through the canal and up the river which is what i actually do... and i should be able
// to do that with congaree river selected so that it is an actual river plan".
//
// NEITHER ROUTER COULD ANSWER THAT PAIR, and it is worth writing down why, because both failures
// look like bugs and neither is.
//
//   * On a river the transit comes from centrelineTransit() -- the pack's own spine, no network,
//     cannot fail. The Congaree's spine runs down the main channel PAST the canal, so a ramp
//     1,801 m down a canal projects onto it as a straight line across the swamp.
//   * The water graph is Garmin's auto-guidance mesh. The river's does not reach Lake Marion at
//     all, and Marion's has the canal's two ends in its main component with NO through-channel
//     between them: asked for Pack's to the canal's south end it answers 14,712 m around the
//     lake, against 1,801 m down the canal.
//
// build_ramp_reach.py had the answer the whole time. It floods the charted water at 26 m cells
// outward from the channel and keeps a distance per cell; Pack's Landing's 1,801 m by water
// against 2,367 straight is that number, and it has been in the pack for weeks. It kept the
// number and threw the path away. trace() walks the field back down -- steepest descent on a BFS
// field, so a shortest path by construction, and over charted water, so it cannot cross land.
//
// What is asserted here is the shape that cannot be got wrong by eye: the generator writes a
// route, the loader does not lose it in the collapse, and the ramp leg wins over the two routers
// that were answering it badly WITHOUT taking any other pair off them.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(HERE, '..', ...p), 'utf8');
const GEN   = read('Scripts', 'build_ramp_reach.py');
const REACH = read('js', 'data', 'launch-reach.js');
const SPV2  = read('js', 'modules', 'smart-plan-v2.js');
const PFW   = read('js', 'modules', 'plan-from-water.js');
const UP    = read('Scripts', 'upload_garmin_to_r2.py');

// rampLegRouter is module-private to a file that pulls in half the app, so lift it out and run
// the real thing rather than a copy that can drift away from it.
function loadRampLegRouter() {
  const m = SPV2.match(/export function rampLegRouter\(launch, launchRoute, base\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'rampLegRouter() is still in smart-plan-v2.js');
  const metres = `function metresBetween(a,b){const R=6371000,t=Math.PI/180;
    const dy=(b[1]-a[1])*t, dx=(b[0]-a[0])*t*Math.cos((a[1]+b[1])/2*t);
    return Math.hypot(dx,dy)*R;}`;
  return new Function(`${metres}\n${m[0].replace('export function', 'function')}\nreturn rampLegRouter;`)();
}

const RAMP = [-80.51509, 33.65925];
// channel end first, landing last -- the order build_ramp_reach.py writes
const ROUTE = [[-80.53297, 33.64428], [-80.52847, 33.64803], [-80.52397, 33.65153],
               [-80.51947, 33.65603], [-80.51522, 33.65903]];

test('the generator writes the route it already measured', () => {
  assert.ok(/def trace\(prev, nx, ny, w0, s0, cell, i, j\)/.test(GEN),
    'build_ramp_reach.py has trace(): the route read back out of the search that measured it');
  // WRAPPED IN recentre() SINCE 2026-09-21, because trace() alone draws a raster staircase:
  // Ryan, on the 72 points it wrote for Pack's Landing, *"your 72 point route is garbage... it
  // just needs to follow the middle of the canal and it does not"*. The assertions still pin
  // trace() as the source of the line -- that is what makes it a measured route and not a guess
  // -- and now also pin the centring that turns it into a course.
  assert.ok(/raw = trace\(prev, nx, ny, w0, s0, CELL_DEG/.test(GEN),
    'the line comes from trace(), not from anything that guesses');
  assert.ok(/route = recentre\(raw, polys, deep=deep_polys\)/.test(GEN),
    'and the fairing is handed the deep water as well as the water. A simplification can stay '
  + 'wet and still cut the corner the routing paid metres to go round; without deep_polys it '
  + 'would straighten the line back onto the flat.');
  assert.ok(/'route': route,/.test(GEN),
    "and every landing record carries 'route'");
  // AND THE DISTANCE IS THAT LINE'S OWN LENGTH. It used to be the flood's cell count times the
  // cell size, which charged 26 m for a 36 m diagonal, so the number in the record and the line
  // the app draws were two different measurements of the same trip.
  assert.ok(/'water_m': int\(round\(polyline_m\(raw\)\)\) if raw else None/.test(GEN),
    'water_m is the length of the route that was written, not a count of cells');
  assert.ok(/out\.reverse\(\)/.test(GEN),
    'the route is stored CHANNEL FIRST, landing last -- the direction a boat leaves in, and the '
  + 'order rampLegRouter reverses for the outbound leg');
  assert.ok(/"launches":\s*"launches\.json"/.test(UP),
    'and the uploader still ships launches.json, or the app never sees any of it');
});

test('the loader does not lose the route in the collapse', () => {
  assert.ok(/export function routeAt\(rows, lat, lon\)/.test(REACH), 'routeAt() exists');
  assert.ok(/export async function launchRouteFor\(key, lat, lon\)/.test(REACH),
    'launchRouteFor() exists for the planners, which hold a slug rather than a display name');
  const m = REACH.match(/function collapse\(rows\) \{[\s\S]*?\n\}/);
  assert.ok(m && /hit\.route = r\.route/.test(m[0]),
    'collapse() carries the route across a merge. Two feeds record one ramp and only the row the '
  + 'generator measured has a path; losing it puts the straight line back');
  assert.ok(/Number\(r\.water_m\) < Number\(hit\.water_m\)/.test(m[0]),
    'and it keeps the route belonging to the SHORTEST water distance, not whichever row won the name');
});

test('the ramp leg wins, and only the ramp leg', () => {
  const rampLegRouter = loadRampLegRouter();
  const base = () => ({ distanceM: 999, coordinates: [[0, 0], [1, 1]], viaBase: true });
  const r = rampLegRouter(RAMP, ROUTE, base);

  const out = r(RAMP, [-80.53336, 33.64439]);
  assert.ok(out && !out.viaBase, 'a leg LEAVING the ramp is routed off the measured water');
  assert.deepEqual(out.coordinates[0], ROUTE[ROUTE.length - 1],
    'and it is reversed, so it starts at the landing');
  assert.ok(out.distanceM > 1500 && out.distanceM < 4000,
    'with a real distance off the traced geometry, not a straight line (got %d)' + out.distanceM);

  const home = r([-80.53336, 33.64439], RAMP);
  assert.ok(home && !home.viaBase, 'and the leg HOME is routed too');
  assert.deepEqual(home.coordinates[0], ROUTE[0],
    'channel first, landing last -- the way it is stored');

  const mid = r([-80.60, 33.70], [-80.61, 33.71]);
  assert.ok(mid && mid.viaBase,
    'every other pair still comes off the router this wraps. The centreline is what a river day '
  + 'is made of and this must not take it over');
});

test('it degrades to exactly what was there before', () => {
  const rampLegRouter = loadRampLegRouter();
  const base = () => ({ distanceM: 1, coordinates: [[0, 0], [1, 1]], viaBase: true });
  assert.equal(rampLegRouter(RAMP, null, base), base,
    'a pack with no measured route hands back the base router unchanged -- not a wrapper that '
  + 'answers null and drops every transit to a straight line');
  assert.equal(rampLegRouter(RAMP, [[0, 0]], base), base, 'a one-point route is not a route');
  assert.equal(rampLegRouter(null, ROUTE, base), base, 'and neither is a day with no ramp');
});

test('both planners reach for it', () => {
  assert.ok(/rampLegRouter\(o\.ramp, rampRoute, riverRoute\)/.test(SPV2),
    'the river path wraps centrelineTransit rather than replacing it');
  assert.ok(/prefetchTransits\(args\.candidates, o\.ramp, o\.routeWater, rampRoute\)/.test(SPV2),
    'and the lake path passes it through to prefetchTransits');
  assert.ok(/prefetchTransits\(candidates, o\.ramp, o\.routeWater, rampRoute\)/.test(PFW),
    'Pick Water does the same -- one resolver, both paths, which is the only way they cannot '
  + 'drift apart');
  assert.ok(/import \{ launchRouteFor \} from '\.\.\/data\/launch-reach\.js';/.test(SPV2)
         && /import \{ launchRouteFor \} from '\.\.\/data\/launch-reach\.js';/.test(PFW),
    'and both load it from the one file that knows how launches.json is shaped');

  // AND THE KEY THEY ASK WITH, WHICH IS THE HALF THAT WAS WRONG.
  //
  // Everything above passed while the feature did nothing. smart-plan-v2 names the pack `o.r2Key`
  // -- counted, not guessed: 19 uses in that file, 7 of them the fetches that pull the pack's own
  // layers off R2 -- and this one line asked with `o.slug`,
  // which that options object has never had. `launchRouteFor(undefined, ...)` returns null on its
  // first line, rampLegRouter hands back the centreline unchanged, and T1 came out a rubber band
  // across the swamp again with nothing logged and nothing thrown.
  //
  // Ryan, 2026-09-21, after the canal was in the pack and the water was right: *"it looks like
  // the transit still runs right over land... so no matter what you are going to have to make
  // something in here know where the water is"*. Something did know. It was asked by a name that
  // does not exist.
  //
  // plan-from-water calls the same value `o.slug` -- plan-water-ui passes it `slug: T.r2Key` --
  // so the two files are RIGHT to differ, and a test that just grepped for one spelling would
  // have to be wrong about one of them.
  assert.ok(/launchRouteFor\(o\.r2Key,/.test(SPV2),
    'smart-plan-v2 asks with the same pack key it fetches every other pack file with');
  assert.ok(!/o\.slug/.test(SPV2),
    'and smart-plan-v2 has no o.slug anywhere -- one name for the pack, per file');
  assert.ok(/launchRouteFor\(o\.slug,/.test(PFW),
    'plan-from-water asks with ITS name for the same value, the one plan-water-ui fills from r2Key');
});
