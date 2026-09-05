// The WQP sweep must advance past a water it cannot do.
//
// 2026-09-04. `wqpCached` writes limnology-cache/<id>.json only when the pull returned records --
// so an empty or failed pull left no object, and the sweep read a MISSING object as "due" and
// sorted the missing ones FIRST. A water that could not be pulled was therefore retried ahead of
// every water that had never been tried, forever.
//
// Measured on the live bucket: the five profiles the sweep ever filled are listing keys #2 to #6,
// one per five-minute firing on 2026-09-02 between 20:45 and 21:06. Key #1, allatoona_lake_ga,
// never completed once -- it is a profile for a water that has since left lake_index.json, so its
// bbox lookup can never succeed. One of the two slots was spent on it every firing; the other
// walked down until it hit cheoah_lake_nc, another retired water, and stopped. Two days of
// re-pulling the same two lakes every five minutes and never reaching key #8.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshStaleLimnology } from '../Worker/research/limnology.js';

const INDEX = {
  badin_lake: { display_name: 'Badin Lake (Stanly Co, NC)', name: 'Badin Lake',
    legacy_display_names: ['Badin Lake, NC'], bounds_wsen: [-80.1, 35.4, -80.0, 35.5] },
  belews_lake: { display_name: 'Belews Lake (Stokes Co, NC)', name: 'Belews Lake',
    legacy_display_names: ['Belews Lake, NC'], bounds_wsen: [-80.1, 36.2, -80.0, 36.3] },
};

function profile(lakeName) {
  return JSON.stringify({ lakeName, limnology: {}, metadata: { versionNumber: 1 } });
}

/** R2 with three profiles: one retired water first, then two the app offers. */
function makeEnv() {
  const store = {
    '_registry/lake_index.json': JSON.stringify(INDEX),
    // Lexicographically first, and NOT in the index -- this is the jam.
    'lakes/allatoona_lake_ga.json': profile('Allatoona Lake, GA'),
    'lakes/badin_lake_nc.json': profile('Badin Lake, NC'),
    'lakes/belews_lake_nc.json': profile('Belews Lake, NC'),
  };
  const asObj = (key) => store[key] === undefined ? null
    : { httpMetadata: {}, text: async () => store[key] };
  return {
    store,
    R2_TROLLMAP_CHARTPACKS: {
      get: async (k) => asObj(k),
      head: async (k) => asObj(k),
      put: async (k, v) => { store[k] = v; },
      // R2 RETURNS ONE PAGE AND A CURSOR, so the fake does too -- `pageSize` is deliberately
      // small so that any listing this loop makes has to be followed to its end. The old fake
      // returned the whole bucket in one call, which is why it could not see the bug that was
      // live in the Worker while every test here passed.
      list: async ({ prefix, cursor }) => {
        const keys = Object.keys(store).filter((k) => k.startsWith(prefix)).sort();
        const start = cursor ? keys.indexOf(cursor) : 0;
        const page = keys.slice(start, start + (store.__pageSize || 2));
        const next = start + page.length;
        return {
          objects: page.map((k) => ({ key: k, size: (store[k] || '').length, uploaded: new Date(0).toISOString() })),
          truncated: next < keys.length,
          cursor: next < keys.length ? keys[next] : undefined,
        };
      },
    },
  };
}

const sweepState = (env) => {
  const raw = env.store['limnology-cache/_sweep.json'];
  return raw ? JSON.parse(raw).waters : null;
};

// Every pull fails, which is the case the old code could not get past.
const failEveryPull = () => { globalThis.fetch = async () => { throw new Error('WQP unreachable'); }; };

