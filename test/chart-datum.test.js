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
import { releaseShape, dukeBasinFor } from '../Worker/conditions.js';

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

test('only the two rivers with a measured centerline have a Duke basin', () => {
  // RIVERS is six hand-written entries and two carry a dukeBasinId. That is not an oversight to
  // fix by guessing: the surge model needs river-mile geometry that exists nowhere else.
  assert.equal(dukeBasinFor('Wateree River'), 1);
  assert.equal(dukeBasinFor('Broad River'), 10);
  assert.equal(dukeBasinFor('Congaree River'), null);
  assert.equal(dukeBasinFor('Lake Murray (Lexington Co, SC)'), null);
  assert.equal(dukeBasinFor(''), null);
  assert.equal(dukeBasinFor(null), null);
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
