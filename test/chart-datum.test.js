// What the chart was drawn at, versus where the water is today.
//
// THE COUNTY PARENTHETICAL BROKE THIS FOR EVERY LAKE AT ONCE. The Duke lookup built its search
// name with `display_name.replace(/,.*$/, '')`, written when a display name was "Wateree Lake,
// SC". Counties landed on 2026-08-02 and it became "Wateree Lake (Kershaw Co, SC)", so the strip
// returned "Wateree Lake (Kershaw Co" and `.includes()` matched nothing. Measured live on
// 2026-08-16: `chart_datum.pending` on wateree_lake, a Duke reservoir with a hardcoded binding.
//
// Third instance of one shape today — a display name changed and a key built from it by hand
// stopped matching. The other two were RESEARCH_CANONICAL_IDS and parseLakeBaseName.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartDatumShape } from '../Worker/conditions.js';

const LAKE = { slug: 'wateree_lake', display_name: 'Wateree Lake (Kershaw Co, SC)',
               feature_type: 'lake', state: 'SC' };

// normalizeDukeRow output, Wateree on 2026-08-15: Actual 98.00 inside a 100 ft band.
const DUKE = { ft: 223.5, fullPool: 225.5, belowFullPoolFt: 2.0, duke_feed_name: 'Lake Wateree' };

test('a Duke row fills the datum and names the feed row that answered', () => {
  const out = chartDatumShape(LAKE, { duke: DUKE });
  assert.equal(out.pending, null);
  assert.equal(out.below_full_pool_ft, 2);
  assert.equal(out.full_pool_ft, 225.5);
  assert.equal(out.level_ft, 223.5);
  assert.equal(out.feed_name, 'Lake Wateree', 'a wrong match must be visible, not silent');
  assert.match(out.source, /Duke Energy/);
});

test('the operator wins over Duke — it is the dam\'s own account of its own reservoir', () => {
  const operator = { source: 'Southern Company / Georgia Power', feed_name: 'Clark Hill (Thurmond Dam)',
                     elevation_ft: 323.08, full_pond_ft: 330, below_full_pond_ft: 6.92 };
  const out = chartDatumShape(LAKE, { operator, duke: DUKE });
  assert.equal(out.below_full_pool_ft, 6.92);
  assert.equal(out.full_pool_ft, 330);
  assert.equal(out.level_ft, 323.08);
  assert.match(out.source, /Southern Company/);
});

test('an operator with a drawdown and no elevation still sets the datum', () => {
  // Chilhowee and Calderwood publish only feet-below-full-pool. The drawdown IS the datum
  // offset; the absolute elevation is not needed to state it.
  const operator = { source: 'Brookfield / safewaters.com', feed_name: 'Chilhowee',
                     elevation_ft: null, full_pond_ft: null, below_full_pond_ft: 1.18 };
  const out = chartDatumShape({ ...LAKE, slug: 'chilhowee_lake' }, { operator });
  assert.equal(out.below_full_pool_ft, 1.18);
  assert.equal(out.full_pool_ft, null);
  assert.equal(out.level_ft, null);
  assert.equal(out.pending, null, 'no elevation is not a failure to report');
});

test('an operator listed but not reading falls through to Duke rather than blanking', () => {
  const operator = { source: 'Southern Company / Georgia Power', feed_name: 'Somewhere',
                     elevation_ft: null, full_pond_ft: null, below_full_pond_ft: null,
                     reporting: false };
  const out = chartDatumShape(LAKE, { operator, duke: DUKE });
  assert.match(out.source, /Duke Energy/);
  assert.equal(out.below_full_pool_ft, 2);
});

test('nothing publishes this water — pending names both wired sources', () => {
  const out = chartDatumShape(LAKE, {});
  assert.equal(out.below_full_pool_ft, null);
  assert.match(out.pending, /Brookfield/);
  assert.match(out.pending, /Duke/);
});

test('a river or coastal zone has no full pool to be below', () => {
  const r = chartDatumShape({ ...LAKE, feature_type: 'river' }, { duke: DUKE });
  assert.match(r.pending, /not a lake/);
  assert.equal(r.below_full_pool_ft, null, 'a Duke row must not fill a river');
  const c = chartDatumShape({ ...LAKE, feature_type: 'coastal' }, { duke: DUKE });
  assert.match(c.pending, /not a lake/);
});

test('the datum is REPORTED and never APPLIED', () => {
  for (const src of [{ duke: DUKE }, {}]) {
    assert.equal(chartDatumShape(LAKE, src).applied, false);
    assert.equal(chartDatumShape(LAKE, src).charted_at, 'full_pool');
  }
});

test('a partial Duke row is not half a datum', () => {
  // fullPool missing means the band cannot be interpreted, so there is no offset to state.
  const out = chartDatumShape(LAKE, { duke: { ft: 223.5, fullPool: null, belowFullPoolFt: 2 } });
  assert.equal(out.below_full_pool_ft, null);
  assert.ok(out.pending);
});

