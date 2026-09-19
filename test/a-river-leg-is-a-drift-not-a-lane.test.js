// A RIVER LEG IS A DRIFT, NOT A LANE.
//
// On 2026-09-16 a Congaree bench plan returned "0 candidate legs" twice. Of 1,473 trolling runs,
// 915 were rejected as unreachable over the water graph and 415 as not fitted -- 90% of the water
// gone to two tests that are both about lanes. Ryan: "its the routes just like i thought."
//
// These assertions are the ones that would have failed before river-drifts.js existed, and the
// ones that will fail again if a drift is ever given a lane's properties.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riverDriftRuns, offsetPoint, profileIndexFor, LATERALS, lateralsFor, medianWidthM,
         meanBearingDeg, centrelineTransit } from '../js/modules/river-drifts.js';
import { structureIndex, DEFAULT_WEIGHTS, eligibleForHolding, markLabel,
         selectCandidates, forModel } from '../js/modules/plan-candidates.js';

// A straight river running due east at 34.0 N, 200 stations at 50 m = 10 km, 120 m wide.
//
// Depth profile: 9 columns RIGHT-to-LEFT, deep on the right bank, shallowing to the left, because
// that is how the producer stores one. cross_sections() in build_river_centrelines.py sweeps from
// `k = -half` -- which is half a width to the RIGHT, its normal pointing left -- and records that
// first sample at offset 0. So column 0 is the right bank looking downstream and column 8 is the
// left. This file said "left-to-right" until 2026-09-19 and every expectation below was written
// against that, which is how a lane drawn on the wrong bank passed its own tests.
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

const pointFeat = (lon, lat, kind, id) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { kind, id, depth_ft: 20 },
});

test('a hole has a weight, or every river scores zero', () => {
  // congaree_river's structure.geojson is 189 holes and 173 ledges. With no `hole` entry the holes
  // scored nothing and only the ledges could move a window, on a river where the scour hole IS the
  // structure. The weight is the citation count off the river's own researched profile -- `deep
  // holes`, 15 cites across 6 species -- by the same method as every sibling in that table.
  assert.equal(DEFAULT_WEIGHTS.hole, 15);
  assert.ok(DEFAULT_WEIGHTS.hole > DEFAULT_WEIGHTS.creek_mouth,
            'a scour hole outranks a creek mouth on moving water, 15 cites against 10');
});

test('three positions, and picking a side actually moves the boat', () => {
  // NAMED EXPLICITLY, because the default is now lateralsFor() and this 120 m test river gets ONE
  // line at the 100 m corridor in force. What is being checked here is that the three positions are
  // where they say they are -- the geometry that lateralsFor() picks between -- so the positions are
  // the input, not the thing under test. See the corridor tests below for the choosing.
  const drifts = riverDriftRuns(eastwardRiver(), { slug: 'test_river', laterals: LATERALS });
  assert.ok(drifts.length >= 3, 'at least one reach per lateral position');
  const sides = new Set(drifts.map((d) => d.properties.drift.side));
  assert.deepEqual([...sides].sort(), ['channel', 'quarter_left', 'quarter_right']);

  const first = (side) => drifts.find((d) => d.properties.drift.side === side
                                          && d.properties.reachFromM === 0);
  const left = first('quarter_left'), right = first('quarter_right');
  // MEASURED AGAINST THE CENTRELINE, NOT AGAINST THE OTHER LINE. The middle used to be a lateral
  // and both quarters were checked against it; since 2026-09-18 the middle line is the CHANNEL and
  // its position is the chart's answer, so a quarter checked against it would be testing the
  // fixture's depth profile instead of the offset convention.
  const centre = eastwardRiver().features[0].geometry.coordinates[0][1];
  // Looking downstream on an eastward river, left is NORTH. If this inverts, every drift picks up
  // the structure on the wrong bank and nothing else in the file would say so.
  assert.ok(left.geometry.coordinates[0][1] > centre,
            'quarter-left sits north of the centreline on an eastward river');
  assert.ok(right.geometry.coordinates[0][1] < centre,
            'quarter-right sits south of the centreline on an eastward river');
  // A quarter of a 120 m channel is 30 m off the centre, so the two sides are 60 m apart.
  const dLat = left.geometry.coordinates[0][1] - right.geometry.coordinates[0][1];
  assert.ok(Math.abs(dLat * 111320 - 60) < 2, `sides 60 m apart, got ${(dLat * 111320).toFixed(1)}`);
});

