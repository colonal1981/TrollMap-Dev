// One read for the state of the water.
//
// This replaced three answers to one question: a seven-lake hand-typed UTILITY_FEEDS table, a
// Duke/Dominion/Santee if-chain matched on the SECOND WORD of the feed name, and a /lake call
// that returned a percent for Duke lakes and feet for everything else — into the same two form
// fields. The assertions here are mostly about the seams where those disagreed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cToF, conditionsUrl, pickWaterTemp, readConditions, fetchWaterConditions, levelSentence }
  from '../js/utils/water-conditions.js';

const REC = { slug: 'wateree_lake', name: 'Wateree Lake', displayName: 'Wateree Lake (Kershaw Co, SC)',
              lat: 34.3459, lon: -80.7011, state: 'SC' };

const envelope = (water, extra = {}) => ({ slug: REC.slug, water, ...extra });

test('the URL carries the centroid, because the Worker has no registry', () => {
  const u = new URL(conditionsUrl('https://w.example', REC));
  assert.equal(u.pathname, '/conditions/wateree_lake');
  assert.equal(u.searchParams.get('lat'), '34.3459');
  assert.equal(u.searchParams.get('lon'), '-80.7011');
});

test('no slug or no centroid is null, not a request that 400s', () => {
  assert.equal(conditionsUrl('https://w.example', { slug: 'x' }), null);
  assert.equal(conditionsUrl('https://w.example', { lat: 1, lon: 2 }), null);
  assert.equal(conditionsUrl('', REC), null);
});

test('a trailing slash on the worker base does not double up', () => {
  assert.ok(conditionsUrl('https://w.example/', REC).startsWith('https://w.example/conditions/'));
});

test('fresh=1 is opt-in — the registry changes when the PIPELINE uploads', () => {
  assert.equal(new URL(conditionsUrl('https://w.example', REC)).searchParams.get('fresh'), null);
  assert.equal(new URL(conditionsUrl('https://w.example', REC, { fresh: true })).searchParams.get('fresh'), '1');
});

test('celsius converts, and a missing temperature stays missing', () => {
  assert.equal(cToF(25), 77);
  assert.equal(cToF(null), null);
  assert.equal(cToF(undefined), null);
  // 0 °C is a temperature, not an absent one. This is the Number('') family.
  assert.equal(cToF(0), 32);
});

test('temperature comes from the pool before the tailwater', () => {
  const t = pickWaterTemp({ pool: { water_temp_c: 28, name: 'Pool' },
                            tailwater: { water_temp_c: 22, name: 'Below dam' } });
  assert.equal(t.from, 'pool');
  assert.equal(t.f, 82.4);
});

test('a tailwater temperature is labelled as one — it is the river, not the lake', () => {
  const t = pickWaterTemp({ pool: { water_temp_c: null }, tailwater: { water_temp_c: 22, name: 'Below dam' } });
  assert.equal(t.from, 'tailwater');
  assert.equal(t.name, 'Below dam');
});

test('the drawdown survives when there is no elevation at all', () => {
  // Brookfield's Chilhowee. `level - full` is NaN here; the number that answers the question
  // is sitting in below_full_pool_ft.
  const c = readConditions(envelope({
    display_name: 'Chilhowee Lake (Monroe Co, TN)', feature_type: 'lake',
    chart_datum: { level_ft: null, full_pool_ft: null, below_full_pool_ft: 1.18,
                   source: 'Brookfield / safewaters.com — Chilhowee', pending: null },
    operator: { url: 'https://www.safewaters.com/facility/chilhowee/', observed_at: 'x' },
  }));
  assert.equal(c.belowFullPoolFt, 1.18);
  assert.equal(c.levelFt, null);
  assert.equal(c.pending, null);
  assert.equal(c.levelUrl, 'https://www.safewaters.com/facility/chilhowee/');
  assert.match(levelSentence(c), /1\.18 ft below full pool/);
});

test('the feed name is not printed twice', () => {
  // chart_datum.source already reads "Brookfield / safewaters.com — Chilhowee" on the operator
  // path, so reading w.operator.feed_name as a fallback said Chilhowee twice.
  const c = readConditions(envelope({
    display_name: 'Chilhowee Lake', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1.18, source: 'Brookfield / safewaters.com — Chilhowee' },
    operator: { feed_name: 'Chilhowee' },
  }));
  assert.equal((levelSentence(c).match(/Chilhowee/g) || []).length, 1);
});

