// The barometer, and the eleven-day-old reading that made the staleness guard necessary.
//
// Verified on 2026-08-16: Wilmington 8658120 answered `product=air_pressure&range=24` with 240
// entries six minutes apart, latest "2026-08-16 17:30". Charleston 8665530 answered
// `date=latest` with "2026-08-05 14:36" — ELEVEN DAYS OLD, no error, no flag. `date=latest`
// means the latest that exists, not the latest that is current.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pressureTrend } from '../Worker/conditions.js';

const MIN = 60 * 1000;
const NOW = Date.parse('2026-08-16T17:36:00Z');
const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

/** `n` readings six minutes apart ending at `endMs`, changing by `perReading`. */
const series = (n, end, start, perReading) => ({
  metadata: { id: '8658120', name: 'Wilmington' },
  data: Array.from({ length: n }, (_, i) => ({
    t: stamp(end - (n - 1 - i) * 6 * MIN),
    v: (start + perReading * i).toFixed(1),
    f: '0,0,0',
  })),
});

test('a falling barometer reads as falling over three, six and twenty-four hours', () => {
  // 251 readings six minutes apart = 25.0 hours, dropping 0.02 mb each.
  const p = pressureTrend(series(251, NOW, 1023, -0.02), NOW);
  assert.equal(p.mb, 1018);
  assert.equal(p.change_3h, -0.6);
  assert.equal(p.change_6h, -1.2);
  assert.equal(p.change_24h, -4.8);
  assert.equal(p.stale, false);
  assert.equal(p.units, 'mb');
  assert.equal(p.station_id, '8658120');
});

test('a series 6 minutes short of 24 hours refuses the 24 hour window', () => {
  // THE REAL SHAPE OF THE FEED, and it caught this test before it caught anything else.
  // `range=24` returned 240 entries at Wilmington, which is 239 six-minute gaps = 23.9 hours.
  // The window is refused rather than answered from 23.9 hours of data and called a day.
  const p = pressureTrend(series(240, NOW, 1023, -0.02), NOW);
  assert.equal(p.change_24h, null);
  assert.equal(p.change_6h, -1.2, 'the windows it CAN answer are unaffected');
});

test('an eleven-day-old reading is flagged stale — the Charleston case', () => {
  const old = NOW - 11 * 24 * 60 * MIN;
  const p = pressureTrend(series(2, old, 1021.3, 0), NOW);
  assert.equal(p.stale, true);
  assert.ok(p.age_minutes > 11 * 24 * 60 - 60);
  // The value is still reported. A caller that wants to ignore it can; one never told cannot.
  assert.equal(p.mb, 1021.3);
});

test('a fresh reading inside the age limit is not stale', () => {
  const p = pressureTrend(series(30, NOW - 20 * MIN, 1015, 0), NOW);
  assert.equal(p.stale, false);
  assert.equal(p.age_minutes, 20);
});

test('a window the series cannot reach is null, not an extrapolation', () => {
  // One hour of data. Six-minute spacing, 11 readings.
  const p = pressureTrend(series(11, NOW, 1010, 0.1), NOW);
  assert.equal(p.change_3h, null);
  assert.equal(p.change_24h, null);
  assert.equal(p.mb, 1011);
});

test('station local timestamps cancel out of a difference and are never a wall clock', () => {
  // CO-OPS returns "2026-08-16 17:30" with no offset. Both the age and the trend are
  // differences between two of these, so a constant offset cancels from both.
  const a = pressureTrend(series(60, NOW, 1000, 0.05), NOW);
  const b = pressureTrend(series(60, NOW + 5 * 3600 * 1000, 1000, 0.05), NOW + 5 * 3600 * 1000);
  assert.equal(a.change_3h, b.change_3h);
  assert.equal(a.age_minutes, b.age_minutes);
});

test('an empty or error payload is null rather than a barometer of zero', () => {
  assert.equal(pressureTrend({ data: [] }, NOW), null);
  assert.equal(pressureTrend({ error: { message: 'No data was found.' } }, NOW), null);
  assert.equal(pressureTrend(null, NOW), null);
});

test('unparseable rows are skipped without taking the series with them', () => {
  const j = series(40, NOW, 1005, 0.1);
  j.data[5].v = '';
  j.data[6].t = 'not a time';
  const p = pressureTrend(j, NOW);
  assert.ok(p && Number.isFinite(p.mb));
});
