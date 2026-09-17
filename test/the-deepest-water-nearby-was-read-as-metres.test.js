// A FIELD NAME IS NOT ITS DEFINITION, AND `deepest_within_m` IS THE PROOF.
//
// The `_m` is the RADIUS the probe searched, not the unit of the answer. The answer is FEET.
// `build_water_features.py` sets it from `grid.span(lon, lat, --relief-m)` -- "(deepest,
// shallowest) charted depth within radius" -- off a raster of `depth_max_ft`, and
// `fit_trolling_runs.py` does the same for structure-seeded passes with an explicit `/ 3.048`.
// Scripts/test_structure_seeds.py has asserted it in feet since it was written.
//
// plan-candidates.js said the opposite for as long as it mentioned the field: "It is metres, and a
// run 8.9 ft deep carries a value of 57 -- whatever it measures, it is not feet of water." The 57
// was read as the RUN's own depth, found impossible, and the unit was blamed instead of the
// reading. 57 ft of water within 250 m of an 8.9 ft run is a channel edge, which is what the
// producer's header says it is: "the 12.1 ft runs on Wateree split into channel-edge runs with
// 34-56 ft of water within 250 m, against flats with 14-16 ft."
//
// Nothing in js/ read the field, so nothing computed a wrong number. What it cost was the fact:
// the selector has scored the `relief` WORD since 2026-08-08 -- a channel edge is worth 12 -- and
// the model was never told which word, let alone how big the drop was. Measured 2026-09-17 across
// 2,387,113 runs in 631 packs, `channel_edge` runs from 19.0 ft of drop at p10 to 64.0 ft at p90.
//
// These assertions are against the PRODUCERS and against the code, never against a comment.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { reliefDropOf, RELIEF_RADIUS_M, forModel } from '../js/modules/plan-candidates.js';
import { buildPlanRequest } from '../js/modules/plan-prompt.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEATURES_PY = readFileSync(path.join(REPO, 'Scripts/build_water_features.py'), 'utf8');
const FIT_PY = readFileSync(path.join(REPO, 'Scripts/fit_trolling_runs.py'), 'utf8');

