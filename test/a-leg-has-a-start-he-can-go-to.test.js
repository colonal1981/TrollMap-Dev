// A leg has a start he can Go To.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-09-27, on the plan loaded onto his ECHOMAP UHD2 93sv: "for navigating a track it only
// gives you from beginning or end and then draws a line to get to track but doesn't get you to the
// beginning". Follow Track offers Forward or Backward, and nothing on the unit marked where a leg
// starts: his 9/28 plan wrote the ramp, four stops and 34 structure marks. A waypoint is what Go To
// takes him to, so planWaypoints() now writes a green flag at each leg's start, carrying the leg's
// depth band, and a red flag at its end.
//
// What these hold:
//   1. every troll leg gets a start and an end, and a transit gets neither;
//   2. a leg fished back gets no mark on top of another one: the start is kept;
//   3. the band in the start's name is the band in the leg's cue line, today's water included;
//   4. the new marks change nothing about the cue lines;
//   5. the GPX carries the two flags, and no name has a period for the unit to eat.
//
// 2026-09-28: his unit keeps ten characters of a waypoint name, and `L1 start 12-22ft` read
// `L1 start 1`. The start is now `L1 12-22ft`, the same text as its cue line, and the comment --
// the second line, twenty characters -- says what to set: `alarm & shade 12-22`.

import { describe, it } from './expect-shim.mjs';
import assert from 'node:assert/strict';
import { planWaypoints, planCueLines } from '../js/modules/plan-tracks.js';
import { buildGPX } from '../js/utils/parsers.js';

const LAT = 34.38;
const line = (fromLon, toLon, lat = LAT) => {
  const co = [];
  for (let i = 0; i <= 10; i++) co.push([fromLon + (toLon - fromLon) * i / 10, lat]);
  return co;
};
const troll = (id, coordinates, extra = {}) => ({
  id, type: 'troll', runId: `wateree_lake#${id}`, depthFt: 17, startM: 0, lengthM: 1000,
  coordinates, stops: [], marks: [], ...extra,
});
const transit = (id, coordinates) => ({ id, type: 'transit', coordinates, startM: 0, lengthM: 500 });
const legMarks = (wps) => wps.filter((w) => w.legStart || w.legEnd);
const LAUNCH = [-80.7288, 34.3793];

describe('a leg has a start he can Go To', () => {
  it('writes a green flag at every troll leg start and a red one at its end, and none on a transit', () => {
    const L1 = troll('L1', line(-80.720, -80.710));
    const T2 = transit('T2', line(-80.710, -80.700, 34.37));
    const L3 = troll('L3', line(-80.700, -80.690, 34.36), { depthFt: 30 });
    const marks = legMarks(planWaypoints({ legs: [L1, T2, L3] }, LAUNCH, 'run'));
    assert.deepEqual(marks.map((m) => [m.name, m.sym]), [
      ['L1 12-22ft', 'Flag, Green'],
      ['L1 end', 'Flag, Red'],
      ['L3 25-35ft', 'Flag, Green'],
      ['L3 end', 'Flag, Red'],
    ]);
    assert.deepEqual([marks[0].lon, marks[0].lat], L1.coordinates[0]);
    assert.deepEqual([marks[1].lon, marks[1].lat], L1.coordinates.at(-1));
    assert.ok(marks.every((m) => m.scoutWaypoint && m.planRunId === 'run'),
      'owned by the plan, so the next build clears them');
  });

  it('puts one mark on each end of a leg fished back, and it is the start', () => {
    const out = line(-80.720, -80.710);
    const L1 = troll('L1', out);
    const L2 = troll('L2', out.slice().reverse(), { pass: 2 });
    const marks = legMarks(planWaypoints({ legs: [L1, L2] }, LAUNCH));
    assert.deepEqual(marks.map((m) => m.name), ['L1 12-22ft', 'L2 12-22ft']);
    assert.deepEqual([marks[1].lon, marks[1].lat], out.at(-1));
  });

  it('does the same for a third pass, which starts where the first one did', () => {
    const out = line(-80.720, -80.710);
    const legs = [troll('L1', out), troll('L2', out.slice().reverse()), troll('L3', out)];
    assert.deepEqual(legMarks(planWaypoints({ legs }, LAUNCH)).map((m) => m.name),
      ['L1 12-22ft', 'L2 12-22ft']);
  });

  it('gives a leg with no depth a start with no band, and a leg with no line nothing', () => {
    const marks = legMarks(planWaypoints({ legs: [
      troll('L1', line(-80.720, -80.710), { depthFt: null }),
      troll('L2', [[-80.70, LAT]]),
    ] }, LAUNCH));
    assert.deepEqual(marks.map((m) => m.name), ['L1 start', 'L1 end']);
  });
});

describe('the start and the cue line say the same thing', () => {
  // The lake 3.5 ft down, as Wateree was on 9/28: the band is set around today's water.
  const L1 = troll('L1', line(-80.720, -80.710), { depthFt: 16.8, drawdownFt: 3.5,
    stops: [{ id: 'S1.1', at: [-80.715, LAT], atM: 500, depthFt: 20, structureType: 'point',
              why: 'point' }] });
  const plan = { legs: [L1], changes: [{ id: 'C1', atM: 800, rodId: 'R3', to: 'DD2 Crankbait' }] };
  const wps = planWaypoints(plan, LAUNCH, 'run');

  it('carries the cue line\'s band, in today\'s water', () => {
    const cue = planCueLines(plan, wps, 'run').find((r) => r.legId === 'L1' && r.cueKind === 'band');
    const start = wps.find((w) => w.legStart);
    assert.ok(cue, 'the leg start has its cue line');
    assert.equal(start.name, cue.name);
    assert.equal(start.name, 'L1 8-18ft', '16.8 ft charted, 3.5 ft down: 13 ft today');
    assert.equal(start.cmt, 'alarm 8-18 shd 12-22', 'the shading is the chart\'s, 17 ft');
  });

  it('leaves the cue lines exactly as they were', () => {
    const without = wps.filter((w) => !(w.legStart || w.legEnd));
    assert.deepEqual(planCueLines(plan, wps, 'run'), planCueLines(plan, without, 'run'));
    assert.ok(legMarks(wps).every((w) => !w.castingStop && !w.lureChange && !w.chartMark));
  });

  it('reaches the GPX as a green flag and a red flag, with no period in a name', () => {
    const gpx = buildGPX({ waypoints: wps, tracks: [], routes: [] });
    assert.ok(gpx.includes('<name>L1 8-18ft</name>'));
    assert.ok(gpx.includes('<cmt>alarm 8-18 shd 12-22</cmt>'));
    assert.ok(gpx.includes('<sym>Flag, Green</sym>'));
    assert.ok(gpx.includes('<name>L1 end</name>'));
    assert.ok(gpx.includes('<sym>Flag, Red</sym>'));
    assert.ok(legMarks(wps).every((w) => !w.name.includes('.')));
  });
});
