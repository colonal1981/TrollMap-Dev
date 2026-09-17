// A RIVER DAY IS ONE PATH THROUGH THE RAMP, AND IT HAS NO STOPS IN IT.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// The 2026-09-17 Congaree bench is what these assertions are written against. It came back with
// five candidates -- three of them the SAME eight kilometres of river at three lateral positions --
// fished all five as separate legs, planned 731 minutes into a 540 minute window, and put a
// stop-and-cast on a scour hole with the instruction to "use a brush gripper to tie off silently to
// nearby shoreline timber". Ryan, reading it: "yeah we need the up and back design and i do not
// typically anchor in a river so stop and cast really isn't going to be a thing... i am not going to
// try and hover with either the trolling motor or the pedals."
//
// Two things were wrong and they are separate. The reaches were laid on a fixed grid from station 0
// with a maxM/2 stride, 126 km of river cut into 96 overlapping options with no relation to where
// the boat launches. And every river got all three lateral lines whatever its width, so one reach
// arrived three times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riverDriftRuns, centrelineTransit, lateralsFor, medianWidthM, LATERALS }
  from '../js/modules/river-drifts.js';
import { structureIndex, selectCandidates, forModel } from '../js/modules/plan-candidates.js';
import { buildPlanRequest, planArgsFrom } from '../js/modules/plan-prompt.js';

// A straight river running due east at 34.0 N. `stations` at 50 m apart, `width` m wide, with a
// nine-column depth profile deep on the left bank and shallowing to the right.
function eastwardRiver({ stations = 600, width = 120 } = {}) {
  const station_m = [], bearing_deg = [], width_m = [], depth_profile_ft = [], coords = [];
  const lon0 = -81.0, lat0 = 34.0, mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  for (let i = 0; i < stations; i++) {
    station_m.push(i * 50);
    bearing_deg.push(90);
    width_m.push(width);
    coords.push([lon0 + (i * 50) / mPerDegLon, lat0]);
    depth_profile_ft.push([18, 15, 13, 11, 9, 6, 4, 2, null]);
  }
  return { type: 'FeatureCollection', features: [{
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
    properties: { slug: 'test_river', step_m: 50, length_m: (stations - 1) * 50,
                  stations, station_m, bearing_deg, width_m, depth_profile_ft,
                  profile_fractions: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1] },
  }] };
}

// ── HOW MANY LINES, AND IT IS THE CORRIDOR THAT DECIDES ───────────────────────────────────────

test('at the corridor actually in force every river is one mid-channel line', () => {
  // All 57 rivers on the card have a median channel under 200 m. Two quarter lines on a 200 m river
  // are 100 m apart, and at a 100 m corridor their catchments overlap completely -- so they are one
  // line drawn twice. FORTY_THREE_OF_FIFTY_SEVEN measured exactly that: at a 100 m corridor one
  // mid-channel line takes 177 of the Congaree's 189 holes and the up-one-back-the-other pair takes
  // 180, a 1.02x gain for doubling the day's options.
  for (const w of [40, 80, 120, 145, 199]) {
    const lat = lateralsFor(w, 100);
    assert.equal(lat.length, 1, `${w} m of river is one line at a 100 m corridor`);
    assert.equal(lat[0].key, 'mid_channel');
  }
});

test('and when the corridor comes down to his fifteen metres, the wide ones become two', () => {
  // The same measurement at a 15 m corridor: one line 45 holes, up one quarter and back the other
  // 98. The rule is the geometry -- the quarters are 0.5*width apart and are two lines only when
  // their corridors do not overlap -- so the threshold falls out at 4*corridor of width, which is
  // 60 m here. That reproduces the published split (43 rivers under the line, 14 over it) without
  // anybody typing 80.
  assert.deepEqual(lateralsFor(145, 15).map((l) => l.key), ['quarter_left', 'quarter_right']);
  assert.deepEqual(lateralsFor(60, 15).map((l) => l.key), ['quarter_left', 'quarter_right']);
  assert.deepEqual(lateralsFor(59, 15).map((l) => l.key), ['mid_channel']);
  // MID-CHANNEL IS NEVER PART OF THE PAIR. The day is up one side and back the other; a third line
  // down the middle is a second day, and this app plans one.
  assert.ok(!lateralsFor(145, 15).some((l) => l.key === 'mid_channel'));
});