test('a Corps target rides along and is never subtracted', () => {
  const c = readConditions(envelope({
    display_name: 'Hartwell Lake', feature_type: 'lake',
    chart_datum: { level_ft: 651.7, full_pool_ft: 660, below_full_pool_ft: 8.3, source: 'X' },
    usace: { project: 'Hartwell', conservation_pool_ft: 660 },
  }));
  assert.equal(c.usaceTargetFt, 660);
  assert.equal(c.usaceProject, 'Hartwell');
  assert.equal(c.belowFullPoolFt, 8.3, 'the target must not become the drawdown');
});

test('an unbound water says so instead of reading as zero', () => {
  const c = readConditions({ slug: 'x', water: null, pending: { water: 'no row for "x" in the registry' } });
  assert.equal(c.ok, true);
  assert.equal(c.belowFullPoolFt, null);
  assert.match(c.pending, /no row/);
});

test('a request failure, an empty answer and a real zero are three different states', () => {
  const fail = readConditions(null);
  assert.equal(fail.ok, false);
  assert.equal(fail.error, 'no response');

  const empty = readConditions(envelope({ display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: null, pending: 'no source publishes a level' } }));
  assert.equal(empty.ok, true);
  assert.equal(empty.error, null);
  assert.match(empty.pending, /no source/);

  const atFull = readConditions(envelope({ display_name: 'L', feature_type: 'lake',
    chart_datum: { level_ft: 225.5, full_pool_ft: 225.5, below_full_pool_ft: 0, source: 'X' } }));
  assert.equal(atFull.belowFullPoolFt, 0);
  assert.match(levelSentence(atFull), /at full pool/);
});

test('above full pool reads as above, not as a negative drawdown', () => {
  const c = readConditions(envelope({ display_name: 'L', feature_type: 'lake',
    chart_datum: { level_ft: 227, full_pool_ft: 225.5, below_full_pool_ft: -1.5, source: 'X' } }));
  assert.match(levelSentence(c), /1\.50 ft above full pool/);
});

test('fetch failure is a stated error, never a silent fallback level', () => {
  return fetchWaterConditions('https://w.example', REC, {
    fetch: () => Promise.reject(new Error('offline')),
  }).then((c) => {
    assert.equal(c.error, 'offline');
    assert.equal(c.belowFullPoolFt, null);
    // The old code wrote a hardcoded normalPool into the form here, which the trip decision
    // then read as a live reading.
    assert.equal(c.levelFt, null);
  });
});

test('a non-200 with a JSON body still reports the status', () => {
  return fetchWaterConditions('https://w.example', REC, {
    fetch: () => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ oops: 1 }) }),
  }).then((c) => assert.equal(c.error, 'HTTP 400'));
});

test('a lake with no centroid never reaches the network', () => {
  let called = false;
  return fetchWaterConditions('https://w.example', { slug: 'x' }, {
    fetch: () => { called = true; return Promise.resolve({ ok: true, json: () => ({}) }); },
  }).then((c) => {
    assert.equal(called, false);
    assert.match(c.error, /centroid/);
  });
});

// ── the one line that has to fit ────────────────────────────────────────────────────────────
import { conditionsStrip } from '../js/utils/water-conditions.js';

const strip = (water, extra = {}) => conditionsStrip(readConditions({ slug: 's', water, ...extra }));

test('a lake leads with the drawdown — the number that decides the ramp', () => {
  const s = strip({ display_name: 'Thurmond', feature_type: 'lake',
    chart_datum: { level_ft: 323.08, full_pool_ft: 330, below_full_pool_ft: 6.92,
                   source: 'Southern Company / Georgia Power — Clark Hill (Thurmond Dam)' },
    pool: { water_temp_c: 29, name: 'Modoc' } });
  assert.match(s.text, /^6\.92 ft down/);
  assert.match(s.text, /84\.2°F/);
  assert.match(s.text, /Southern Company \/ Georgia Power$/, 'the source, not the feed row');
  assert.equal(s.tone, 'ok');
});