test('the depth under the boat is the depth on the line he picked, and the channel picks the deep', () => {
  const drifts = riverDriftRuns(eastwardRiver(), { slug: 'test_river', laterals: LATERALS });
  const at = (side) => drifts.find((d) => d.properties.drift.side === side
                                       && d.properties.reachFromM === 0).properties.mean_depth_ft;
  // The section runs 18 ft on the RIGHT bank to 2 ft on the left. Asking for the minimum across
  // the whole section gives the margin at every station, which is why the profile is read at the
  // fraction actually travelled.
  assert.equal(at('quarter_right'), 13);
  assert.equal(at('quarter_left'), 4);
  assert.ok(at('quarter_right') > at('quarter_left'), 'picking a side changes the water under him');
  // AND THE CHANNEL LINE IS NOT A FOURTH GUESS -- it is the deepest column the chart has, which on
  // this fixture is the right bank at 18 ft. A line down the middle of this river would read 9, and
  // reading 9 on water that is charted at 18 is the defect Ryan found on his own Congaree tail.
  assert.equal(at('channel'), 18);
  assert.ok(at('channel') > at('quarter_right'), 'the channel beats the best fixed position');

  // ── AND IT IS DRAWN ON THE SIDE THE DEPTH CAME OFF, WHICH NOTHING EVER CHECKED ───────────────
  //
  // This is the assertion the file was missing, and its absence is the whole of Ryan's 2026-09-19
  // day: the channel line reported the deepest column correctly and was drawn on the mirror of it,
  // so the card said 12 ft over water Garmin charts at 8.6, with 16 points of one leg over 3 ft or
  // less and turns up to 111 degrees where the lane crossed the river the wrong way.
  //
  // The deepest column on this fixture is column 0, the RIGHT bank, and right of an eastward river
  // is SOUTH. A drawn line that reads 18 ft while sitting north of the centre is reading one bank
  // and floating over the other.
  const centreLat = eastwardRiver().features[0].geometry.coordinates[0][1];
  const chan = drifts.find((d) => d.properties.drift.side === 'channel'
                                && d.properties.reachFromM === 0);
  assert.ok(chan.geometry.coordinates[0][1] < centreLat,
            'the channel line sits south of the centre, on the bank its 18 ft came from');
  // Half a width off the centre, because the deepest column IS the bank on this fixture.
  const offM = (centreLat - chan.geometry.coordinates[0][1]) * 111320;
  assert.ok(Math.abs(offM - 60) < 2, `a full half-width off the centre, got ${offM.toFixed(1)} m`);
});

test('an uncharted station is uncharted, not one foot deep', () => {
  // On the Congaree 105 of 2,537 stations have no charted depth at all. Storing a shallow number
  // there is the `0 ft relief` defect -- a missing measurement wearing the clothes of a real one.
  const drifts = riverDriftRuns(eastwardRiver({ nullFrom: 0 }), { slug: 'test_river' });
  assert.ok(drifts.length > 0, 'the reach is still laid out');
  for (const d of drifts) {
    assert.equal(d.properties.mean_depth_ft, undefined, 'no depth is asserted where none is charted');
    assert.equal(d.properties.charted_frac, 0);
    // And the selector must REJECT it rather than plan over water nothing measured.
    const elig = eligibleForHolding(d.properties, [5, 20], null);
    assert.equal(elig.ok, false);
    assert.match(elig.rule, /no charted depth/);
  }
});

test('a drift carries no lane properties, so no lane test can fire on it', () => {
  const drifts = riverDriftRuns(eastwardRiver(), { slug: 'test_river' });
  for (const d of drifts) {
    // `routable` means the water graph could route this. The graph was never asked and on a river
    // it should not be: the charted water's own continuity is 88-99% with no land test at all.
    assert.ok(!('routable' in d.properties), 'routable is absent, not asserted true');
    // `fitted` belongs to fit_trolling_runs.py. A batch may not assert a field it did not compute,
    // and selectCandidates derives fittedAvailable from the array it is handed -- so a set of only
    // drifts switches that gate off by itself rather than by being lied to.
    assert.ok(!('fitted' in d.properties), 'fitted is absent, not asserted true');
    assert.ok(!('depth_ft' in d.properties), 'there is no contour behind a drift');
    assert.ok(d.properties.length_m > 0 && Array.isArray(d.properties.near));
  }
});

