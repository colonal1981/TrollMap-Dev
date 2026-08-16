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

// ── the timeseries payload, and the unit that disagrees with the catalogue ───────────────────
//
// FIXTURE IS REAL. Envelope read live 2026-08-16 for
// Hartwell.Elev-Pool.Inst.1Hour.0.Raw-SHEF_SAS. `values` came back empty for that window and the
// rows here are added in the documented column order.
import { parseCwmsTimeseries, cwmsLevel } from '../Worker/conditions.js';

const ENVELOPE = (values) => ({
  begin: '2026-08-15T00:00:00Z', 'date-version-type': 'UNVERSIONED',
  end: '2026-08-16T23:00:00Z', interval: 'PT1H', 'interval-offset': 0,
  name: 'Hartwell.Elev-Pool.Inst.1Hour.0.Raw-SHEF_SAS', 'office-id': 'SAS',
  'page-size': 5, 'time-zone': 'US/Central', total: values.length, units: 'ft',
  'value-columns': [
    { name: 'date-time', ordinal: 1, datatype: 'java.sql.Timestamp' },
    { name: 'value', ordinal: 2, datatype: 'java.lang.Double' },
    { name: 'quality-code', ordinal: 3, datatype: 'int' },
  ],
  values,
});
const T0 = Date.parse('2026-08-14T09:00:00Z');

test('THE UNIT COMES FROM THE RESPONSE, and it disagrees with the catalogue', () => {
  // The catalogue entry for this exact series says "units": "m". The data endpoint says "ft".
  // Converting on the catalogue would turn 660 ft into 2,165 ft; assuming the catalogue meant
  // feet would show the lake at 201. Neither guess is safe.
  const p = parseCwmsTimeseries(ENVELOPE([[T0, 659.87, 0]]));
  assert.equal(p.units, 'ft');
  assert.equal(cwmsLevel(p, T0 + 3600000).elevation_ft, 659.87, 'feet must not be re-converted');
});

test('columns are located by name, not by ordinal', () => {
  const env = ENVELOPE([[0, T0, 659.87]]);
  env['value-columns'] = [
    { name: 'quality-code', ordinal: 1 }, { name: 'date-time', ordinal: 2 },
    { name: 'value', ordinal: 3 },
  ];
  const p = parseCwmsTimeseries(env);
  assert.equal(p.latest.value, 659.87);
  assert.equal(p.latest.quality, 0);
});

test('an ISO timestamp is accepted as readily as epoch milliseconds', () => {
  const p = parseCwmsTimeseries(ENVELOPE([['2026-08-14T09:00:00Z', 659.87, 0]]));
  assert.equal(p.latest.at, '2026-08-14T09:00:00.000Z');
});

test('the newest point wins regardless of the order rows arrive in', () => {
  const p = parseCwmsTimeseries(ENVELOPE([
    [T0, 659.87, 0], [T0 - 7200000, 660.10, 0], [T0 - 3600000, 659.95, 0]]));
  assert.equal(p.points, 3);
  assert.equal(p.latest.value, 659.87);
});

test('an empty window is a real answer, not a failure', () => {
  // total 0 with values [] is how we learned this SHEF series runs about two days behind.
  const p = parseCwmsTimeseries(ENVELOPE([]));
  assert.equal(p.empty_window, true);
  assert.equal(p.latest, null);
  assert.equal(cwmsLevel(p, Date.now()), null);
});

test('a two-day-old reading is returned WITH its age and flagged stale', () => {
  const p = parseCwmsTimeseries(ENVELOPE([[T0, 659.87, 0]]));
  const l = cwmsLevel(p, T0 + 60 * 3600 * 1000);
  assert.equal(l.age_hours, 60);
  assert.equal(l.stale, true);
  assert.equal(l.elevation_ft, 659.87, 'the value is still carried — the caller decides');
});

test('metres on the response ARE converted, because the response is what is trusted', () => {
  const env = ENVELOPE([[T0, 201.17, 0]]);
  env.units = 'm';
  assert.equal(cwmsLevel(parseCwmsTimeseries(env), T0).elevation_ft, 660.01);
});

test('an unrecognised unit on the response yields no level at all', () => {
  const env = ENVELOPE([[T0, 201.17, 0]]);
  env.units = 'furlongs';
  assert.equal(cwmsLevel(parseCwmsTimeseries(env), T0), null);
});

test('the quality code is carried through and never interpreted', () => {
  // CWMS packs screening, validity and replacement into bit fields and this codebase has no
  // reference for them. Passing the integer through is honest; inventing a meaning is not.
  const p = parseCwmsTimeseries(ENVELOPE([[T0, 659.87, 3221225472]]));
  assert.equal(p.latest.quality, 3221225472);
  assert.equal(cwmsLevel(p, T0).quality_code, 3221225472);
});

test('a malformed envelope is null rather than half-parsed', () => {
  assert.equal(parseCwmsTimeseries(null), null);
  assert.equal(parseCwmsTimeseries({}), null);
  const noCols = ENVELOPE([[T0, 1, 0]]);
  delete noCols['value-columns'];
  assert.equal(parseCwmsTimeseries(noCols), null);
});
