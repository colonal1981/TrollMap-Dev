// A river bend reached the Garmin still called a cove, and every function in the chain was right.
//
// 2026-09-18, benched against the live app on the real congaree_river pack: 123 waypoints in the
// exported GPX, 34 of them named "cove", 25 named "point", and not one "outside bend" or "inside
// bend" anywhere in the file. The rename had shipped that morning.
//
// Every end of the chain was correct. kindHits() put the feature's own `bend_side` on each `near`
// record. plan-assemble.js read `side: h.side` off each pass. markLabel() turned cove+outside into
// "outside bend" and had a passing unit test proving it. scoreWindow() -- the one step between the
// two ends -- built its hit record field by field and did not copy `side`, so `markLabel` was
// called with undefined on every mark in every plan.
//
// THE UNIT TEST WAS THE PROBLEM. It called markLabel() directly, so it could only ever prove that
// markLabel works. A function that is right and is never reached is indistinguishable from one that
// is wrong, and the only way to tell them apart is to run the chain.
//
// So this test starts where the pack starts -- a water_features.geojson feature with bend_side on
// it -- and finishes where the Garmin starts, at the waypoint's name and symbol.
//
// Personal use only, not for distribution or resale; not for navigation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structureIndex, kindHits, selectCandidates, cumulative } from '../js/modules/plan-candidates.js';
import { planWaypoints, markSymbol } from '../js/modules/plan-tracks.js';

// A straight 2 km line at 50 m spacing, due east, in water the app would plan on.
const N = 41;
const LINE = Array.from({ length: N }, (_, i) => [-81.0 + i * 0.00054, 33.9]);
const CUM = cumulative(LINE);

/** A river feature as build_river_centrelines.py stamps it: kind, depth, and which side of the bend. */
function feature(kind, i, side, depthFt) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [LINE[i][0], LINE[i][1] + 0.0002] },
    properties: { kind, id: `${kind}-${i}`, depth_ft: depthFt, bend_side: side, score: 1 },
  };
}

const FEATURES = {
  type: 'FeatureCollection',
  features: [feature('cove', 10, 'outside', 14), feature('point', 20, 'inside', 8),
             feature('cove', 30, 'outside', 4)],
};

/** One run in the shape riverDriftRuns writes, with `near` built the way the pipeline builds it. */
function run() {
  const index = structureIndex(FEATURES.features);
  const near = [
    ...kindHits(LINE, CUM, index, 150, 'cove'),
    ...kindHits(LINE, CUM, index, 150, 'point'),
  ];
  assert.ok(near.length >= 3, 'the fixture has to reach kindHits at all');
  assert.ok(near.every((n) => n.side === 'outside' || n.side === 'inside'),
            'kindHits puts the feature own bend side on every near record -- the START of the chain');
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: LINE },
    properties: {
      id: 'congaree_river:drift:channel@0', slug: 'congaree_river',
      length_m: CUM[CUM.length - 1], mean_depth_ft: 12, charted_frac: 1,
      envelope_step_m: 50, stations: N,
      envelope_line_ft: new Array(N).fill(12), envelope_ft: new Array(N).fill(10),
      near,
    },
  };
}

test('the side survives the scorer and reaches the pass', () => {
  const [c] = selectCandidates([run()], { ramp: LINE[0], maxOffM: 150, minM: 400, maxM: 2000, stepM: 100,
                                          slug: 'congaree_river', structures: structureIndex(FEATURES.features) });
  assert.ok(c, 'the fixture run has to produce a candidate');
  const bends = (c.passes || []).filter((h) => h.type === 'cove' || h.type === 'point');
  assert.ok(bends.length, 'the passes have to carry the bend features at all');
  for (const h of bends) {
    assert.ok(h.side === 'outside' || h.side === 'inside',
              `pass ${h.id} lost its side in scoreWindow -- this is the 2026-09-18 defect`);
  }
});