test('structure joins by measured distance, and on a narrow river that reaches both banks', () => {
  const river = eastwardRiver();
  const [lon0, lat0] = river.features[0].geometry.coordinates[100];
  const m = 1 / 111320;
  // One hole 30 m NORTH of the centre -- on the quarter-left line -- and one 300 m north, which is
  // off the river entirely.
  const structures = structureIndex([pointFeat(lon0, lat0 + 30 * m, 'hole', 'hole_near'),
                                     pointFeat(lon0, lat0 + 300 * m, 'hole', 'hole_far')]);
  const drifts = riverDriftRuns(river, { structures, slug: 'test_river', laterals: LATERALS });
  const marks = (side) => drifts.filter((d) => d.properties.drift.side === side)
    .flatMap((d) => d.properties.near).filter((n) => n.t === 'hole');

  // THE FIRST VERSION OF THIS TEST ASSERTED THE OPPOSITE AND WAS WRONG, which is worth keeping
  // rather than quietly correcting. A 120 m channel puts the two quarter lines 60 m apart, and
  // `maxOffM` is 100, so a hole on the left bank is still "on the way" from the right one. On a
  // card where 43 of 57 rivers are under 80 m wide that is the normal case, not an edge: PICKING A
  // SIDE ON A NARROW RIVER CHANGES THE WATER UNDER THE BOAT AND THE DISTANCE TO THE STRUCTURE, NOT
  // WHICH STRUCTURE HE PASSES. Ryan said exactly that -- "you are going to either pick a side or
  // the middle and then kind of follow where the fish might be" -- and the depth test above is
  // where the three positions genuinely differ, by three times the median depth.
  assert.ok(marks('quarter_left').length > 0, 'the hole reaches the line it sits on');
  assert.ok(marks('quarter_right').length > 0, 'and, at 60 m, the far quarter line too');
  const nearest = (side) => Math.min(...marks(side).map((n) => n.d));
  assert.ok(nearest('quarter_left') < nearest('quarter_right'),
            'but it is nearer the bank it is on, which is what the scoring reads');
  assert.ok(Math.abs(nearest('quarter_left')) < 5, 'a hole on the line is on the line');
  assert.ok(Math.abs(nearest('quarter_right') - 60) < 5, 'and 60 m off the opposite quarter');
  // The one 300 m out is off the river and reaches nothing, whichever side he takes.
  for (const side of ['quarter_left', 'mid_channel', 'quarter_right']) {
    for (const n of marks(side)) assert.ok(n.d <= 100, 'nothing past maxOffM is ever joined');
  }
});

test('the lateral fraction maps to a real profile column', () => {
  const fr = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
  assert.equal(profileIndexFor(fr, 0.25), 2);
  assert.equal(profileIndexFor(fr, 0.5), 4);
  assert.equal(profileIndexFor(fr, 0.75), 6);
  assert.equal(profileIndexFor([], 0.5), -1);
  // The two quarters are constants; the middle one is `null`, which means ask the chart at every
  // station -- see channelFractions(). A number here would be the defect back.
  // 0.75 IS THE LEFT BANK'S QUARTER AND 0.25 IS THE RIGHT'S, because column 0 is the right bank --
  // see the fixture note at the top of this file. These were [0.25, null, 0.75] until 2026-09-19,
  // which named each quarter after the bank it was not on.
  assert.deepEqual(LATERALS.map((l) => l.frac), [0.75, null, 0.25]);
});

test('offsetPoint puts a positive offset to the right of downstream', () => {
  // Bearing 0 is due north, so right of it is due east: longitude increases, latitude does not.
  const [lon, lat] = offsetPoint(-81, 34, 0, 100);
  assert.ok(lon > -81, 'right of north is east');
  assert.ok(Math.abs(lat - 34) < 1e-9, 'and not north or south of it');
});

