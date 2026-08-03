/**
 * test/fake-indexeddb.mjs — a small in-memory IndexedDB, enough for utils/db.js.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 *   import { installFakeIndexedDB } from './fake-indexeddb.mjs';
 *   installFakeIndexedDB();                 // before importing anything that opens the DB
 *
 * WHY THIS EXISTS
 *
 * Twelve modules persist through `utils/db.js`, and until 2026-08-03 they all reached it via
 * the `window.DB` global, which a test could stub with a plain object. That global is gone —
 * they use static imports now — so stubbing no longer works and the real `openDB()` runs.
 * `openDB()` needs `indexedDB`, which Node does not have, so every DB-backed module became
 * untestable at the moment it became correctly wired.
 *
 * Rather than weaken the tests to match, supply the missing browser API. This is not a
 * complete IndexedDB: no cursors, no indexes, no version-change blocking, no key ranges. It
 * implements exactly what `utils/db.js` calls — open with onupgradeneeded, createObjectStore
 * with keyPath and autoIncrement, and put/get/getAll/delete/clear on a transaction — because
 * a fake that pretends to do more than it does is a place for a test to pass wrongly.
 *
 * Requests resolve on a microtask, like the real thing, so code that attaches `onsuccess`
 * after calling still sees it fire.
 */

class FakeRequest {
  constructor() {
    this.onsuccess = null;
    this.onerror = null;
    this.onupgradeneeded = null;
    this.result = undefined;
    this.error = null;
  }

  _succeed(result) {
    this.result = result;
    queueMicrotask(() => this.onsuccess && this.onsuccess({ target: this }));
  }

  _fail(err) {
    this.error = err;
    queueMicrotask(() => this.onerror && this.onerror({ target: this }));
  }
}

class FakeObjectStore {
  constructor(name, opts, data) {
    this.name = name;
    this.keyPath = opts?.keyPath ?? null;
    this.autoIncrement = !!opts?.autoIncrement;
    this._data = data;          // Map, shared with the store's home so writes persist
    this._seq = 0;
  }

  _keyFor(obj) {
    if (!this.keyPath) return undefined;
    const k = obj?.[this.keyPath];
    if (k !== undefined && k !== null) return k;
    if (this.autoIncrement) {
      this._seq += 1;
      // Mirror IndexedDB: the generated key is written back onto the stored object.
      if (this.keyPath) obj[this.keyPath] = this._seq;
      return this._seq;
    }
    return undefined;
  }

  put(obj) {
    const r = new FakeRequest();
    try {
      const key = this._keyFor(obj);
      if (key === undefined) throw new Error(`no key for store "${this.name}"`);
      this._data.set(key, JSON.parse(JSON.stringify(obj)));
      r._succeed(key);
    } catch (e) { r._fail(e); }
    return r;
  }

  get(key) {
    const r = new FakeRequest();
    r._succeed(this._data.has(key) ? JSON.parse(JSON.stringify(this._data.get(key))) : undefined);
    return r;
  }

  getAll() {
    const r = new FakeRequest();
    r._succeed([...this._data.values()].map((v) => JSON.parse(JSON.stringify(v))));
    return r;
  }

  delete(key) {
    const r = new FakeRequest();
    this._data.delete(key);
    r._succeed(undefined);
    return r;
  }

  clear() {
    const r = new FakeRequest();
    this._data.clear();
    r._succeed(undefined);
    return r;
  }
}

class FakeDB {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this._stores = new Map();        // name -> { opts, data }
    this.objectStoreNames = {
      contains: (n) => this._stores.has(n),
      get length() { return 0; },
    };
  }

  createObjectStore(name, opts) {
    this._stores.set(name, { opts, data: new Map() });
    return new FakeObjectStore(name, opts, this._stores.get(name).data);
  }

  transaction(storeName) {
    const names = Array.isArray(storeName) ? storeName : [storeName];
    return {
      objectStore: (n) => {
        const home = this._stores.get(n);
        if (!home) throw new Error(`no object store "${n}"`);
        return new FakeObjectStore(n, home.opts, home.data);
      },
      _names: names,
    };
  }

  close() {}
}

const _databases = new Map();

/**
 * Install the fake on globalThis. Call BEFORE importing any module that opens the DB —
 * utils/db.js caches the handle on first open, so a late install is a no-op that looks like
 * a working one.
 *
 * @param {{reset?: boolean}} [opts] reset:true wipes stored data first, for test isolation.
 */
export function installFakeIndexedDB(opts = {}) {
  if (opts.reset) _databases.clear();

  const api = {
    open(name, version) {
      const req = new FakeRequest();
      let db = _databases.get(name);
      const isNew = !db || (version && db.version < version);
      if (!db) {
        db = new FakeDB(name, version || 1);
        _databases.set(name, db);
      } else if (version) {
        db.version = version;
      }
      queueMicrotask(() => {
        if (isNew && req.onupgradeneeded) req.onupgradeneeded({ target: { result: db } });
        req.result = db;
        if (req.onsuccess) req.onsuccess({ target: { result: db } });
      });
      return req;
    },
    deleteDatabase(name) {
      const r = new FakeRequest();
      _databases.delete(name);
      r._succeed(undefined);
      return r;
    },
  };

  globalThis.indexedDB = api;
  if (!globalThis.window) globalThis.window = globalThis;
  globalThis.window.indexedDB = api;
  return api;
}

/** Drop every stored database. Use between test files that share a process. */
export function resetFakeIndexedDB() {
  _databases.clear();
}
