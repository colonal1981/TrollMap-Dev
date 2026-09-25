/**
 * test/an-empty-reading-is-not-a-zero.test.js — "" and " " are no reading, in every copy.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * CO-OPS sends a missing reading as `"v": ""`. Charleston 8665530's water temperature for August
 * 2026 has three such rows, `{"t":"2026-08-16 22:36","v":"","f":"1,1,1"}` among them. The Worker's
 * CO-OPS/NWPS `num` in conditions.js did `Number(v)` on a string, and Number('') is 0, so with
 * `date=latest` a blank row was the whole answer and the card read 0 °F. structure-markers.js had
 * the same shape. The dead-code sweep of 2026-09-25 found both.
 *
 * Each copy is reached through a function it feeds, not by reading its source, so this holds for
 * whatever the copy becomes. The table is the full before/after for the inputs the fix was asked
 * about; the only rows that changed are '' and ' ' in conditions.js and structure-markers.js.
 *
 *   input       conditions  structure-markers  worker-data  registry  num.js
 *   ''          0 -> null   0 -> null          null         null      null
 *   ' '         0 -> null   0 -> null          null         null      null
 *   null        null        0  (unchanged)     null         null      null
 *   undefined   null        null               null         null      null
 *   NaN         null        null               null         null      null
 *   '12.1'      12.1        12.1               12.1         12.1      12.1
 *   0           0           0                  0            0         0
 *   '0'         0           0                  0            0         0
 *   -999        null        -999               -999         -999      -999
 *   '-999'      null        -999               -999         -999      -999
 *
 * -999 is null only in conditions.js: -999/-9999/-99999 are NWPS's and CO-OPS's no-data codes and
 * that rule belongs to those feeds, not to a pack's depths or a lake's acreage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nwpsFloodContext } from '../Worker/conditions.js';
import { normalizeDukeRow } from '../Worker/worker-data.js';
import { identityBaseline } from '../Worker/registry.js';
import { humpsFromPack } from '../js/utils/structure-markers.js';
import { num } from '../js/utils/num.js';

// conditions.js `num`: a low-water impact's stage is carried through it with no filter.
const conditions = (v) =>
  nwpsFloodContext({ impactsLowWaters: [{ stage: v, statement: 'low' }] }, null, '01/01')
    .low_water_impacts[0].stage;
// worker-data.js numOrNull: Duke's Target column.
const workerData = (v) => normalizeDukeRow({ Actual: '98', Elevation: '100', Target: v }).target;
// registry.js identityBaseline's `n`: a lake's acreage.
const registry = (v) => identityBaseline({ slug: 'x', area_acres: v }).surfaceAreaAcres;
// structure-markers.js `num`: a hump's depth.
const structure = (v) => humpsFromPack({ features: [{
  type: 'Feature', geometry: { type: 'Point', coordinates: [-80, 34] },
  properties: { kind: 'hump', depth_ft: v },
}] })[0].depth;

const COPIES = { conditions, structure, workerData, registry, num };

const ROWS = [
  //  input       conditions structure workerData registry num
  ['',            null,      null,     null,      null,    null],
  [' ',           null,      null,     null,      null,    null],
  [null,          null,      0,        null,      null,    null],
  [undefined,     null,      null,     null,      null,    null],
  [NaN,           null,      null,     null,      null,    null],
  ['12.1',        12.1,      12.1,     12.1,      12.1,    12.1],
  [0,             0,         0,        0,         0,       0],
  ['0',           0,         0,        0,         0,       0],
  [-999,          null,      -999,     -999,      -999,    -999],
  ['-999',        null,      -999,     -999,      -999,    -999],
];

for (const [input, ...want] of ROWS) {
  test(`number-or-null, every copy, for ${JSON.stringify(input) ?? String(input)}`, () => {
    Object.entries(COPIES).forEach(([name, f], i) => {
      assert.equal(f(input), want[i], `${name}(${JSON.stringify(input) ?? String(input)})`);
    });
  });
}

test('CO-OPS and NWPS no-data codes stay null through conditions.js, as numbers and as strings', () => {
  for (const v of [-999, -9999, -99999, '-999', '-9999', '-99999']) {
    assert.equal(conditions(v), null, String(v));
  }
});