// A river with a hole every 500 m, so every reach scores and nothing is cut for being empty.
function scoredRiver() {
  const river = eastwardRiver();
  const coords = river.features[0].geometry.coordinates;
  const feats = [];
  for (let i = 10; i < coords.length; i += 10) {
    feats.push(pointFeat(coords[i][0], coords[i][1], 'hole', `h${i}`));
  }
  return { river, coords, structures: structureIndex(feats) };
}

const SELECT = (structures, ramp) => ({
  ramp, slug: 'test_river', fishDepthFt: [0, 30], holding: 'suspended',
  usableAh: 200, windowMin: 900, structures, limit: 12,
});

test('the dedupe does not get to decide which side he fishes', () => {
  // Measured on congaree_river the first day this ran: 96 drifts in, 7 out, 24 cut by the dedupe,
  // and every survivor was a DIFFERENT REACH -- so the app was picking his side for him and showing
  // the winner as if it were the only water there. The start-distance test did it: three lines over
  // one reach start 30-60 m apart against a 1,200 m rule.
  const { river, coords, structures } = scoredRiver();
  const drifts = riverDriftRuns(river, { structures, slug: 'test_river', laterals: LATERALS });
  const cands = selectCandidates(drifts, SELECT(structures, coords[0]));
  assert.ok(cands.length > 0, 'candidates came back at all');

  const byReach = {};
  for (const c of cands) {
    assert.ok(c.drift && c.drift.side, 'every drift candidate says which line it is on');
    const reach = c.runId.split('@')[1];
    (byReach[reach] = byReach[reach] || new Set()).add(c.drift.side);
  }
  const offeredBothWays = Object.values(byReach).filter((s) => s.size > 1);
  assert.ok(offeredBothWays.length > 0,
            'at least one reach is offered at more than one lateral position');
});

test('and a lane still dedupes against a lane, because a lake has no side to pick', () => {
  // The A/B that proves the change is the QUESTION and not the thresholds. Same geometry, same
  // scores, same numbers -- the only difference is whether a candidate knows which line it is on.
  const { river, coords, structures } = scoredRiver();
  const drifts = riverDriftRuns(river, { structures, slug: 'test_river', laterals: LATERALS });
  const asLanes = drifts.map((d) => {
    const props = { ...d.properties };
    delete props.drift;
    return { ...d, properties: props };
  });
  const withSides = selectCandidates(drifts, SELECT(structures, coords[0])).length;
  const withoutSides = selectCandidates(asLanes, SELECT(structures, coords[0])).length;
  assert.ok(withoutSides < withSides,
            `stripping the side collapses the lines: ${withSides} with, ${withoutSides} without`);
  assert.ok(withoutSides > 0, 'and does not collapse them to nothing');
});

test('the reported depth rule is the one applied, not the first one seen', () => {
  // congaree_river's first drift run reported "no charted depth" while 66 of 96 drifts were being
  // judged against the band, because the first drift in the array sat on an uncharted reach and the
  // rule latched. The sentence whose whole job is saying WHICH test emptied the list was naming the
  // wrong test.
  const { structures, coords } = scoredRiver();
  // A reach is maxM (8000 m) long and they are butted end to end, so to get one reach entirely
  // uncharted the river has to be longer than one reach: 400 stations is 20 km, and nulling the
  // first 161 of them makes the reach at 0 uncharted end to end while the reach at 8000 still has
  // charted water. Station 0 is where the latch used to happen.
  const river = eastwardRiver({ stations: 400 });
  const props = river.features[0].properties;
  for (let i = 0; i <= 160; i++) props.depth_profile_ft[i] = new Array(9).fill(null);
  const drifts = riverDriftRuns(river, { structures, slug: 'test_river' });
  assert.ok(drifts.some((d) => d.properties.mean_depth_ft == null), 'some reach is uncharted');
  assert.ok(drifts.some((d) => d.properties.mean_depth_ft != null), 'and some reach is not');

  const cands = selectCandidates(drifts, SELECT(structures, coords[0]));
  const rule = cands.selection.depthRule;
  assert.match(rule, /suspended/, `the band rule is reported, got: ${rule}`);
  assert.doesNotMatch(rule, /no charted depth/,
                      'and not the failure wording off an uncharted reach');
});

