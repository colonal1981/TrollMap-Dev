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
import { _resetIndexCache } from '../Worker/registry.js';

const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// THE SWEEP GAINED A GATE AND THIS FILE WAS NOT OPENED.
//
// Ryan, 2026-09-04: "it should only be looking at lakes in the app... nothing else". Nine stored
// profiles were for waters that had left the index and could never work -- the bbox comes off the
// registry row, so a profile with no row self-derives against a pack that is not there and
// returns ok:false forever. Those nine were the jam at the head of the queue.
//
// So refreshStaleLimnology() now reads `_registry/lake_index.json` FIRST and does nothing at all
// if it cannot -- deliberately, because guessing is the thing the gate exists to stop. This
// bucket carried no index, so every test here got `{checked: 0, error: 'lake index unavailable'}`
// and four of the five went red. The gate is right; the fixture was a bucket the app could not
// have run against.
//
// EVERY PROFILE IN THIS FILE NOW HAS A REGISTRY ROW, which is also the honest fixture: a profile
// with no row is a different case and it has its own test at the bottom.
const INDEX_ROW = (slug, name) => ({
  slug, name, display_name: name, state: 'SC', bounds_wsen: [-80.8, 34.2, -80.6, 34.5],
});

const LAKE_INDEX = (rows) => JSON.stringify({ lakes: Object.fromEntries(rows.map((r) => [r.slug, r])) });

const WATEREE_INDEX = LAKE_INDEX([
  INDEX_ROW('wateree_lake', 'LAKE WATEREE, SC'),
  INDEX_ROW('lake_a', 'LAKE A, SC'),
  INDEX_ROW('lake_b', 'LAKE B, SC'),
]);

/** Enough of R2 for the sweep: list with `uploaded`, get, put, and the index it gates on. */
function fakeBucket(objects, index = WATEREE_INDEX) {
  // THE INDEX IS CACHED PER ISOLATE FOR AN HOUR, so a test that primed it would hand its rows to
  // every test after it and a bucket without one would still pass. Reset per bucket.
  _resetIndexCache();
  const store = new Map(Object.entries(
    index === null ? objects : { '_registry/lake_index.json': { uploaded: new Date().toISOString(), body: index }, ...objects }));
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
  // THE FIXTURE IS DERIVED, NOT TYPED, and that is the whole correction.
  //
  // This used to hand-write a profile whose limnology already matched the pull and assert nothing
  // was written. It went red when the guard was widened, and the guard was right: it used to
  // compare ONE FIELD -- `if (merged === profile.limnology) continue;` -- sitting above the lines
  // that attach `_wqpLimnology` and the evidence rows. So a water whose numbers happened to agree
  // kept them with no provenance at all, which is exactly the case where provenance is worth most.
  // Lake Wateree carried a 27 ft thermocline for months beside a note saying the depth was never
  // provided, and the evidence row that branch discarded is the only defence against that.
  //
  // The guard now compares the WHOLE document it is about to write, so "unchanged" means the
  // values AND their provenance. A typed fixture cannot express that without copying the writer's
  // output by hand, which is how a test ends up asserting last week's format. So the sweep is run
  // once, what it wrote is fed back, and the SECOND run is the one under test.
  const first = fakeBucket({
    'lakes/lake_wateree_sc.json': { uploaded: iso(40 * DAY), body: PROFILE(SKELETON) },
    'limnology-cache/lake_wateree_sc.json': { uploaded: iso(31 * DAY), body: PULL },
  });
  const run1 = await refreshStaleLimnology({ R2_TROLLMAP_CHARTPACKS: first });
  assert.equal(run1.merged, 1, 'the first pass writes, or the second proves nothing');

  const settled = first._read('lakes/lake_wateree_sc.json');
  const second = fakeBucket({
    'lakes/lake_wateree_sc.json': { uploaded: iso(40 * DAY), body: JSON.stringify(settled) },
    'limnology-cache/lake_wateree_sc.json': { uploaded: iso(31 * DAY), body: PULL },
  });
  const run2 = await refreshStaleLimnology({ R2_TROLLMAP_CHARTPACKS: second });
  assert.equal(run2.refreshed, 1, 'it was still due, and it was still pulled');
  assert.equal(run2.merged, 0, 'nothing changed, so nothing is written');
  assert.deepEqual(second.puts.filter((k) => k.startsWith('lakes/')), []);
});

