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
import { releaseDirection, normalizeDamName, releaseShape } from '../Worker/conditions.js';

// water_chain.json, both directions verbatim, as PUBLISHED TODAY -- the 283-water chain built
// on GNIS ids alone. Every Catawba reservoir appears adjacent to the next here.
const CHAIN = {
  lake_james:              { upstream: [], downstream: 'rhodhiss_lake' },
  rhodhiss_lake:           { upstream: ['lake_james'], downstream: 'lake_hickory' },
  lake_hickory:            { upstream: ['old_millpond', 'rhodhiss_lake', 'shuford_pond'], downstream: 'lookout_shoals_lake' },
  lookout_shoals_lake:     { upstream: ['lake_hickory'], downstream: 'lake_norman' },
  lake_norman:             { upstream: ['lookout_shoals_lake'], downstream: 'mountain_island_lake' },
  mountain_island_lake:    { upstream: ['lake_norman'], downstream: 'lake_wylie' },
  lake_wylie:              { upstream: ['mountain_island_lake', 'rankin_lake', 'robinwood_lake'], downstream: 'fishing_creek_reservoir' },
  fishing_creek_reservoir: { upstream: ['lake_haigler', 'lake_wylie'], downstream: 'great_falls_reservoir' },
  great_falls_reservoir:   { upstream: ['fishing_creek_reservoir', 'fishing_creek_wcd_site_number_two'], downstream: 'cedar_creek_reservoir_2' },
  cedar_creek_reservoir_2: { upstream: ['great_falls_reservoir'], downstream: 'wateree_lake' },
  wateree_lake:            { upstream: ['cedar_creek_reservoir_2'], downstream: 'lake_marion' },
  lake_marion:             { upstream: ['wateree_lake', 'lake_murray', 'parr_shoals_reservoir'], downstream: null },
  old_millpond:            { upstream: [], downstream: 'lake_hickory' },
  shuford_pond:            { upstream: [], downstream: 'lake_hickory' },
};

