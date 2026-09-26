// A READING BELOW THE DAM IS NOT THE LAKE.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Lake Murray, the plan for 2026-09-27 from Hilton. The prompt said "Water temperature 60.4 °F —
// Saluda River below Lake Murray Dam. Dissolved oxygen 8.8 mg/L." Both came off USGS 02168504, in
// the river below the dam; Murray releases from deep in the lake and its surface was near 80. The
// card has always labelled that gauge TAILWATER and kept it out of the Water Temp field, but the
// prompt labelled only an UPSTREAM reading, and Smart Plan handed the same 60.3 to the squeeze as
// the surface -- so "SQUEEZED FROM BOTH ENDS", which fires when the surface is warmer than the
// species is recorded in and sends the spread down to the oxygen floor, stayed silent. The model
// wrote "early fall suspended fish" and ran a squarebill at 2-5 ft over 48-67 ft of water.
//
// On Wateree the same kind of gauge read 80.4 against Ryan's 77-78 on the water. Nothing in the
// app knows how deep a dam draws, so no below-dam reading stands in for a lake's surface. On a
// river reach below a dam the tailrace IS the water being fished, so none of this applies there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lakeSurfaceTemp, readConditions } from '../js/utils/water-conditions.js';
import { conditionsPromptBlock } from '../js/modules/plan-prompt.js';
import { isBelowDam } from '../Worker/conditions.js';

// The shape readConditions() gives for Murray on 2026-09-26, cut to the fields that matter.
const MURRAY = {
  featureType: 'lake', waterTempF: 60.3, waterTempFrom: 'tailwater',
  waterTempGauge: 'Saluda River below Lake Murray Dam', waterTempSite: '02168504',
  oxygenMgL: 8.6, oxygenGauge: 'Saluda River below Lake Murray Dam', oxygenBelowDam: true,
};

test('a below-dam reading on a lake is not the surface: the squeeze gets nothing, not 60.3', () => {
  const s = lakeSurfaceTemp(MURRAY, null);
  assert.equal(s.tempF, null);
  assert.equal(s.belowDamF, 60.3);
  assert.equal(s.belowDamGauge, 'Saluda River below Lake Murray Dam');
});

test('what Ryan types into Water Temp is used where the lake has no thermometer, and says so', () => {
  const s = lakeSurfaceTemp(MURRAY, 80);
  assert.equal(s.tempF, 80);
  assert.equal(s.tempFrom, 'typed');
  assert.equal(s.belowDamF, 60.3, 'the below-dam reading is still reported beside it');
});

test('a reading taken on the lake still wins over the typed value', () => {
  const s = lakeSurfaceTemp({ featureType: 'lake', waterTempF: 78.4, waterTempFrom: 'gauge' }, 80);
  assert.equal(s.tempF, 78.4);
  assert.equal(s.tempFrom, 'gauge');
  assert.equal(s.belowDamF, null);
});

test('on a river below a dam the tailrace is the water being fished, and it is used', () => {
  const s = lakeSurfaceTemp({ featureType: 'river', waterTempF: 60.3, waterTempFrom: 'tailwater' }, null);
  assert.equal(s.tempF, 60.3);
  assert.equal(s.belowDamF, null);
});

test('the prompt says the temperature was measured below the dam and is not the surface', () => {
  const block = conditionsPromptBlock(MURRAY);
  assert.match(block, /Water temperature 60\.3 °F — measured in the river BELOW THE DAM \(Saluda River below Lake Murray Dam\), not on the lake/);
  assert.match(block, /not the lake's surface temperature and it does not say what season/);
});

test('the prompt says the oxygen was measured below the dam too', () => {
  const block = conditionsPromptBlock(MURRAY);
  assert.match(block, /Dissolved oxygen 8\.6 mg\/L\. .*measured in the river BELOW THE DAM, Saluda River below Lake Murray Dam/);
});

test('on a river the tailrace reading is printed as the water it is, with no lake label', () => {
  const river = { ...MURRAY, featureType: 'river' };
  const block = conditionsPromptBlock(river);
  assert.match(block, /Water temperature 60\.3 °F — Saluda River below Lake Murray Dam\./);
  assert.doesNotMatch(block, /not on the lake/);
  assert.doesNotMatch(block, /BELOW THE DAM/);
});

test('readConditions carries whether the oxygen gauge is below the dam', () => {
  const c = readConditions({ slug: 'lake_murray', water: {
    feature_type: 'lake',
    dissolved_oxygen: { usgs_site: '02168504', name: 'Saluda River below Lake Murray Dam',
                        role: 'tailwater', below_dam: true, mg_l: 8.6 } } });
  assert.equal(c.oxygenMgL, 8.6);
  assert.equal(c.oxygenBelowDam, true);
  const d = readConditions({ slug: 'x', water: { dissolved_oxygen: { name: 'On the lake', mg_l: 7 } } });
  assert.equal(d.oxygenBelowDam, false);
});

test('USGS writes "below" as BL in a station name, and that is below the dam', () => {
  // Lake Wylie's temperature comes off this station and went out as the lake's.
  assert.equal(isBelowDam('gauge', 'CATAWBA RIVER BL LAKE WYLIE DAM FEWELL ISLAND, SC'), true);
  assert.equal(isBelowDam('gauge', 'Saluda River below Lake Murray Dam'), true);
  assert.equal(isBelowDam('gauge', 'LAKE WATEREE TAILRACE ABOVE CAMDEN, SC'), true);
  // A word that starts with BL is not the abbreviation.
  assert.equal(isBelowDam('gauge', 'BLUE RIDGE LAKE NR BLUE RIDGE, GA'), false);
  assert.equal(isBelowDam('pool', 'Lake Murray'), false);
});