test('a binding with no display name says so rather than matching everything', () => {
  const out = chartDatumShape({ slug: 'x', feature_type: 'lake', display_name: '  ' }, { duke: DUKE });
  assert.match(out.pending, /no display name/);
  assert.equal(out.below_full_pool_ft, null);
});

// ── release schedules: one shape, three operators that mean different things ─────────────────
import { releaseShape, dukeBasinFor, splitCamel, gaugeRiverPart, waterBasinEvidence }
  from '../Worker/conditions.js';

// Duke's own /rivers/get-rivers, verbatim, pasted by Ryan on 2026-08-17. Seven basins, against
// the two ids that were hand-typed into RIVERS.
const DUKE_RIVERS = [
  { RiverId: 1,  RiverName: 'Catawba',        riverDescription: 'Catawba - Wateree' },
  { RiverId: 2,  RiverName: 'Nantahala',      riverDescription: 'Nantahala/Tuckasegee Area' },
  { RiverId: 3,  RiverName: 'Yadkin',         riverDescription: 'Yadkin-Pee Dee' },
  { RiverId: 10, RiverName: 'BroadRiver',     riverDescription: 'Broad River Basin' },
  { RiverId: 6,  RiverName: 'Keowee Toxaway', riverDescription: 'Keowee - Toxaway' },
  { RiverId: 11, RiverName: 'PigeonRiver',    riverDescription: 'Pigeon River' },
  { RiverId: 4,  RiverName: 'Others',         riverDescription: 'Other Lakes and Rivers' },
];

test('a Duke arrival is a PROJECTION and says so', () => {
  const r = releaseShape({ duke: { basinName: 'Catawba-Wateree', lastUpdated: 'x',
    source: 'u', arrivals: [{ damName: 'Wateree', mileMarkerName: 'Hwy 601', arrival: 'a' },
                            { damName: 'Wateree', mileMarkerName: 'Sparkleberry', arrival: 'b' }] } });
  assert.equal(r.kind, 'projected');
  assert.equal(r.operator, 'Duke Energy');
  assert.equal(r.next.mileMarkerName, 'Hwy 601');
  assert.equal(r.items.length, 2);
});

test('a Brookfield discharge is OBSERVED and must never read as a forecast', () => {
  // safewaters publishes what is going through the turbines right now. Calling that a schedule
  // is how a person launches into a surge that already passed.
  const r = releaseShape({ operator: { source: 'Brookfield / safewaters.com', url: 'u',
    observed_at: 't', discharges: [{ cfs: 9448.5, into: 'Little Tennessee River' }] } });
  assert.equal(r.kind, 'observed');
  assert.equal(r.next, null, 'an observation has no "next"');
  assert.equal(r.items[0].cfs, 9448.5);
});

test('TVA generation is scheduled, and Duke outranks it when both exist', () => {
  const tva = { generation: [{ generators: 2 }], observed_at: 'now', source: 'TVA — tva.com/RestApi' };
  assert.equal(releaseShape({ tva }).kind, 'scheduled');
  assert.equal(releaseShape({ tva }).operator, 'TVA');
  const both = releaseShape({ duke: { arrivals: [{ damName: 'D' }] }, tva });
  assert.equal(both.operator, 'Duke Energy', 'a projection beats a current reading');
});

test('nothing publishing a release is null, not an empty schedule', () => {
  assert.equal(releaseShape({}), null);
  assert.equal(releaseShape({ duke: { arrivals: [] }, tva: { generation: [] } }), null);
  assert.equal(releaseShape({ operator: { discharges: [] } }), null);
  assert.equal(releaseShape(), null);
});

test('the basin comes from Duke\'s published roster, not from two typed ids', () => {
  // Was: RIVERS[key].dukeBasinId, hand-typed on two of six rivers. Now: match the water against
  // /rivers/get-rivers. The two the table had still resolve, and so does everything else.
  assert.equal(dukeBasinFor(DUKE_RIVERS, 'Wateree River'), 1);
  assert.equal(dukeBasinFor(DUKE_RIVERS, 'Broad River'), 10);
  assert.equal(dukeBasinFor(DUKE_RIVERS, 'Yadkin River'), 3);
  assert.equal(dukeBasinFor(DUKE_RIVERS, 'Keowee River'), 6);
  assert.equal(dukeBasinFor(DUKE_RIVERS, 'Pigeon River'), 11);
  assert.equal(dukeBasinFor(DUKE_RIVERS, 'Nantahala River'), 2);
  assert.equal(dukeBasinFor(DUKE_RIVERS, 'Tuckasegee River'), 2, 'the description names it, not RiverName');
  assert.equal(dukeBasinFor(DUKE_RIVERS, 'Congaree River'), null);
  assert.equal(dukeBasinFor(DUKE_RIVERS, ''), null);
  assert.equal(dukeBasinFor(DUKE_RIVERS, null), null);
  // No roster, no guess. A release projection is not worth inventing an id for.
  assert.equal(dukeBasinFor(null, 'Wateree River'), null);
  assert.equal(dukeBasinFor([], 'Wateree River'), null);
});

