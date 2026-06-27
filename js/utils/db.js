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
const DB_VERSION = 5;

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
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = (e) => reject(e.target.error || new Error('IndexedDB open failed'));
  });
}

function tx(store, mode = 'readonly') {
  if (!_db) throw new Error('DB not open');
  return _db.transaction(store, mode).objectStore(store);
}

/**
 * Put an object into a store. Resolves with the new/updated key.
 * @param {string} store
 * @param {Object} obj
 */
export function put(store, obj) {
  if (!_db) return Promise.resolve();
  return new Promise((resolve, reject) => {
    try {
      const r = tx(store, 'readwrite').put(obj);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    } catch (e) { reject(e); }
  });
}

/**
 * Get one record by key. Returns null if not found.
 * @param {string} store
 * @param {*} key
 */
export function get(store, key) {
  if (!_db) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    try {
      const r = tx(store).get(key);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => reject(r.error);
    } catch (e) { reject(e); }
  });
}

/**
 * Get all records from a store.
 * @param {string} store
 */
export function getAll(store) {
  if (!_db) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    try {
      const r = tx(store).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    } catch (e) { reject(e); }
  });
}

/**
 * Delete one record by key.
 */
export function del(store, key) {
  if (!_db) return Promise.resolve();
  return new Promise((resolve, reject) => {
    try {
      const r = tx(store, 'readwrite').delete(key);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    } catch (e) { reject(e); }
  });
}

/**
 * Clear all records from a store.
 */
export function clear(store) {
  if (!_db) return Promise.resolve();
  return new Promise((resolve, reject) => {
    try {
      const r = tx(store, 'readwrite').clear();
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    } catch (e) { reject(e); }
  });
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
