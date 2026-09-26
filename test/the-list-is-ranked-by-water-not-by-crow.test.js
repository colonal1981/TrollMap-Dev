// THE LIST IS RANKED BY WATER, NOT BY CROW.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Item 24, Lake Murray from Hilton, 2026-09-26: selectCandidates() ranked water by the straight
// line from the ramp. Hilton sits in a cove that opens east; the first leg offered was 3.2 km
// straight and 5.6 km around the point, and the day ran 85% of its distance between legs.
// selectByWater() prices everything it offers by water and re-ranks until nothing offered is still
// a straight line. Anything left out was beaten while judged on its best case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectByWater } from '../js/modules/smart-plan-v2.js';
import { selectCandidates, metresBetween } from '../js/modules/plan-candidates.js';

const lane = (lon0) => ({
  type: 'Feature',
  geometry: { type: 'LineString',
              coordinates: Array.from({ length: 41 }, (_, k) => [lon0 + k * 0.0006, 34.38]) },
  properties: { depth_ft: 20, length_m: 2200, routable: true, relief: 'flat', fitted: true,
                shallowest_ft: 14,
                near: Array.from({ length: 6 }, (_, k) => ({ s: 200 + k * 300, t: 'point', d: 25 })) },
});
const RAMP = [-80.73, 34.38];
const OPTS = { ramp: RAMP, slug: 'w', fishDepthFt: [0, 99], holding: 'bottom',
               usableAh: 999, windowMin: 9999 };
// A: 1 km west of the ramp by crow, but behind a point -- ten times that by water.
// B: 2.3 km east by crow, and open water all the way.
const RUNS = [lane(-80.765), lane(-80.705)];
const behindThePoint = (p) => p[0] < RAMP[0];
function water(calls = []) {
  return async (from, pts) => {
    calls.push({ from, n: pts.length });
    return pts.map((p) => metresBetween(from, p) * (behindThePoint(p) !== behindThePoint(from) ? 10 : 1.05));
  };
}

test('by crow the near-looking leg wins; by water the other one does', async () => {
  const crow = selectCandidates(RUNS, { ...OPTS, limit: 1 });
  assert.equal(crow[0].runIndex, 0, 'the straight line picks the leg behind the point');
  const calls = [];
  const wet = await selectByWater(RUNS, { ...OPTS, limit: 1 }, { ramp: RAMP, distancesFrom: water(calls) });
  assert.equal(wet[0].runIndex, 1, 'priced by water, the open-water leg is the nearer one');
  assert.ok(wet[0].transitInM >= metresBetween(RAMP, wet[0].start), 'never shorter than the straight line');
  assert.ok(wet.byWater.askedFromRamp >= 4, 'both legs got asked about, one after the other');
  assert.ok(calls.length <= 4, `a handful of calls, not one per window: ${calls.length}`);
});

test('the ordering table between offered legs is priced by water too', async () => {
  const wet = await selectByWater(RUNS, { ...OPTS, limit: 2 }, { ramp: RAMP, distancesFrom: water() });
  assert.equal(wet.length, 2);
  const a = wet.find((c) => c.runIndex === 0), b = wet.find((c) => c.runIndex === 1);
  const crow = selectCandidates(RUNS, { ...OPTS, limit: 2 });
  const ca = crow.find((c) => c.runIndex === 0);
  assert.ok(a.transitToM[b.runId] > ca.transitToM[b.runId] * 5,
    `across the point is priced as across the point: ${a.transitToM[b.runId]} vs ${ca.transitToM[b.runId]}`);
  assert.ok(wet.byWater.pricedBetween > 0);
});

test('the table is one matrix call where the asker offers one, and never a burst where it does not', async () => {
  const calls = [];
  const asker = water(calls);
  let matrixCalls = 0;
  asker.matrix = async (sources, pts) => { matrixCalls += 1; return Promise.all(sources.map((s) => water()(s, pts))); };
  const wet = await selectByWater(RUNS, { ...OPTS, limit: 2 }, { ramp: RAMP, distancesFrom: asker });
  assert.equal(matrixCalls, 1, 'the whole table in one call');
  assert.ok(wet.byWater.pricedBetween > 0);

  // Without .matrix, one source at a time: never more than one call in flight.
  let inFlight = 0, most = 0;
  const serial = async (from, pts) => {
    inFlight += 1; most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight -= 1;
    return water()(from, pts);
  };
  await selectByWater(RUNS, { ...OPTS, limit: 2 }, { ramp: RAMP, distancesFrom: serial });
  assert.equal(most, 1, 'no burst');
});

test('no Worker, or a failed call, is the straight line exactly as before', async () => {
  const failing = async () => null;
  const wet = await selectByWater(RUNS, { ...OPTS, limit: 1 }, { ramp: RAMP, distancesFrom: failing });
  const crow = selectCandidates(RUNS, { ...OPTS, limit: 1 });
  assert.equal(wet[0].runIndex, crow[0].runIndex);
  assert.equal(wet[0].transitInM, crow[0].transitInM);
  const throwing = async () => { throw new Error('offline'); };
  const w2 = await selectByWater(RUNS, { ...OPTS, limit: 1 }, { ramp: RAMP, distancesFrom: throwing });
  assert.equal(w2[0].runIndex, crow[0].runIndex);
});

test('a ramp up a canal pays for its own path out', async () => {
  const lead = await selectByWater(RUNS, { ...OPTS, limit: 1 },
    { ramp: RAMP, distancesFrom: water(), source: RAMP, leadM: 1800 });
  const none = await selectByWater(RUNS, { ...OPTS, limit: 1 }, { ramp: RAMP, distancesFrom: water() });
  assert.ok(Math.abs(lead[0].transitInM - none[0].transitInM - 1800) <= 1);
});
