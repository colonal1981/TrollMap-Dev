/**
 * IndexedDB layer for TrollMap persistence.
 *
 * Stores:
 *   layers    — imported GeoJSON/KML/GPX layers
 *   charts    — imported depth-contour tile overlays
 *   gpx       — saved working GPX data (waypoints + tracks)
 *   settings  — keyed config (gear profile, lake levels, etc.)
 *   sonar     — reserved (sonar import not active)
 *   plans     — saved fishing trip plans
 *   spreads   — saved rod-spread configurations
 *   journal   — catch log entries
 *
 * DB version: 5. Data persists indefinitely unless the user clears
 * site data from the browser.
 */

const DB_NAME = 'TrollMapDB';
// v6 adds `cache`. Three modules -- ramps-loader, contour-data and supplemental-layers -- each
// opened their OWN IndexedDB database (TrollMapRamps, trollmap_contours,
// trollmap-supplemental) with their own copy of open/get/put and their own silent catches.
// All three hold nothing but re-fetchable data, so they fold in here with no migration: the
// worst case is one refetch. `trollmap-tackle` is deliberately NOT folded -- it holds Ryan's
// own inventory, which cannot be regenerated, and moving it needs a real migration rather
// than a version bump.
const DB_VERSION = 6;

let _db = null;

/**
 * Open (or upgrade) the IndexedDB database. Resolves with the IDBDatabase
 * instance once ready. Caches the instance for future calls.
 *
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  if (_db) return Promise.resolve(_db);
  if (!window.indexedDB) return Promise.reject(new Error('IndexedDB not supported'));

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('layers'))   db.createObjectStore('layers',   { keyPath: 'name' });
      if (!db.objectStoreNames.contains('charts'))    db.createObjectStore('charts',    { keyPath: 'name' });
      if (!db.objectStoreNames.contains('gpx'))       db.createObjectStore('gpx',       { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('settings'))  db.createObjectStore('settings',  { keyPath: 'key' });
      if (!db.objectStoreNames.contains('sonar'))     db.createObjectStore('sonar',     { keyPath: 'name' });
      if (!db.objectStoreNames.contains('plans'))     db.createObjectStore('plans',     { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('spreads'))   db.createObjectStore('spreads',   { keyPath: 'name' });
      if (!db.objectStoreNames.contains('journal'))   db.createObjectStore('journal',   { keyPath: 'name' });
      if (!db.objectStoreNames.contains('cache'))     db.createObjectStore('cache',     { keyPath: 'key' });
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = (e) => reject(e.target.error || new Error('IndexedDB open failed'));
  });
}

/**
 * Is the database actually open right now?
 *
 * WHY THIS EXISTS. Twelve modules guarded their DB work with `if (!window.DB?.db) return;`,
 * which reads exactly like "bail if the database is not ready" and **can never be true**.
 * `window.DB.db` was a getter returning `openDB()` -- a Promise, and a Promise is always
 * truthy. So the guard never fired; the code fell through and called put/get, which silently
 * no-op when `_db` is null (returning null, [] or undefined). "The database is not open yet"
 * and "the store is empty" were indistinguishable to every caller in the app.
 *
 * Synchronous on purpose: it replaces a synchronous test. Anything that wants to WAIT should
 * await `ready()` instead of polling this.
 */
export function isReady() {
  return !!_db;
}


/**
 * Get the open database, opening it if this is the first call.
 *
 * WHY EVERY OPERATION GOES THROUGH THIS NOW. Each function below used to begin
 * `if (!_db) return Promise.resolve()`. For a read that is defensible -- you get the empty
 * answer. For a WRITE it is not: the promise resolved, so `await dbPut(...)` succeeded, the
 * caller carried on and told the user the thing was saved, and nothing had been written.
 * Any write issued before IndexedDB finished opening -- which on mobile is most of the first
 * second after load -- was dropped and reported as a success.
 *
 * Awaiting the open instead turns that whole class into a non-event: the write waits the few
 * milliseconds and then happens. What is left is a database that genuinely cannot open
 * (private browsing, blocked storage, a failed upgrade), and that is a real failure which
 * writes now reject on rather than paper over.
 *
 * @param {string} op    operation name, for the error message
 * @param {string} store store name, for the error message
 */
