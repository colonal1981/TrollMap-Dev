// Inflow or outflow: which side of a lake a Duke release comes from.
//
// RYAN, 2026-08-17, correcting the model this file implements: "for wateree if fishing north end
// then cedar creek dam release would flow down into the lake ... for the south end water leaving
// the wateree dam may cause a slight current but probably not noticeable".
//
// FIXTURES ARE REAL. The chain rows are from registry/water_chain.json, derived from NHDPlus HR
// on 2026-08-17; the dam names are Duke's own from /rivers/active-run; the gauge names are the
// ones bound to each water in registry/water_bindings.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseDirection, normalizeDamName } from '../Worker/conditions.js';

// water_chain.json, upstream lists verbatim.
const CHAIN = {
  lake_james:              { upstream: [] },
  rhodhiss_lake:           { upstream: ['lake_james'] },
  lake_hickory:            { upstream: ['old_millpond', 'rhodhiss_lake', 'shuford_pond'] },
  lookout_shoals_lake:     { upstream: ['lake_hickory'] },
  lake_norman:             { upstream: ['lookout_shoals_lake'] },
  mountain_island_lake:    { upstream: ['lake_norman'] },
  lake_wylie:              { upstream: ['mountain_island_lake', 'rankin_lake', 'robinwood_lake'] },
  fishing_creek_reservoir: { upstream: ['lake_haigler', 'lake_wylie'] },
  great_falls_reservoir:   { upstream: ['fishing_creek_reservoir', 'fishing_creek_wcd_site_number_two'] },
  cedar_creek_reservoir_2: { upstream: ['great_falls_reservoir'] },
  wateree_lake:            { upstream: ['cedar_creek_reservoir_2'] },
  lake_marion:             { upstream: ['wateree_lake', 'lake_murray', 'parr_shoals_reservoir'] },
};

// Duke's dam name -> the slug it impounds. NONE of Bridgewater, Oxford or Cowans Ford appears in
// its lake's own name, which is why this is a table and not a comparison.
const OWNER = {
  'bridgewater':   'lake_james',
  'rhodhiss':      'rhodhiss_lake',
  'oxford':        'lake_hickory',
  'lookout shoals': 'lookout_shoals_lake',
  'cowans ford':   'lake_norman',
  'mountain island': 'mountain_island_lake',
  'wylie':         'lake_wylie',
  'fishing creek': 'fishing_creek_reservoir',
  'great falls':   'great_falls_reservoir',
  'cedar creek':   'cedar_creek_reservoir_2',
  'wateree':       'wateree_lake',
};
const DAMS = Object.keys(OWNER).map((d) => ({ dam: d, date: '08/19/26' }));
const label = (slug) => {
  const out = {};
  for (const r of releaseDirection(DAMS, { slug, chain: CHAIN, damOwner: OWNER })) {
    if (r.direction) out[r.dam] = `${r.direction}:${r.from}`;
  }
  return out;
};

test('a lake sees exactly two dams: the one above it and its own', () => {
  assert.deepEqual(label('wateree_lake'), {
    'cedar creek': 'inflow:cedar_creek_reservoir_2',
    'wateree': 'outflow:wateree_lake',
  });
  assert.deepEqual(label('lake_norman'), {
    'lookout shoals': 'inflow:lookout_shoals_lake',
    'cowans ford': 'outflow:lake_norman',
  });
});

test('the dam name need not resemble the lake name', () => {
  // Oxford impounds Lake Hickory; Bridgewater impounds Lake James; Cowans Ford impounds Norman.
  assert.equal(label('lake_hickory')['oxford'], 'outflow:lake_hickory');
  assert.equal(label('lake_hickory')['rhodhiss'], 'inflow:rhodhiss_lake');
  assert.equal(label('lake_james')['bridgewater'], 'outflow:lake_james');
});

test('the top of a chain has no inflow dam', () => {
  const got = label('lake_james');
  assert.deepEqual(got, { 'bridgewater': 'outflow:lake_james' });
});

test('a dam two lakes upstream is NOT credited to the neighbour', () => {
  // Cedar Creek's dam appears in wateree_lake's own gauge list, so a token comparison called it
  // "inflow from wateree_lake" for Lake Marion. It is two dams above Marion and adjacent to
  // nothing there, so it must be left unlabelled.
  const got = label('lake_marion');
  assert.equal(got['wateree'], 'inflow:wateree_lake');
  assert.equal(got['cedar creek'], undefined);
  assert.equal(got['great falls'], undefined);
});

test('an upstream water with no powerhouse contributes nothing', () => {
  // lake_hickory's upstream list holds old_millpond and shuford_pond.
  const got = label('lake_hickory');
  assert.equal(Object.keys(got).length, 2);
});

test('a water absent from the chain labels nothing, and does not throw', () => {
  assert.deepEqual(label('a_lake_not_in_the_chain'), {});
  assert.deepEqual(releaseDirection(DAMS, {}), DAMS.map((r) => ({ ...r, direction: null, from: null })));
  assert.deepEqual(releaseDirection(null, { slug: 'wateree_lake', chain: CHAIN, damOwner: OWNER }), []);
});

test('rows are copied, never mutated, and every field survives', () => {
  const rows = [{ dam: 'Wateree', date: '08/19/26', no_release: true, units: 2 }];
  const out = releaseDirection(rows, { slug: 'wateree_lake', chain: CHAIN, damOwner: OWNER });
  assert.equal(rows[0].direction, undefined, 'input untouched');
  assert.equal(out[0].no_release, true);
  assert.equal(out[0].units, 2);
  assert.equal(out[0].direction, 'outflow');
});

test('one spelling for a dam, so the table and the payload meet', () => {
  assert.equal(normalizeDamName('CEDAR CREEK DAM'), 'cedar creek');
  assert.equal(normalizeDamName('Cedar Creek'), 'cedar creek');
  assert.equal(normalizeDamName('Cowans Ford Dam'), 'cowans ford');
  assert.equal(normalizeDamName('Lake Wateree Dam'), 'wateree');
  assert.equal(normalizeDamName('Great&nbsp;Falls'), 'great falls');
  assert.equal(normalizeDamName(''), null);
  assert.equal(normalizeDamName(null), null);
  assert.equal(normalizeDamName('Dam'), null, 'a name that is only noise is not a name');
});

test('Duke spellings all resolve through the table', () => {
  for (const d of Object.keys(OWNER)) {
    assert.ok(OWNER[normalizeDamName(d)], `${d} must normalise onto its own key`);
  }
});