test('an unmeasured width is not a wide river', () => {
  assert.deepEqual(lateralsFor(null, 15).map((l) => l.key), ['mid_channel']);
  assert.deepEqual(lateralsFor(145, null).map((l) => l.key), ['mid_channel']);
  assert.equal(medianWidthM([]), null);
  assert.equal(medianWidthM([null, 0, -3]), null, 'a zero width is a missing width');
  assert.equal(medianWidthM([100, 120, 140]), 120);
});

// ── THE REACHES ARE THE DAY, AND THE DAY STARTS WHERE HE LAUNCHES ─────────────────────────────

test('the reaches are laid out from the ramp, not from station zero', () => {
  const river = eastwardRiver();                       // 600 stations = 29,950 m
  const line = river.features[0].geometry.coordinates;
  const ramp = line[300];                              // station 15,000
  const stationAt = centrelineTransit(river).stationAt;
  const rampM = stationAt(ramp);
  assert.ok(Math.abs(rampM - 15000) < 100, `the ramp projects onto its own station, got ${rampM}`);

  const drifts = riverDriftRuns(river, { slug: 'test_river', rampStationM: rampM });
  const starts = drifts.map((d) => d.properties.reachFromM).sort((a, b) => a - b);
  // A reach boundary lands ON the ramp, because that is where the day turns around and where both
  // halves of it begin. Before this the boundaries were 0, 4000, 8000 ... and the ramp was wherever
  // it happened to fall inside one.
  assert.ok(starts.includes(15000), `a reach starts at the ramp; starts were ${starts}`);
});

test('and they are butted end to end, so two neighbouring legs are not two halves of one pass', () => {
  const river = eastwardRiver();
  const drifts = riverDriftRuns(river, { slug: 'test_river', rampStationM: 15000 });
  const spans = drifts
    .map((d) => [d.properties.reachFromM, d.properties.reachFromM + Math.round(d.properties.length_m)])
    .sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) {
    // Consecutive, not overlapping. The maxM/2 stride existed to give a ranker choices over one
    // piece of water; a path has no choices to offer.
    assert.ok(spans[i][0] >= spans[i - 1][1] - 60,
              `reach ${i} starts at ${spans[i][0]}, the one before ends at ${spans[i - 1][1]}`);
  }
});

test('each leg says which half of the day it is, in words and not a sign', () => {
  const river = eastwardRiver();
  const drifts = riverDriftRuns(river, { slug: 'test_river', rampStationM: 15000 });
  const at = (start) => drifts.find((d) => d.properties.reachFromM === start).properties.from_ramp;
  // Station increases DOWNSTREAM -- 3DHP's `flowdirection` sets vertex order -- so the reaches
  // below the ramp station are the upstream half. Getting this backwards sends him down the river
  // on a full battery and back up it on an empty one.
  // Upstream reaches are named by their START station, which is their FAR end -- the boat meets
  // them at the other one. [7000, 15000] touches the ramp, so it is zero out; [0, 7000] begins
  // 8,000 m up. Downstream reaches are named by their start, which IS the near end.
  assert.equal(at(7000).direction, 'upstream');
  assert.equal(at(7000).m, 0, 'the upstream reach that touches the launch is zero out');
  assert.equal(at(0).direction, 'upstream');
  assert.equal(at(0).m, 8000, 'metres from the ramp to the NEAR end of the reach');
  assert.equal(at(15000).direction, 'downstream');
  assert.equal(at(15000).m, 0, 'the reach that starts at the launch is zero out');
  assert.equal(at(23000).direction, 'downstream');
  assert.equal(at(23000).m, 8000);
});

test('with no ramp the whole river comes back, and it says nothing about halves', () => {
  // The documented fallback, and it must not quietly claim a day shape it was not given one for.
  const drifts = riverDriftRuns(eastwardRiver(), { slug: 'test_river' });
  assert.ok(drifts.length > 0);
  for (const d of drifts) assert.equal('from_ramp' in d.properties, false);
});