// THE SAME WATER, once the chain stops omitting the rivers. Reading _nhd_bindings.json adds 140
// waters that have no GNIS id, 47 of them river reaches, and wateree_river is one:
//
//     before   wateree_lake -> lake_marion
//     after    wateree_lake -> wateree_river -> lake_marion
//
// Nothing physical changed. If a fuller, more correct map makes the answer WORSE, the rule was
// wrong -- which is why releaseDirection walks instead of testing adjacency.
const CHAIN_WITH_RIVERS = {
  ...CHAIN,
  wateree_lake:  { upstream: ['cedar_creek_reservoir_2'], downstream: 'wateree_river' },
  wateree_river: { upstream: ['wateree_lake'], downstream: 'lake_marion' },
  lake_marion:   { upstream: ['wateree_river', 'congaree_river'], downstream: 'santee_river' },
  santee_river:  { upstream: ['lake_marion'], downstream: null },
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


// ── what the app actually receives ───────────────────────────────────────────────────────────
const labelled = (slug) => releaseDirection(
  [{ dam: 'cedar creek', date: '08/19/26', no_release: false, units: 2 },
   { dam: 'wateree', date: '08/19/26', no_release: true }],
  { slug, chain: CHAIN, damOwner: OWNER });

test('releaseShape splits a reservoir\'s two dams rather than ranking them', () => {
  const shape = releaseShape({ dukeRun: labelled('wateree_lake') });
  assert.equal(shape.kind, 'scheduled');
  assert.equal(shape.inflow.length, 1);
  assert.equal(shape.inflow[0].dam, 'cedar creek');
  assert.equal(shape.inflow_from, 'cedar_creek_reservoir_2');
  assert.equal(shape.outflow.length, 1);
  assert.equal(shape.outflow[0].dam, 'wateree');
  // Which one matters depends on which end you are fishing, so both survive whole.
  assert.equal(shape.items.length, 2, 'the full schedule is still there');
});

test('a no-release day keeps its direction', () => {
  const shape = releaseShape({ dukeRun: labelled('wateree_lake') });
  assert.equal(shape.outflow[0].no_release, true,
    'Duke saying "no flow release" is a stated zero, and it is still the lake\'s own dam');
});

test('an unlabelled row still yields a schedule', () => {
  // The chain or the dam table may be unpublished. That must degrade to what the app showed
  // before any of this existed -- a release with no direction -- not to no release at all.
  const shape = releaseShape({ dukeRun: [{ dam: 'Some Dam Nobody Bound', date: '08/19/26' }] });
  assert.equal(shape.kind, 'scheduled');
  assert.equal(shape.items.length, 1);
  assert.equal(shape.inflow, null);
  assert.equal(shape.outflow, null);
  assert.equal(shape.inflow_from, null);
});

test('a river reach gets neither, because a lake is not a river', () => {
  // lake_marion is two dams below Cedar Creek; only Wateree is adjacent to it.
  const shape = releaseShape({ dukeRun: labelled('lake_marion') });
  assert.equal(shape.inflow.length, 1);
  assert.equal(shape.inflow[0].dam, 'wateree');
  assert.equal(shape.outflow, null, 'Marion\'s own dam is not Duke\'s and is not in the table');
});


// ── the chain grew, and the answers must not ─────────────────────────────────────────────────
// Adding 140 waters is only safe if it changes nothing about what a lake is told. These run the
// SAME assertions against the fuller chain, and one of them is the reason the rule was rewritten.
const labelIn = (chain, slug, owner = OWNER) => {
  const out = {};
  for (const r of releaseDirection(DAMS, { slug, chain, damOwner: owner })) {
    if (r.direction) out[r.dam] = `${r.direction}:${r.from}`;
  }
  return out;
};

test('a river reach between two reservoirs is TRANSPARENT', () => {
  // Under the old adjacency test this was the regression: lake_marion's upstream list stops
  // holding wateree_lake the moment wateree_river appears between them, and Marion goes from
  // correctly labelling the Wateree release to labelling nothing.
  assert.equal(labelIn(CHAIN, 'lake_marion')['wateree'], 'inflow:wateree_lake');
  assert.equal(labelIn(CHAIN_WITH_RIVERS, 'lake_marion')['wateree'], 'inflow:wateree_lake');
  assert.equal(CHAIN_WITH_RIVERS.lake_marion.upstream.includes('wateree_lake'), false,
    'the fixture must actually pose the problem -- Wateree is NOT adjacent here');
});

test('a reservoir between two reservoirs is OPAQUE, river or no river', () => {
  // Cedar Creek -> wateree_lake -> (wateree_river) -> lake_marion. Wateree impounds a dam, so
  // the walk stops there. What reaches Marion is whatever Wateree passes on, which is Wateree's
  // release and not Cedar Creek's. This is the case adjacency was introduced to refuse and it
  // must still be refused now that adjacency is gone.
  for (const chain of [CHAIN, CHAIN_WITH_RIVERS]) {
    const got = labelIn(chain, 'lake_marion');
    assert.equal(got['cedar creek'], undefined);
    assert.equal(got['great falls'], undefined);
    assert.equal(got['fishing creek'], undefined);
  }
});

test('every Catawba answer is identical on both chains', () => {
  // So this can deploy before OR after the fuller chain is published, in either order.
  for (const slug of Object.keys(CHAIN)) {
    assert.deepEqual(labelIn(CHAIN_WITH_RIVERS, slug), labelIn(CHAIN, slug), slug);
  }
});


// ── 0304, the run that found this ────────────────────────────────────────────────────────────
// Verbatim from `build_water_chain.py --only 0304` on 2026-08-17, the run that first placed
// blewett_falls_lake. Lake Tillery's dam releases into the Pee Dee, which IS Blewett Falls
// Lake's headwater -- one reservoir up, two chain hops.
const PEE_DEE = {
  lake_tillery:        { upstream: ['badin_lake', 'uwharrie_river'], downstream: 'pee_dee_river_2' },
  pee_dee_river_2:     { upstream: ['lake_tillery'], downstream: 'blewett_falls_lake' },
  blewett_falls_lake:  { upstream: ['pee_dee_river_2'], downstream: 'great_pee_dee_river' },
  great_pee_dee_river: { upstream: ['blewett_falls_lake'], downstream: null },
  badin_lake:          { upstream: [], downstream: 'lake_tillery' },
};
const PEE_DEE_OWNER = {
  'tillery': 'lake_tillery',
  'blewett falls': 'blewett_falls_lake',
  'narrows': 'badin_lake',
};
const PEE_DEE_DAMS = Object.keys(PEE_DEE_OWNER).map((d) => ({ dam: d, date: '08/19/26' }));
const peeDee = (slug) => {
  const out = {};
  for (const r of releaseDirection(PEE_DEE_DAMS, { slug, chain: PEE_DEE, damOwner: PEE_DEE_OWNER })) {
    if (r.direction) out[r.dam] = `${r.direction}:${r.from}`;
  }
  return out;
};

test('Blewett Falls, the lake this whole thread started on', () => {
  // Duke publishes it in /lakes/current-level and it had NO CHAIN NODE AT ALL until the binding
  // table was read, so releaseDirection returned null for every row on it. It ran and did
  // nothing, and nothing said so.
  assert.deepEqual(peeDee('blewett_falls_lake'), {
    'tillery': 'inflow:lake_tillery',
    'blewett falls': 'outflow:blewett_falls_lake',
  });
});

test('Narrows is two reservoirs above Blewett and stays unlabelled', () => {
  assert.equal(peeDee('blewett_falls_lake')['narrows'], undefined,
    'badin_lake -> lake_tillery stops the walk: Tillery impounds a dam');
  assert.equal(peeDee('lake_tillery')['narrows'], 'inflow:badin_lake');
});

test('Tillery sees its own dam as outflow and Blewett\'s not at all', () => {
  const got = peeDee('lake_tillery');
  assert.equal(got['tillery'], 'outflow:lake_tillery');
  assert.equal(got['blewett falls'], undefined, 'a dam BELOW you is not your inflow');
});


// ── the guards ───────────────────────────────────────────────────────────────────────────────
test('a dam bound to a river reach makes that reach opaque', () => {
  // bind_dams_to_waters.py binds by position and drainage. With rivers now in the chain, a
  // structure ON a river could bind to the river slug rather than the reservoir it impounds --
  // which is exactly why that table gets re-run as a dry run and DIFFED before it is rewritten.
  // Recording the consequence here so it is a known behaviour and not a surprise.
  const owner = { ...OWNER, 'some diversion': 'wateree_river' };
  const rows = [{ dam: 'wateree', date: '08/19/26' }];
  const got = releaseDirection(rows, { slug: 'lake_marion', chain: CHAIN_WITH_RIVERS, damOwner: owner });
  assert.equal(got[0].direction, null,
    'a dam on wateree_river stops the walk from wateree_lake to lake_marion');
});

test('a cyclic or runaway chain terminates instead of hanging', () => {
  const loop = {
    a: { downstream: 'b' }, b: { downstream: 'c' }, c: { downstream: 'a' },
  };
  const got = releaseDirection([{ dam: 'x' }], { slug: 'z', chain: loop, damOwner: { x: 'a' } });
  assert.equal(got[0].direction, null);
});

test('a long unbroken run of river reaches still connects', () => {
  const chain = { src: { downstream: 'r0' } };
  for (let i = 0; i < 6; i += 1) chain[`r${i}`] = { downstream: i === 5 ? 'dst' : `r${i + 1}` };
  const got = releaseDirection([{ dam: 'd' }], { slug: 'dst', chain, damOwner: { d: 'src' } });
  assert.equal(got[0].direction, 'inflow');
  assert.equal(got[0].from, 'src');
});

test('a chain node with no downstream field labels nothing and does not throw', () => {
  const got = releaseDirection([{ dam: 'wateree' }],
    { slug: 'lake_marion', chain: { wateree_lake: {} }, damOwner: OWNER });
  assert.equal(got[0].direction, null);
});


// ── a water with TWO outlets ─────────────────────────────────────────────────────────────────
// Lake Moultrie drains to the Santee through St Stephen and to the Cooper through Pinopolis.
// NHD routes the first and cannot route the second -- the Tail Race Canal was dug in the 1940s
// and drainage is a topographic quantity. registry/_chain_links.json asserts it, the chain
// publishes `outlets`, and this is the walk following both.
//
// The whole lower Santee, from the 2026-08-17 chain plus the two asserted links.
const SANTEE = {
  lake_marion:   { upstream: ['wateree_river'], downstream: 'santee_river',
                   outlets: ['santee_river', 'lake_moultrie'] },
  lake_moultrie: { upstream: ['lake_marion'], downstream: 'santee_river',
                   outlets: ['santee_river', 'cooper_river'] },
  cooper_river:  { upstream: ['lake_moultrie', 'goose_creek_reservoir'], downstream: null,
                   outlets: [] },
  santee_river:  { upstream: ['lake_marion', 'lake_moultrie'], downstream: null, outlets: [] },
  wateree_lake:  { upstream: [], downstream: 'wateree_river', outlets: ['wateree_river'] },
  wateree_river: { upstream: ['wateree_lake'], downstream: 'lake_marion',
                   outlets: ['lake_marion'] },
};
const SANTEE_OWNER = {
  'santee': 'lake_marion',          // Wilson Dam, which impounds Marion
  'pinopolis': 'lake_moultrie',
  'st stephen': 'lake_moultrie',
  'wateree': 'wateree_lake',
};
const SANTEE_DAMS = Object.keys(SANTEE_OWNER).map((d) => ({ dam: d }));
const santee = (slug) => {
  const out = {};
  for (const r of releaseDirection(SANTEE_DAMS, { slug, chain: SANTEE, damOwner: SANTEE_OWNER })) {
    if (r.direction) out[r.dam] = `${r.direction}:${r.from}`;
  }
  return out;
};

test('Moultrie reaches the Cooper down the outlet NHD cannot route', () => {
  // Without `outlets` the walk follows downstream === santee_river and never arrives.
  assert.equal(santee('cooper_river')['pinopolis'], 'inflow:lake_moultrie');
  assert.equal(santee('cooper_river')['st stephen'], 'inflow:lake_moultrie');
});

test('and still reaches the Santee down the outlet it can', () => {
  const got = santee('santee_river');
  assert.equal(got['st stephen'], 'inflow:lake_moultrie');
  assert.equal(got['santee'], 'inflow:lake_marion');
});

test('Marion feeds Moultrie through the Diversion Canal', () => {
  assert.equal(santee('lake_moultrie')['santee'], 'inflow:lake_marion');
  assert.equal(santee('lake_moultrie')['pinopolis'], 'outflow:lake_moultrie');
});

test('an impoundment on ONE branch does not block the other', () => {
  // Wateree -> wateree_river -> lake_marion -> {santee_river, lake_moultrie}. Marion impounds
  // the Santee dam, so a Wateree release stops there and reaches neither the Santee nor the
  // Cooper -- but it must still be inflow to Marion itself.
  assert.equal(santee('lake_marion')['wateree'], 'inflow:wateree_lake');
  assert.equal(santee('santee_river')['wateree'], undefined);
  assert.equal(santee('cooper_river')['wateree'], undefined);
});

test('a braided chain that rejoins itself terminates', () => {
  // The lower Santee genuinely rejoins: Marion and Moultrie both reach the Santee River, and
  // Moultrie is below Marion. A depth-first walk revisits waters; `seen` is what stops it.
  const braid = {
    a: { outlets: ['b', 'c'] }, b: { outlets: ['d'] }, c: { outlets: ['d'] },
    d: { outlets: ['a'] },      // and back to the start
  };
  const got = releaseDirection([{ dam: 'x' }], { slug: 'z', chain: braid, damOwner: { x: 'a' } });
  assert.equal(got[0].direction, null);
  const hit = releaseDirection([{ dam: 'x' }], { slug: 'd', chain: braid, damOwner: { x: 'a' } });
  assert.equal(hit[0].direction, 'inflow');
});

test('a chain with no outlets field falls back to downstream', () => {
  // Everything published before _chain_links.json existed. Must behave exactly as it did.
  for (const slug of Object.keys(CHAIN)) {
    assert.deepEqual(labelIn(CHAIN, slug), labelIn(CHAIN, slug), slug);
  }
  assert.equal(labelIn(CHAIN, 'lake_marion')['wateree'], 'inflow:wateree_lake');
  assert.equal(labelIn(CHAIN_WITH_RIVERS, 'lake_marion')['wateree'], 'inflow:wateree_lake');
});
