// The chain has to reach the Worker, and a missing object must not look like an empty chain.
//
// lake_index.json and water_bindings.json each learned this the hard way: a registry file the
// pipeline builds and the uploader never ships is indistinguishable from work that was never
// done. water_chain.json is the third, and Worker/conditions.js:releaseDirection() cannot label
// a single Duke release inflow or outflow without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waterChain, WATER_CHAIN_KEY, _resetIndexCache } from '../Worker/registry.js';

const obj = (body) => ({
  text: async () => body,
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  httpMetadata: {},
});
const bucketOf = (body, key = WATER_CHAIN_KEY) => ({
  get: async (k) => (k === key ? obj(body) : null),
});
// Real rows, from registry/water_chain.json on 2026-08-17.
const REAL = JSON.stringify({
  _meta: { source: 'NHDPlus HR', direction: 'HydroSeq decreases downstream' },
  waters: {
    wateree_lake: { upstream: ['cedar_creek_reservoir_2'], downstream: 'lake_marion',
                    side_channel: false, drainage_km2: 12256.6, local_drainage_km2: 12256.6 },
    lowthers_lake: { upstream: [], downstream: null,
                     side_channel: true, drainage_km2: 21302.2, local_drainage_km2: 25.2 },
  },
});

test('the key is the one the uploader writes', () => {
  assert.equal(WATER_CHAIN_KEY, '_registry/water_chain.json');
});

test('rows come back keyed by slug, unwrapped from _meta', async () => {
  _resetIndexCache();
  const c = await waterChain(null, { bucket: bucketOf(REAL) });
  assert.deepEqual(c.wateree_lake.upstream, ['cedar_creek_reservoir_2']);
  assert.equal(c.wateree_lake.downstream, 'lake_marion');
  assert.equal(c._meta, undefined, 'the waters object is returned, not the wrapper');
});

test('an oxbow keeps both drainage figures, which answer different questions', async () => {
  _resetIndexCache();
  const c = await waterChain(null, { bucket: bucketOf(REAL) });
  const ox = c.lowthers_lake;
  assert.equal(ox.side_channel, true);
  // 21,302 km2 is the Big Pee Dee it hangs off; 25.2 is its own catchment. Ryan watches the
  // river's gauge upstream to know its level in high water, so the river figure is not noise.
  assert.equal(ox.drainage_km2, 21302.2);
  assert.equal(ox.local_drainage_km2, 25.2);
});

test('a missing object throws and names the script that writes it', async () => {
  _resetIndexCache();
  await assert.rejects(
    () => waterChain(null, { bucket: { get: async () => null } }),
    (e) => /build_water_chain\.py/.test(e.message) && /upload_garmin_to_r2\.py/.test(e.message),
  );
});

test('a bare object keyed by slug is accepted; an array is refused', async () => {
  _resetIndexCache();
  const c = await waterChain(null, { bucket: bucketOf('{"a":{"upstream":["b"]}}') });
  assert.deepEqual(c.a.upstream, ['b']);
  _resetIndexCache();
  await assert.rejects(() => waterChain(null, { bucket: bucketOf('[]') }),
    (e) => /keyed by slug/.test(e.message));
});

test('no bucket binding is an error, not an empty chain', async () => {
  _resetIndexCache();
  await assert.rejects(() => waterChain(null, {}),
    (e) => /R2_TROLLMAP_CHARTPACKS/.test(e.message));
});

test('cached for an hour, and _resetIndexCache clears it', async () => {
  _resetIndexCache();
  let reads = 0;
  const counting = { get: async () => { reads += 1; return obj(REAL); } };
  await waterChain(null, { bucket: counting, now: 1000 });
  await waterChain(null, { bucket: counting, now: 1000 + 59 * 60 * 1000 });
  assert.equal(reads, 1, 'served from cache inside the hour');
  await waterChain(null, { bucket: counting, now: 1000 + 61 * 60 * 1000 });
  assert.equal(reads, 2, 're-read after it');
  await waterChain(null, { bucket: counting, now: 1000 + 61 * 60 * 1000, fresh: true });
  assert.equal(reads, 3, 'fresh bypasses the cache');
  _resetIndexCache();
  await waterChain(null, { bucket: counting, now: 1000 });
  assert.equal(reads, 4, 'reset clears it');
});
