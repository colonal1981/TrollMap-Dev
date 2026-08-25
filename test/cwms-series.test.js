// Picking the Corps' pool elevation out of forty-two candidates, and the metres trap.
//
// FIXTURE IS REAL. These entries are lifted verbatim from
// /cwms-data/catalog/TIMESERIES?office=SAS&like=^Hartwell\.Elev, read 2026-08-16. It returned 42
// series for one lake and exactly one of them is "how high is the water".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickElevSeries, pickCwmsSeries, cwmsToFeet, cwmsToCfs, usaceRelease,
         releaseShape } from '../Worker/conditions.js';

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



// ── what is going through the dam ────────────────────────────────────────────────────────────
//
// Ryan, 2026-08-25: *"any data that is available for any and all lakes should be available for
// any and all lakes"*.
//
// releaseShape has answered for Duke and for TVA since those were wired. A Corps lake got
// nothing — not because the Corps publishes nothing, but because nothing here asked. Savannah
// District publishes Flow-Out, Flow-Power, Flow-Spill and Flow-In hourly on every project,
// alongside Elev-Tail. The ts-ids below are transcribed from registry/_cwms_inventory.json,
// which holds all 3,328 catalogued series for these districts.

async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => { seen.push(String(url)); return impl(String(url), opts); };
  try { return { out: await fn(), seen }; } finally { globalThis.fetch = real; }
}

// EVERY TEST BELOW USES ITS OWN PROJECT NAME, AND THAT IS NOT COSMETIC. usaceRelease caches both
// the catalogue and each series read by name, which is correct -- two waters on one Corps project
// should not be two requests -- but it means two tests sharing a project share a cached answer,
// and the second one passes on the first one's numbers. Caught by exactly that, twice.
const REL_CAT = (proj) => ({ total: 41, 'page-size': 500, entries: [
  e(`${proj}.Flow-In.Ave.1Day.1Day.Raw-SHEF_SAS`, '1Day', '2026-08-21T00:00:00Z'),
  e(`${proj}.Flow-In.Ave.1Hour.1Hour.Raw-SHEF_SAS`, '1Hour', '2026-08-25T01:00:00Z'),
  e(`${proj}.Flow-Out.Ave.1Hour.1Hour.Raw-SHEF_SAS`, '1Hour', '2026-08-25T01:00:00Z'),
  e(`${proj}.Flow-Power.Ave.1Hour.1Hour.Raw-SHEF_SAS`, '1Hour', '2026-08-25T01:00:00Z'),
  e(`${proj}.Flow-Spill.Ave.1Hour.1Hour.Raw-SHEF_SAS`, '1Hour', '2026-08-25T01:00:00Z'),
  e(`${proj}.Elev-Tail.Inst.1Hour.0.HISTORIAN_SAS`, '1Hour', '2025-09-05T12:00:00Z'),
  e(`${proj}.Elev-Tail.Inst.1Hour.0.Raw-SHEF_SAS`, '1Hour', '2026-08-25T01:00:00Z'),
] });

const T1 = Date.parse('2026-08-25T01:00:00Z');
const NOW2 = Date.parse('2026-08-25T01:30:00Z');

/** cms on the catalogue, cfs on the data — the trap this whole path exists to avoid. */
const relResponder = (units, vals, proj = 'Hartwell') => async (url) => {
  if (url.includes('/catalog/TIMESERIES')) {
    return { ok: true, status: 200, json: async () => REL_CAT(proj) };
  }
  const name = decodeURIComponent((url.match(/name=([^&]+)/) || [])[1] || '');
  const v = vals[Object.keys(vals).find((k) => name.includes(k))];
  if (v === undefined) return { ok: false, status: 404, json: async () => ({}) };
  const env = ENVELOPE([[T1, v, 0]]);
  env.name = name;
  env.units = name.includes('Elev') ? 'ft' : units;
  env['office-id'] = 'SAS';
  return { ok: true, status: 200, json: async () => env };
};