test('RiverName is concatenated on two rows and would never have matched', () => {
  // "BroadRiver" and "PigeonRiver" are ONE token to any splitter that breaks on non-word
  // characters, so "Broad River" could not match basin 10 through RiverName at all.
  assert.equal(splitCamel('BroadRiver'), 'Broad River');
  assert.equal(splitCamel('PigeonRiver'), 'Pigeon River');
  assert.equal(splitCamel('Keowee Toxaway'), 'Keowee Toxaway', 'a real space is left alone');
  assert.equal(splitCamel('Catawba'), 'Catawba');
});

test('the catch-all basin agrees with nothing', () => {
  // RiverId 4 is "Other Lakes and Rivers". A basin matching on the word "lakes" would put a
  // release projection on every water in the app.
  assert.equal(dukeBasinFor(DUKE_RIVERS, 'Other Lake'), null);
  assert.equal(dukeBasinFor([{ RiverId: 4, RiverName: 'Others', riverDescription: 'Other Lakes and Rivers' }],
                            'Lake Murray'), null);
});

test('THE WATEREE, which is what started this', () => {
  // Ryan, 2026-08-17: "this is for wateree... which is part of the catawba chain". The card said
  // 'refused - RIVERS.dukeBasinId 1 returned "Catawba", which does not name Wateree Lake'. The id
  // was right; the comparison held a BASIN name against a LAKE name.
  //
  // riverDescription is "Catawba - Wateree" and names it outright.
  assert.equal(dukeBasinFor(DUKE_RIVERS, 'Wateree Lake (Kershaw Co, SC)'), 1);

  // And the six Catawba lakes whose own names contain no river at all. Every one of them is
  // bound to a gauge named "Catawba River at ...", because NWS names a gauge for its river.
  const chain = [
    ['Lake Wylie (York Co, NC/SC)',       ['Catawba River at Lake Wylie Dam']],
    ['Lake Norman (Catawba Co, NC)',      ['Catawba River at Lake Norman/Cowans Ford Dam']],
    ['Lake James (Burke Co, NC)',         ['Catawba River at Lake James/Linville Dam',
                                           'Linville River near Nebo']],
    ['Lake Hickory (Catawba Co, NC)',     ['Catawba River at Lake Hickory/Oxford Dam']],
    ['Rhodhiss Lake (Burke Co, NC)',      ['Catawba River at Lake Rhodhiss Dam']],
    ['Mountain Island Lake (Gaston Co, NC)', ['Catawba River at Mountain Island Lake and Dam',
                                              'McDowell Creek at Beatties Ford Rd.',
                                              'Long Creek at PAW CREEK']],
  ];
  for (const [name, gauges] of chain) {
    assert.equal(dukeBasinFor(DUKE_RIVERS, name, gauges), 1, name);
    // and without the gauges, the lake's own name says nothing about its river
    assert.equal(dukeBasinFor(DUKE_RIVERS, name), null, `${name} unaided`);
  }
});

test('only the river half of a gauge name is read', () => {
  // "<RIVER> at <PLACE>" — the place half is a minefield of towns, roads and other creeks.
  assert.equal(gaugeRiverPart('Catawba River at Cedar Creek Reservoir/Rocky Ck-Cedar Ck Dam'),
               'Catawba River');
  assert.equal(gaugeRiverPart('CATAWBA RIVER BL LAKE WYLIE DAM FEWELL ISLAND, SC'), 'CATAWBA RIVER');
  assert.equal(gaugeRiverPart('Long Creek at PAW CREEK'), 'Long Creek');
  assert.equal(gaugeRiverPart('LAKE WATEREE TAILRACE ABOVE CAMDEN, SC'), 'LAKE WATEREE TAILRACE');
  assert.equal(gaugeRiverPart(''), '');
  // A place called after another river must not drag a basin in with it.
  const ev = waterBasinEvidence('Some Pond', ['Mill Creek at Yadkin Road']);
  assert.equal(ev.has('yadkin'), false, 'a road named Yadkin is not the Yadkin');
  assert.equal(dukeBasinFor(DUKE_RIVERS, 'Some Pond', ['Mill Creek at Yadkin Road']), null);
});

test('the most specific basin wins', () => {
  // "Catawba - Wateree" shares two tokens with the Wateree and one with Lake Norman. Both are
  // right; preferring the stronger overlap stops a one-word coincidence outranking a real match.
  const rival = [...DUKE_RIVERS, { RiverId: 99, RiverName: 'Wateree', riverDescription: 'Wateree only' }];
  assert.equal(dukeBasinFor(rival, 'Wateree Lake', ['Catawba River at Wateree Dam']), 1);
});

// ── which USGS sites a water can ask for a temperature ──────────────────────────────────────
import { usgsSitesFor } from '../Worker/conditions.js';

const WATEREE = {
  slug: 'wateree_lake',
  pool: { lid: 'WATS1', name: 'Wateree River at Lake Wateree Dam', lat: 34.3347, lon: -80.7031 },
  tailwater: null,
  gauges: [
    { lid: 'CDCS1', usgs_site: null, name: 'Catawba River at Cedar Creek Reservoir' },
    { lid: null, usgs_site: '02147801', name: 'LAKE WATEREE TAILRACE ABOVE CAMDEN, SC', lat: 34.30, lon: -80.66 },
  ],
};

