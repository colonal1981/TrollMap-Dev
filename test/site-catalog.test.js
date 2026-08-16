// Which parameters a site actually publishes, instead of asking for twelve and seeing what
// comes back.
//
// Verified 2026-08-16 against 02147801, the Wateree tailrace this app reads for temperature:
// seriesCatalogOutput=true&outputDataTypeCd=iv returns 00010, 00060, 00065, 00300 and 63160 —
// exactly the five found by experiment that morning — and says 63160 only began 2025-10-01.
//
// The point is not saving a request. It is that "no water temperature on this lake" and "the
// request failed" were the same silence, and now one of them can say which.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSiteCatalog } from '../Worker/conditions.js';

const T = '\t';
const HEAD = ['agency_cd', 'site_no', 'station_nm', 'site_tp_cd', 'dec_lat_va', 'dec_long_va',
              'coord_acy_cd', 'dec_coord_datum_cd', 'alt_va', 'alt_acy_va', 'alt_datum_cd',
              'huc_cd', 'data_type_cd', 'parm_cd', 'stat_cd', 'ts_id', 'loc_web_ds',
              'medium_grp_cd', 'parm_grp_cd', 'srs_id', 'access_cd', 'begin_date', 'end_date',
              'count_nu'];
const row = (parm, begin, end, count) => {
  const f = HEAD.map(() => '');
  f[0] = 'USGS'; f[1] = '02147801'; f[2] = 'LAKE WATEREE TAILRACE'; f[13] = parm;
  f[21] = begin; f[22] = end; f[23] = count;
  return f.join(T);
};
const RDB = ['# USGS site service', '#', HEAD.join(T), HEAD.map(() => '5s').join(T),
  row('00010', '2021-10-29', '2026-08-16', '1752'),
  row('00060', '2021-10-29', '2026-08-16', '1752'),
  row('00065', '2021-10-29', '2026-08-16', '1752'),
  row('00300', '2021-10-29', '2026-08-16', '1752'),
  row('63160', '2025-10-01', '2026-08-16', '319'),
].join('\n');

test('every published parameter is listed with its period of record', () => {
  const c = parseSiteCatalog(RDB);
  assert.deepEqual(Object.keys(c).sort(), ['00010', '00060', '00065', '00300', '63160']);
  assert.equal(c['63160'].begin, '2025-10-01');
  assert.equal(c['63160'].count, 319);
  assert.equal(c['00010'].count, 1752);
});

test('a parameter the site does not publish is simply absent', () => {
  const c = parseSiteCatalog(RDB);
  assert.equal(c['63680'], undefined, 'turbidity is not published here');
  assert.equal(c['00480'], undefined, 'nor salinity');
});

test('columns are read by header name — stat_cd and loc_web_ds are empty on this site', () => {
  const c = parseSiteCatalog(RDB);
  assert.equal(c['00010'].begin, '2021-10-29', 'empty columns must not shift the dates');
});

test('an empty count is not a count of zero', () => {
  // Number('') is 0 and isFinite(0) is true. A series with no count published is not a series
  // with no observations, and the difference decides whether it is worth asking for.
  const rdb = ['#', HEAD.join(T), HEAD.map(() => '5s').join(T),
               row('00010', '2021-10-29', '2026-08-16', '')].join('\n');
  assert.equal(parseSiteCatalog(rdb)['00010'].count, null);
});

test('a site with no series at all is null, not an empty catalogue', () => {
  // These are different: null means we do not know what this site publishes, and an empty
  // object would mean we know it publishes nothing. Only the second justifies saying so.
  assert.equal(parseSiteCatalog(['#', HEAD.join(T), HEAD.map(() => '5s').join(T)].join('\n')), null);
  assert.equal(parseSiteCatalog(''), null);
  assert.equal(parseSiteCatalog('# comments only'), null);
  assert.equal(parseSiteCatalog(null), null);
});

test('a response with no parm_cd column is refused rather than half-read', () => {
  const head = HEAD.filter((h) => h !== 'parm_cd');
  const rdb = [head.join(T), head.map(() => '5s').join(T), head.map(() => 'x').join(T)].join('\n');
  assert.equal(parseSiteCatalog(rdb), null);
});