test('cwmsToCfs converts cms and passes cfs, and refuses anything else', () => {
  assert.equal(cwmsToCfs(100, 'cms'), 3531);
  assert.equal(cwmsToCfs(100, 'm3/s'), 3531);
  assert.equal(cwmsToCfs(4000, 'cfs'), 4000);
  assert.equal(cwmsToCfs(4000, 'ft3/s'), 4000);
  // A silent pass-through of an unknown unit is how 201.2 becomes a lake level.
  assert.equal(cwmsToCfs(100, 'furlongs/fortnight'), null);
  assert.equal(cwmsToCfs(100, ''), null);
  assert.equal(cwmsToCfs(NaN, 'cfs'), null);
});

test('pickCwmsSeries picks the live Elev-Tail over the HISTORIAN copy', () => {
  // Same tie the pool series has: two 1Hour candidates, one of them eleven months behind.
  const p = pickCwmsSeries(REL_CAT('Hartwell'), /\.Elev-Tail\./i);
  assert.equal(p.name, 'Hartwell.Elev-Tail.Inst.1Hour.0.Raw-SHEF_SAS');
});

test('pickCwmsSeries prefers the hourly flow over the daily one', () => {
  assert.equal(pickCwmsSeries(REL_CAT('Hartwell'), /\.Flow-In\./i).name,
    'Hartwell.Flow-In.Ave.1Hour.1Hour.Raw-SHEF_SAS');
});

test('usaceRelease reads all four flows and the tailwater, in cfs', async () => {
  const { out } = await withFetch(
    relResponder('cms', { 'Flow-Out': 200, 'Flow-Power': 180, 'Flow-Spill': 20,
                          'Flow-In': 150, 'Elev-Tail': 480.2 }),
    () => usaceRelease('Hartwell', 'SAS', NOW2));
  assert.equal(out.outflow.value, 7063, '200 cms is 7,063 cfs — reading it as cfs is a 35x error');
  assert.equal(out.through_turbines.value, 6357);
  assert.equal(out.spill.value, 706);
  assert.equal(out.inflow.value, 5297);
  assert.equal(out.tailwater_ft, 480.2);
  assert.equal(out.flow_units, 'ft3/s');
  assert.equal(out.project, 'Hartwell');
  assert.equal(out.age_hours, 0.5, 'the age travels, because this district can run behind');
});

test('the like pattern is upper-case and asks the district, not the division', async () => {
  const { seen } = await withFetch(
    relResponder('cms', { 'Flow-Out': 200 }, 'Russell'), () => usaceRelease('Russell', 'SAS', NOW2));
  const cat = decodeURIComponent(seen[0]);
  assert.ok(cat.includes('office=SAS'), cat);
  assert.ok(cat.includes('^RUSSELL\\.(FLOW|ELEV-TAIL)'), cat);
});

test('a project publishing only one flow still answers', async () => {
  const { out } = await withFetch(
    relResponder('cms', { 'Flow-Out': 100 }, 'Thurmond'), () => usaceRelease('Thurmond', 'SAS', NOW2));
  assert.equal(out.outflow.value, 3531);
  assert.equal(out.through_turbines, undefined);
  assert.equal(out.tailwater_ft, null);
});

test('a project publishing nothing is null, not an empty block', async () => {
  const { out } = await withFetch(
    async () => ({ ok: true, status: 200, json: async () => ({ total: 0, entries: [] }) }),
    () => usaceRelease('Nowhere', 'SAS', NOW2));
  assert.equal(out, null);
});

test('no project or no office, no request', async () => {
  const { out, seen } = await withFetch(async () => { throw new Error('should not fetch'); },
    () => usaceRelease('', 'SAS', NOW2));
  assert.equal(out, null);
  assert.equal(seen.length, 0);
  const b = await withFetch(async () => { throw new Error('should not fetch'); },
    () => usaceRelease('Hartwell', '', NOW2));
  assert.equal(b.out, null);
  assert.equal(b.seen.length, 0);
});