async function withDb(op, store) {
  if (_db) return _db;
  try {
    return await openDB();
  } catch (err) {
    const e = new Error(`IndexedDB unavailable — ${op} on "${store}" did not happen: ${err && err.message}`);
    e.cause = err;
    throw e;
  }
}

/**
 * Reads keep their empty default, because for a read there is a sensible empty answer and no
 * data is at risk. They do not keep their silence: "this store is empty" and "this database
 * will not open" produce the same value, so the only way to tell them apart is the log.
 */
function readFailed(op, store, err) {
  console.warn(`[db] ${op} on "${store}" failed, returning the empty result:`, err && err.message);
}

/**
 * Put an object into a store. Resolves with the new/updated key.
 *
 * Rejects if the database cannot be opened. Callers that catch this must not report the
 * write as successful -- that is the exact bug this function used to have on their behalf.
 *
 * @param {string} store
 * @param {Object} obj
 */
export async function put(store, obj) {
  const db = await withDb('put', store);
  return new Promise((resolve, reject) => {
    try {
      const r = db.transaction(store, 'readwrite').objectStore(store).put(obj);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error(`put on "${store}" failed`));
    } catch (e) { reject(e); }
  });
}

/**
 * Get one record by key. Returns null if not found, or if the database is unavailable.
 * @param {string} store
 * @param {*} key
 */
export async function get(store, key) {
  let db;
  try { db = await withDb('get', store); }
  catch (err) { readFailed('get', store, err); return null; }
  return new Promise((resolve) => {
    try {
      const r = db.transaction(store).objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => { readFailed('get', store, r.error); resolve(null); };
    } catch (e) { readFailed('get', store, e); resolve(null); }
  });
}

/**
 * Get all records from a store. Returns [] if the database is unavailable.
 * @param {string} store
 */
export async function getAll(store) {
  let db;
  try { db = await withDb('getAll', store); }
  catch (err) { readFailed('getAll', store, err); return []; }
  return new Promise((resolve) => {
    try {
      const r = db.transaction(store).objectStore(store).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => { readFailed('getAll', store, r.error); resolve([]); };
    } catch (e) { readFailed('getAll', store, e); resolve([]); }
  });
}

/**
 * Delete one record by key. Rejects if the database cannot be opened.
 */
export async function del(store, key) {
  const db = await withDb('delete', store);
  return new Promise((resolve, reject) => {
    try {
      const r = db.transaction(store, 'readwrite').objectStore(store).delete(key);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error || new Error(`delete on "${store}" failed`));
    } catch (e) { reject(e); }
  });
}

/**
 * Clear all records from a store. Rejects if the database cannot be opened.
 */
export async function clear(store) {
  const db = await withDb('clear', store);
  return new Promise((resolve, reject) => {
    try {
      const r = db.transaction(store, 'readwrite').objectStore(store).clear();
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error || new Error(`clear on "${store}" failed`));
    } catch (e) { reject(e); }
  });
}

// ── reporting a failed write, in one place ───────────────────────────────────
//
// Fifteen call sites wrote `try { await dbPut(...) } catch (_) {}`. Fifteen copies of the
// same three lines, and fifteen separate decisions to say nothing. Collapsing them onto one
// helper is not only less code: it means "a save failed" has exactly ONE implementation, so
// wiring a toast to it later is a change to this file rather than a hunt through the app.

let _onWriteFailure = null;

/**
 * Register the app-level handler for a failed write -- a toast, a banner, whatever the UI
 * wants. Called with (what, error). Setting it is optional; the console message happens
 * either way, so a failure is never invisible even before any UI exists.
 */
export function onWriteFailure(fn) {
  _onWriteFailure = typeof fn === 'function' ? fn : null;
}

function reportWriteFailure(what, err) {
  console.error(`[db] save failed — ${what}:`, err && err.message);
  if (_onWriteFailure) {
    try {
      _onWriteFailure(what, err);
    } catch (hookErr) {
      // A broken notifier must not also eat the original failure, which is the more
      // important of the two.
      console.error('[db] onWriteFailure handler itself threw:', hookErr && hookErr.message);
    }
  }
}

