// TVA's four reservoir routes, shaped.
//
// FIXTURES ARE REAL. Every response below was fetched live from www.tva.com/RestApi on
// 2026-08-15 and trimmed, not invented -- the whole point of a pure shaper is that the shapes
// can be pinned without a network, and a made-up fixture pins nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tvaShape } from '../Worker/conditions.js';

// /observed-data-48-hours/CHAN7 -- tail of the real 51-row response
const OBSERVED = [
  { Day: '08/13/2026', Time: '7 PM EDT', ReservoirElevation: '1,923.32', TailwaterElevation: '1,803.17', AverageHourlyDischarge: '35' },
  { Day: '08/14/2026', Time: '5 AM EDT', ReservoirElevation: '1,923.34', TailwaterElevation: '1,803.30', AverageHourlyDischarge: '35' },
  { Day: '08/15/2026', Time: '6 PM EDT', ReservoirElevation: '1,923.41', TailwaterElevation: '1,805.95', AverageHourlyDischarge: '1,410' },
];

// /operating-guide/CHAN7 -- note the 2025 stamp on Day while the values are current
const GUIDE = {
  MidNightElevation: 1923.36,
  items: [
    { Day: '08/14/2025', TopOfGates: 1928, PrevYrElev: 1923.8, CurYrElev: 1923.34, BtmOpZone: 0, TopOpZone: 0, FloodGuide: 1924.3, GuideCurve: 1924.31, LowExptdElevRange: 1922.2, UpperExptdEleRange: 1924.31 },
    { Day: '08/15/2025', TopOfGates: 1928, PrevYrElev: 1923.75, CurYrElev: 1923.36, BtmOpZone: 0, TopOpZone: 0, FloodGuide: 1924.28, GuideCurve: 1924.29, LowExptdElevRange: 1922.21, UpperExptdEleRange: 1924.29 },
  ],
};

const RELEASES = [
  { Day: '08/15/2026', Time: '1 AM - 5 AM EDT', Generators: '0' },
  { Day: '08/15/2026', Time: '5 AM - 6 AM EDT', Generators: '1' },
  { Day: '08/16/2026', Time: '5 AM - 6 AM EDT', Generators: '1' },
];

const MESSAGES = [{ EffectiveSince: '07/02/2025 11:30 AM EDT', Message: '', DisplayGeneration: true }];

test('the latest observation wins, and comma-formatted strings become numbers', () => {
  const t = tvaShape(OBSERVED, GUIDE, RELEASES, MESSAGES, '08/15');
  assert.equal(t.elevation_ft, 1923.41);
  assert.equal(t.tailwater_ft, 1805.95);
  assert.equal(t.discharge_cfs, 1410);          // "1,410" -- the comma is the whole reason
  assert.equal(t.observed_at, '08/15/2026 6 PM EDT');
});

test('the guide is matched on MM/DD, because its year disagrees with the rest of the API', () => {
  // Day says 2025 on the guide and 2026 everywhere else. Matching the full string finds
  // nothing; matching MM/DD finds the right row.
  const t = tvaShape(OBSERVED, GUIDE, RELEASES, MESSAGES, '08/15');
  assert.equal(t.guide_curve_ft, 1924.29);
  assert.equal(t.flood_guide_ft, 1924.28);
  assert.deepEqual(t.expected_range_ft, [1922.21, 1924.29]);
});

test('vs_guide_ft is signed against the curve, NOT against top of gates', () => {
  const t = tvaShape(OBSERVED, GUIDE, RELEASES, MESSAGES, '08/15');
  assert.equal(t.top_of_gates_ft, 1928);
  assert.equal(t.vs_guide_ft, -0.88);            // 1923.41 - 1924.29
  // Against gates it would read -4.59, which is the error this whole block exists to avoid.
  assert.notEqual(t.vs_guide_ft, -4.59);
});

test('Norris is the case that proves it — gates 1034, guide 1020, actual 1016.76', () => {
  const norrisObs = [{ Day: '08/15/2026', Time: '6 PM EDT', ReservoirElevation: '1,016.76', TailwaterElevation: '900.10', AverageHourlyDischarge: '0' }];
  const norrisGuide = { MidNightElevation: 1016.76, items: [
    { Day: '08/15/2025', TopOfGates: 1034, PrevYrElev: 1015.41, CurYrElev: 1016.76, FloodGuide: 1020, GuideCurve: 1020, LowExptdElevRange: 1009.13, UpperExptdEleRange: 1019.19 }] };
  const t = tvaShape(norrisObs, norrisGuide, [], [], '08/15');
  assert.equal(t.vs_guide_ft, -3.24);            // 3 ft under guide
  assert.equal(t.top_of_gates_ft - t.guide_curve_ft, 14);   // gates is 14 ft high here
});