test('an unreachable district does not throw into the route', async () => {
  const { out } = await withFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }),
    () => usaceRelease('HartwellOffline', 'SAS', NOW2));
  assert.equal(out, null);
});

test('releaseShape gives a Corps lake a release where it used to give nothing', () => {
  const usace = { project: 'Hartwell', outflow: { value: 7063, at: '2026-08-25T01:00:00Z' },
                  through_turbines: { value: 6357, at: '2026-08-25T01:00:00Z' },
                  spill: { value: 706, at: '2026-08-25T01:00:00Z' },
                  tailwater_ft: 480.2, age_hours: 0.5, observed_at: '2026-08-25T01:00:00Z',
                  source: 'x' };
  const r = releaseShape({ usace });
  assert.equal(r.operator, 'US Army Corps of Engineers');
  // Observed, not scheduled: this is the hour that just passed, not the trip you have not taken.
  assert.equal(r.kind, 'observed');
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].label, 'Total release');
  assert.equal(r.items[0].cfs, 7063);
  assert.equal(r.tailwater_ft, 480.2);
  assert.equal(r.age_hours, 0.5);
});

test('a SCHEDULE still outranks the Corps, because a schedule is about a trip not yet taken', () => {
  const usace = { project: 'Hartwell', outflow: { value: 7063, at: 'x' }, source: 'x' };
  const tva = { generation: [{ hour: '08:00', cfs: 4000 }], observed_at: 'y', source: 'z' };
  assert.equal(releaseShape({ usace, tva }).operator, 'TVA');
  const duke = { arrivals: [{ at: 'noon' }], basinName: 'Catawba' };
  assert.equal(releaseShape({ usace, duke }).operator, 'Duke Energy');
});

test('no Corps flows, no Corps release — a tailwater alone is not a release', () => {
  assert.equal(releaseShape({ usace: { project: 'Hartwell', tailwater_ft: 480.2 } }), null);
});


// ── AND THE SAMPLE WAS ONE LAKE ───────────────────────────────────────────────────────────────
//
// Everything above is Hartwell's own 42 series. That is a sample, and a census answers a
// question about the thing it counted -- a lesson this project has paid for more than once.
//
// `/cwms-data/parameters?office=SAS`, fetched 2026-08-25, is the POPULATION: 199 registered
// parameters, of which 54 are `Elev`. The manual calls it "a hardwired list of parameter IDs in
// the CWMS database", so this is the whole vocabulary a Corps project can publish under, not
// the subset one reservoir happens to use.
//
// Transcribed verbatim. THIRTY-FOUR of them begin with the literal text `Elev-Pool`, and the
// comment on `usaceElevation` claims the trailing dot separates the reading from all of them.
// Claimed against 42; proved here against 54.
const OFFICIAL_ELEV = [
  'Elev', 'Elev-Pool', 'Elev-Head', 'Elev-Tail', 'Elev-Tail-Sen2',
  'Elev-Level1', 'Elev-Level2', 'Elev-Level3', 'Elev-Rule',
  'Elev-Trigger-Level1', 'Elev-Trigger_Level1', 'Elev-Trigger_Level2', 'Elev-Trigger_Level3',
  'Elev-Pool-Level1', 'Elev-Pool-Level2', 'Elev-Pool-Level3', 'Elev-Pool-Level4',
  'Elev-Pool-Rule', 'Elev-Pool-Ave', 'Elev-Pool-Aver',
  'Elev-Pool_Avg', 'Elev-Pool_Max', 'Elev-Pool_Min', 'Elev-Pool_DOY', 'Elev-Pool_AVER',
  'Elev-Pool_p02', 'Elev-Pool_p05', 'Elev-Pool_p10', 'Elev-Pool_p15', 'Elev-Pool_p20',
  'Elev-Pool_p25', 'Elev-Pool_p30', 'Elev-Pool_p35', 'Elev-Pool_p40', 'Elev-Pool_p45',
  'Elev-Pool_p50', 'Elev-Pool_p55', 'Elev-Pool_p60', 'Elev-Pool_p65', 'Elev-Pool_p70',
  'Elev-Pool_p75', 'Elev-Pool_p80', 'Elev-Pool_p85', 'Elev-Pool_p90', 'Elev-Pool_p95',
  'Elev-Pool_p98',
  'Elev-88', 'Elev-Guide-Curve', 'Elev-Guide_Curve', 'Elev-GC',
  'Elev-L1', 'Elev-L2', 'Elev-L3', 'Elev-AVER',
];