test('a gauge with no USGS site cannot answer for temperature', () => {
  // Wateree's pool is an NWPS lid and NWPS publishes no temperature at all, which is why the
  // strip was blank on both Wateree Lake and Wateree River.
  const sites = usgsSitesFor(WATEREE, 34.41, -80.86);
  assert.deepEqual(sites.map((s) => s.site), ['02147801']);
});

test('the tailrace is recognised as below the dam', () => {
  const [s] = usgsSitesFor(WATEREE, 34.41, -80.86);
  assert.equal(s.below_dam, true, 'a tailrace reading is the river, not the lake');
  assert.equal(s.role, 'gauge');
});

test('a site ON the lake outranks a nearer one below the dam', () => {
  const b = { pool: { usgs_site: '111', name: 'Mid-lake', lat: 34.0, lon: -81.0 },
              gauges: [{ usgs_site: '222', name: 'TAILRACE below dam', lat: 34.001, lon: -81.001 }] };
  assert.deepEqual(usgsSitesFor(b, 34.0, -81.0).map((s) => s.site), ['111', '222']);
});

test('the same site listed twice is one site', () => {
  const b = { pool: { usgs_site: '02147801', name: 'A' },
              tailwater: { usgs_site: '02147801', name: 'B' },
              gauges: [{ usgs_site: '02147801', name: 'C' }] };
  assert.equal(usgsSitesFor(b, 34, -81).length, 1);
});

test('a water with no USGS site anywhere returns an empty list, not a throw', () => {
  assert.deepEqual(usgsSitesFor({ pool: { lid: 'X' }, gauges: [] }, 34, -81), []);
  assert.deepEqual(usgsSitesFor({}, 34, -81), []);
});

// ── a hand-typed foreign key has to prove itself ────────────────────────────────────────────
import { dukeBasinAgrees } from '../Worker/conditions.js';

test('a basin that names the river agrees', () => {
  assert.equal(dukeBasinAgrees({ basinName: 'Catawba-Wateree', arrivals: [] }, 'Wateree River'), true);
  assert.equal(dukeBasinAgrees({ basinName: 'Broad River', arrivals: [] }, 'Broad River'), true);
});

test('a lake agrees through the river its gauges are named for', () => {
  // THE BUG RYAN HIT. The schedule for basin 1 comes back named "Catawba" and the water is
  // "Wateree Lake" — no shared word, refused, and the refusal called a correct id unverified.
  const sched = { basinName: 'Catawba', arrivals: [] };
  assert.equal(dukeBasinAgrees(sched, 'Lake Wylie (York Co, NC/SC)'), false, 'unaided, still no');
  assert.equal(dukeBasinAgrees(sched, 'Lake Wylie (York Co, NC/SC)',
                               ['Catawba River at Lake Wylie Dam']), true);
  assert.equal(dukeBasinAgrees({ basinName: 'Yadkin-Pee Dee', arrivals: [] },
                               'Lake Wylie', ['Catawba River at Lake Wylie Dam']), false);
});

test('a schedule from the catch-all basin is refused whatever it carries', () => {
  assert.equal(dukeBasinAgrees({ basinName: 'Others', arrivals: [] },
                               'Lake Murray', ['Saluda River at Lake Murray Dam']), false);
});

test('a basin that names a DIFFERENT river is refused', () => {
  // RIVERS.broad says operator "SCE&G / Dominion (Parr Shoals)" and then carries
  // dukeBasinId: 10. If 10 is the Yadkin, the projection would be another river's water.
  assert.equal(dukeBasinAgrees({ basinName: 'Yadkin-Pee Dee', arrivals: [] }, 'Broad River'), false);
  assert.equal(dukeBasinAgrees({ basinName: 'Catawba-Wateree', arrivals: [] }, 'Broad River'), false);
});

test('"river" is not a distinctive token — otherwise every basin agrees', () => {
  assert.equal(dukeBasinAgrees({ basinName: 'Some Other River', arrivals: [] }, 'Broad River'), false);
  assert.equal(dukeBasinAgrees({ basinName: 'River Basin', arrivals: [] }, 'Wateree River'), false);
});

test('a dam or mile marker can carry the agreement when the basin name does not', () => {
  const sched = { basinName: 'Basin 10',
                  arrivals: [{ damName: 'Ninety-Nine Islands', mileMarkerName: 'Broad River at Lockhart' }] };
  assert.equal(dukeBasinAgrees(sched, 'Broad River'), true);
});

test('nothing to check is not agreement', () => {
  assert.equal(dukeBasinAgrees(null, 'Broad River'), false);
  assert.equal(dukeBasinAgrees({ basinName: null, arrivals: [] }, 'Broad River'), false);
  assert.equal(dukeBasinAgrees({ basinName: 'Broad River', arrivals: [] }, ''), false);
});

// ── a basin is not a water ───────────────────────────────────────────────────────────────────
import { arrivalsForWater, arrivalsAppliesTo, nextArrivalPerMarker, arrivalDams }
  from '../Worker/conditions.js';