test('the waypoint the Garmin gets is named for the bend, not for a cove on a river', () => {
  const [c] = selectCandidates([run()], { ramp: LINE[0], maxOffM: 150, minM: 400, maxM: 2000, stepM: 100,
                                          slug: 'congaree_river', structures: structureIndex(FEATURES.features) });
  // The leg shape planWaypoints reads, with marks mapped as plan-assemble.js maps them.
  const plan = { legs: [{ id: 'L1', startM: 0, stops: [], marks: (c.passes || []).map((h) => ({
    id: h.id, type: h.type, at: h.at, side: h.side, atM: h.atM, offM: h.offM,
    depthFt: h.depthFt ?? null })) }] };
  const wpts = planWaypoints(plan, null, 'run1', { marks: true }).filter((w) => w.chartMark);
  assert.ok(wpts.length, 'the marks have to become waypoints');
  const names = wpts.map((w) => w.name.replace(/\s*\d+ft$/, ''));
  assert.ok(!names.includes('cove'), `a river bend reached the Garmin as "cove": ${names.join(', ')}`);
  assert.ok(names.includes('outside bend'), `no outside bend among ${names.join(', ')}`);
  assert.ok(names.includes('inside bend'), `no inside bend among ${names.join(', ')}`);
});

test('and it is a circle or a triangle, not the default pin', () => {
  // The shape comes from the RENAMED kind, so a dropped side costs the symbol as well as the name.
  assert.equal(markSymbol('cove', 'outside', 14), 'Circle, Blue');
  assert.equal(markSymbol('point', 'inside', 8), 'Triangle, Green');
  // Without the side it is still a circle -- MARK_SHAPE has the raw kinds too -- which is exactly
  // why the dropped field was invisible in the symbol column and visible only in the name.
  assert.equal(markSymbol('cove', undefined, 14), 'Circle, Blue');
});

test('a mark with no charted depth is still one of ours, and it is a flag', () => {
  // THIS ASSERTED `Waypoint` AND THAT WAS MINE, NOT RYAN'S. 43 of the 123 waypoints in the real
  // 2026-09-18 export came out as the bare default pin -- every one a mark resolveStructure() could
  // not give a depth -- and I wrote it up as "a decision about Ryan's symbol set, not a bug to fix
  // quietly" and pinned it here. That put my guess behind his name. He replied: "we already decided
  // and i thought we fixed the waypoint symbol issue."
  //
  // He had. The vocabulary he gave was "Circles, Diamonds, Flags, Pins, Squares, and Triangles in
  // Red, Yellow, Blue, and Green", FLAG WAS UNUSED, and his own ActiveCaptain export carries 16
  // `Flag, Green` and 10 `Flag, Red`. The reasoning I offered -- no neutral colour, because all four
  // are depth bands -- was true of COLOURS and irrelevant, because the free slot was a SHAPE.
  //
  // A flag cannot be misread as a depth band, since no depth-coloured mark is a flag. The kind is
  // still in the name. And `Waypoint` is what an unclassified user pin gets, so it threw away that
  // this was one of ours at the exact moment it matters -- the desc reads "charted position --
  // compare with the sounder", and a mark the chart could not put a number on is the one worth
  // standing next to the sounder.
  assert.equal(markSymbol('cove', 'outside', null), 'Flag, Blue');
  assert.equal(markSymbol('hole', null, undefined), 'Flag, Blue');
  assert.equal(markSymbol('creek_mouth', null, 0), 'Flag, Blue', 'a charted zero is not a depth');
  // A named symbol needs no colour, so it survives a missing depth unchanged.
  assert.equal(markSymbol('ledge', null, null), 'Ledge');
  assert.equal(markSymbol('shallow', null, null), 'Triangle, Red', 'shallow is red by definition');
  // `Waypoint` is now only for a kind nothing here can name, which is the one honest use of it.
  assert.equal(markSymbol('something_new', null, 12), 'Waypoint');
});
