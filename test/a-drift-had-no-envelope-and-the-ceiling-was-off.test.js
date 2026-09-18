import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riverDriftRuns, shallowestBesideLine, SIDE_ENVELOPE_M,
         LATERALS } from '../js/modules/river-drifts.js';
import { structureIndex, selectCandidates } from '../js/modules/plan-candidates.js';
import { waterBand } from '../js/modules/plan-pieces.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A DRIFT CARRIED NO ENVELOPE, SO THE BAIT-DEPTH CEILING WAS OFF ON EVERY RIVER
//
// Found in Ryan's 2026-09-17 Congaree bench export. The candidate carried `waterDepthFt: 6.4` and
// `depthFt`, `depthMinFt`, `depthMaxFt` and `maxRunDepthFt` ALL NULL — and those four are what
// `capBaitDepth()` judges a bait against. With no ceiling there is nothing to exceed, so the check
// did not fire, and the plan put a 1/2 oz spinnerbait rated to 25 ft on 60 FEET OF LEAD IN 6.4 FEET
// OF WATER. Silently.
//
// The cause: `waterBand()` reads `envelope_step_m` / `envelope_line_ft` / `envelope_ft`, which
// `fit_trolling_runs.py` writes on a fitted lake pass. A drift is never fitted, so it had none —
// while the centreline it is cut from carries a charted cross-section at every 50 m station. The
// measurement was there and nothing joined it up. Same family as the anoxic 8 ft: a field under
// another name, and a null is what nothing checks.
//
// Measured on the real Congaree pack after the fix, reach @47800 from Barney Jordan:
//     depthFt 6 · depthMinFt 1 · depthMaxFt 16 · maxRunDepthFt 1 · 36 of 161 stations charted
//     and the bench's own rig now says: "a 1/2oz Spinnerbait runs to 13 ft and the shallowest
//     water on this leg is 1 ft ... lead will not lift it"
// ─────────────────────────────────────────────────────────────────────────────────────────────

// A straight river running due east, 200 stations at 50 m, 120 m wide. Nine profile columns, deep
// on the left bank shallowing to the right — so a lateral position's side band is CHECKABLE by hand.
function eastwardRiver({ stations = 200, width = 120, nullFrom = null } = {}) {
  const station_m = [], bearing_deg = [], width_m = [], depth_profile_ft = [], coords = [];
  const lon0 = -81.0, lat0 = 34.0, mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  for (let i = 0; i < stations; i++) {
    station_m.push(i * 50);
    bearing_deg.push(90);
    width_m.push(width);
    coords.push([lon0 + (i * 50) / mPerDegLon, lat0]);
    depth_profile_ft.push(nullFrom != null && i >= nullFrom
      ? [null, null, null, null, null, null, null, null, null]
      : [18, 15, 13, 11, 9, 6, 4, 2, null]);
  }
  return { type: 'FeatureCollection', features: [{
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
    properties: { slug: 'test_river', step_m: 50, length_m: (stations - 1) * 50,
                  stations, station_m, bearing_deg, width_m, depth_profile_ft,
                  profile_fractions: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1] },
  }] };
}
const FRACTIONS = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
const ROW = [18, 15, 13, 11, 9, 6, 4, 2, null];

test('the side envelope is the shallowest column WITHIN 25 m, and the line is always in it', () => {
  // 120 m wide over eight gaps is 15 m a column, so 25 m reaches exactly one column either side.
  // Mid-channel is frac 0.5, column 4, reading 9 ft; its neighbours are 11 and 6.
  assert.equal(shallowestBesideLine(ROW, FRACTIONS, 0.5, 120), 6);
  // At the deep bank the band is columns 0 and 1 — 18 and 15 — so 15.
  assert.equal(shallowestBesideLine(ROW, FRACTIONS, 0, 120), 15);
  // And it never returns something the line itself contradicts: the line's own column is in band by
  // construction, so a band whose only charted member is the line reads the line.
  assert.equal(shallowestBesideLine([null, null, null, null, 9, null, null, null, null],
                                    FRACTIONS, 0.5, 120), 9);
});

test('a wider river brings fewer columns into the band, which is the definition working', () => {
  // 400 m wide is 50 m a column, so nothing but the line's own column is inside 25 m.
  assert.equal(shallowestBesideLine(ROW, FRACTIONS, 0.5, 400), 9);
  // 60 m wide is 7.5 m a column, so three either side — down to the 2 ft column at frac 0.875.
  assert.equal(shallowestBesideLine(ROW, FRACTIONS, 0.625, 60), 2);
});

test('an uncharted station is -1 and never 0, because nobody sounded it', () => {
  assert.equal(shallowestBesideLine([null, null, null, null, null, null, null, null, null],
                                    FRACTIONS, 0.5, 120), -1);
  assert.equal(shallowestBesideLine(null, FRACTIONS, 0.5, 120), -1);
  assert.equal(shallowestBesideLine(ROW, [], 0.5, 120), -1);
  // A zero is not a depth either: the pipeline writes 0 where the raster has no water.
  assert.equal(shallowestBesideLine([0, 0, 0, 0, 0, 0, 0, 0, 0], FRACTIONS, 0.5, 120), -1);
});

test('with no width there is no metre distance to test, so only the line reads', () => {
  assert.equal(shallowestBesideLine(ROW, FRACTIONS, 0.5, null), 9);
  assert.equal(shallowestBesideLine(ROW, FRACTIONS, 0.5, 0), 9);
});