const OFFICIAL_CATALOG = { entries: OFFICIAL_ELEV.map(
  (param) => e(`Somelake.${param}.Inst.1Hour.0.Raw-SHEF_SAS`, '1Hour', '2026-08-25T12:00:00Z')) };

test('the whole registered Elev vocabulary, and only one of it is the water', () => {
  assert.equal(OFFICIAL_ELEV.length, 54, 'the fetch returned 54 Elev parameters');
  const hit = pickCwmsSeries(OFFICIAL_CATALOG, /\.Elev-Pool\./i);
  assert.ok(hit, 'something matched');
  assert.equal(hit.name, 'Somelake.Elev-Pool.Inst.1Hour.0.Raw-SHEF_SAS');
});

test('thirty-four registered parameters start with the text Elev-Pool', () => {
  // If this number moves, the vocabulary moved and the anchor is worth re-proving. It was
  // written as 33 first, by counting the transcribed list by eye; the count came off the fetch.
  const family = OFFICIAL_ELEV.filter((p) => p.startsWith('Elev-Pool'));
  assert.equal(family.length, 34);
  // Every one of them is excluded by the trailing dot, which is the whole claim.
  for (const param of family) {
    if (param === 'Elev-Pool') continue;
    assert.equal(/\.Elev-Pool\./i.test(`Somelake.${param}.Inst.1Hour.0.Raw-SHEF_SAS`), false,
      `${param} must not read as the pool`);
  }
});

test('a percentile is one underscore away from the reading', () => {
  // The pair the original comment named, now with its 20 siblings behind it.
  assert.equal(/\.Elev-Pool\./i.test('X.Elev-Pool_p10.Inst.1Hour.0.R'), false);
  assert.equal(/\.Elev-Pool\./i.test('X.Elev-Pool.Inst.1Hour.0.R'), true);
});

test('the guide curve has THREE registered spellings, which is why none is hard-coded here', () => {
  // Elev-GC, Elev-Guide-Curve and Elev-Guide_Curve are all in the Corps' own list -- Hartwell
  // publishes all three. Nothing in the Worker reads a guide curve from CWMS (usaceLevels does
  // it), so no matcher is built for them; this records that any future one needs all three and
  // that the hyphen/underscore inconsistency is the Corps', not a typo.
  const spellings = OFFICIAL_ELEV.filter((p) => /^Elev-(GC|Guide[-_]Curve)$/.test(p));
  assert.deepEqual(spellings.sort(), ['Elev-GC', 'Elev-Guide-Curve', 'Elev-Guide_Curve']);
  // And none of them is the pool.
  for (const param of spellings) {
    assert.equal(/\.Elev-Pool\./i.test(`X.${param}.Inst.1Hour.0.R`), false);
  }
});

test('the drought-level family is inconsistent in the Corps vocabulary itself', () => {
  // Elev-Trigger-Level1 is hyphenated; Elev-Trigger_Level2 and _Level3 are underscored. One
  // family, two punctuations, in the published list. This is exactly why a hand-written pattern
  // over these names rots, and it is recorded rather than matched.
  assert.ok(OFFICIAL_ELEV.includes('Elev-Trigger-Level1'));
  assert.ok(OFFICIAL_ELEV.includes('Elev-Trigger_Level2'));
  assert.ok(OFFICIAL_ELEV.includes('Elev-Trigger_Level3'));
});
