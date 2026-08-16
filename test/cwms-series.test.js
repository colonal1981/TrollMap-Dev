// Picking the Corps' pool elevation out of forty-two candidates, and the metres trap.
//
// FIXTURE IS REAL. These entries are lifted verbatim from
// /cwms-data/catalog/TIMESERIES?office=SAS&like=^Hartwell\.Elev, read 2026-08-16. It returned 42
// series for one lake and exactly one of them is "how high is the water".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickElevSeries, cwmsToFeet } from '../Worker/conditions.js';

const e = (name, interval, latest) => ({
  office: 'SAS', name, units: 'm', interval, 'interval-offset': 0, 'time-zone': 'US/Central',
  extents: [{ 'earliest-time': '1997-01-16T00:00:00Z', 'latest-time': latest,
              'last-update': '2026-08-16T08:02:57.646937Z' }],
  versioned: false,
});

const CATALOG = { total: 42, 'page-size': 25, entries: [
  e('Hartwell.Elev-GC.Inst.1Day.0.ARCHIVE-DAILY', '1Day', '2030-01-01T00:00:00Z'),
  e('Hartwell.Elev-Guide-Curve.Inst.~1Day.0.ARCHIVE-DAILY', '~1Day', '2025-07-01T05:00:00Z'),
  e('Hartwell.Elev-Head.Inst.1Hour.0.Raw-SHEF_SAS', '1Hour', '2026-08-14T09:00:00Z'),
  e('Hartwell.Elev-L1.Inst.1Day.0.ARCHIVE-DAILY', '1Day', '2030-01-01T00:00:00Z'),
  e('Hartwell.Elev-Level1.Inst.~1Day.0.ARCHIVE-DAILY', '~1Day', '2025-12-16T05:00:00Z'),
  e('Hartwell.Elev-Pool.Inst.1Day.0.Raw-SHEF_SAS', '1Day', '2026-08-10T00:00:00Z'),
  e('Hartwell.Elev-Pool.Inst.1Hour.0.HISTORIAN_SAS', '1Hour', '2026-05-07T14:00:00Z'),
  e('Hartwell.Elev-Pool.Inst.1Hour.0.Raw-SHEF_SAS', '1Hour', '2026-08-14T09:00:00Z'),
  e('Hartwell.Elev-Pool_Avg.Inst.1Day.0.ARCHIVE-DAILY', '1Day', '2031-12-31T00:00:00Z'),
  e('Hartwell.Elev-Pool_Max.Inst.1Day.0.ARCHIVE-DAILY', '1Day', '2031-12-31T00:00:00Z'),
  e('Hartwell.Elev-Pool_p10.Inst.1Day.0.ARCHIVE-DAILY', '1Day', '2031-12-31T00:00:00Z'),
  e('Hartwell.Elev-Pool_p40.Inst.1Day.0.ARCHIVE-DAILY', '1Day', '2031-12-31T00:00:00Z'),
] };

test('the hourly pool reading is chosen out of the forty-two', () => {
  const p = pickElevSeries(CATALOG);
  assert.equal(p.name, 'Hartwell.Elev-Pool.Inst.1Hour.0.Raw-SHEF_SAS');
  assert.equal(p.interval, '1Hour');
  assert.equal(p.office, 'SAS');
  assert.equal(p.of_total, 42);
});

test('a percentile is not a reading, and it differs by ONE UNDERSCORE', () => {
  // Elev-Pool_p10 is a tenth-percentile statistic over the record; Elev-Pool is today's water.
  const p = pickElevSeries(CATALOG);
  assert.ok(!/_p\d/.test(p.name));
  assert.ok(!/_Avg|_Max|_Min/.test(p.name));
  assert.equal(p.candidates, 3, 'only the three true Elev-Pool series are candidates');
});

test('the guide curve, the head and the drought levels are not the pool', () => {
  const p = pickElevSeries(CATALOG);
  assert.ok(!/Elev-GC|Guide-Curve|Elev-Head|Elev-L\d|Elev-Level/.test(p.name));
});

test('a statistics series with a latest-time in 2031 does not win on recency', () => {
  // The archive series run to 2031-12-31 because they are climatology, not observations. Ranking
  // on recency alone would pick a percentile over today's reading.
  assert.equal(pickElevSeries(CATALOG).latest_time, '2026-08-14T09:00:00.000Z');
});

test('an irregular interval is not a reading cadence', () => {
  const only = { entries: [e('X.Elev-Pool.Inst.~1Day.0.ARCHIVE-DAILY', '~1Day', '2026-08-14T00:00:00Z'),
                           e('X.Elev-Pool.Inst.1Day.0.Raw', '1Day', '2026-08-10T00:00:00Z')] };
  assert.equal(pickElevSeries(only).interval, '1Day');
});

test('a lake with no pool series is null, not the nearest thing', () => {
  assert.equal(pickElevSeries({ entries: [e('X.Elev-Head.Inst.1Hour.0.Raw', '1Hour', '2026-08-14T00:00:00Z')] }), null);
  assert.equal(pickElevSeries({ entries: [] }), null);
  assert.equal(pickElevSeries(null), null);
});

// ── the metres trap ─────────────────────────────────────────────────────────────────────────
test('metres convert to feet — 201.2 m is Hartwell at full pool, not forty feet down', () => {
  // Every CWMS entry carries units "m". Hartwell's full pool is 660 ft. Reading the number
  // without converting puts the lake below its own bottom of conservation.
  assert.equal(cwmsToFeet(201.17, 'm'), 660.01);
  assert.equal(cwmsToFeet(201.17, 'meters'), 660.01);
});

test('feet stay feet', () => {
  assert.equal(cwmsToFeet(660, 'ft'), 660);
  assert.equal(cwmsToFeet(660, 'feet'), 660);
});

test('an unrecognised unit is REFUSED, never passed through', () => {
  // A silent pass-through of an unknown unit is how 201.2 becomes a lake level.
  assert.equal(cwmsToFeet(201.17, ''), null);
  assert.equal(cwmsToFeet(201.17, null), null);
  assert.equal(cwmsToFeet(201.17, 'cm'), null);
  assert.equal(cwmsToFeet(201.17, 'kcfs'), null);
});

test('a non-numeric value is null rather than NaN feet', () => {
  assert.equal(cwmsToFeet(null, 'm'), null);
  assert.equal(cwmsToFeet(undefined, 'm'), null);
  assert.equal(cwmsToFeet(Number.NaN, 'm'), null);
});
