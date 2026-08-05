/**
 * ramps.js — Tri-state (SC/NC/GA) boat ramp database.
 *
 * Previously a hardcoded static blob (~15,000 lines). Now fetches live data
 * from the Cloudflare Worker /ramps endpoint, which pulls from official state
 * ArcGIS services (SCDNR, GA DNR WRD, NC WRC) and caches in R2 with a 7-day TTL.
 *
 * The export TRISTATE_MASTER_RAMPS starts as an empty object and is populated
 * asynchronously. Modules that need ramp data should either:
 *   a) Call await rampsReady() to wait for data to be available, or
 *   b) Use TRISTATE_MASTER_RAMPS normally — it will be populated within ~1-2
 *      seconds on first load (or instantly from IndexedDB cache on subsequent loads)
 *
 * IDB cache TTL: 7 days (matching the worker's R2 cache TTL)
 * Worker endpoint: /ramps?state=SC|GA|NC
 *
 * FIX (2026-07-03): cache freshness used to be tracked with one global
 * `fetchedAt` for all three states combined. If any single state's fetch
 * failed once (network blip, worker 502, bad field mapping, etc.), that
 * state was simply left out of the cache write — but the global timestamp
 * still got set to "now", and the "is cache fresh?" check only looked at
 * that global timestamp. Every state passed except the one that failed,
 * so `anySuccess` was true and the cache got written. Result: a state
 * that failed once would silently stay empty client-side for up to 6-7
 * days before the "cache >6 days old" background-refresh path even
 * looked at it again — with no error, no visible signal, nothing wrong
 * shown anywhere. That's exactly how NC went missing from the map.
 *
 * Fixed by tracking `fetchedAt` per state instead of once globally, so a
 * state that never successfully cached is always treated as stale and
 * retried on next load, while states that did succeed keep their normal
 * 7-day TTL and aren't hammered unnecessarily.
 */

import { CF_WORKER_URL } from '../core/state.js';

import { cacheGet, cacheSet, cacheClear } from '../utils/db.js';
// Was its own database, `TrollMapRamps`, with its own open/get/put -- the third copy of the
// same forty lines, alongside contour-data.js and supplemental-layers.js. The ramp list is
// always re-fetchable from the Worker, so folding into the shared `cache` store needed no
// migration. NOTE: the per-state `fetchedAt` migration below is a separate thing and still
// applies -- it is about the shape of the cached VALUE, not where it is stored.
const CACHE_NS  = 'ramps';
const CACHE_KEY = 'tristate_ramps';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const BACKGROUND_REFRESH_MS = 6 * 24 * 60 * 60 * 1000; // 6 days

// ── The live export — starts empty, populated async ──────────────────────────
// Consumers can use this directly; it will be populated before most UI
// interactions occur (within ~1s on network, instantly from IndexedDB cache).
// TN was missing here while the worker has served it all along -- `/ramps` carries a full
// Tennessee Wildlife Resources Agency source (Boat_Launch_Sites, with lanes, courtesy dock, fee,
// restrooms, handicap parking and canoe landing), and `access-index.js` has always requested
// ['SC','NC','GA','TN'] for the toolbar and planner dropdowns. Only this loader -- which feeds
// the map's ramp LAYER, and now the shoreline ramp labels in supplemental-layers.js -- stopped
// at three. So Tennessee ramps appeared in the dropdowns and nowhere on the map.
//
// The name TRISTATE_ is now wrong; it is kept because several modules import it by that name.
export const TRISTATE_MASTER_RAMPS = { SC: {}, GA: {}, NC: {}, TN: {} };

// TRISTATE_MASTER_BANK_PIER / _PADDLE / _HOTSPOTS were here as empty arrays,
// "kept for any code that might reference them". Nothing did except gis-toggles.js,
// which passed them as a fallback that could only ever be empty. Bank-pier, paddle
// and attractors are now fetched live from the Worker for all four states.
// Deleted rather than left empty: an exported [] reads like a valid data source
// and silently produces a blank layer instead of an error.

// Promise that resolves when ramp data is fully loaded
let _resolveReady;
export const rampsReady = new Promise(resolve => { _resolveReady = resolve; });

// ── Merge worker response into TRISTATE_MASTER_RAMPS ─────────────────────────
// Worker returns { waterbodies: { 'Lake Wateree': [{name, lat, lon, ...}] } }
// We need to convert to { 'Lake Wateree': { 'Clearwater Cove': [lat, lon] } }
function mergeWorkerData(state, workerData) {
  const wbs = workerData.waterbodies || {};
  const stateObj = TRISTATE_MASTER_RAMPS[state] || {};
  for (const [wb, ramps] of Object.entries(wbs)) {
    if (!stateObj[wb]) stateObj[wb] = {};
    for (const r of ramps) {
      if (r.name && r.lat && r.lon) {
        stateObj[wb][r.name] = [r.lat, r.lon];
      }
    }
  }
  TRISTATE_MASTER_RAMPS[state] = stateObj;
}

