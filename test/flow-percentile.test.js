// Where today's flow sits in this river's own history.
//
// 1,240 ft3/s is not a fact anyone can act on. "1,240, below the 10th percentile for August 16
// across 96 years" is. The only answer this app had before was NOAA's `anomaly_category`, which
// conditions.js passes through untranslated because it is a code into a legend nobody has read.
//
// Verified 2026-08-16 against site 02148000 (Wateree River near Camden): statReportType=daily
// returns one row per calendar day with begin_yr 1930, end_yr 2026, count_nu 96.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDailyStats, statBand } from '../Worker/conditions.js';

const T = '\t';
const HEAD = ['agency_cd', 'site_no', 'parameter_cd', 'ts_id', 'loc_web_ds', 'month_nu', 'day_nu',
              'begin_yr', 'end_yr', 'count_nu', 'p10_va', 'p25_va', 'p50_va', 'p75_va', 'p90_va'];
const row = (m, d, p) => ['USGS', '02148000', '00060', '124978', '', String(m), String(d),
                          '1930', '2026', '96', ...p].join(T);
const RDB = [
  '# comment line that must be skipped',
  HEAD.join(T),
  HEAD.map(() => '5s').join(T),
  row(1, 1, ['1330', '2600', '5760', '8220', '14200']),
  row(8, 16, ['420', '760', '1500', '3100', '7400']),
].join('\n');

test('the row for the right calendar day is found, comments and the format line skipped', () => {
  const st = parseDailyStats(RDB, 8, 16);
  assert.equal(st.p10, 420);
  assert.equal(st.p50, 1500);
  assert.equal(st.p90, 7400);
  assert.equal(st.years, 96);
  assert.equal(st.begin_yr, 1930);
});

test('columns are read by HEADER NAME, not by counting from the front', () => {
  // `loc_web_ds` is empty on this site. Counting fields drifts by one the moment a site fills
  // it in, and the drift lands p25 in the p10 slot — a wrong answer that still looks like flow.
  const shifted = RDB.replace(`${T}${T}8${T}16`, `${T}Wateree at Camden${T}8${T}16`);
  const st = parseDailyStats(shifted, 8, 16);
  assert.equal(st.p10, 420, 'a populated loc_web_ds must not shift the percentiles');
  assert.equal(st.p90, 7400);
});

test('a day with no row is null, not the nearest day', () => {
  assert.equal(parseDailyStats(RDB, 2, 29), null);
});

test('a drought flow lands below the tenth percentile', () => {
  const st = parseDailyStats(RDB, 8, 16);
  const b = statBand(310, st);
  assert.equal(b.label, 'below the 10th percentile');
  assert.equal(b.percentile_at_least, null);
  assert.equal(b.percentile_below, 10);
  assert.equal(b.median, 1500);
  assert.equal(b.period, '1930–2026');
});

test('an ordinary flow lands between two published set points', () => {
  const st = parseDailyStats(RDB, 8, 16);
  const b = statBand(1200, st);
  assert.equal(b.label, 'between the 25th and 50th percentile');
  assert.equal(b.percentile_at_least, 25);
  assert.equal(b.percentile_below, 50);
});

test('a flood lands above the ninetieth and says so', () => {
  const st = parseDailyStats(RDB, 8, 16);
  const b = statBand(22000, st);
  assert.equal(b.label, 'above the 90th percentile');
  assert.equal(b.percentile_at_least, 90);
  assert.equal(b.percentile_below, null);
});

test('a band is never presented as an interpolated percentile', () => {
  // Interpolating between p25 and p50 would be a derived value wearing a measurement's clothes,
  // which is the same refusal usaceSeasonalValue makes about interpolating a Corps level.
  const b = statBand(1200, parseDailyStats(RDB, 8, 16));
  assert.match(b.note, /not an interpolated percentile/);
  assert.equal(typeof b.percentile_at_least, 'number');
  assert.ok(!('percentile' in b), 'no single percentile figure is offered');
});

test('exactly on a set point counts as at or above it', () => {
  const st = parseDailyStats(RDB, 8, 16);
  assert.equal(statBand(1500, st).percentile_at_least, 50);
  assert.equal(statBand(7400, st).label, 'above the 90th percentile');
});

test('a malformed or empty response is null rather than a band of zero', () => {
  assert.equal(parseDailyStats('', 8, 16), null);
  assert.equal(parseDailyStats('# only comments', 8, 16), null);
  assert.equal(parseDailyStats('no tabs here at all', 8, 16), null);
  assert.equal(statBand(100, null), null);
  assert.equal(statBand(NaN, parseDailyStats(RDB, 8, 16)), null);
});

test('a row whose percentiles are all blank is not a statistic', () => {
  const blank = [HEAD.join(T), HEAD.map(() => '5s').join(T),
                 row(8, 16, ['', '', '', '', ''])].join('\n');
  assert.equal(parseDailyStats(blank, 8, 16), null);
});
