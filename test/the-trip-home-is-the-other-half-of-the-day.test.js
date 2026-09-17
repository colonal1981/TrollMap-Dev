// THE TRIP HOME IS THE OTHER HALF OF THE DAY, AND IT IS FISHING.
//
// Ryan, 2026-09-17, shown that the app charged him 8.2 km of deadhead home on a Congaree leg that
// starts 0.2 km from the ramp: "the trip home is the other half of the day... fishing... so yeah
// that needs to be fixed whatever that looks like."
//
// A LEG FISHED TWICE ENDS WHERE IT STARTED. plan-candidates.js already knew that for the hop to the
// NEXT leg — `transitToMIfFishedBack` exists because "a leg fished twice ends where it started, so
// the hop to the next leg is measured from the OTHER end". The run back to the RAMP is the same
// sentence and nobody had written it: it is `transitInM`, not `transitOutM`.
//
// SO THERE ARE TWO WHOLE DAYS, NOT TWO NUMBERS. Fishing it back costs LESS BATTERY and MORE CLOCK
// and covers twice the water, and the gate now refuses only when NEITHER day fits — its job is to
// stop him committing to a day he cannot finish, not to refuse one he could.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCandidates, structureIndex, minutesFor } from '../js/modules/plan-candidates.js';
import { riverDriftRuns } from '../js/modules/river-drifts.js';

// A straight river running due east at 34.0 N, 160 stations at 50 m = 8 km, 120 m wide, with a
// hole every 500 m so every window scores.
function eastwardRiver(stations = 161) {
  const station_m = [], bearing_deg = [], width_m = [], depth_profile_ft = [], coords = [];
  const lon0 = -81.0, lat0 = 34.0, mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  for (let i = 0; i < stations; i++) {
    station_m.push(i * 50); bearing_deg.push(90); width_m.push(120);
    coords.push([lon0 + (i * 50) / mPerDegLon, lat0]);
    depth_profile_ft.push([18, 15, 13, 11, 9, 6, 4, 2, null]);
  }
  return { type: 'FeatureCollection', features: [{
    type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
    properties: { slug: 'test_river', step_m: 50, length_m: (stations - 1) * 50, stations,
                  station_m, bearing_deg, width_m, depth_profile_ft,
                  profile_fractions: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1] },
  }] };
}
const RIVER = eastwardRiver();
const COORDS = RIVER.features[0].geometry.coordinates;
const holes = COORDS.filter((_, i) => i % 10 === 0 && i > 0).map((c, k) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [c[0], c[1] + 0.0002] },
  properties: { kind: 'hole', id: `hole_${k}`, depth_ft: 14 },
}));
const IDX = structureIndex(holes);
// The ramp sits at the river's western end, so a leg's near end is on top of it and its far end is
// the leg's own length away — which is the shape the Congaree case has.
const RAMP = COORDS[0];
const SELECT = (extra = {}) => ({ ramp: RAMP, slug: 'test_river', structures: IDX,
  fishDepthFt: [0, 99], holding: 'bottom', usableAh: 999, windowMin: 9999, maxOffM: 100, ...extra });
const drifts = () => riverDriftRuns(RIVER, { slug: 'test_river', structures: IDX, maxOffM: 100, maxM: 4000 });

test('the run home is the run out, because the boat finishes where it started', () => {
  const [c] = selectCandidates(drifts(), SELECT());
  assert.ok(c, 'the fixture yields a candidate');
  assert.equal(c.transitToRampMIfFishedBack, c.transitInM,
               'fished back, the run home is the run out — not a second measurement');
  assert.ok(c.transitOutM > c.transitInM,
            `and it is not the same as the one-pass run home: in ${c.transitInM}, out ${c.transitOutM}`);
});

