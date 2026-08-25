// Picking the Corps' pool elevation out of forty-two candidates, and the metres trap.
//
// FIXTURE IS REAL. These entries are lifted verbatim from
// /cwms-data/catalog/TIMESERIES?office=SAS&like=^Hartwell\.Elev, read 2026-08-16. It returned 42
// series for one lake and exactly one of them is "how high is the water".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickElevSeries, cwmsToFeet, cwmsPoolElevation } from '../Worker/conditions.js';

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


// ── the fetch that was never wired ──────────────────────────────────────────────────────────
//
// pickElevSeries, parseCwmsTimeseries and cwmsLevel were written on 2026-08-16 and tested right
// here, and NOTHING EVER CALLED THEM. The CWMS reader that WAS wired lived in worker-data.js and
// asked for `Hartwell.Elev.Inst.0.0.USACE-RAW` on office `SA` in feet -- wrong parameter, wrong
// interval, wrong version, wrong office, wrong unit. It returned nothing on every call, and the
// /lakes route fell through to scraping a district web page for a three-digit number.
//
// These tests pin the request as well as the answer, because four of those five mistakes were
// in the URL rather than in the parsing.

/** Swap global fetch for one call, always restoring it, and record what was asked for. */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => { seen.push(String(url)); return impl(String(url), opts); };
  try { return { out: await fn(), seen }; } finally { globalThis.fetch = real; }
}

const CAT_FOR = (loc) => ({ total: 42, 'page-size': 500, entries: [
  e(`${loc}.Elev-GC.Inst.1Day.0.ARCHIVE-DAILY`, '1Day', '2030-01-01T00:00:00Z'),
  e(`${loc}.Elev-Head.Inst.1Hour.0.Raw-SHEF_SAS`, '1Hour', '2026-08-21T18:00:00Z'),
  e(`${loc}.Elev-Pool_p50.Inst.1Day.0.ARCHIVE-DAILY`, '1Day', '2031-12-31T00:00:00Z'),
  e(`${loc}.Elev-Pool.Inst.1Day.0.Raw-SHEF_SAS`, '1Day', '2026-08-21T00:00:00Z'),
  e(`${loc}.Elev-Pool.Inst.1Hour.0.Raw-SHEF_SAS`, '1Hour', '2026-08-21T18:00:00Z'),
] });

const NOW = Date.parse('2026-08-21T20:00:00Z');

/** A catalogue-then-timeseries responder. `metres` is what the Corps actually publishes. */
const responder = (loc, metres) => async (url) => {
  if (url.includes('/catalog/TIMESERIES')) {
    return { ok: true, status: 200, json: async () => CAT_FOR(loc) };
  }
  const env = ENVELOPE([[Date.parse('2026-08-21T18:00:00Z'), metres, 0]]);
  env.units = 'm';
  env.name = `${loc}.Elev-Pool.Inst.1Hour.0.Raw-SHEF_SAS`;
  return { ok: true, status: 200, json: async () => env };
};

// EVERY FIXTURE PROJECT NAME BELOW IS DISTINCT, AND THAT IS NOT COSMETIC. cwmsPoolElevation
// caches the series read by the SERIES NAME the catalogue handed back, which is correct -- two
// waters on one Corps series should not be two requests -- but it means two tests sharing a
// project name share a cached answer, and the second one passes on the first one's numbers. The
// real `Hartwell.*` names are reserved for the live-response test further down.

test('a metres payload is converted, and the hourly series is the one discovered', async () => {
  // 201.17 m is 660.01 ft. Hartwell's full pool is 660 ft; reading the metres as feet would put
  // the lake 459 feet below the bottom of its conservation pool. (Synthetic: the live service
  // answered this series in FEET on 2026-08-25 while its catalogue said metres -- see below.)
  const { out, seen } = await withFetch(responder('HartwellMetres', 201.17),
    () => cwmsPoolElevation('HartwellMetres', 'SAS', NOW));
  assert.equal(out.elevation_ft, 660.01);
  assert.equal(out.location, 'HartwellMetres');
  assert.equal(out.series, 'HartwellMetres.Elev-Pool.Inst.1Hour.0.Raw-SHEF_SAS');
  assert.equal(out.units_reported, 'm');
  assert.equal(out.stale, false);
  assert.equal(seen.length, 2, 'one catalogue request, one series request');
});

test('the like pattern is upper-case, because CWMS upper-cases the id before matching', async () => {
  const { seen } = await withFetch(responder('Russell', 101.5),
    () => cwmsPoolElevation('Russell', 'SAS', NOW));
  const cat = decodeURIComponent(seen[0]);
  assert.ok(cat.includes('office=SAS'), cat);
  assert.ok(cat.includes('^RUSSELL\\.ELEV'), cat);
  assert.ok(cat.includes('page-size=500'), cat);
});

test('no unit= is requested, so whatever arrives is what gets converted', async () => {
  // Asking for feet and being answered in metres is the exact failure this path exists to
  // avoid. The response carries its unit; the request must not presume one.
  const { seen } = await withFetch(responder('Thurmond', 100.6),
    () => cwmsPoolElevation('Thurmond', 'SAS', NOW));
  assert.ok(!seen[1].includes('unit='), seen[1]);
  assert.ok(seen[1].includes('office=SAS'), seen[1]);
});