test('THE ENVELOPE IS 25 m AND THAT IS THE PRODUCER\'S NUMBER, NOT A CHOICE HERE', () => {
  // `fit_trolling_runs.py --envelope-m` is 25 and plan-pieces.js documents `envelope_ft` as "the
  // shallowest water within 25 m either side of the line". A drift has to mean the same thing by the
  // same field or the two cannot share it. It is NOT the app's 100 m structure corridor.
  assert.equal(SIDE_ENVELOPE_M, 25);
});

test('a drift now carries the envelope, one value per station, in waterBand\'s own shape', () => {
  const [d] = riverDriftRuns(eastwardRiver(), { slug: 'test_river', laterals: [LATERALS[1]] });
  const p = d.properties;
  assert.equal(p.envelope_step_m, 50);
  assert.equal(p.envelope_line_ft.length, p.stations);
  assert.equal(p.envelope_ft.length, p.stations);
  // THE SIDE IS NEVER DEEPER THAN THE LINE, because the line's own column is in the band.
  for (let i = 0; i < p.stations; i++) {
    if (p.envelope_ft[i] > 0 && p.envelope_line_ft[i] > 0) {
      assert.ok(p.envelope_ft[i] <= p.envelope_line_ft[i],
                `station ${i}: side ${p.envelope_ft[i]} deeper than line ${p.envelope_line_ft[i]}`);
    }
  }
  // And it agrees with the three summary numbers the drift already reported.
  const real = p.envelope_line_ft.filter((x) => x > 0);
  assert.equal(Math.min(...real), p.shallowest_ft);
  assert.equal(Math.max(...real), p.deepest_ft);
});

test('an uncharted reach carries -1 all the way and claims no depth at all', () => {
  const [d] = riverDriftRuns(eastwardRiver({ nullFrom: 0 }), { slug: 'test_river' });
  const p = d.properties;
  assert.ok(p.envelope_line_ft.every((x) => x === -1));
  assert.ok(p.envelope_ft.every((x) => x === -1));
  // MEASURED OR ABSENT, which is the rule the summary fields already followed.
  assert.equal(p.mean_depth_ft, undefined);
  assert.equal(waterBand(p, 0, 1000), null, 'no charted station means no band, not a band of nothing');
});

// Holes every 500 m along the line, so the reach scores and is actually offered. Same shape
// a-river-leg-is-a-drift-not-a-lane.test.js uses, for the same reason: a scoreless reach is rejected
// before any of its depth fields matter.
function scoredRiver() {
  const river = eastwardRiver();
  const coords = river.features[0].geometry.coordinates;
  const feats = [];
  for (let i = 10; i < coords.length; i += 10) {
    feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: coords[i] },
                 properties: { kind: 'hole', id: `h${i}`, depth_ft: 20 } });
  }
  return { river, coords, structures: structureIndex(feats) };
}

test('AND THE FOUR FIELDS THE CEILING READS ARE NO LONGER NULL', () => {
  const { river, coords, structures } = scoredRiver();
  const drifts = riverDriftRuns(river, { structures, slug: 'test_river', laterals: [LATERALS[1]] });
  const cands = selectCandidates(drifts, {
    ramp: coords[0], slug: 'test_river', fishDepthFt: [0, 30], holding: 'suspended',
    maxOffM: 100, maxM: 8000, structures, usableAh: 200, windowMin: 900, limit: 12,
  });
  assert.ok(cands.length, 'the reach is still offered');
  for (const c of cands) {
    for (const k of ['depthFt', 'depthMinFt', 'depthMaxFt', 'maxRunDepthFt']) {
      assert.ok(Number.isFinite(Number(c[k])), `${k} is ${c[k]} — that is the bug`);
    }
    // Mid-channel on this fixture reads 9 ft the whole way, with 6 ft one column over.
    assert.equal(c.depthFt, 9);
    // AND THE CEILING IS THE LINE, NOT THE SIDE. `maxRunDepthFt = band.line.minFt` — that is
    // selectCandidates' rule on a lake and a river alike, and it is not this change's to move. See
    // the note in the next test for why it is worth a second look.
    assert.equal(c.maxRunDepthFt, 9);
  }
});

test('BOTH arrays reach waterBand, and the side is the shallower of the two', () => {
  // `envelope_ft` is the shallowest water within 25 m, so it is at or below the line everywhere. Both
  // halves are here because waterBand() returns both and its other reader — plan-pieces.js, for Pick
  // Water's `holdsFt` — uses the side.
  //
  // NAMED AND NOT CHANGED: the bait ceiling reads `band.line.minFt`, the shallowest water UNDER the
  // line, while the boat wanders 25 m either side of it and a dragged bait goes where the boat goes.
  // The side envelope is arguably the honest ceiling. That is true on every lake leg as well as every
  // river one, so moving it is its own change with its own measurement, not a rider on this one.
  const { river, structures } = scoredRiver();
  const [d] = riverDriftRuns(river, { structures, slug: 'test_river', laterals: [LATERALS[1]] });
  const band = waterBand(d.properties, 0, 2000);
  assert.equal(band.line.medianFt, 9);
  assert.equal(band.side.medianFt, 6);
  assert.ok(band.side.minFt <= band.line.minFt);
});
