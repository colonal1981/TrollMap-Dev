// NDBC realtime2, against rows transcribed from the LIVE files on 2026-08-25.
//
// Ryan ran these curls; the text below is what came back, unedited. A fixture invented from the
// format documentation would have agreed with my reading of the format rather than with NDBC.
import test from 'node:test';
import assert from 'node:assert';
import { parseRealtime2, shapeMet, shapeOcean, ndbcUrl, ndbcReadings } from '../Worker/ndbc.js';

// LMFS1 — Lake Murray SC, C-MAN, NWS WFO Columbia. Ten-minute clock, and it DOES publish gust.
const LMFS1 = `#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft
2026 08 25 22 50  80  3.6  6.2    MM    MM    MM  MM     MM  31.2    MM    MM   MM   MM    MM
2026 08 25 22 40  70  3.1  5.7    MM    MM    MM  MM     MM  31.4    MM    MM   MM   MM    MM
`;

// NIWS1 — Oyster Landing, North Inlet-Winyah Bay reserve. Fifteen-minute clock, and GST and
// WTMP are MM on EVERY row. A no-gust station must never read as a station reporting no gusts.
const NIWS1 = `#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft
2026 08 25 23 00 170  4.1   MM    MM    MM    MM  MM 1016.0  28.4    MM  23.9   MM +0.0    MM
2026 08 25 22 45 180  4.6   MM    MM    MM    MM  MM 1016.0  28.3    MM  23.6   MM   MM    MM
`;

// NIQS1 — the SAME SITE as NIWS1 under a second id, and this is the file with the water in it.
const NIQS1 = `#YY  MM DD hh mm   DEPTH  OTMP   COND   SAL   O2% O2PPM  CLCON  TURB    PH    EH
#yr  mo dy hr mn       m  degC  mS/cm   psu     %   ppm   ug/l   FTU     -    mv
2026 08 25 23 00     2.6 28.80  55.54 36.70 110.0  6.90     MM    12  8.00    MM
2026 08 25 22 45     2.5 28.90  55.50 36.70 110.5  7.00     MM    13  8.00    MM
`;

const AT_2300 = Date.parse('2026-08-25T23:05:00Z');

test('the met file parses by header name and converts to the units the app shows', () => {
  const m = shapeMet(parseRealtime2(LMFS1), { feed_id: 'LMFS1', name: 'Lake Murray SC', km_outside: 0 }, AT_2300);
  assert.equal(m.observed_at, '2026-08-25T22:50:00.000Z');
  assert.equal(m.wind_dir_deg, 80);
  assert.equal(m.wind_mph, 8.1);      // 3.6 m/s
  assert.equal(m.gust_mph, 13.9);     // 6.2 m/s
  assert.equal(m.air_c, 31.2);
  assert.equal(m.air_f, 88.2);
  assert.equal(m.station, 'LMFS1');
});

test('MM is a missing reading and never a zero', () => {
  const m = shapeMet(parseRealtime2(NIWS1), { feed_id: 'NIWS1' }, AT_2300);
  // plan-preflight calls a no-go at 20 mph gusts. A null has to arrive as "not measured here".
  assert.equal(m.gust_mph, null);
  assert.equal(m.water_c, null);
  assert.equal(m.wind_mph, 9.2);      // 4.1 m/s — the wind IS measured
  assert.equal(m.pressure_mb, 1016);
  assert.equal(m.dewpoint_c, 23.9);
});

test('pressure tendency survives, including a signed zero', () => {
  // "+0.0" is a REPORTED steady barometer, not an absent one, and it parses to 0 not null.
  const m = shapeMet(parseRealtime2(NIWS1), { feed_id: 'NIWS1' }, AT_2300);
  assert.equal(m.pressure_tendency_mb, 0);
});

test('the ocean file carries the water the coastal cards have never had', () => {
  const o = shapeOcean(parseRealtime2(NIQS1), { feed_id: 'NIQS1', km_outside: 2.45 }, AT_2300);
  assert.equal(o.water_c, 28.8);
  assert.equal(o.water_f, 83.8);
  assert.equal(o.salinity_psu, 36.7);
  assert.equal(o.oxygen_ppm, 6.9);
  assert.equal(o.oxygen_pct, 110);
  assert.equal(o.ph, 8);
  assert.equal(o.sonde_depth_m, 2.6);
  assert.equal(o.km_from_water, 2.45);
});