test('but when nothing is charted it says exactly that', () => {
  // The other half: "we applied a rule and nothing passed" and "nothing here has a depth to judge"
  // are different days, and the fallback must not go silent.
  const { structures, coords } = scoredRiver();
  const drifts = riverDriftRuns(eastwardRiver({ nullFrom: 0 }), { structures, slug: 'test_river' });
  const cands = selectCandidates(drifts, SELECT(structures, coords[0]));
  assert.equal(cands.length, 0);
  assert.match(cands.selection.depthRule, /no charted depth/);
  assert.equal(cands.selection.rejected.depth, drifts.length);
});

// ── THE CURRENT ────────────────────────────────────────────────────────────────────────────────
// A river 10 km long, 120 m wide, with a charted section at every station: area 200 m2 and a
// deepest line of 10 ft, so every station is eligible to divide a discharge.
function sectionedRiver({ area = 200, deepestFt = 10, stations = 200 } = {}) {
  const river = eastwardRiver({ stations });
  const p = river.features[0].properties;
  p.area_m2 = new Array(stations).fill(area);
  p.deepest_line_ft = new Array(stations).fill(deepestFt);
  return river;
}

test('V = Q/A, in the units the gauge actually publishes', () => {
  // 3,000 cfs over a 200 m2 section: 3000 * 0.0283168466 = 84.95 m3/s, / 200 = 0.4248 m/s,
  // * 2.2369363 = 0.950 mph. Worked by hand so a bad conversion constant cannot hide behind a
  // plausible-looking number -- the whole point of V = Q/A is that it is checkable.
  const drifts = riverDriftRuns(sectionedRiver(), { slug: 'test_river', flowCfs: 3000 });
  for (const d of drifts) {
    assert.equal(d.properties.current_mph, 0.95);
    assert.equal(d.properties.current_frac, 1);
    assert.match(d.properties.current_basis, /Q\/A/);
  }
  // Double the discharge, double the speed. Halve the section, double the speed.
  const fast = riverDriftRuns(sectionedRiver(), { slug: 'test_river', flowCfs: 6000 });
  assert.equal(fast[0].properties.current_mph, 1.9);
  const narrow = riverDriftRuns(sectionedRiver({ area: 100 }), { slug: 'test_river', flowCfs: 3000 });
  assert.equal(narrow[0].properties.current_mph, 1.9);
});

test('a section with no real depth in it may not divide a discharge', () => {
  // THE GUARD IS THE CHART, NOT THE CODE. On the Congaree 877 stations have no charted point deeper
  // than 2 ft on a river that is 76% charted, and dividing 3,000 cfs by one of those sections
  // returns 8.30 mph, which is not a river.
  const river = sectionedRiver({ area: 20, deepestFt: 1 });
  const drifts = riverDriftRuns(river, { slug: 'test_river', flowCfs: 3000 });
  for (const d of drifts) {
    assert.equal(d.properties.current_mph, undefined, 'no velocity off a section with no depth');
    assert.match(d.properties.current_basis, /2 ft or more of charted section/);
  }
});

test('the support travels with the number', () => {
  // A velocity from a handful of stations and one from all of them are different claims. No cutoff
  // is applied here -- the fraction is reported so whoever consumes it can pick.
  const river = sectionedRiver();
  const p = river.features[0].properties;
  for (let i = 0; i < 200; i++) if (i % 10) p.deepest_line_ft[i] = 1;  // 1 station in 10 survives
  const drifts = riverDriftRuns(river, { slug: 'test_river', flowCfs: 3000 });
  const d = drifts.find((x) => x.properties.current_mph != null);
  assert.ok(d, 'a thinly supported reach still reports a velocity');
  assert.ok(d.properties.current_frac > 0 && d.properties.current_frac < 0.2,
            `and says how thin: ${d.properties.current_frac}`);
  assert.equal(d.properties.current_mph, 0.95, 'the value itself is unaffected');
});