test('the projector and the transit are the same projection', () => {
  const river = eastwardRiver();
  const line = river.features[0].geometry.coordinates;
  const t = centrelineTransit(river);
  const a = line[100], b = line[400];
  // One scan, one cache, one answer to "where on the river is this". A second projector would be a
  // second answer, and the two would come apart the first time either was tuned.
  assert.equal(Math.round(Math.abs(t.stationAt(a) - t.stationAt(b))), Math.round(t(a, b)));
});

test('which half of the day a leg is on reaches the model', () => {
  const river = eastwardRiver();
  const line = river.features[0].geometry.coordinates;
  const ramp = line[300];
  const structures = structureIndex(line.filter((_, i) => i % 7 === 0).map((c, i) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [c[0], c[1] + 0.0002] },
    properties: { kind: 'hole', id: `hole_${i}`, depth_ft: 20 },
  })));
  const drifts = riverDriftRuns(river, { structures, slug: 'test_river', rampStationM: 15000 });
  const cands = selectCandidates(drifts, {
    ramp, slug: 'test_river', fishDepthFt: [0, 30], holding: 'suspended',
    usableAh: 200, windowMin: 900, structures, limit: 12,
  });
  assert.ok(cands.length > 0, 'candidates came back at all');
  for (const c of cands) {
    assert.ok(c.fromRamp && c.fromRamp.direction, 'every river candidate says which half it is');
    // The river block tells the model to order the day upstream first. Until this it had nothing to
    // order BY: `flowDeg` says where the water goes, not which side of the launch a reach is on.
    const m = forModel(c);
    assert.ok(m.fromRamp && ['upstream', 'downstream'].includes(m.fromRamp.direction));
  }
  assert.ok(cands.some((c) => c.fromRamp.direction === 'upstream'), 'both halves are offered');
  assert.ok(cands.some((c) => c.fromRamp.direction === 'downstream'));
});

// ── AND THERE ARE NO STOPS ON IT ──────────────────────────────────────────────────────────────

const RIVER_CANDS = [{ runId: 'r:drift:mid_channel@0', lengthM: 8000, depthFt: 9,
                       drift: { side: 'mid_channel', label: 'mid-channel' },
                       fromRamp: { direction: 'upstream', m: 0 },
                       structures: [{ id: 'r#1:p0', type: 'hole', atM: 900, depthFt: 15,
                                      what: 'scour hole', worthFishing: true }] }];
const LAKE_CANDS = [{ runId: 'w#1', lengthM: 2500, depthFt: 24,
                      structures: [{ id: 'w#1:p0', type: 'hump', atM: 900, depthFt: 18,
                                     what: 'hump', worthFishing: true }] }];
const STOP = { runId: 'r:drift:mid_channel@0', id: 'r#1:p0', rods: ['R3'], durationMin: 15,
               why: 'deep scour hole edge',
               positioning: 'use a brush gripper to tie off silently to nearby shoreline timber' };

test('a stop returned on a river is dropped, and the drop says why', () => {
  // Rule 4 says so and the shape block asks for an empty array -- and a rule stated in a prompt is a
  // request. The bench came back with this exact stop: a 12.5 ft kayak swinging on a branch in
  // moving current with both hands on a rod.
  const args = planArgsFrom({ legs: [{ runId: RIVER_CANDS[0].runId }], stops: [STOP] }, RIVER_CANDS);
  assert.equal(args.stops.length, 0);
  assert.ok(args.problems.some((p) => /river and the boat cannot be held/.test(p)),
            `the drop is reported: ${JSON.stringify(args.problems)}`);
});

test('and the same stop on a lake is kept, because a lake is not the reason', () => {
  const lakeStop = { ...STOP, runId: 'w#1', id: 'w#1:p0' };
  const args = planArgsFrom({ legs: [{ runId: 'w#1' }], stops: [lakeStop] }, LAKE_CANDS);
  assert.equal(args.stops.length, 1);
  assert.equal(args.stops[0].structureId, 'w#1:p0');
});