// Verbatim off Ryan's Wateree card, 2026-08-17, the moment the basin started resolving:
// "all of these are north of wateree so why would they be projected releases for lake wateree".
const CATAWBA_ARRIVALS = {
  basinName: 'Catawba',
  arrivals: [
    { damName: 'Wylie', mileMarkerName: 'Watermill Road Access Area', arrival: '2026-08-16T18:24:00' },
    { damName: 'Wylie', mileMarkerName: 'Catawba River Water Intake', arrival: '2026-08-16T19:00:00' },
    { damName: 'Bridgewater', mileMarkerName: 'Morganton Greenway', arrival: '2026-08-16T19:18:00' },
    { damName: 'Wylie', mileMarkerName: 'Rock Hill River Park', arrival: '2026-08-16T19:57:00' },
  ],
};
const BASIN_1 = { RiverId: 1, RiverName: 'Catawba', riverDescription: 'Catawba - Wateree' };

// The gauges the registry actually binds to wateree_lake.
const WATEREE_GAUGES = [
  'Catawba River at Cedar Creek Reservoir/Rocky Ck-Cedar Ck Dam',
  'Wateree River at Lake Wateree Dam',
  'LAKE WATEREE TAILRACE ABOVE CAMDEN, SC',
];

test('a basin-wide schedule is not this lake’s release schedule', () => {
  // Morganton is at the TOP of the Catawba below Lake James; Rock Hill is at Wylie. Lake Wateree
  // is the last impoundment on the chain, 150 miles down.
  const mine = arrivalsForWater(CATAWBA_ARRIVALS, 'Wateree Lake (Kershaw Co, SC)',
                                WATEREE_GAUGES, BASIN_1);
  assert.deepEqual(mine, [], 'none of the four is at Wateree');
});

test('the basin’s own river name cannot do the filtering', () => {
  // Every gauge on this chain is named "Catawba River at ...", and one of the four arrivals is
  // "Catawba River Water Intake". Matching on the river keeps exactly the wrong one.
  const naive = CATAWBA_ARRIVALS.arrivals.filter((a) => /catawba/i.test(a.mileMarkerName));
  assert.equal(naive.length, 1, 'the trap this test exists for');
  const mine = arrivalsForWater(CATAWBA_ARRIVALS, 'Wateree Lake', WATEREE_GAUGES, BASIN_1);
  assert.equal(mine.length, 0);
});

test('an arrival that names this water survives', () => {
  const sched = { basinName: 'Catawba', arrivals: [
    ...CATAWBA_ARRIVALS.arrivals,
    { damName: 'Wateree', mileMarkerName: 'Lake Wateree Dam Tailrace', arrival: '2026-08-16T21:00:00' },
  ] };
  const mine = arrivalsForWater(sched, 'Wateree Lake (Kershaw Co, SC)', WATEREE_GAUGES, BASIN_1);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].mileMarkerName, 'Lake Wateree Dam Tailrace');
});

test('a place named in a gauge, not in the lake name, still carries it', () => {
  // "Camden" appears only in the tailrace gauge's name, never in "Wateree Lake".
  const sched = { basinName: 'Catawba', arrivals: [
    { damName: 'Wateree', mileMarkerName: 'Camden Boat Ramp', arrival: '2026-08-16T22:00:00' },
  ] };
  assert.equal(arrivalsForWater(sched, 'Wateree Lake', WATEREE_GAUGES, BASIN_1).length, 1);
  // and without the gauges there is nothing to match on
  assert.equal(arrivalsForWater(sched, 'Wateree Lake', [], BASIN_1).length, 1,
    'the dam name still says Wateree');
  assert.equal(arrivalsForWater({ basinName: 'Catawba', arrivals: [
    { damName: 'Bridgewater', mileMarkerName: 'Camden Boat Ramp' }] }, 'Wateree Lake', [], BASIN_1).length,
    0, 'neither the dam nor the marker names this lake');
});

test('nothing to filter is an empty list, not a throw', () => {
  assert.deepEqual(arrivalsForWater(null, 'Wateree Lake', WATEREE_GAUGES, BASIN_1), []);
  assert.deepEqual(arrivalsForWater({ arrivals: [] }, 'Wateree Lake', WATEREE_GAUGES, BASIN_1), []);
  assert.deepEqual(arrivalsForWater(CATAWBA_ARRIVALS, '', [], BASIN_1), []);
});


// The real /rivers/flow-arrivals/1 payload, pasted by Ryan 2026-08-17. Two dams publishing on the
// whole Catawba basin, three mile markers each, repeated across three days: eighteen entries for
// six real places, and `RiverSection` null on every one.
const RAW_BASIN_1 = { basinName: 'Catawba', basinId: 1, arrivals: [] };
for (const [dam, markers] of [
  ['BW 2 Units', ['Watermill Road Access Area', 'Catawba River Water Intake', 'Morganton Greenway']],
  ['Wylie', ['Rock Hill River Park', 'Catawba Indian Reservation', 'Lansford Canal State Park']],
]) {
  for (const day of ['16', '17', '18']) {
    for (const m of markers) {
      const iso = `2026-08-${day}T19:00:00Z`;
      RAW_BASIN_1.arrivals.push({ damName: dam, mileMarkerName: m, arrival: iso,
                                  arrivalEpoch: Date.parse(iso), riverSection: null });
    }
  }
}