test('a tidal river is told it is tidal instead of quoted a number', () => {
  // Eleven of the 57 carry a NOAA tide station and reverse twice a day, so an instantaneous
  // discharge is not the flow and Q/A does not describe it.
  const drifts = riverDriftRuns(sectionedRiver(), { slug: 'test_river', flowCfs: 3000, tidal: true });
  for (const d of drifts) {
    assert.equal(d.properties.current_mph, undefined);
    assert.match(d.properties.current_basis, /tidal/);
  }
});

test('no gauge says no gauge, rather than going quiet', () => {
  const drifts = riverDriftRuns(sectionedRiver(), { slug: 'test_river' });
  for (const d of drifts) {
    assert.equal(d.properties.current_mph, undefined);
    assert.match(d.properties.current_basis, /no discharge/);
  }
});

test('the flow direction is a circular mean, not an arithmetic one', () => {
  // 350 and 10 average to 0, not to 180. A river doubling back on itself is what the naive version
  // reports on any reach that crosses north.
  assert.equal(Math.round(meanBearingDeg([350, 10])), 0);
  assert.equal(Math.round(meanBearingDeg([80, 100])), 90);
  assert.equal(meanBearingDeg([]), null);
  assert.equal(meanBearingDeg([0, 180]), null, 'bearings that cancel have no mean to report');
  // And the drift carries it, because until now nothing in the app knew which way the water went.
  const drifts = riverDriftRuns(sectionedRiver(), { slug: 'test_river', flowCfs: 3000 });
  assert.equal(drifts[0].properties.flow_deg, 90, 'due east, which is how the fixture is built');
  // ONE ANGLE, ONE MEANING. `current_deg` used to be emitted here holding the same value, which is a
  // trap: ampHoursBand() wants the direction a flow comes FROM and this is where it is going, so
  // passing it straight through is 180 degrees wrong. The reciprocal is taken at the point of use.
  assert.ok(!('current_deg' in drifts[0].properties),
            'no second name for the same angle with the opposite meaning');
});

test('the current reaches the model, because the model owns the order', () => {
  const { structures, coords } = scoredRiver();
  const river = sectionedRiver();
  const drifts = riverDriftRuns(river, { structures, slug: 'test_river', flowCfs: 3000 });
  const cands = selectCandidates(drifts, SELECT(structures, coords[0]));
  assert.ok(cands.length > 0);
  for (const c of cands) {
    assert.equal(c.currentMph, 0.95);
    assert.equal(c.flowDeg, 90, 'where the water is going, in plain English');
    assert.ok(c.currentBasis, 'and the basis is never null');
    const m = forModel(c);
    assert.equal(m.currentMph, 0.95, 'it survives the trim to what the model sees');
    assert.equal(m.flowDeg, 90);
    assert.ok(m.currentBasis);
    assert.ok(m.drift && m.drift.side, 'and so does which line it is');
  }
});

test('the upstream price is upstream whichever way the river happens to run', () => {
  // THE TEST THAT CATCHES A HARD-CODED 0/180. The first version of the cost passed course 0 against
  // a current from 0, which is correct by construction and therefore says nothing about whether the
  // real bearing is being used. A river running WEST must still charge more upstream.
  const { structures, coords } = scoredRiver();
  const west = sectionedRiver();
  const p = west.features[0].properties;
  for (let i = 0; i < p.bearing_deg.length; i++) p.bearing_deg[i] = 270;
  const drifts = riverDriftRuns(west, { structures, slug: 'test_river', flowCfs: 3000 });
  assert.equal(drifts[0].properties.flow_deg, 270, 'the fixture flows west');
  const cands = selectCandidates(drifts, SELECT(structures, coords[0]));
  assert.ok(cands.length > 0, 'a westward river still produces candidates');
  for (const c of cands) {
    assert.ok(c.batteryAhUpstream > c.batteryAhDownstream,
              `west-flowing: upstream ${c.batteryAhUpstream} must still exceed ${c.batteryAhDownstream}`);
  }
  // And the magnitudes match the eastward case, because a river's cost does not depend on which way
  // the compass happens to point.
  const east = riverDriftRuns(sectionedRiver(), { structures, slug: 'test_river', flowCfs: 3000 });
  const eastCands = selectCandidates(east, SELECT(structures, coords[0]));
  assert.equal(eastCands.length, cands.length);
  assert.ok(Math.abs(eastCands[0].batteryAhUpstream - cands[0].batteryAhUpstream) < 0.01);
});

