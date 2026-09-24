// Personal use only, not for distribution or resale; not for navigation.
//
// EVERY WATER KEEPS ITS OWN CLARITY CACHE.
//
// getSecchiSummary() keyed its thirty-day cache `clarity-cache/${resolveR2Key(name)}.json`.
// resolveR2Key() is the chart-pack lookup, and in the Worker it returns null for 269 of the 352
// registry display names -- so all of those waters read and wrote `clarity-cache/null.json`.
// Measured live 2026-09-24: Lake Glenville NC, Lake Brandt NC, Quaker Creek NC, Lake Adger NC,
// Tugaloo, Yonah, Fishing Creek and Cedar Creek all returned the same seventeen SC stations.
//
// These run the real pull and the real cache against a stubbed bucket and a stubbed WQP that
// answers by bounding box, so each water's readings are its own and a shared key shows up as the
// second water getting the first one's number.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const A = 'Qqqx Reservoir (Nowhere Co, NC)';
const B = 'Zzzy Pond (Elsewhere Co, GA)';

const HEAD = ['OrganizationFormalName', 'ProjectIdentifier', 'MonitoringLocationIdentifier',
  'ActivityStartDate', 'ActivityDepthHeightMeasure/MeasureValue',
  'ActivityDepthHeightMeasure/MeasureUnitCode', 'CharacteristicName', 'ResultMeasureValue',
  'ResultMeasure/MeasureUnitCode', 'ResultDepthHeightMeasure/MeasureValue',
  'ResultDepthHeightMeasure/MeasureUnitCode'].join(',');
const csv = (station, ft) => [HEAD,
  ...['2022-06-01', '2023-06-01'].map((d) => `ORG,P1,${station},${d},,,"Depth, Secchi disk depth",${ft},ft,,`),
].join('\n');

const store = new Map(Object.entries({
  '_registry/lake_index.json': JSON.stringify({
    qqqx: { slug: 'qqqx', name: 'Qqqx Reservoir', display_name: A, state: 'NC',
      feature_type: 'lake', bounds_wsen: [-83.25, 35.1, -83.1, 35.2] },
    zzzy: { slug: 'zzzy', name: 'Zzzy Pond', display_name: B, state: 'GA',
      feature_type: 'lake', bounds_wsen: [-84.5, 33.5, -84.4, 33.6] },
  }),
}));
const bucket = {
  store,
  async get(k) { return store.has(k) ? { httpMetadata: {}, text: async () => store.get(k) } : null; },
  async put(k, v) { store.set(k, typeof v === 'string' ? v : String(v)); },
};

const pulls = [];
globalThis.fetch = async (input) => {
  const url = decodeURIComponent(typeof input === 'string' ? input : input.url);
  if (url.includes('waterqualitydata.us/data/Station/')) return new Response('', { status: 200 });
  if (url.includes('waterqualitydata.us/data/Result/')) {
    pulls.push(url);
    // Answer by the box the pull asked for: A's box reads 2 ft, B's reads 10 ft.
    if (url.includes('-83.25')) return new Response(csv('ST-A', 2), { status: 200 });
    if (url.includes('-84.5')) return new Response(csv('ST-B', 10), { status: 200 });
    return new Response(HEAD, { status: 200 });
  }
  return new Response('no', { status: 503 });
};

const { resolveR2Key } = await import('../js/data/lake-keys.js');
const { getSecchiSummary } = await import('../Worker/research/limnology.js');
const env = { R2_TROLLMAP_CHARTPACKS: bucket };

test('the two names are ones the chart-pack lookup cannot place -- the case that collided', () => {
  assert.equal(resolveR2Key(A), null);
  assert.equal(resolveR2Key(B), null);
});

test('each water gets its own readings, not the first water to miss', async () => {
  const a = await getSecchiSummary(env, A);
  const b = await getSecchiSummary(env, B);
  assert.equal(a.avgSecchiDepthFt, 2);
  assert.equal(b.avgSecchiDepthFt, 10, 'the second water read the first one\'s cache');
  assert.deepEqual(b.stations.map((s) => s.id), ['ST-B']);
  assert.equal(pulls.length, 2, 'one pull per water');
});

test('the cache is named for the registry row whose box was pulled, and never "null"', () => {
  const keys = [...store.keys()].filter((k) => k.startsWith('clarity-cache/')).sort();
  assert.deepEqual(keys, ['clarity-cache/qqqx.json', 'clarity-cache/zzzy.json']);
});

test('a second ask for each water comes from its own cache', async () => {
  pulls.length = 0;
  assert.equal((await getSecchiSummary(env, B)).avgSecchiDepthFt, 10);
  assert.equal((await getSecchiSummary(env, A)).avgSecchiDepthFt, 2);
  assert.equal(pulls.length, 0);
});

test('a name with no registry row is never filed under "null"', async () => {
  await getSecchiSummary(env, 'Not In The Registry Lake, SC');
  assert.ok(![...store.keys()].includes('clarity-cache/null.json'));
});