test('generation is carried, and generating_now reads the first entry', () => {
  const t = tvaShape(OBSERVED, GUIDE, RELEASES, MESSAGES, '08/15');
  assert.equal(t.generation.length, 3);
  assert.deepEqual(t.generation[0], { day: '08/15/2026', time: '1 AM - 5 AM EDT', generators: 0 });
  assert.equal(t.generating_now, false);
});

test('an empty lake message is not a message', () => {
  assert.equal(tvaShape(OBSERVED, GUIDE, RELEASES, MESSAGES, '08/15').message, null);
  assert.equal(tvaShape(OBSERVED, GUIDE, RELEASES,
    [{ Message: 'Drawdown begins 1 September.' }], '08/15').message, 'Drawdown begins 1 September.');
});

test('a route that failed is null, not a crash', () => {
  const t = tvaShape(null, null, null, null, '08/15');
  assert.equal(t.elevation_ft, null);
  assert.equal(t.guide_curve_ft, null);
  assert.equal(t.vs_guide_ft, null);
  assert.deepEqual(t.generation, []);
  assert.equal(t.generating_now, null);
});

test('observations missing but the guide present still yields an elevation', () => {
  const t = tvaShape([], GUIDE, [], [], '08/15');
  assert.equal(t.elevation_ft, 1923.36);          // MidNightElevation, a bare number not a string
});

test('a date with no guide row falls back to the last row rather than reporting nothing', () => {
  const t = tvaShape(OBSERVED, GUIDE, RELEASES, MESSAGES, '02/29');
  assert.equal(t.guide_curve_ft, 1924.29);
});

// ── /predicted-data ─────────────────────────────────────────────────────────────────────────
//
// Verbatim from tva.com/RestApi/predicted-data/DUGT1?format=json, fetched 2026-08-24 for
// Douglas Dam. TWO CONVENTIONS IN ONE OBJECT: the flows are display strings carrying a
// thousands separator, MidnightElevation is a bare number. That is TVA's doing, not a typo
// here, and it is the reason tvaNum has to take both.
const PREDICTED = [
  { Day: '08/24/2026', AverageInflow: '2,422', MidnightElevation: 989.03, AverageOutflow: '6,088' },
  { Day: '08/25/2026', AverageInflow: '2,633', MidnightElevation: 988.850037, AverageOutflow: '5,000' },
  { Day: '08/26/2026', AverageInflow: '2,113', MidnightElevation: 988.630066, AverageOutflow: '5,000' },
];

test('the forecast parses comma-separated flows as numbers, not NaN', () => {
  const t = tvaShape([], null, [], [], '08/24', PREDICTED);
  assert.equal(t.forecast[0].inflow_cfs, 2422);
  assert.equal(t.forecast[0].outflow_cfs, 6088);
});

test('MidnightElevation is taken even though it arrives as a bare number', () => {
  const t = tvaShape([], null, [], [], '08/24', PREDICTED);
  assert.equal(t.forecast[0].midnight_elevation_ft, 989.03);
  assert.equal(t.forecast[2].midnight_elevation_ft, 988.630066);
});

test('days keep their order, so a falling lake reads as falling', () => {
  const t = tvaShape([], null, [], [], '08/24', PREDICTED);
  assert.deepEqual(t.forecast.map((r) => r.day),
    ['08/24/2026', '08/25/2026', '08/26/2026']);
  assert.ok(t.forecast[0].midnight_elevation_ft > t.forecast[2].midnight_elevation_ft);
});

test('the forecast is an empty list, never undefined, when TVA sends nothing', () => {
  assert.deepEqual(tvaShape([], null, [], [], '08/24', null).forecast, []);
  assert.deepEqual(tvaShape([], null, [], [], '08/24').forecast, []);
  assert.deepEqual(tvaShape([], null, [], [], '08/24', []).forecast, []);
});

test('a forecast row carrying a day and no numbers at all is dropped', () => {
  const t = tvaShape([], null, [], [], '08/24',
    [{ Day: '08/24/2026' }, { Day: '08/25/2026', AverageInflow: '1,000' }]);
  assert.equal(t.forecast.length, 1);
  assert.equal(t.forecast[0].day, '08/25/2026');
});

// The five-argument form is what every call before 2026-08-25 used. Adding `predicted` last
// keeps them working; this pins that so the next person to extend the signature knows why the
// order is what it is.
test('the five-argument signature still behaves', () => {
  const t = tvaShape(OBSERVED, GUIDE, RELEASES, MESSAGES, '08/15');
  assert.ok(Array.isArray(t.forecast));
  assert.equal(t.forecast.length, 0);
});