// ── Fetch one state from worker ───────────────────────────────────────────────
async function fetchState(state) {
  const url = `${CF_WORKER_URL}/ramps?state=${state}`;
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) throw new Error(`Worker /ramps?state=${state} HTTP ${resp.status}`);
  return resp.json();
}

// ── Main init ─────────────────────────────────────────────────────────────────
async function initRamps() {
  const STATES = ['SC', 'GA', 'NC', 'TN'];
  const now = Date.now();

  // Cache shape is now: { SC: { data, fetchedAt }, GA: {...}, NC: {...} }
  // The TTL is applied per state below, not here, because each state carries its own
  // fetchedAt -- so this read deliberately does NOT pass a maxAge.
  let cached = await cacheGet(CACHE_NS, CACHE_KEY);

  // Migrate old single-fetchedAt cache shape if present, so existing users
  // don't lose their SC/GA cache just because the format changed.
  if (cached && cached.fetchedAt && !cached.SC?.fetchedAt) {
    const migrated = {};
    for (const st of STATES) {
      if (cached[st]) migrated[st] = { data: cached[st], fetchedAt: cached.fetchedAt };
    }
    cached = migrated;
  }

  const statesToFetch = [];

  for (const st of STATES) {
    const entry = cached?.[st];
    if (entry?.data && entry.fetchedAt && (now - entry.fetchedAt) < CACHE_TTL_MS) {
      TRISTATE_MASTER_RAMPS[st] = entry.data;
      const ageH = Math.round((now - entry.fetchedAt) / 3600000);
      console.log(`[ramps] ${st}: loaded from IDB cache (${ageH}h old)`);
      // Still queue a background refresh if this state's cache is aging out.
      if ((now - entry.fetchedAt) >= BACKGROUND_REFRESH_MS) {
        statesToFetch.push(st);
      }
    } else {
      // No cache, expired cache, or a state that never successfully cached
      // last time (this is the fix — previously this state would have been
      // silently skipped for up to 7 days because only a single combined
      // timestamp was checked).
      statesToFetch.push(st);
    }
  }

  if (statesToFetch.length) {
    // Resolve immediately with whatever we already have from cache, so the
    // UI isn't blocked on states that need a live refetch.
    if (Object.values(TRISTATE_MASTER_RAMPS).some(v => Object.keys(v).length)) {
      _resolveReady(TRISTATE_MASTER_RAMPS);
    }

    console.log(`[ramps] fetching from worker: ${statesToFetch.join(', ')}`);
    try {
      const results = await Promise.allSettled(statesToFetch.map(s => fetchState(s)));
      const toCache = cached && typeof cached === 'object' ? { ...cached } : {};

      results.forEach((result, i) => {
        const st = statesToFetch[i];
        if (result.status === 'fulfilled') {
          mergeWorkerData(st, result.value);
          toCache[st] = { data: TRISTATE_MASTER_RAMPS[st], fetchedAt: Date.now() };
          console.log(`[ramps] ${st}: ${result.value.count || '?'} ramps across ${result.value.waterbodyCount || '?'} waterbodies`);
        } else {
          console.warn(`[ramps] ${st} fetch failed, will retry next load:`, result.reason?.message);
          // Deliberately do NOT write a fetchedAt for this state — leaving
          // it absent (or with its old value) means it's correctly treated
          // as stale/missing on the next page load instead of getting
          // stuck behind a cache window it never actually earned.
        }
      });

      await cacheSet(CACHE_NS, CACHE_KEY, toCache);
    } catch (e) {
      console.warn('[ramps] worker fetch failed:', e);
    }
  }

  _resolveReady(TRISTATE_MASTER_RAMPS);
}

// Kick off immediately — don't block module loading
initRamps().catch(e => {
  console.warn('[ramps] init error:', e);
  _resolveReady(TRISTATE_MASTER_RAMPS);
});

console.log('[ramps] module ready');

// ── Dev helper: force a full refresh past both IDB and (implicitly) the
// worker's R2 cache is NOT bypassed by this alone — combine with ?refresh=1
// on the worker if you also need to bypass R2. This only clears the local
// IndexedDB cache and re-fetches from the worker.
window.forceRefreshRamps = async function forceRefreshRamps() {
  console.log('[ramps] forceRefreshRamps: clearing IDB cache...');
  // Deleting a whole database is no longer the right move: this cache shares `TrollMapDB`
  // with the catch journal, saved plans and spreads. cacheClear touches only this namespace.
  const ok = await cacheClear(CACHE_NS);

  // The old standalone database is left behind by the fold. Removing it here means the one
  // command a person runs when ramps look wrong is also the command that reclaims the space,
  // rather than orphaning it forever. Harmless when it was never created.
  await new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase('TrollMapRamps');
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch (e) {
      console.warn('[ramps] could not remove the retired TrollMapRamps database:', e && e.message);
      resolve();
    }
  });

  console.log(ok
    ? '[ramps] cache cleared. Reload the page to re-fetch all states fresh.'
    : '[ramps] cache clear reported a failure — see the [db] message above.');
};
