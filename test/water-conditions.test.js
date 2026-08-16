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