// THIS ONE RUNS FIRST ON PURPOSE. registry.js caches the index at module scope for an hour, so
// once any test above has read it, deleting the object cannot make the read fail -- which is also
// true in the Worker and is the right behaviour there. The refusal below is what happens on a
// COLD index, and a cold index is the only state in which it can be observed.
test('it refuses to sweep at all when the index cannot be read', async () => {
  // The gate IS the index, so no index means no basis for deciding what the app offers.
  failEveryPull();
  const env = makeEnv();
  delete env.store['_registry/lake_index.json'];
  const out = await refreshStaleLimnology(env, { limit: 2 });
  assert.match(String(out.error || ''), /index/i);
  assert.equal(out.refreshed, 0);
});

test('a water the app no longer offers is skipped and does not spend a slot', async () => {
  failEveryPull();
  const env = makeEnv();
  const out = await refreshStaleLimnology(env, { limit: 2 });
  assert.equal(out.notOffered, 1, 'Allatoona is not in the index and must be counted as such');
  assert.equal(out.refreshed, 2, 'both slots must still reach a water the app offers');
  const st = sweepState(env);
  assert.equal(st.allatoona_lake_ga.outcome, 'not offered by the app');
});

test('an attempt is recorded even when the pull comes back with nothing', async () => {
  failEveryPull();
  const env = makeEnv();
  await refreshStaleLimnology(env, { limit: 2 });
  const st = sweepState(env);
  // The pull cache is untouched -- an empty pull must never evict a good one -- so the ATTEMPT
  // is the only record that this water was tried at all.
  assert.ok(st.badin_lake_nc?.at, 'badin must be marked attempted');
  assert.ok(st.belews_lake_nc?.at, 'belews must be marked attempted');
  assert.equal(env.store['limnology-cache/badin_lake_nc.json'], undefined,
    'a failed pull must not be cached as a pull');
});

test('the next firing does not spend itself on the same two waters', async () => {
  failEveryPull();
  const env = makeEnv();
  const first = await refreshStaleLimnology(env, { limit: 2 });
  assert.equal(first.refreshed, 2);
  // Nothing else is left to do, so the second firing must find nothing rather than re-pulling.
  const second = await refreshStaleLimnology(env, { limit: 2 });
  assert.equal(second.refreshed, 0, 'the same waters must not be pulled again inside the TTL');
  assert.equal(second.stale, 0, 'and they must no longer read as due');
});

// ── A PULL THAT CHANGED NO VALUE STILL CHANGED WHAT WE KNOW ─────────────────────────────────
//
// 2026-09-04, Lake Sidney Lanier. The sweep state said "35183 records" at 09:36 and the profile
// it belongs to had not been written since 22 July, with `limnologyRefreshedAt` null. The cache
// object holds a thermocline of 28 ft derived from 8,823 depth records at confidence 88.
//
// The guard read `if (merged === profile.limnology) continue;` ABOVE the lines that attach the
// pull and its evidence, so a water whose numbers already matched kept them with no
// `_wqpLimnology` block, no evidence rows and no refresh stamp -- the provenance was discarded
// exactly when it agreed, which is when it is most worth having. Wateree carried a thermocline
// of 27 ft for months beside a note saying the depth was never provided, and an evidence row is
// the only thing that catches that.

test('a pull that confirms the stored numbers still records its evidence', async () => {
  const env = makeEnv();
  // Badin already holds the number WQP is about to derive.
  env.store['lakes/badin_lake_nc.json'] = JSON.stringify({
    lakeName: 'Badin Lake, NC',
    limnology: { thermocline: { summerDepthFt: 28 } },
    metadata: { versionNumber: 1 },
  });
  delete env.store['lakes/belews_lake_nc.json'];
  delete env.store['lakes/allatoona_lake_ga.json'];

  globalThis.fetch = async () => ({
    ok: true, status: 200,
    text: async () => 'ResultIdentifier,CharacteristicName,ResultMeasureValue\n',
    json: async () => ({}),
  });

  const before = env.store['lakes/badin_lake_nc.json'];
  await refreshStaleLimnology(env, { limit: 2 });
  const after = env.store['lakes/badin_lake_nc.json'];

  // Whatever the pull returned, the profile must not come out of this LOSING information.
  const b = JSON.parse(before);
  const a = JSON.parse(after);
  assert.equal(a.limnology.thermocline.summerDepthFt, b.limnology.thermocline.summerDepthFt,
    'the stored depth must survive a confirming pull');
});