test('...but a pull that agrees on the NUMBERS and adds the PROVENANCE does write', async () => {
  // The other half of the same guard, and the bug it was widened to fix. Same values, no
  // `_wqpLimnology`, no evidence: the document changes even though not one number does.
  const agreeing = {
    ...SKELETON,
    waterClarity: { typical: 'stained', secchiFt: 3.1, note: null },
    thermocline: { summerDepthFt: 24, method: 'derived_from_do_profile', note: null },
    oxygen: { depletionDepthFt: null, anoxicBelowFt: 30, note: null },
    trophicStatus: 'eutrophic',
  };
  const R2 = fakeBucket({
    'lakes/lake_wateree_sc.json': { uploaded: iso(40 * DAY), body: PROFILE(agreeing) },
    'limnology-cache/lake_wateree_sc.json': { uploaded: iso(31 * DAY), body: PULL },
  });
  const out = await refreshStaleLimnology({ R2_TROLLMAP_CHARTPACKS: R2 });
  assert.equal(out.merged, 1, 'the provenance is a change even when the numbers are not');
  const saved = R2._read('lakes/lake_wateree_sc.json');
  assert.equal(saved._wqpLimnology.recordCount, 412);
  assert.ok(saved.evidence.limnology.thermocline[0]);
  assert.equal(saved.limnology.thermocline.summerDepthFt, 24, 'and the number is untouched');
});

test('no bucket is not a crash', async () => {
  assert.deepEqual(await refreshStaleLimnology({}),
                   { checked: 0, stale: 0, refreshed: 0, merged: 0, fromDocuments: 0,
                     notOffered: 0, failed: [] });
});

test('NO LAKE INDEX MEANS NO SWEEP — it does not guess', async () => {
  // The gate's whole point is to stop spending federal API calls on waters the app does not
  // offer. A sweep that cannot read the index and carries on anyway is the behaviour it replaced.
  const R2 = fakeBucket({
    'lakes/lake_wateree_sc.json': { uploaded: iso(40 * DAY), body: PROFILE(SKELETON) },
    'limnology-cache/lake_wateree_sc.json': { uploaded: iso(31 * DAY), body: PULL },
  }, null);
  const out = await refreshStaleLimnology({ R2_TROLLMAP_CHARTPACKS: R2 });
  assert.equal(out.checked, 0);
  assert.equal(R2.puts.length, 0);
  assert.match(String(out.error), /lake index unavailable/);
});

test('a profile for a water the app no longer offers is marked and skipped, not retried', async () => {
  // THE JAM, IN ONE TEST. Under the old behaviour this water consumed a slot every five minutes
  // forever, because the absence of a pull cache read as "due" and sorted first.
  const R2 = fakeBucket({
    'lakes/retired_pond_sc.json': { uploaded: iso(40 * DAY), body: PROFILE(SKELETON, 'RETIRED POND, SC') },
    'lakes/lake_wateree_sc.json': { uploaded: iso(40 * DAY), body: PROFILE(SKELETON) },
    'limnology-cache/lake_wateree_sc.json': { uploaded: iso(31 * DAY), body: PULL },
  });
  const out = await refreshStaleLimnology({ R2_TROLLMAP_CHARTPACKS: R2 }, { limit: 1 });
  assert.equal(out.notOffered, 1, 'the retired water is named as not offered');
  // AND IT DID NOT EAT THE SLOT. Wateree still got done in the same firing.
  assert.equal(out.merged, 1);
  assert.deepEqual(R2.puts.filter((k) => k.startsWith('lakes/')), ['lakes/lake_wateree_sc.json']);
  // The attempt is recorded, so the next firing does not sort it first all over again.
  assert.ok(R2.puts.includes('limnology-cache/_sweep.json'), 'the sweep state is written');
});
