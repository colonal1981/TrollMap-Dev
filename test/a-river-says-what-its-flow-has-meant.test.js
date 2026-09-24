// Personal use only, not for distribution or resale; not for navigation.
//
// A RIVER SAYS WHAT ITS FLOW HAS MEANT FOR ITS WATER.
//
// The card already said where today's flow sits in the river's own history -- "between the 75th
// and 90th percentile", USGS's daily statistics. It could not say what that meant. Measured
// 2026-09-24 on 34 rivers: turbidity rises with flow against its normal, the median reading at the
// 35th percentile of its river's turbidity in the lowest quarter of flow and the 78th in the top
// tenth. Ryan approved showing the river's own readings beside the flow line -- not a formula.
//
//   node --test test/a-river-says-what-its-flow-has-meant.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clarityAtFlow } from '../Worker/conditions.js';
import { readConditions, flowClaritySentence } from '../js/utils/water-conditions.js';
import { GENERIC_LAKE_ZONES, GENERIC_RIVER_ZONES } from '../Worker/clarity-sensitivity.js';

// The shape build_river_clarity_by_flow.py writes, with the Broad's own numbers from 2026-09-24.
const TABLE = {
  built: '2026-09-24',
  normal_bands: ['between the 25th and 50th percentile', 'between the 50th and 75th percentile'],
  waters: { broad_river: { stations_on: 12, readings: 898, since: '2015-01-01', sites: { '02153200': {
    bands: {
      'above the 75th percentile': { turbidity: { median_ntu: 18.0, n: 291 } },
      'between the 50th and 75th percentile': { turbidity: { median_ntu: 10.0, n: 243 } },
      'between the 25th and 50th percentile': { turbidity: { median_ntu: 7.8, n: 204 } },
      'below the 10th percentile': { turbidity: { median_ntu: 5.1, n: 28 } },
    },
    normal: { turbidity: { median_ntu: 9.2, n: 447 } },
    readings_placed: 898,
  } } } },
};

test('high flow reads its own band and the normal beside it', () => {
  const c = clarityAtFlow(TABLE, 'broad_river', '02153200', 'above the 75th percentile');
  assert.deepEqual(c.at_this_flow, { turbidity: { median_ntu: 18.0, n: 291 } });
  assert.equal(c.band_is_normal, false);
  assert.equal(c.normal.turbidity.median_ntu, 9.2);
  assert.equal(flowClaritySentence(c),
    'At flows in this band, readings on this river have run about 18 NTU turbidity (291 readings); '
    + 'at normal flow, 9.2 NTU turbidity (447 readings).');
});

test('a normal band says so, once, instead of comparing it with itself', () => {
  const c = clarityAtFlow(TABLE, 'broad_river', '02153200', 'between the 25th and 50th percentile');
  assert.equal(c.band_is_normal, true);
  assert.equal(flowClaritySentence(c),
    "At normal flow like today's, readings on this river have run about 7.8 NTU turbidity (204 readings).");
});

test('a band no reading was ever taken in says that, and still gives the normal', () => {
  const c = clarityAtFlow(TABLE, 'broad_river', '02153200', 'between the 10th and 25th percentile');
  assert.equal(c.at_this_flow, null);
  assert.match(flowClaritySentence(c), /^No reading on this river was taken at flows in this band; at normal flow, 9\.2 NTU/);
});

test('another gauge, another river, or no table: nothing, and the flow line stands alone', () => {
  assert.equal(clarityAtFlow(TABLE, 'broad_river', '02156500', 'above the 75th percentile'), null);
  assert.equal(clarityAtFlow(TABLE, 'saluda_river', '02153200', 'above the 75th percentile'), null);
  assert.equal(clarityAtFlow(null, 'broad_river', '02153200', 'above the 75th percentile'), null);
  assert.equal(flowClaritySentence(null), null);
});

test('the app reads it off the wire, and the card and the plan print the same sentence', () => {
  const clarity = clarityAtFlow(TABLE, 'broad_river', '02153200', 'above the 75th percentile');
  const c = readConditions({ ok: true, water: { flow_vs_history: {
    label: 'above the 75th percentile', median: 1500, years: 30, clarity } } });
  assert.equal(c.flowClarity, clarity);
  assert.equal(readConditions(null).flowClarity, null);
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(src('../js/modules/conditions-strip.js'), /flowClaritySentence\(c\.flowClarity\)/);
  assert.match(src('../js/modules/plan-preflight.js'), /flowClarity: flowClaritySentence\(c\.flowClarity\)/);
  assert.match(src('../js/modules/plan-prompt.js'), /Clarity at this flow, from this river's own Water Quality Portal readings/);
});

test('a river\'s zones are its reaches, at the lake zones\' own rates', () => {
  assert.deepEqual(GENERIC_RIVER_ZONES.map((z) => z.name), ['Upper reach', 'Lower reach']);
  assert.deepEqual(GENERIC_RIVER_ZONES.map((z) => z.sensitivity), GENERIC_LAKE_ZONES.map((z) => z.sensitivity));
  assert.deepEqual(GENERIC_RIVER_ZONES.map((z) => z.base), GENERIC_LAKE_ZONES.map((z) => z.base));
});