describe('the producers, which are the only thing that can settle the unit', () => {
  test('build_water_features.py fills it from a depth probe, not a distance', () => {
    assert.match(FEATURES_PY, /f\['deepest_within_m'\]\s*=\s*d\b/,
      'build_water_features.py no longer assigns deepest_within_m from `d`');
    assert.match(FEATURES_PY, /d,\s*s\s*=\s*grid\.span\(f\['lon'\],\s*f\['lat'\],\s*a\.relief_m\)/,
      '`d` no longer comes from grid.span()');
    assert.match(FEATURES_PY, /def span\(self, lon, lat, radius_m\):\s*\n\s*"""\(deepest, shallowest\) charted depth within radius\./,
      'span() no longer documents itself as returning charted DEPTH within a radius');
    // And the raster it reads is feet by construction.
    assert.match(FEATURES_PY, /\.get\('depth_max_ft'\)/,
      'the depth grid is no longer built from depth_max_ft');
  });

  test('fit_trolling_runs.py converts decimetres to feet before storing it', () => {
    assert.match(FIT_PY, /p2\['deepest_within_m'\]\s*=\s*deep\b/,
      'fit_trolling_runs.py no longer assigns deepest_within_m from `deep`');
    assert.match(FIT_PY, /d\s*=\s*float\(np\.nanmax\(box\)\)\s*\/\s*3\.048/,
      'seed_relief() no longer divides by 3.048 — if the unit changed, everything below is wrong');
  });

  test('the app holds the same radius both producers default to', () => {
    const defaults = [FEATURES_PY, FIT_PY].map((src) => {
      const m = src.match(/add_argument\('--relief-m',\s*type=float,\s*default=([0-9.]+)/);
      assert.ok(m, 'a producer stopped declaring a --relief-m default');
      return Number(m[1]);
    });
    assert.equal(defaults[0], defaults[1],
      `build_water_features.py and fit_trolling_runs.py disagree about --relief-m: `
      + `${defaults[0]} and ${defaults[1]}. A run's relief word and a seeded pass's would then be `
      + `measured over different circles and mean different things on the same lake.`);
    assert.equal(RELIEF_RADIUS_M, defaults[0],
      `RELIEF_RADIUS_M is ${RELIEF_RADIUS_M} and the pipeline builds on ${defaults[0]}. The pack `
      + `ships the answer and not the radius, so the app cannot read this back off the chart — it `
      + `states it to the model, and it has to state the one the packs were built with.`);
  });
});

describe('reliefDropOf — the water beside the line', () => {
  test('reads the field as feet and reports the drop', () => {
    // The producer's own worked example: a 12.1 ft Wateree run on a channel edge.
    const r = reliefDropOf({ depth_ft: 12.1, deepest_within_m: 56 });
    assert.equal(r.deepestFt, 56);
    assert.equal(r.dropFt, 43.9);
  });

  test('the 8.9 ft run carrying 57 is a channel edge, not a unit error', () => {
    const r = reliefDropOf({ depth_ft: 8.9, deepest_within_m: 57 });
    assert.equal(r.dropFt, 48.1);
    // 48 ft, which is what `channel_edge` means. Read as metres it would have been 187 ft of
    // water beside a 9 ft run, which is the impossibility that got the unit blamed.
    assert.ok(r.dropFt > 15, 'a drop of 15 ft or more is what the pipeline calls a channel edge');
  });

  test('a negative drop is the raster and the contour disagreeing, so there is no answer', () => {
    // 0.60% of runs on the card, and every one of them a `flat`. Clamping it to 0 would report a
    // measurement where there is a contradiction.
    assert.equal(reliefDropOf({ depth_ft: 30, deepest_within_m: 25 }), null);
  });

  test('silence where the probe never answered, and where the run has no depth', () => {
    assert.equal(reliefDropOf({ depth_ft: 20 }), null);
    assert.equal(reliefDropOf({ depth_ft: 20, deepest_within_m: 0 }), null);
    assert.equal(reliefDropOf({ deepest_within_m: 40 }), null);
    assert.equal(reliefDropOf(null), null);
  });

  test('zero is an answer, because a flat is a real thing to be told', () => {
    const r = reliefDropOf({ depth_ft: 18, deepest_within_m: 18 });
    assert.equal(r.dropFt, 0);
  });
});

describe('what reaches the model', () => {
  const candidate = {
    runId: 'wateree_lake#256', depthFt: 28, lengthM: 2400, transitInM: 900, transitOutM: 900,
    batteryAh: 12, estMin: 140, passes: [], relief: 'channel_edge',
    deepestNearbyFt: 64, reliefDropFt: 36, runLedges: null, support: null,
  };

  test('forModel carries the word and the two numbers it was classified from', () => {
    const m = forModel(candidate);
    assert.equal(m.relief, 'channel_edge');
    assert.equal(m.deepestNearbyFt, 64);
    assert.equal(m.reliefDropFt, 36);
  });

  test('a run the probe never answered for sends nothing rather than a zero', () => {
    const m = forModel({ ...candidate, relief: null, deepestNearbyFt: null, reliefDropFt: null });
    assert.equal('relief' in m && m.relief !== undefined, false);
    assert.equal(m.deepestNearbyFt, undefined);
    assert.equal(m.reliefDropFt, undefined);
  });

  test('the prompt says what the fields are, over which radius, and what they are not', () => {
    const { user } = buildPlanRequest({
      water: 'Lake Wateree, SC', species: ['Striped Bass'], tackle: [],
      candidates: [forModel(candidate)],
    });
    assert.ok(user.includes(`within ${RELIEF_RADIUS_M} m of the pass`),
      'the prompt no longer says which circle the relief fields are measured over');
    assert.ok(/reliefDropFt/.test(user), 'the prompt no longer names reliefDropFt');
    assert.ok(/Never set a bait to/.test(user) && /deepestNearbyFt/.test(user),
      'the prompt no longer forbids fishing the nearby deep water, which is the one way this '
      + 'field can still put a bait in the wrong place');
  });
});
