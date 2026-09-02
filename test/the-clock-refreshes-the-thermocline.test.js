/**
 * test/the-clock-refreshes-the-thermocline.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Step 4 of THE_PROFILE_BECAME_A_CACHE_AND_NOBODY_MOVED_THE_READS_2026-09-01: "give WQP a TTL and
 * put its refresh on the existing cron", gated to the oldest waters per firing so the whole card
 * rolls over inside a month. This is that gate, run against a fake bucket.
 *
 * The pairing is the part worth a test. A profile lives at `lakes/<researchStorageId>.json` and
 * its pull at `limnology-cache/<researchStorageId>.json`, and the sweep matches them from the two
 * R2 LISTINGS without reading either body. Key those two differently -- the pack id is
 * `wateree_lake` where the profile id is `lake_wateree_sc` -- and the sweep silently decides every
 * water on the card is stale, forever.
 *
 *   node --test test/the-clock-refreshes-the-thermocline.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshStaleLimnology } from '../Worker/research/limnology.js';

const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

/** Enough of R2 for the sweep: list with `uploaded`, get, put. */
function fakeBucket(objects) {
  const store = new Map(Object.entries(objects));
  return {
    puts: [],
    async list({ prefix }) {
      return { objects: [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({ key: k, uploaded: v.uploaded })) };
    },
    async get(key) {
      const hit = store.get(key);
      return hit ? { text: async () => hit.body, body: hit.body } : null;
    },
    // HEAD is how the cache id is resolved against the profiles actually in the bucket.
    async head(key) {
      return store.has(key) ? { key } : null;
    },
    async put(key, body) {
      this.puts.push(key);
      store.set(key, { uploaded: new Date().toISOString(), body });
    },
    _read: (k) => JSON.parse(store.get(k).body),
  };
}

const PROFILE = (limnology, lakeName = 'LAKE WATEREE, SC') => JSON.stringify({
  lakeName, state: 'SC',
  limnology, metadata: { version: '7.0', versionNumber: 7 },
});

const SKELETON = {
  waterClarity: { typical: null, secchiFt: null, note: null },
  thermocline: { summerDepthFt: null, method: null, note: null },
  oxygen: { depletionDepthFt: null, anoxicBelowFt: null, note: null },
  trophicStatus: null, seasonalDrawdownFt: 2.5,
};

const PULL = JSON.stringify({
  ok: true, recordCount: 412, lastObserved: '2024-08-14',
  fetchedAt: iso(2 * DAY),
  thermocline: { depthFt: 24, method: 'derived_from_do_profile', evidenceCount: 61 },
  oxygen: { anoxicBelowFt: 30 },
  secchi: { avgSecchiDepthFt: 3.1, sampleCount: 9 },
});

test('a cache inside the thirty days is left alone', async () => {
  const R2 = fakeBucket({
    'lakes/lake_wateree_sc.json': { uploaded: iso(40 * DAY), body: PROFILE(SKELETON) },
    'limnology-cache/lake_wateree_sc.json': { uploaded: iso(3 * DAY), body: PULL },
  });
  const out = await refreshStaleLimnology({ R2_TROLLMAP_CHARTPACKS: R2 });
  assert.equal(out.checked, 1);
  assert.equal(out.stale, 0);
  assert.equal(R2.puts.length, 0, 'a fresh cache must cost nothing but the two listings');
});

test('a cache past thirty days is refreshed and merged into the profile in place', async () => {
  const R2 = fakeBucket({
    'lakes/lake_wateree_sc.json': { uploaded: iso(40 * DAY), body: PROFILE(SKELETON) },
    'limnology-cache/lake_wateree_sc.json': { uploaded: iso(31 * DAY), body: PULL },
  });
  const out = await refreshStaleLimnology({ R2_TROLLMAP_CHARTPACKS: R2 });
  assert.equal(out.stale, 1);
  assert.equal(out.merged, 1);
  assert.deepEqual(out.failed, []);

  const saved = R2._read('lakes/lake_wateree_sc.json');
  assert.equal(saved.limnology.thermocline.summerDepthFt, 24);
  assert.equal(saved.limnology.oxygen.anoxicBelowFt, 30);
  assert.equal(saved.limnology.waterClarity.secchiFt, 3.1);
  assert.equal(saved.limnology.trophicStatus, 'eutrophic');
  assert.equal(saved.limnology.seasonalDrawdownFt, 2.5, 'the deterministic field survives');
  assert.equal(saved._wqpLimnology.recordCount, 412);
  assert.equal(saved.evidence.limnology.thermocline[0].method, 'derived_from_do_profile');
  assert.ok(saved.metadata.limnologyRefreshedAt, 'the refresh is dated');

  // A VERSION MARKS A RESEARCH RUN, NOT A RE-READ OF THE SAME MEASUREMENT. Bumping it here would
  // file a version a month per water that no human authored.
  assert.equal(saved.metadata.version, '7.0');
  assert.equal(saved.metadata.versionNumber, 7);
});

test('the oldest goes first, and lakes/versions is not a water', async () => {
  // Both are past the TTL, so both are due and neither needs the network -- an expired cache is
  // still served when the refetch cannot be made, which is the stale-rather-than-null rule. With
  // a limit of one, the older of the two is the one that gets done.
  const R2 = fakeBucket({
    'lakes/lake_a_sc.json': { uploaded: iso(40 * DAY), body: PROFILE(SKELETON, 'LAKE A, SC') },
    'lakes/lake_b_sc.json': { uploaded: iso(40 * DAY), body: PROFILE(SKELETON, 'LAKE B, SC') },
    'limnology-cache/lake_a_sc.json': { uploaded: iso(400 * DAY), body: PULL },
    'limnology-cache/lake_b_sc.json': { uploaded: iso(31 * DAY), body: PULL },
    // History must not be mistaken for a profile.
    'lakes/versions/lake_a_sc/v3.json': { uploaded: iso(90 * DAY), body: PROFILE(SKELETON) },
  });
  const out = await refreshStaleLimnology({ R2_TROLLMAP_CHARTPACKS: R2 }, { limit: 1 });
  assert.equal(out.checked, 2, 'lakes/versions/** is history, not a water');
  assert.equal(out.stale, 2);
  assert.equal(out.merged, 1, 'one per firing when the limit says one');
  assert.deepEqual(R2.puts.filter((k) => k.startsWith('lakes/')), ['lakes/lake_a_sc.json'],
                   'the one whose pull was 400 days old went first');
});

test('an unchanged pull does not rewrite the profile', async () => {
  const already = {
    ...SKELETON,
    waterClarity: { typical: 'stained', secchiFt: 3.1, note: null },
    thermocline: { summerDepthFt: 24, method: 'derived_from_do_profile', note: null },
    oxygen: { depletionDepthFt: null, anoxicBelowFt: 30, note: null },
    trophicStatus: 'eutrophic',
    surfaceWater: {},
  };
  const R2 = fakeBucket({
    'lakes/lake_wateree_sc.json': { uploaded: iso(40 * DAY), body: PROFILE(already) },
    'limnology-cache/lake_wateree_sc.json': { uploaded: iso(31 * DAY), body: PULL },
  });
  const out = await refreshStaleLimnology({ R2_TROLLMAP_CHARTPACKS: R2 });
  assert.equal(out.merged, 0);
  assert.equal(R2.puts.filter((k) => k.startsWith('lakes/')).length, 0);
});

test('no bucket is not a crash', async () => {
  assert.deepEqual(await refreshStaleLimnology({}),
                   { checked: 0, stale: 0, refreshed: 0, merged: 0, failed: [] });
});