test('a flow arrival is a river fact, refused for a lake before any name matching', () => {
  // Every mile marker Duke publishes on this basin is a river access point below a dam, and the
  // endpoint is /rivers/. A release from the dam above a reservoir raises it imperceptibly and a
  // release from its own dam lowers it. Neither is an arrival.
  assert.equal(arrivalsAppliesTo('river'), true);
  assert.equal(arrivalsAppliesTo('lake'), false);
  assert.equal(arrivalsAppliesTo('coastal'), false);
  assert.equal(arrivalsAppliesTo(null), false);
  assert.equal(arrivalsAppliesTo(''), false);
});

test('the payload carries no geometry, so "downstream of" cannot be computed', () => {
  // Stated as a test rather than a comment: every entry has DamName, MileMarkerName, Arrival,
  // Recedes and a null RiverSection. No river mile, no coordinates, no ordering field. If Duke
  // ever adds one, this fails and the name matching can be replaced with something better.
  for (const a of RAW_BASIN_1.arrivals) {
    assert.equal(a.riverSection, null);
    assert.equal('riverMile' in a, false);
    assert.equal('lat' in a, false);
  }
});

test('eighteen entries are six places repeated over three days', () => {
  assert.equal(RAW_BASIN_1.arrivals.length, 18);
  const next = nextArrivalPerMarker(RAW_BASIN_1.arrivals, Date.parse('2026-08-16T12:00:00Z'));
  assert.equal(next.length, 6, 'one row per place');
  // The card slices to four. Sorted by raw time, three days of Bridgewater filled it and Wylie
  // never appeared at all.
  assert.equal(new Set(next.map((a) => a.damName)).size, 2, 'both dams survive the collapse');
  assert.ok(next.every((a) => a.arrivalEpoch >= Date.parse('2026-08-16T12:00:00Z')),
    'the next one due, not one from this morning');
});

test('a marker whose arrivals are all past keeps its most recent one', () => {
  // Mid-surge, the marker must not vanish from the card entirely.
  const past = nextArrivalPerMarker(RAW_BASIN_1.arrivals, Date.parse('2026-09-01T00:00:00Z'));
  assert.equal(past.length, 6);
});

test('the refusal names the dams that are actually releasing', () => {
  // On 2026-08-16 the whole Catawba basin had exactly two dams publishing, Bridgewater at the top
  // and Wylie in the middle, and neither is adjacent to most of the chain. "Nothing for you" and
  // "nothing for you because only these two are releasing" are different answers.
  assert.deepEqual(arrivalDams(RAW_BASIN_1), ['BW 2 Units', 'Wylie']);
  assert.deepEqual(arrivalDams({ arrivals: [] }), []);
  assert.deepEqual(arrivalDams(null), []);
});

test('BW is Bridgewater and nothing in the payload says so', () => {
  // A dam name that is an internal abbreviation plus a unit count cannot be matched to Lake
  // James, whose own gauge is "OLD CATAWBA R BL CATAWBA DAM NEAR BRIDGEWATER, NC". Recorded so
  // the limit is known rather than rediscovered: this is a false NEGATIVE the name test cannot
  // fix, and it is the safe direction.
  const james = ['Catawba River at Lake James/Linville Dam',
                 'OLD CATAWBA R BL CATAWBA DAM NEAR BRIDGEWATER, NC'];
  assert.equal(arrivalsForWater(RAW_BASIN_1, 'Lake James (Burke Co, NC)', james, BASIN_1).length, 0);
});

// ── the dam's own schedule, which is the only Duke release fact a reservoir has ───────────────
import { parseDukeRunTime, parseActiveRun, activeRunForWater } from '../Worker/conditions.js';

// Verbatim rows off /rivers/active-run, pasted by Ryan 2026-08-17.
const ACTIVE_RUN = [
  { riverId: 1, riverName: 'Bridgewater', Releases: [
    { StartDateTime: '08/16/2026 04:00:00 PM', EndDateTime: '08/16/2026 08:00:00 PM', Units: '2' }] },
  { riverId: 1, riverName: 'Oxford', Releases: [
    { StartDateTime: '08/16/2026 02:00:00 PM', EndDateTime: '08/16/2026 11:00:00 PM', Units: '' }] },
  { riverId: 1, riverName: 'Wylie', Releases: [
    { StartDateTime: '08/16/2026 04:00:00 PM', EndDateTime: '08/16/2026 10:00:00 PM', Units: '' }] },
  { riverId: 1, riverName: 'Wateree', Releases: [
    { StartDateTime: '08/17/26 No Flow Release', EndDateTime: '08/17/26 No Flow Release', Units: 'N/A' },
    { StartDateTime: '08/18/26 No Flow Release', EndDateTime: '08/18/26 No Flow Release', Units: 'N/A' },
    { StartDateTime: '08/19/26 No Flow Release', EndDateTime: '08/19/26 No Flow Release', Units: 'N/A' }] },
  { riverId: 2, riverName: 'Nantahala', Releases: [
    { StartDateTime: '08/16/2026 08:00:00 AM', EndDateTime: '08/16/2026 08:00:00 PM', Units: '' }] },
  { riverId: 3, riverName: 'Tillery', Releases: [
    { StartDateTime: '08/16/2026 06:00:00 PM', EndDateTime: '08/16/2026 09:00:00 PM', Units: '' }] },
];