test('a river leads with FLOW — stage alone does not say what it is doing', () => {
  const s = strip({ display_name: 'Broad River', feature_type: 'river',
    chart_datum: { pending: 'not a lake — a river or coastal zone has no full pool to be below' },
    gauge: { flow: 1240.4, stage: 3.21, name: 'Alston' } });
  assert.match(s.text, /1,240 ft³\/s/);
  assert.match(s.text, /3\.2 ft stage/);
});

test('a projected release reaches the strip; an observed discharge does not', () => {
  const base = { display_name: 'Wateree River', feature_type: 'river',
                 gauge: { flow: 900, name: 'g' } };
  const proj = strip({ ...base, releases: { kind: 'projected', operator: 'Duke Energy',
    next: { mileMarkerName: 'Hwy 601' }, items: [] } });
  assert.match(proj.text, /release → Hwy 601/);
  // Brookfield's discharge IS the flow number two fields to the left. Printing it again as a
  // schedule is exactly what `kind` exists to prevent.
  const obs = strip({ ...base, releases: { kind: 'observed', operator: 'Brookfield',
    next: null, items: [{ cfs: 9448 }] } });
  assert.ok(!/release/.test(obs.text), obs.text);
});

test('a modelled clarity is marked, a measured one is not', () => {
  const model = strip({ display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 } }, { clarity: { overall: { clarity: 'Stained', score: 40 }, measured: null } });
  assert.match(model.text, /~Stained/);
  assert.ok(model.footnotes.some((f) => /modelled from rainfall/.test(f)));

  const meas = strip({ display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 } }, { clarity: { overall: { clarity: 'Clear', score: 5 }, measured: { avgSecchiDepthFt: 8 } } });
  assert.match(meas.text, /· Clear/);
  assert.ok(!/~/.test(meas.text));
  assert.ok(!meas.footnotes.some((f) => /modelled/.test(f)));
});

test('a tailwater temperature is starred and the footnote says why', () => {
  const s = strip({ display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 2 },
    tailwater: { water_temp_c: 20, name: 'Below dam' } });
  assert.match(s.text, /68°F\*/);
  assert.ok(s.footnotes.some((f) => /below the dam/.test(f)));
});

test('at full pool says so rather than printing 0.00 ft down', () => {
  const s = strip({ display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 0, level_ft: 225.5, full_pool_ft: 225.5 } });
  assert.match(s.text, /at full pool/);
});

test('nothing to say is idle, and an error is bad — they look different', () => {
  assert.equal(conditionsStrip(null).tone, 'idle');
  assert.equal(conditionsStrip({ error: 'offline' }).tone, 'bad');
  const empty = strip({ display_name: 'L', feature_type: 'lake',
    chart_datum: { pending: 'no source publishes a level for this water' } });
  assert.equal(empty.tone, 'idle');
  assert.match(empty.text, /no source publishes/);
});

test('the resolved water_temp wins, and a tailrace reading is still marked', () => {
  // NWPS publishes no temperature, so Wateree's pool gauge can never answer this. The Worker
  // resolves it from the nearest USGS site that reports 00010 — for Wateree that is
  // "LAKE WATEREE TAILRACE ABOVE CAMDEN", which is below the dam and must say so.
  const c = readConditions({ slug: 'wateree_lake', water: {
    display_name: 'Wateree Lake (Kershaw Co, SC)', feature_type: 'lake',
    chart_datum: { level_ft: 223.5, full_pool_ft: 225.5, below_full_pool_ft: 2, source: 'Duke Energy' },
    pool: { lid: 'WATS1', name: 'Wateree River at Lake Wateree Dam', stage: 223.5 },
    water_temp: { c: 29.4, f: 84.9, usgs_site: '02147801',
                  name: 'LAKE WATEREE TAILRACE ABOVE CAMDEN, SC', role: 'gauge', below_dam: true },
  } });
  assert.equal(c.waterTempF, 84.9);
  assert.equal(c.waterTempFrom, 'tailwater', 'below the dam is not the lake');
  assert.equal(c.waterTempSite, '02147801');
  assert.match(conditionsStrip(c).text, /84\.9°F\*/);
});

test('an on-lake reading is not marked as a tailrace one', () => {
  const c = readConditions({ slug: 's', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 },
    water_temp: { c: 26, f: 78.8, usgs_site: '123', name: 'Mid-lake', role: 'pool', below_dam: false } } });
  assert.equal(c.waterTempFrom, 'pool');
  assert.ok(!/°F\*/.test(conditionsStrip(c).text));
});
