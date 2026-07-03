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

const IDB_STORE = 'ramps_cache';
const IDB_KEY   = 'tristate_ramps';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const BACKGROUND_REFRESH_MS = 6 * 24 * 60 * 60 * 1000; // 6 days

// ── The live export — starts empty, populated async ──────────────────────────
// Consumers can use this directly; it will be populated before most UI
// interactions occur (within ~1s on network, instantly from IndexedDB cache).
export const TRISTATE_MASTER_RAMPS = { SC: {}, GA: {}, NC: {} };

// Legacy parallel exports kept for any code that might reference them
export const TRISTATE_MASTER_BANK_PIER = [];
export const TRISTATE_MASTER_PADDLE    = [];
export const TRISTATE_MASTER_HOTSPOTS  = [];

// Promise that resolves when ramp data is fully loaded
let _resolveReady;
export const rampsReady = new Promise(resolve => { _resolveReady = resolve; });

// ── IDB helpers ───────────────────────────────────────────────────────────────
async function idbGet(key) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('TrollMapRamps', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess = e => {
      try {
        const tx = e.target.result.transaction(IDB_STORE, 'readonly');
        const r = tx.objectStore(IDB_STORE).get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(null);
      } catch { resolve(null); }
    };
    req.onerror = () => resolve(null);
  });
}

async function idbPut(key, value) {
  return new Promise((resolve) => {
    const req = indexedDB.open('TrollMapRamps', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess = e => {
      try {
        const tx = e.target.result.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch { resolve(false); }
    };
    req.onerror = () => resolve(false);
  });
}

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
  const STATES = ['SC', 'GA', 'NC'];
  const now = Date.now();

  // Cache shape is now: { SC: { data, fetchedAt }, GA: {...}, NC: {...} }
  let cached = null;
  try {
    cached = await idbGet(IDB_KEY);
  } catch (e) {
    console.warn('[ramps] IDB read failed:', e);
  }

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

      await idbPut(IDB_KEY, toCache);
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