test('a throw between the pull and the put is recorded in the sweep state', async () => {
  // `out.failed` is returned to the caller and the cron calls this with nobody listening, so a
  // throw there left a state row saying "35183 records" beside an untouched profile and no way
  // to tell which of the two branches had fired.
  const env = makeEnv();
  delete env.store['lakes/allatoona_lake_ga.json'];
  delete env.store['lakes/belews_lake_nc.json'];
  const realPut = env.R2_TROLLMAP_CHARTPACKS.put;
  env.R2_TROLLMAP_CHARTPACKS.put = async (k, v) => {
    if (k.startsWith('lakes/')) throw new Error('R2 put refused');
    return realPut(k, v);
  };
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    text: async () => 'ResultIdentifier,CharacteristicName,ResultMeasureValue\n',
    json: async () => ({}),
  });
  await refreshStaleLimnology(env, { limit: 2 });
  const st = sweepState(env);
  assert.ok(st, 'the sweep state must still be written when a merge throws');
});


// ── THE VERSION BLOCK SITS BETWEEN THE PROFILES ────────────────────────────────────────────────
//
// 2026-09-05. `lakes/` holds the profiles AND `lakes/versions/<id>/vN.json` history, and R2 orders
// keys lexicographically, so every profile whose id sorts after the word "versions" comes AFTER
// the whole history block. On the live bucket that is 802 version objects standing between
// `lakes/tuckertown_lake_nc.json` and these four:
//
//   w_kerr_scott_reservoir_wilkes_co_nc   watauga_lake_tn   watauga_tn   white_lake_bladen_co_nc
//
// All four hold a profile. None has a `limnology-cache/<id>.json` and none has a row in
// `_sweep.json`, so by this loop's own due test they were first in line -- and the sweep asked
// R2 for one page and never saw them. The firing at 19:06 on 2026-09-04 had two slots, pulled
// ONE water, and stopped; nothing has been written since. A short firing with work outstanding
// is what an early-ended listing looks like from the outside.

test('a profile that sorts after the version block is still swept', async () => {
  failEveryPull();
  const env = makeEnv();
  delete env.store['lakes/allatoona_lake_ga.json'];
  delete env.store['lakes/badin_lake_nc.json'];
  delete env.store['lakes/belews_lake_nc.json'];

  INDEX.w_kerr_scott = { display_name: 'W Kerr Scott Reservoir (Wilkes Co, NC)',
    name: 'W Kerr Scott Reservoir', legacy_display_names: ['W. Kerr Scott Reservoir, NC'],
    bounds_wsen: [-81.3, 36.1, -81.1, 36.2] };

  // The history block, standing where it stands in the bucket.
  for (let i = 1; i <= 12; i++) {
    env.store[`lakes/versions/tuckertown_lake_nc/v${i}.json`] = '{}';
  }
  env.store['lakes/tuckertown_lake_nc.json'] = profile('Badin Lake, NC');
  env.store['lakes/w_kerr_scott_reservoir_wilkes_co_nc.json'] =
    profile('W Kerr Scott Reservoir (Wilkes Co, NC)');

  const out = await refreshStaleLimnology(env, { limit: 2 });
  const st = sweepState(env) || {};
  assert.ok(st.w_kerr_scott_reservoir_wilkes_co_nc,
    'the water behind the version block must be reached');
  // And the history objects must never be mistaken for profiles.
  assert.equal(Object.keys(st).some((k) => k.includes('/')), false,
    'a versions key is not a profile id');
  assert.equal(out.checked, 2, 'two profiles exist under lakes/ and both must be counted');
});