test('a river pass is priced both ways, and the gate takes the dearer one', () => {
  // The direction is not chosen at candidate time -- orientLegs and the model decide later -- so the
  // feasibility gate has to pick a price without knowing. It takes the upstream one, because the gate
  // exists to stop him committing to a day he cannot finish.
  const { structures, coords } = scoredRiver();
  const river = sectionedRiver();
  const drifts = riverDriftRuns(river, { structures, slug: 'test_river', flowCfs: 3000 });
  const cands = selectCandidates(drifts, SELECT(structures, coords[0]));
  assert.ok(cands.length > 0);
  for (const c of cands) {
    assert.ok(c.batteryAhUpstream > c.batteryAhDownstream,
              `upstream ${c.batteryAhUpstream} should cost more than downstream ${c.batteryAhDownstream}`);
    // batteryAh is one pass plus transit, and the pass it prices is the upstream one.
    assert.ok(c.batteryAh >= c.batteryAhUpstream,
              'batteryAh carries the upstream pass plus the transit on top');
    const m = forModel(c);
    assert.equal(m.batteryAhUpstream, c.batteryAhUpstream, 'both prices reach the model');
    assert.equal(m.batteryAhDownstream, c.batteryAhDownstream);
  }
});

test('still water gets one price, because one number is the whole answer there', () => {
  // The lake path must be untouched: no current means no second price and no change to batteryAh.
  const { structures, coords } = scoredRiver();
  const drifts = riverDriftRuns(eastwardRiver(), { structures, slug: 'test_river' });
  const cands = selectCandidates(drifts, SELECT(structures, coords[0]));
  assert.ok(cands.length > 0);
  for (const c of cands) {
    assert.equal(c.batteryAhUpstream, null);
    assert.equal(c.batteryAhDownstream, null);
    assert.equal(forModel(c).batteryAhUpstream, undefined);
  }
});

test('a faster river costs more to fish, which is the point of supplying the current at all', () => {
  const { structures, coords } = scoredRiver();
  const slow = selectCandidates(
    riverDriftRuns(sectionedRiver(), { structures, slug: 'test_river', flowCfs: 3000 }),
    SELECT(structures, coords[0]));
  const fast = selectCandidates(
    riverDriftRuns(sectionedRiver(), { structures, slug: 'test_river', flowCfs: 12000 }),
    SELECT(structures, coords[0]));
  assert.ok(slow.length > 0 && fast.length > 0);
  const byId = new Map(slow.map((c) => [c.runId, c]));
  let compared = 0;
  for (const f of fast) {
    const s = byId.get(f.runId);
    if (!s) continue;
    compared++;
    assert.ok(f.batteryAhUpstream > s.batteryAhUpstream,
              `${f.runId}: 12,000 cfs upstream ${f.batteryAhUpstream} vs 3,000 cfs ${s.batteryAhUpstream}`);
    assert.ok(f.batteryAhDownstream < s.batteryAhDownstream,
              'and going with a faster push is cheaper, not floored at zero');
  }
  assert.ok(compared > 0, 'at least one reach survived both discharges to be compared');
});

test('a scour hole reaches the model as a scour hole, with its depth and its bend', () => {
  // `bend_side` and `bend_r_m` were stamped onto 22,939 features on 2026-09-16 and nothing read
  // either. And `hole` was missing from DEPTH_FIELD, so every one of the 7,854 river holes reached
  // the model with no depth -- on water where the hole's depth is the reason to go there.
  const hole = {
    type: 'Feature', geometry: { type: 'Point', coordinates: [-81, 34] },
    properties: { kind: 'hole', id: 'hole_1', depth_ft: 20, rim_ft: 7.9, relief_ft: 12.1,
                  area_acres: 62.23, bend_side: 'outside', bend_r_m: 224.8 },
  };
  const ix = structureIndex([hole]);
  const rec = [...ix.grid.values()].flat().find((r) => r.kind === 'hole');
  assert.ok(rec, 'the hole is indexed');
  assert.equal(rec.depthFt, 20, 'and it has a depth, which it did not before');
  assert.match(rec.what, /scour hole/, 'named as what it is, not the bare word "hole"');
  assert.match(rec.what, /20 ft/);
  assert.match(rec.what, /12\.1 ft below the rim/);
  assert.match(rec.what, /on the outside of the bend/);
  // AND THE PLOTTER'S NAME FOR IT CARRIES THE SIDE, because a scour hole on the outside of a bend is
  // the one feature where the side is the reason to go there. 128 of this river's 189 holes are on
  // the outside and they run a median of 12.1 ft, against 3 ft for the bank pockets beside them.
  // The prose keeps its own clause: `what` is what the model reads and it never said "outside bend".
  assert.equal(markLabel('hole', 'outside'), 'outside bend hole');
  assert.match(rec.what, /225 m bend radius/, 'the radius is a measurement, not a category');
});