test('fishing it back costs less battery and more clock, and covers twice the water', () => {
  const [c] = selectCandidates(drifts(), SELECT());
  assert.ok(c.batteryAhFishedBack < c.batteryAh,
            `${c.batteryAhFishedBack} Ah fished back against ${c.batteryAh} one pass and a deadhead`);
  assert.ok(c.estMinFishedBack > c.estMin, 'and it takes longer, because it is twice the trolling');
  // THE WHOLE POINT: the cheaper day is the one that fishes MORE. Checked against the trolling
  // itself rather than against the other day's total, because `estMin` carries transit too and a
  // ratio between the two totals says more about the deadhead than about the water.
  assert.ok(c.estMinFishedBack >= minutesFor(2 * c.lengthM, 2.0) - 1,
            `${c.estMinFishedBack} min covers two passes of ${c.lengthM} m`);
});

test('the gate refuses only when NEITHER day fits', () => {
  const one = selectCandidates(drifts(), SELECT())[0];
  // A battery that the one-pass day cannot meet but the fished-back day can. The leg must survive,
  // because it is a day he can actually finish -- "if they are going to run out of battery because
  // of choice they shouldn't be able to make that choice" is about days that CANNOT be finished.
  const tight = (one.batteryAh + one.batteryAhFishedBack) / 2;
  assert.ok(tight < one.batteryAh && tight > one.batteryAhFishedBack, 'the fixture straddles');
  const kept = selectCandidates(drifts(), SELECT({ usableAh: tight }));
  assert.ok(kept.some((c) => c.runId === one.runId), 'the leg is still offered');
  // And below BOTH, it goes.
  const gone = selectCandidates(drifts(), SELECT({ usableAh: one.batteryAhFishedBack * 0.5 }));
  assert.ok(!gone.some((c) => c.runId === one.runId), 'a day neither reading can finish is refused');
  assert.ok(gone.selection.rejected.battery > 0, 'and it is counted against the battery');
});

test('a clock that neither day fits is a clock refusal, not a battery one', () => {
  const one = selectCandidates(drifts(), SELECT())[0];
  const out = selectCandidates(drifts(), SELECT({ windowMin: Math.floor(one.estMin / 2) }));
  assert.ok(!out.some((c) => c.runId === one.runId));
  assert.ok(out.selection.rejected.window > 0, 'the counter names the clock');
  assert.equal(out.selection.rejected.battery, 0, 'and not the battery, which was never the problem');
});

test('`batteryAh` keeps its one-pass meaning, which several readers depend on', () => {
  const [c] = selectCandidates(drifts(), SELECT());
  // plan-assemble materialises each pass as a real leg with its own amp-hours, so a `batteryAh`
  // carrying two passes would have every reader of lengthM, coordinates and estDurationMin
  // quietly understating the day. The fished-back figures ride BESIDE it.
  assert.ok(c.batteryAh > c.batteryAhUpstream, 'one pass plus its transit');
  assert.ok(c.batteryAhFishedBack > c.batteryAhUpstream + c.batteryAhDownstream - 0.01,
            'and the pair plus the trip out and back');
});

test('a LAKE lane is not offered the fished-back day, and that is deliberate', () => {
  // The arithmetic is true on a lake too. It is not applied there: rampBiasM -- the 4 km at which a
  // leg is worth half what the same leg is worth off the ramp -- was tuned against the one-pass
  // transit share, and plan-weights.test.js went red on two assertions the moment the denominator
  // moved. Ryan set that ordering by looking at his own plans.
  const lane = { type: 'Feature',
    geometry: { type: 'LineString',
                coordinates: Array.from({ length: 41 }, (_, k) => [-80.720 + k * 0.0006, 34.38]) },
    properties: { depth_ft: 20, length_m: 2200, routable: true, relief: 'flat',
                  near: Array.from({ length: 6 }, (_, k) => ({ s: 200 + k * 300, t: 'timber', d: 25 })) } };
  const [c] = selectCandidates([lane], { ramp: [-80.73, 34.38], slug: 'w', fishDepthFt: [0, 99],
                                         holding: 'bottom', usableAh: 999, windowMin: 9999 });
  assert.ok(c, 'the lane is still offered');
  assert.equal(c.batteryAhFishedBack, null);
  assert.equal(c.estMinFishedBack, null);
  assert.equal(c.transitToRampMIfFishedBack, null);
  assert.equal(c.drift, null, 'and it is a lane, not a drift — which is what scopes it');
});
