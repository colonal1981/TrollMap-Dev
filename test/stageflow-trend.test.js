// Which way the water has been going.
//
// Verified against CMDS1, CFMS1 and WATS1 on 2026-08-16: /nwps/v1/gauges/{lid}/stageflow returns
// roughly a month of observations, carries its own primaryName/primaryUnits, and puts -999 in
// `secondary` on every point at two of the three gauges. That sentinel is the same shape as
// USGS's -999999 and reporting it would print a flow of minus nine hundred and ninety-nine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageflowTrend } from '../Worker/conditions.js';

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-08-16T18:00:00Z');

/** `hours` back from NOW, one point per hour, level rising by `perHour`. */
const series = (hours, start, perHour, extra = {}) => ({
  observed: {
    primaryName: 'Pool Elevation', primaryUnits: 'ft',
    secondaryName: 'Flow', secondaryUnits: 'kcfs',
    data: Array.from({ length: hours + 1 }, (_, i) => ({
      validTime: new Date(NOW - (hours - i) * HOUR).toISOString(),
      generatedTime: new Date(NOW - (hours - i) * HOUR).toISOString(),
      primary: Math.round((start + perHour * i) * 100) / 100,
      secondary: -999,
      ...extra,
    })),
  },
});

test('a falling lake reads as falling, over both windows', () => {
  const t = stageflowTrend(series(24 * 10, 225.5, -0.01), NOW);
  assert.equal(t.units, 'ft');
  assert.equal(t.measures, 'Pool Elevation');
  assert.equal(t.change_24h, -0.24);
  assert.equal(t.change_7d, -1.68);
  assert.equal(t.latest, 223.1);
});

test('a series that does not reach back far enough returns null, not an extrapolation', () => {
  // Six hours of data cannot answer a 24 h question. Inventing one is how a trend becomes a lie.
  const t = stageflowTrend(series(6, 100, 0.1), NOW);
  assert.equal(t.change_24h, null);
  assert.equal(t.change_7d, null);
  assert.equal(t.latest, 100.6);
  assert.equal(t.covers_hours, 6);
});

test('-999 in the PRIMARY value is dropped, not averaged in', () => {
  const j = series(48, 10, 0);
  j.observed.data[20].primary = -999;
  j.observed.data[21].primary = -999999;
  const t = stageflowTrend(j, NOW);
  assert.equal(t.points, 47, 'both sentinels dropped');
  assert.equal(t.latest, 10);
});

test('a steady lake is zero change, which is an answer and not a gap', () => {
  const t = stageflowTrend(series(24 * 8, 660, 0), NOW);
  assert.equal(t.change_24h, 0);
  assert.equal(t.change_7d, 0);
});

test('fewer than two usable points is null rather than a trend of one', () => {
  assert.equal(stageflowTrend({ observed: { data: [] } }, NOW), null);
  assert.equal(stageflowTrend({ observed: { data: [{ validTime: 'x', primary: 1 }] } }, NOW), null);
  assert.equal(stageflowTrend(null, NOW), null);
  assert.equal(stageflowTrend({}, NOW), null);
});

test('an out-of-order series is sorted before it is read', () => {
  const j = series(24 * 3, 50, 0.05);
  j.observed.data.reverse();
  const t = stageflowTrend(j, NOW);
  assert.equal(t.change_24h, 1.2);
});

test('units are read off the payload, never assumed', () => {
  const j = series(24 * 2, 3, 0.02);
  j.observed.primaryUnits = 'kcfs';
  j.observed.primaryName = 'Flow';
  const t = stageflowTrend(j, NOW);
  assert.equal(t.units, 'kcfs');
  assert.equal(t.measures, 'Flow');
});