// ── the live shape, read 2026-08-25 ─────────────────────────────────────────────────────────
//
// Both calls made against cwms-data.usace.army.mil with exactly the URLs cwmsPoolElevation
// builds. Everything below is transcribed from those two responses.

test('the live Hartwell response: catalogue says metres, the DATA says feet', async () => {
  // ONE SERVICE, TWO ANSWERS, AND ONLY THE SECOND IS BESIDE THE NUMBERS.
  //   catalog/TIMESERIES  Hartwell.Elev-Pool.Inst.1Hour.0.Raw-SHEF_SAS  "units": "m"
  //   timeseries          the same name                                 "units": "ft"
  // Converting on the catalogue's metres would report 2,138 feet for a lake sitting at 651.59.
  const live = async (url) => {
    if (url.includes('/catalog/TIMESERIES')) {
      return { ok: true, status: 200, json: async () => ({ 'page-size': 500, total: 42, entries: [
        // Real names, real extents, real units -- the tie between the two 1Hour candidates is
        // broken by latest-time, and HISTORIAN_SAS is four months behind.
        e('Hartwell.Elev-Pool.Inst.1Day.0.Raw-SHEF_SAS', '1Day', '2026-08-21T00:00:00Z'),
        e('Hartwell.Elev-Pool.Inst.1Hour.0.HISTORIAN_SAS', '1Hour', '2026-05-07T14:00:00Z'),
        e('Hartwell.Elev-Pool.Inst.1Hour.0.Raw-SHEF_SAS', '1Hour', '2026-08-21T18:00:00Z'),
        e('Hartwell.Elev-Pool_p50.Inst.1Day.0.ARCHIVE-DAILY', '1Day', '2031-12-31T00:00:00Z'),
        e('Hartwell.Elev-Tail.Inst.1Hour.0.Raw-SHEF_SAS', '1Hour', '2026-08-21T18:00:00Z'),
      ] }) };
    }
    const env = ENVELOPE([[1787616000000, 651.62, 3], [1787619600000, 651.5899999999999, 3]]);
    env.name = 'Hartwell.Elev-Pool.Inst.1Hour.0.Raw-SHEF_SAS';
    env.units = 'ft';                       // <- the data endpoint's answer, not the catalogue's
    env['office-id'] = 'SAS';
    return { ok: true, status: 200, json: async () => env };
  };
  const now = Date.parse('2026-08-25T01:30:00Z');
  const { out, seen } = await withFetch(live, () => cwmsPoolElevation('Hartwell', 'SAS', now));
  assert.equal(out.elevation_ft, 651.59, 'feet passed through, not multiplied by 3.28');
  assert.equal(out.units_reported, 'ft');
  assert.equal(out.series, 'Hartwell.Elev-Pool.Inst.1Hour.0.Raw-SHEF_SAS',
    'the HISTORIAN copy is four months behind and must lose the tie');
  assert.equal(out.of_total, 42, 'the whole catalogue fits in one page at page-size=500');
  assert.equal(out.stale, false, 'the newest point was half an hour old');
  assert.equal(out.age_hours, 0.5);
  assert.equal(seen.length, 2);
});

test('the catalogue extent is NOT the age of the data', () => {
  // The extent for that series said latest-time 2026-08-21T18:00 while its newest value was
  // 2026-08-25T01:00 -- three and a half days apart. Staleness is computed from the VALUE's
  // timestamp for exactly this reason; reading it off the catalogue would have called a
  // half-hour-old reading stale and thrown it away in favour of a scraped web page.
  const env = ENVELOPE([[1787619600000, 651.59, 3]]);
  env.units = 'ft';
  const l = cwmsLevel(parseCwmsTimeseries(env), Date.parse('2026-08-25T01:30:00Z'));
  assert.equal(l.observed_at, '2026-08-25T01:00:00.000Z');
  assert.equal(l.stale, false);
});

test('a stale reading is still returned, and says so', async () => {
  const week = Date.parse('2026-08-28T20:00:00Z');
  const { out } = await withFetch(responder('HartwellStale', 201.17),
    () => cwmsPoolElevation('HartwellStale', 'SAS', week));
  assert.equal(out.stale, true, 'seven days old is past the 48-hour bar');
  assert.equal(out.elevation_ft, 660.01, 'the value is carried; the caller decides');
});

test('an empty catalogue is null rather than a guess', async () => {
  const { out } = await withFetch(
    async () => ({ ok: true, status: 200, json: async () => ({ total: 0, entries: [] }) }),
    () => cwmsPoolElevation('Nowhere', 'SAS', NOW));
  assert.equal(out, null);
});

test('a failed catalogue request does not throw into the route', async () => {
  const { out } = await withFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }),
    () => cwmsPoolElevation('Offline', 'SAS', NOW));
  assert.equal(out, null);
});

test('no location, no request', async () => {
  const { out, seen } = await withFetch(async () => { throw new Error('should not fetch'); },
    () => cwmsPoolElevation('', 'SAS', NOW));
  assert.equal(out, null);
  assert.equal(seen.length, 0);
});