test('"No Flow Release" is a sentence inside a datetime field', () => {
  // Date.parse returns NaN on it, so a parser that only kept finite dates would drop the row and
  // turn "Duke has explicitly scheduled no release" into "we have no information".
  const no = parseDukeRunTime('08/19/26 No Flow Release');
  assert.equal(no.noRelease, true);
  assert.equal(no.date, '2026-08-19', 'and the year loses two digits when it happens');
  assert.equal(no.epoch, null);

  const yes = parseDukeRunTime('08/16/2026 04:00:00 PM');
  assert.equal(yes.noRelease, false);
  assert.equal(yes.date, '2026-08-16');
  assert.equal(yes.iso, '2026-08-16T16:00:00-04:00', 'PM, and Eastern assumed as elsewhere');
  assert.equal(parseDukeRunTime('08/16/2026 12:00:00 AM').iso, '2026-08-16T00:00:00-04:00');
  assert.equal(parseDukeRunTime('08/16/2026 12:00:00 PM').iso, '2026-08-16T12:00:00-04:00');
  assert.equal(parseDukeRunTime(''), null);
  assert.equal(parseDukeRunTime(null), null);
  assert.equal(parseDukeRunTime('not a date at all'), null);
});

test('Units is empty on most dams and empty is not zero', () => {
  const rows = parseActiveRun(ACTIVE_RUN);
  const bw = rows.find((r) => r.dam === 'Bridgewater');
  const ox = rows.find((r) => r.dam === 'Oxford');
  const wa = rows.find((r) => r.dam === 'Wateree');
  assert.equal(bw.generators, 2, 'the only dam publishing a unit count');
  assert.equal(ox.generators, null, '"" is published-without-a-count, not zero');
  assert.equal(wa.generators, null, '"N/A" rides along with a no-release');
  assert.equal(wa.no_release, true);
});

test('THE WATEREE, and the answer is a stated zero', () => {
  // /flow-arrivals had nothing for this lake at all. /active-run says: no release, three days
  // running. That is worth more to a trip than most of what is on the card.
  const rows = parseActiveRun(ACTIVE_RUN);
  const wateree = activeRunForWater(rows, 1, 'Wateree Lake (Kershaw Co, SC)', WATEREE_GAUGES, BASIN_1);
  assert.equal(wateree.length, 3);
  assert.ok(wateree.every((r) => r.no_release));
  assert.deepEqual(wateree.map((r) => r.date), ['2026-08-17', '2026-08-18', '2026-08-19']);
});

test('the powerhouse is named in the gauge, never in the lake', () => {
  const rows = parseActiveRun(ACTIVE_RUN);
  // Lake Hickory's dam is "Oxford" and its own name says nothing about it.
  const hickory = ['Catawba River at Lake Hickory/Oxford Dam'];
  assert.equal(activeRunForWater(rows, 1, 'Lake Hickory (Catawba Co, NC)', hickory, BASIN_1)
    .map((r) => r.dam).join(), 'Oxford');
  assert.equal(activeRunForWater(rows, 1, 'Lake Hickory (Catawba Co, NC)', [], BASIN_1).length, 0);

  // Lake James' dam is "Bridgewater", which /flow-arrivals abbreviated to "BW 2 Units" and this
  // endpoint spells out.
  const james = ['OLD CATAWBA R BL CATAWBA DAM NEAR BRIDGEWATER, NC'];
  assert.equal(activeRunForWater(rows, 1, 'Lake James (Burke Co, NC)', james, BASIN_1)
    .map((r) => r.dam).join(), 'Bridgewater');
});

test('a dam name cannot reach across basins', () => {
  const rows = parseActiveRun(ACTIVE_RUN);
  // Nantahala is basin 2. Asking basin 1 for it returns nothing even though the name matches.
  assert.equal(activeRunForWater(rows, 1, 'Nantahala Lake', ['Nantahala River at Aquone'], BASIN_1).length, 0);
  assert.equal(activeRunForWater(rows, 2, 'Nantahala Lake', ['Nantahala River at Aquone'],
    { RiverId: 2, RiverName: 'Nantahala', riverDescription: 'Nantahala/Tuckasegee Area' }).length, 1,
    'and a water named after its own river keeps its name');
});

test('nothing published is an empty list, not a throw', () => {
  assert.deepEqual(parseActiveRun(null), []);
  assert.deepEqual(parseActiveRun([]), []);
  assert.deepEqual(parseActiveRun([{ riverId: 1 }]), [], 'a dam with no name is not a dam');
  assert.deepEqual(activeRunForWater([], 1, 'Wateree Lake', WATEREE_GAUGES, BASIN_1), []);
  assert.deepEqual(activeRunForWater(parseActiveRun(ACTIVE_RUN), 1, '', [], BASIN_1), []);
});