/**
 * Write, reporting rather than swallowing a failure. Returns true if the record landed.
 *
 * Use this where the old code had `try { await dbPut(...) } catch (_) {}`. The boolean lets a
 * caller that shows the user a confirmation check first; a caller that genuinely does not
 * care can ignore it and still gets the log.
 *
 * @param {string} store
 * @param {Object} obj
 * @param {string} [what] human description for the message, e.g. 'catch journal'
 */
export async function tryPut(store, obj, what) {
  try {
    await put(store, obj);
    return true;
  } catch (err) {
    reportWriteFailure(what || `put "${store}"`, err);
    return false;
  }
}

/**
 * Delete, reporting rather than swallowing a failure. Returns true if the record is gone.
 */
export async function tryDel(store, key, what) {
  try {
    await del(store, key);
    return true;
  } catch (err) {
    reportWriteFailure(what || `delete "${store}"`, err);
    return false;
  }
}

// ── the shared cache store ───────────────────────────────────────────────────
//
// One store, namespaced by caller, replacing three separate databases that each re-implemented
// the same forty lines. Namespacing rather than a store per caller keeps adding a new cache
// from being a schema migration -- `cacheSet('routes', ...)` just works, no DB_VERSION bump,
// which is the whole reason those three modules opened their own databases in the first place.

const CACHE_STORE = 'cache';
const NS_SEP = '::';

const cacheId = (ns, key) => `${ns}${NS_SEP}${key}`;

/**
 * Read a cached value. Returns null when absent, expired, or unreadable -- all three are
 * "you will have to fetch it", which is the only thing a cache caller can act on.
 *
 * @param {string} ns       namespace, e.g. 'contours'
 * @param {string} key
 * @param {number} [maxAgeMs] treat anything older as absent
 */
export async function cacheGet(ns, key, maxAgeMs) {
  const rec = await get(CACHE_STORE, cacheId(ns, key));
  if (!rec) return null;
  if (maxAgeMs && rec.ts && Date.now() - rec.ts > maxAgeMs) return null;
  return rec.value ?? null;
}

/**
 * Write a cached value. Returns true if it landed.
 *
 * A failed cache write is genuinely low-stakes -- the answer is still correct, it will just be
 * refetched -- so this reports through the same path as every other write rather than
 * inventing a quieter one. If a cache write fails EVERY time, the app silently refetches
 * everything forever, and that is worth one line in the console.
 */
export async function cacheSet(ns, key, value) {
  return tryPut(CACHE_STORE, { key: cacheId(ns, key), value, ts: Date.now() }, `cache ${ns}/${key}`);
}

/**
 * Drop everything in one namespace, leaving the other namespaces alone.
 *
 * Reads the keys and deletes them one at a time rather than using a cursor, because the whole
 * point of sharing a store is that clearing one caller's cache must not clear another's --
 * and `objectStore.clear()` cannot tell them apart.
 */
export async function cacheClear(ns) {
  const prefix = `${ns}${NS_SEP}`;
  let rows;
  try {
    rows = await getAll(CACHE_STORE);
  } catch (err) {
    reportWriteFailure(`cache clear "${ns}"`, err);
    return false;
  }
  const mine = rows.filter((r) => typeof r.key === 'string' && r.key.startsWith(prefix));
  const results = await Promise.all(mine.map((r) => tryDel(CACHE_STORE, r.key, `cache ${r.key}`)));
  return results.every(Boolean);
}

/**
 * Open the DB and run a callback when it's ready.
 * Soft-warns and retries once if the initial open fails (this matches
 * the original code's tolerance for slow IndexedDB startup on mobile).
 */
export async function ready(onReady) {
  try {
    await openDB();
    await onReady();
  } catch (e) {
    console.warn('[TrollMap] IndexedDB open failed, retrying once…', e);
    setTimeout(async () => {
      if (_db) await onReady();
    }, 1200);
  }
}