test('a point on the inside of a bend is named for the bank it is on, with its depth', () => {
  // Card-wide from one sign convention: holes 65% outside, coves 88%, creek mouths 94% -- and points
  // 65% INSIDE, which is where a point bar forms. Two feature types river physics puts on opposite
  // banks, coming out on opposite banks.
  //
  // Ryan, 2026-09-18: *"i am seeing waypoints that say cove... but there are no coves on a river"*,
  // and 2026-09-19: *"an outside bend shouldn't be in 1 ft of water... that should be the deepest
  // part of the river"*. Both hold only if neither word goes on a bank feature: a point bar is not a
  // bend and it is not a cove, so it is named for the bank it sits on and the GPX appends the depth
  // the chart gives it. See markLabel().
  const pt = {
    type: 'Feature', geometry: { type: 'Point', coordinates: [-81, 34] },
    properties: { kind: 'point', id: 'point_9', deep_side_ft: 11, bulge_m: 40,
                  bend_side: 'inside', bend_r_m: 600 },
  };
  const rec = [...structureIndex([pt]).grid.values()].flat()[0];
  assert.match(rec.what, /^inside bank/);
  assert.doesNotMatch(rec.what, /on the inside of the bend/, 'said once, not twice');
  assert.match(rec.what, /600 m bend radius/, 'the measurement stays');
  assert.equal(rec.bendSide, 'inside', 'and it is a field now, not only a sentence');
});

test('a cove is not a thing a river has, so on one it is named for its bank', () => {
  // 4,530 coves across the 57 river packs. The detector finds a bulge in the shoreline, which on a
  // lake IS a cove and on a river is a pocket in the bank -- 159 of the Congaree's are stamped on the
  // outside of a bend and they carry a median of 3 ft, so they are the slack beside the scour and not
  // the scour. Neither "cove" nor "outside bend" is true of them; the bank is.
  const mk = (side) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [-81, 34] },
    properties: { kind: 'cove', id: `cove_${side}`, deep_side_ft: 9, bulge_m: 80,
                  bend_side: side, bend_r_m: 300 },
  });
  const what = (side) => [...structureIndex([mk(side)]).grid.values()].flat()[0].what;
  assert.match(what('outside'), /^outside bank/);
  assert.match(what('inside'), /^inside bank/);
  // AND THE WORD IS GONE FROM A RIVER ALTOGETHER. Ryan, 2026-09-19: "what the hell is a cove on a
  // river?" Nothing -- so nothing on a bend-stamped feature may say it.
  assert.ok(!/cove/.test(what('outside')) && !/cove/.test(what('inside')),
            'no river feature is called a cove');
});

test('a lake feature says nothing about bends, because it has no bend to speak of', () => {
  // The regression guard: bend_side is stamped on river packs only, and a reservoir hump must
  // describe exactly as it always did.
  const hump = {
    type: 'Feature', geometry: { type: 'Point', coordinates: [-80.7, 34.4] },
    properties: { kind: 'hump', id: 'hump_3', depth_ft: 18, relief_ft: 9, area_acres: 2.4 },
  };
  const rec = [...structureIndex([hump]).grid.values()].flat()[0];
  assert.match(rec.what, /offshore hump/);
  assert.doesNotMatch(rec.what, /bend/);
  assert.equal(rec.depthFt, 18);
});