test('releaseShape renders a no-release schedule instead of dropping it', () => {
  const rows = activeRunForWater(parseActiveRun(ACTIVE_RUN), 1,
    'Wateree Lake (Kershaw Co, SC)', WATEREE_GAUGES, BASIN_1);
  const shaped = releaseShape({ dukeRun: rows });
  assert.equal(shaped.kind, 'scheduled');
  assert.equal(shaped.operator, 'Duke Energy');
  assert.equal(shaped.basin, 'Wateree', 'the dam, which is what this endpoint keys on');
  assert.equal(shaped.all_no_release, true);
  assert.equal(shaped.items.length, 3);
  // An arrival, where one exists, still outranks the powerhouse schedule: it says when the water
  // reaches YOU.
  const both = releaseShape({ duke: { arrivals: [{ damName: 'Wateree', arrival: 'x' }] }, dukeRun: rows });
  assert.equal(both.kind, 'projected');
});

// ── THE REGISTRY ARM, AND WHY Z IS NOT ALWAYS EARNED ──────────────────────────────────────────
//
// Ryan, 2026-08-27: "i want to see full pool is x lake level is y and the difference is z."
//
// Z is the ask and Z is the part that can lie. The bound gauges state NAVD88 on 38 waters and
// NGVD29 on 15; our full pools state NGVD29 on 14 and say nothing on 57; both are stated AND
// equal on TWO. NAVD88 and NGVD29 differ by roughly half a foot to a foot in the Carolinas,
// which is the size of a real drawdown on a lake held near full — so a subtraction across them
// can flip the sign on the only question being asked.
//
// So this arm shows X and Y always and Z only when it is earned, two ways: the datums agree by
// name, or the gauge's own zero reconciles with the full pool, which is proof without a label.

const NORMAN = { slug: 'lake_norman', display_name: 'Lake Norman (Catawba Co, NC)',
                 feature_type: 'lake', state: 'NC',
                 // Verbatim from water_bindings.json: NWPS publishes the gauge's zero, and on a
                 // Duke-index gauge that zero is full pool minus 100.
                 pool: { lid: 'CWAN7', datum: { name: 'NGVD29', nrldb: 660.0 } },
                 levels: { primary: 'nws:HP' } };

test('the gauge zero turns an index reading into an elevation', () => {
  const r = chartDatumShape(NORMAN, { fullPool: { ft: 760.0, source: 'x' }, gaugeStageFt: 97.0 });
  // 97 is Duke's index, not an elevation. 97 + 660 is.
  assert.equal(r.level_ft, 757.0);
  assert.equal(r.full_pool_ft, 760.0);
  assert.equal(r.below_full_pool_ft, 3.0);
});

test('a reconciling gauge zero earns the subtraction with no datum named on the pool', () => {
  const r = chartDatumShape(NORMAN, { fullPool: { ft: 760.0, source: 'x', datum: null },
                                      gaugeStageFt: 97.0 });
  assert.equal(r.below_full_pool_ft, 3.0);
  // and it says WHY it was allowed, rather than looking like a datum check that passed
  assert.match(r.datum_note, /reconcile/);
});

test('datums that disagree withhold Z and keep X and Y', () => {
  const b = { ...NORMAN, pool: { lid: 'X', datum: { name: 'NAVD88', nrldb: 12.0 } } };
  const r = chartDatumShape(b, { fullPool: { ft: 760.0, source: 'x', datum: 'NGVD 29' },
                                 gaugeStageFt: 97.0 });
  assert.equal(r.full_pool_ft, 760.0);
  assert.equal(r.level_ft, 109.0);
  assert.equal(r.below_full_pool_ft, null, 'a cross-datum subtraction is never published');
  assert.match(r.datum_note, /different marks/);
  assert.match(r.datum_note, /flip sign/);
});

test('matching datum names earn it even when the zero does not reconcile', () => {
  const b = { ...NORMAN, pool: { lid: 'X', datum: { name: 'NAVD88', nrldb: 0.0 } } };
  const r = chartDatumShape(b, { fullPool: { ft: 76.8, source: 'x', datum: 'NAVD88' },
                                 gaugeStageFt: 74.0 });
  assert.equal(r.below_full_pool_ft, 2.8);
  assert.equal(r.datum, 'NAVD88');
});

test('full pool with no reading says so instead of reading as zero drawdown', () => {
  const r = chartDatumShape(NORMAN, { fullPool: { ft: 760.0, source: 'x' }, gaugeStageFt: null });
  assert.equal(r.full_pool_ft, 760.0);
  assert.equal(r.level_ft, null);
  assert.equal(r.below_full_pool_ft, null);
  assert.match(r.datum_note, /level is not/);
});

test('no full pool falls through to pending, not to a silent zero', () => {
  const r = chartDatumShape(NORMAN, { fullPool: null, gaugeStageFt: 97.0 });
  assert.equal(r.full_pool_ft, null);
  assert.equal(r.below_full_pool_ft, null);
  assert.ok(r.pending, 'a water with no full pool must say why, not return nulls');
});
