// The version history has to be readable, or it is not history.
//
// `lakes/versions/<id>/vN.json` has been written on every save since the beginning -- 802 objects
// on the live bucket -- and until 2026-09-04 nothing could read one back. Ryan, on being told we
// would have to wait to learn what the 2026-09-02 batch cost: "we aren't guessing at it... the old
// research profiles will tell you". They can only tell us if something serves them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleResearchGet } from '../Worker/research/storage.js';

const WATEREE = 'Wateree Lake (Kershaw Co, SC)';
const INDEX = JSON.stringify({
  wateree_lake: {
    display_name: WATEREE, name: 'Wateree Lake',
    legacy_display_names: ['Wateree Lake, SC', 'Lake Wateree', 'Lake Wateree, SC'],
  },
});

function env(store) {
  const asObj = (k) => store[k] === undefined ? null : { httpMetadata: {}, text: async () => store[k] };
  return { R2_TROLLMAP_CHARTPACKS: {
    get: async (k) => asObj(k),
    head: async (k) => asObj(k),
    put: async (k, v) => { store[k] = v; },
    list: async ({ prefix }) => ({ objects: Object.keys(store)
      .filter((k) => k.startsWith(prefix)).sort().map((k) => ({ key: k, size: store[k].length })) }),
  } };
}

const STORE = () => ({
  '_registry/lake_index.json': INDEX,
  'lakes/lake_wateree_sc.json': JSON.stringify({ lakeName: WATEREE, metadata: { versionNumber: 141 },
    limnology: { trophicStatus: null } }),
  'lakes/versions/lake_wateree_sc/v140.json': JSON.stringify({ lakeName: WATEREE,
    metadata: { versionNumber: 140 }, limnology: { trophicStatus: 'eutrophic' } }),
  'lakes/versions/lake_wateree_sc/v141.json': JSON.stringify({ lakeName: WATEREE,
    metadata: { versionNumber: 141 }, limnology: { trophicStatus: null } }),
});

test('a version is served through the same resolution the master uses', async () => {
  // The county-stamped name still has to find lake_wateree_sc before any version can be read.
  const res = await handleResearchGet(env(STORE()), WATEREE, 140);
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.masterKey, 'lakes/versions/lake_wateree_sc/v140.json');
  assert.equal(out.version, 140);
  assert.equal(out.profile.limnology.trophicStatus, 'eutrophic',
    'the OLDER value is the whole reason this endpoint exists');
});

test('no version argument still returns the master, unchanged', async () => {
  const res = await handleResearchGet(env(STORE()), WATEREE);
  const out = await res.json();
  assert.equal(out.masterKey, 'lakes/lake_wateree_sc.json');
  assert.equal(out.profile.metadata.versionNumber, 141);
  assert.ok(Array.isArray(out.versions), 'the master read still lists what versions exist');
});

test('a version that does not exist says which ones do', async () => {
  // "no such version" without the list makes the caller guess twice.
  const res = await handleResearchGet(env(STORE()), WATEREE, 9);
  const out = await res.json();
  assert.equal(res.status, 404);
  assert.deepEqual(out.versionsAvailable, [140, 141]);
});

test('a water with no profile at all 404s before it looks for versions', async () => {
  const res = await handleResearchGet(env({ '_registry/lake_index.json': INDEX }), WATEREE, 140);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /no profile/);
});