test('the prompt asks a river for no stops at all, and a lake for the ones that earn it', () => {
  const common = { water: 'Congaree River, SC', ramp: 'Barney Jordan', date: '2026-09-17',
                   launchTime: '06:00', returnTime: '15:00', species: ['Largemouth Bass'],
                   conditions: {}, tackle: ['MR Crankbait (6-12ft)'], usableAh: 80 };
  const river = buildPlanRequest({ ...common, candidates: RIVER_CANDS, isRiver: true });
  const lake = buildPlanRequest({ ...common, candidates: LAKE_CANDS, water: 'Lake Wateree, SC' });

  assert.ok(river.user.includes('THERE ARE NO STOPS ON A RIVER'));
  assert.ok(river.user.includes('EMPTY, ALWAYS, ON A RIVER'));
  assert.ok(!river.user.includes('A stop is a pause ON a leg'));
  assert.ok(lake.user.includes('A stop is a pause ON a leg'));
  assert.ok(!lake.user.includes('THERE ARE NO STOPS ON A RIVER'));
});

test('the prompt gives a river the one path and a lake the ordering problem', () => {
  const common = { water: 'Congaree River, SC', ramp: 'Barney Jordan', date: '2026-09-17',
                   launchTime: '06:00', returnTime: '15:00', species: ['Largemouth Bass'],
                   conditions: {}, tackle: ['MR Crankbait (6-12ft)'], usableAh: 80 };
  const river = buildPlanRequest({ ...common, candidates: RIVER_CANDS, isRiver: true });
  const lake = buildPlanRequest({ ...common, candidates: LAKE_CANDS, water: 'Lake Wateree, SC' });

  assert.ok(river.user.includes('THE DAY IS ONE PATH'));
  // THE ORDER MOVED FROM THE MODEL TO THE APP ON 2026-09-17, when riverDay() started choosing the
  // reaches and the turnaround. The prompt used to say "ORDER THE OUTWARD HALF NEAREST-FIRST"; it
  // now hands the list over already in that order and asks for it back unchanged.
  assert.ok(river.user.includes('THE DAY IS ALREADY DRAWN'));
  assert.ok(river.user.includes('DO NOT REORDER THE LEGS'));
  assert.ok(!river.user.includes('ORDER THE OUTWARD HALF'));
  // The lake paragraph is actively wrong on a river: it says there is no out and back, and tells
  // the model to hunt for legs that are near each other. On a river they all are.
  assert.ok(!river.user.includes('There is no "out and back"'));
  assert.ok(lake.user.includes('There is no "out and back"'));
  assert.ok(!lake.user.includes('THE DAY IS ONE PATH'));
});

test('the cast-only baits are not offered on a river, because there is nothing to cast at', () => {
  const common = { water: 'Congaree River, SC', ramp: 'Barney Jordan', date: '2026-09-17',
                   launchTime: '06:00', returnTime: '15:00', species: ['Largemouth Bass'],
                   conditions: {}, usableAh: 80,
                   tackle: ['MR Crankbait (6-12ft)', 'Senko 5in'],
                   trollable: ['MR Crankbait (6-12ft)'] };
  const river = buildPlanRequest({ ...common, candidates: RIVER_CANDS, isRiver: true });
  const lake = buildPlanRequest({ ...common, candidates: LAKE_CANDS, water: 'Lake Wateree, SC' });
  assert.ok(river.user.includes('NOT ON THE WATER TODAY'));
  assert.ok(!river.user.includes('CAST ONLY — NEVER BEHIND THE BOAT'));
  assert.ok(lake.user.includes('CAST ONLY — NEVER BEHIND THE BOAT'));
  assert.ok(!lake.user.includes('NOT ON THE WATER TODAY'));
});

test('LATERALS still describes the three positions, which is what lateralsFor picks between', () => {
  assert.deepEqual(LATERALS.map((l) => l.key),
                   ['quarter_left', 'mid_channel', 'quarter_right']);
});