test('FTU is not FNU and psu is not ppt, so neither borrows the other\'s field name', () => {
  const o = shapeOcean(parseRealtime2(NIQS1), { feed_id: 'NIQS1' }, AT_2300);
  assert.equal(o.turbidity_ftu, 12);
  // The app renders USGS 63680 as `turbidity`, in FNU. Different instrument, different unit.
  assert.ok(!('turbidity' in o), 'must not occupy the USGS turbidity field');
  assert.equal(o.salinity_psu, 36.7);
  assert.ok(!('salinity_ppt' in o), 'must not claim the USGS 00480 unit');
});

test('the reporting interval comes from the station, not from a number somebody picked', () => {
  assert.equal(parseRealtime2(LMFS1).intervalMin, 10);
  assert.equal(parseRealtime2(NIQS1).intervalMin, 15);
});

test('stale is three missed reports on the station\'s own clock', () => {
  const fresh = shapeMet(parseRealtime2(LMFS1), { feed_id: 'LMFS1' }, AT_2300);
  assert.equal(fresh.age_minutes, 15);
  assert.equal(fresh.interval_min, 10);
  assert.equal(fresh.stale, false);            // 15 min against a 10 min clock
  const late = shapeMet(parseRealtime2(LMFS1), { feed_id: 'LMFS1' },
                        Date.parse('2026-08-26T00:00:00Z'));
  assert.equal(late.stale, true);              // 70 min against a 10 min clock
});

test('one row means no interval, and no interval means no claim about staleness', () => {
  const one = LMFS1.split('\n').slice(0, 3).join('\n');
  const p = parseRealtime2(one);
  assert.equal(p.intervalMin, null);
  assert.equal(shapeMet(p, { feed_id: 'LMFS1' }, AT_2300).stale, null);
});

test('a truncated row is refused rather than zipped into the wrong columns', () => {
  // Drop two fields off the newest row. Zipping it against the header would slide DEWP into
  // WTMP and put an air-dewpoint into the water temperature field.
  const bad = LMFS1.replace('2026 08 25 22 50  80  3.6  6.2    MM    MM    MM  MM     MM  31.2    MM    MM   MM   MM    MM',
                            '2026 08 25 22 50  80  3.6  6.2    MM    MM    MM  MM     MM  31.2');
  const p = parseRealtime2(bad);
  assert.equal(p.rows.length, 1);
  assert.equal(p.latest.hh, 22);
  assert.equal(p.latest.mm, 40);               // the SECOND row, the short one having been dropped
});

test('a file with a header and no data is null, not an empty reading', () => {
  assert.equal(parseRealtime2(LMFS1.split('\n').slice(0, 2).join('\n')), null);
  assert.equal(parseRealtime2(''), null);
  assert.equal(shapeMet(null, {}), null);
});

test('the url is derived from the id, uppercase, with the right extension', () => {
  assert.equal(ndbcUrl('lmfs1', 'met'), 'https://www.ndbc.noaa.gov/data/realtime2/LMFS1.txt');
  assert.equal(ndbcUrl('niqs1', 'ocean'), 'https://www.ndbc.noaa.gov/data/realtime2/NIQS1.ocean');
});

test('met and water quality are read from the stations that publish each', async () => {
  const asked = [];
  const get = async (u) => {
    asked.push(u);
    if (u.endsWith('NIWS1.txt')) return NIWS1;
    if (u.endsWith('NIQS1.ocean')) return NIQS1;
    throw new Error('404');
  };
  const r = await ndbcReadings([
    { feed_id: 'NIQS1', water_quality: true, met: false, km_outside: 0 },
    { feed_id: 'NIWS1', met: true, water_quality: false, km_outside: 0 },
  ], get);
  assert.equal(r.met.station, 'NIWS1');
  assert.equal(r.ocean.station, 'NIQS1');
  // The ocean-only station was never asked for a met file, and vice versa.
  assert.ok(!asked.includes(ndbcUrl('NIQS1', 'met')));
});

test('a station that answers nothing does not block a further one that answers', async () => {
  const get = async (u) => {
    if (u.endsWith('DEAD1.txt')) throw new Error('502');
    if (u.endsWith('LMFS1.txt')) return LMFS1;
    throw new Error('404');
  };
  const r = await ndbcReadings([
    { feed_id: 'DEAD1', met: true, km_outside: 0.0 },
    { feed_id: 'LMFS1', met: true, km_outside: 2.0 },
  ], get);
  // Binding order is a PREFERENCE, not a result: nearest-that-answered wins.
  assert.equal(r.met.station, 'LMFS1');
});

test('no bound stations is null, not an empty shape', async () => {
  assert.equal(await ndbcReadings([], async () => ''), null);
  assert.equal(await ndbcReadings(null, async () => ''), null);
});
