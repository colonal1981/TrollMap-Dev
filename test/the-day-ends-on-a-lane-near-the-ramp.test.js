// The day ends on a lane near the ramp, and a dead end is fished back, not run back.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-09-28, on item 31 -- the 9/28 Wateree Smart Plan crossed the lake twice and finished
// 3 miles out: "i want to end a lane close to the ramp... i do not want to waste 3 miles heading
// back and not being able to fish it... however that looks".
//
// What these hold:
//   1. on the 9/28 legs the shortest order alone ends near the ramp, and fishing #48 back as well
//      cuts the running from 5.4 mi to 2.0;
//   2. a pass is added only when it saves battery on his measured curve, and only while the day
//      fits its window; with no window, none is;
//   3. of two equally short orders, the one nearer the given order is kept;
//   4. the prompt tells the model the order is the app's.

import { describe, it } from './expect-shim.mjs';
import assert from 'node:assert/strict';
import { dayShape, shortestOrder, movingM, orientLegs, metresBetween } from '../js/modules/plan-candidates.js';
import { buildPlanRequest } from '../js/modules/plan-prompt.js';

// Clearwater Cove, and the four lanes of the 9/28 plan (ends from its saved gpx.trackList), in the
// order the model wrote them. #275 was fished back (L1/L2).
const RAMP = [-80.728814, 34.379271];
const LEGS = [
  { runId: 'wateree_lake#275', start: [-80.721998, 34.371318], end: [-80.73183, 34.379011], trollPasses: 2, lengthM: 1462 },
  { runId: 'wateree_lake#1289', start: [-80.721897, 34.361266], end: [-80.731342, 34.367282], lengthM: 1172 },
  { runId: 'wateree_lake#1570', start: [-80.731845, 34.381693], end: [-80.73922, 34.375568], lengthM: 960 },
  { runId: 'wateree_lake#48', start: [-80.738401, 34.376424], end: [-80.778731, 34.388193], lengthM: 4084 },
];
const SPEEDS = { trollMph: 2.0, transitMph: 3.5 };
const home = (legs) => metresBetween(orientLegs(legs, RAMP).at(-1).finish, RAMP);
const mi = (m) => m / 1609.34;

describe('the 9/28 Wateree day', () => {
  it('as the model ordered it: 5.4 mi of running and 2.9 mi home from the last lane', () => {
    assert.ok(Math.abs(mi(movingM(LEGS, RAMP)) - 5.35) < 0.05);
    assert.ok(Math.abs(mi(home(LEGS)) - 2.91) < 0.05);
  });

  it('in the shortest order it ends 0.2 mi from the ramp', () => {
    const so = shortestOrder(LEGS, RAMP);
    const legs = so.order.map((i) => LEGS[i]);
    assert.ok(mi(home(legs)) < 0.25);
    assert.ok(so.moveM < so.givenM);
  });

  it('and fishing #48 back brings the long lane home trolling: 2.0 mi of running, within the day', () => {
    const r = dayShape(LEGS, RAMP, { ...SPEEDS, windowMin: 480 });   // 08:30 to 16:30
    assert.deepEqual(r.added.map((a) => a.runId)[0], 'wateree_lake#48');
    assert.ok(r.added[0].savedM > 3500, 'about 2.3 mi of running saved by that one pass');
    assert.ok(mi(r.moveM) < 2.1, `${mi(r.moveM)} mi`);
    assert.equal(r.legs.find((c) => c.runId === 'wateree_lake#48').trollPasses, 2);
    assert.equal(r.legs.find((c) => c.runId === 'wateree_lake#275').trollPasses, 2,
      'a leg already fished back is not given a third pass');
    assert.ok(mi(home(r.legs)) < 1);
  });
});

describe('a pass goes in only when it pays and the day has room', () => {
  it('with no window, the order changes and no pass is added', () => {
    const r = dayShape(LEGS, RAMP, SPEEDS);
    assert.deepEqual(r.added, []);
    const passesOf = (c) => c.trollPasses || 1;
    for (const c of r.legs) assert.equal(passesOf(c), passesOf(LEGS.find((x) => x.runId === c.runId)));
  });

  it('with a window the extra pass does not fit, none is added', () => {
    const r = dayShape(LEGS, RAMP, { ...SPEEDS, windowMin: 150 });
    assert.deepEqual(r.added, []);
  });

  it('a lane whose far end leads on to the next lane is not fished back', () => {
    // Three lanes end to end, heading away and a loop home: turning round saves no running.
    const chain = [
      { runId: 'a', start: [-80.730, 34.380], end: [-80.740, 34.380], lengthM: 900 },
      { runId: 'b', start: [-80.741, 34.380], end: [-80.741, 34.370], lengthM: 1100 },
      { runId: 'c', start: [-80.740, 34.369], end: [-80.730, 34.369], lengthM: 900 },
    ];
    const r = dayShape(chain, [-80.729, 34.375], { ...SPEEDS, windowMin: 480 });
    assert.deepEqual(r.added, []);
  });
});

describe('of two equally short orders, the given one', () => {
  it('keeps the model\'s first leg first when the loop runs the same both ways', () => {
    // Two short lanes either side of the ramp: A then B and B then A cost the same.
    const A = { runId: 'A', start: [-80.720, 34.380], end: [-80.720, 34.381], lengthM: 110 };
    const B = { runId: 'B', start: [-80.740, 34.380], end: [-80.740, 34.381], lengthM: 110 };
    assert.deepEqual(shortestOrder([A, B], [-80.730, 34.380]).order, [0, 1]);
    assert.deepEqual(shortestOrder([B, A], [-80.730, 34.380]).order, [0, 1]);
  });
});

describe('the prompt says the order is the app\'s', () => {
  it('on a Smart Plan day, and quotes him', () => {
    const u = buildPlanRequest({
      candidates: [{ runId: 'w#1', lengthM: 2500, depthFt: 24, transitFromRampM: 400,
                     transitToRampM: 5200, transitToM: { 'w#2': 9687 }, structures: [] },
                   { runId: 'w#2', lengthM: 2200, depthFt: 26, transitFromRampM: 600,
                     transitToRampM: 2800, transitToM: { 'w#1': 9420 }, structures: [] }],
      water: 'Lake Wateree, SC', tackle: [],
    }).user;
    assert.match(u, /THE APP PUTS YOUR LEGS IN ORDER/);
    assert.match(u, /i want to end a lane close to the ramp/);
    assert.doesNotMatch(u, /you finish near the ramp because\s+you ordered it that way/);
  });
});
