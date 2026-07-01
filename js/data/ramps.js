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
 */

import { CF_WORKER_URL } from '../core/state.js';

const IDB_STORE = 'ramps_cache';
const IDB_KEY   = 'tristate_ramps';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── The live export — starts empty, populated async ──────────────────────────
// Consumers can use this directly; it will be populated before most UI
// interactions occur (within ~1s on network, instantly from IDB cache).
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

  // 1. Try IDB cache first — instant on subsequent loads
  try {
    const cached = await idbGet(IDB_KEY);
    if (cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
      for (const state of STATES) {
        if (cached[state]) TRISTATE_MASTER_RAMPS[state] = cached[state];
      }
      console.log(`[ramps] loaded from IDB cache (${Math.round((Date.now() - cached.fetchedAt) / 3600000)}h old)`);
      _resolveReady(TRISTATE_MASTER_RAMPS);
      // Still refresh in background if cache is >6 days old
      const ageDays = (Date.now() - cached.fetchedAt) / 86400000;
      if (ageDays < 6) return;
      console.log('[ramps] cache >6 days old, refreshing in background...');
    }
  } catch (e) {
    console.warn('[ramps] IDB read failed:', e);
  }

  // 2. Fetch from worker — parallel requests for all three states
  try {
    const results = await Promise.allSettled(STATES.map(s => fetchState(s)));
    const toCache = { fetchedAt: Date.now() };
    let anySuccess = false;

    results.forEach((result, i) => {
      const state = STATES[i];
      if (result.status === 'fulfilled') {
        mergeWorkerData(state, result.value);
        toCache[state] = TRISTATE_MASTER_RAMPS[state];
        anySuccess = true;
        console.log(`[ramps] ${state}: ${result.value.count || '?'} ramps across ${result.value.waterbodyCount || '?'} waterbodies`);
      } else {
        console.warn(`[ramps] ${state} fetch failed:`, result.reason?.message);
      }
    });

    if (anySuccess) {
      await idbPut(IDB_KEY, toCache);
      console.log('[ramps] saved to IDB cache');
    }
  } catch (e) {
    console.warn('[ramps] worker fetch failed:', e);
  }

  _resolveReady(TRISTATE_MASTER_RAMPS);
}

// Kick off immediately — don't block module loading
initRamps().catch(e => {
  console.warn('[ramps] init error:', e);
  _resolveReady(TRISTATE_MASTER_RAMPS);
});
