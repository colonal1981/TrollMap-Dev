// A catch pinned off the water it is filed under is not drawn and not planned on; two photos of one fish
// are one fish. The journal itself is not touched.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-04: "i am seeing fish on land in this area still... we need to fix this somehow", and
// asked how: "honestly if it is showing off water it should be filtered from the app... fish with either
// no position or incorrect position should not make it into the app... going forward and the way i have
// done it the last couple of times with the gpx and the catch photo this shouldn't be a problem".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hasPosition, oneFishEach, pinOffItsWater, SAME_SPOT_M } from '../js/utils/catch-pins.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('a position is two numbers, not the 0,0 an empty field parses to', () => {
  assert.equal(hasPosition({ lat: '33.5247', lon: '-80.2131' }), true);
  assert.equal(hasPosition({ lat: '', lon: '' }), false);
  assert.equal(hasPosition({ lat: 0, lon: 0 }), false);
  assert.equal(hasPosition(null), false);
});

test('two photos of one fish are one fish: same species, date and minute, within his wander', () => {
  // 2025-11-23 1:20 PM on Marion: two photos a second apart, one pin -- counted twice in the loop's depth.
  const a = { species: 'Striped Bass', date: '2025-11-23', time: '1:20 PM', lat: 33.5247222, lon: -80.2131139, length: '18.25', sourceFile: 'PXL_20251123_182020967.jpg' };
  const b = { ...a, sourceFile: 'PXL_20251123_182022080.jpg' };
  // 2025-11-25 2:13 PM hybrid: two photos 2 m apart.
  const c = { species: 'White Bass / Hybrid', date: '2025-11-25', time: '2:13 PM', lat: 33.53, lon: -80.22, sourceFile: 'x1.jpg' };
  const d = { ...c, lat: 33.53 + 2 / 110540, sourceFile: 'x2.jpg' };
  assert.deepEqual(oneFishEach([a, b, c, d]), [a, c]);
  assert.equal(SAME_SPOT_M, 25);
  // Another minute, another species, or farther than his wander: another fish.
  const later = { ...a, time: '1:21 PM' };
  const other = { ...a, species: 'White Bass / Hybrid' };
  const away = { ...a, lat: a.lat + 40 / 110540 };
  assert.equal(oneFishEach([a, later, other, away]).length, 4);
  // A second fish in one photo, as the sorter writes it, is a fish of its own.
  const two = { ...a, sourceFile: 'PXL_20251123_182020967.jpg#2' };
  assert.equal(oneFishEach([a, two]).length, 2);
  // No position or no time: nothing to match on, left as it is.
  const noPos = { species: 'Bowfin', date: '2025-10-06', time: '3:12 PM', lat: '', lon: '' };
  assert.equal(oneFishEach([noPos, { ...noPos }]).length, 2);
});

test('a pin is off its water when its lake is this water and it is on neither the chart nor inside the boundary', () => {
  const water = {
    key: 'lake_marion',
    keyOf: (name) => (/marion/i.test(name) ? 'lake_marion' : /bates|congaree/i.test(name) ? 'congaree_river' : null),
    depthAt: ([lon]) => (lon > -80.2135 ? 28 : null),        // the chart: east of -80.2135
    inside: (lon) => lon > -80.2138,                          // the boundary reaches a little farther
  };
  // 2025-11-01 2:10 PM striper on Marion, on the bank of Wyboo Creek
  assert.equal(pinOffItsWater({ lake: 'Lake Marion, SC', lat: 33.5490528, lon: -80.2139639 }, water), true);
  // on the chart
  assert.equal(pinOffItsWater({ lake: 'Lake Marion, SC', lat: 33.5247, lon: -80.2131 }, water), false);
  // off the chart but inside the boundary -- the body of Bates Old River is charted by nobody
  assert.equal(pinOffItsWater({ lake: 'Lake Marion (Clarendon Co, SC)', lat: 33.5, lon: -80.2136 }, water), false);
  // filed under another water, or a name that resolves to none: not this water's to judge
  assert.equal(pinOffItsWater({ lake: 'Bates Old River (Richland Co, SC)', lat: 33.69, lon: -80.6 }, water), false);
  assert.equal(pinOffItsWater({ lake: '', lat: 33.5, lon: -80.3 }, water), false);
  // with no chart and no boundary in hand, nothing is judged
  assert.equal(pinOffItsWater({ lake: 'Lake Marion, SC', lat: 33.5, lon: -80.3 }, { key: 'lake_marion', keyOf: water.keyOf }), false);
});

test('the map draws each fish once and leaves off a pin off the water it has loaded', () => {
  const plot = read('../js/modules/catch-plot.js');
  assert.ok(plot.includes('for (const c of oneFishEach(catches || [])) {'));
  assert.ok(plot.includes('if (pinOffItsWater(c, water)) { offWater++; continue; }'));
  // judged against the water the map has loaded, and drawn again when a new one comes in
  assert.ok(plot.includes("window.addEventListener('trollmap:waterLoaded', () => {"));
  assert.ok(plot.includes("if (isVisible('catches')) replaceLayer('catches', buildCatchLayer());"));
  const sup = read('../js/modules/supplemental-layers.js');
  assert.ok(sup.includes('export function getActiveLakeKey() { return _activeLakeKey; }'));
  assert.ok(sup.includes("window.dispatchEvent(new CustomEvent('trollmap:waterLoaded', { detail: { lakeKey } }));"));
});

test('the plans count each fish once, and the loop only the ones on the chart', () => {
  const wiring = read('../js/modules/smart-plan-v2-wiring.js');
  assert.ok(wiring.includes('catches: oneFishEach(state.CATCHES || []),'));
  const ui = read('../js/modules/plan-water-ui.js');
  assert.ok(ui.includes("const catches = oneFishEach((state.CATCHES || [])"));
  assert.ok(ui.includes('chartFt: ft != null && Number.isFinite(Number(ft)) ? Number(ft) : null'));
});

test('nothing here writes the journal', () => {
  for (const f of ['../js/utils/catch-pins.js', '../js/modules/catch-plot.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /state\.CATCHES\s*=/);
    assert.doesNotMatch(src, /setCatches|tryPut|cloud-sync/);
  }
});
