/**
 * test/db-writes.test.js — a write either happened or it did not, and the caller must be able
 * to tell which.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS FILE EXISTS
 *
 * `put`, `del` and `clear` all began with `if (!_db) return Promise.resolve()`. Resolving is
 * how a promise says "done". So a write issued before IndexedDB had finished opening --
 * which on a phone is most of the first second after load, and every single time the app is
 * opened cold at a boat ramp -- resolved successfully, the caller carried on, and nothing was
 * written. Fifteen call sites then wrapped that in `catch (_) {}`, so even a genuine failure
 * afterwards had nowhere to surface.
 *
 * The behaviour under test: a write waits for the database rather than skipping itself, and
 * when the database truly cannot be opened the write REJECTS instead of claiming success.
 * Reads keep their empty default -- there is no data at risk in a read -- but say so.
 */
import { describe, it, expect } from './expect-shim.mjs';
import { installFakeIndexedDB, resetFakeIndexedDB } from './fake-indexeddb.mjs';

let freshCount = 0;
/** utils/db.js caches its handle in module scope, so each case needs its own instance. */
async function freshDb() {
  return import(`../js/utils/db.js?w=${++freshCount}`);
}

describe('db writes — a write issued before the database opens still lands', () => {
  it('put() resolves AFTER the record is actually readable', async () => {
    resetFakeIndexedDB();
    installFakeIndexedDB({ reset: true });
    const db = await freshDb();

    // The regression, exactly: write without awaiting openDB() first. The old code saw
    // _db === null here and resolved without doing anything.
    expect(db.isReady()).toBe(false);
    await db.put('journal', { name: 'catches', data: [{ species: 'striper', lengthIn: 31 }] });

    const back = await db.get('journal', 'catches');
    expect(back).not.toBe(null);
    expect(back.data[0].species).toBe('striper');
  });

  it('the database is open once the first write completes', async () => {
    resetFakeIndexedDB();
    installFakeIndexedDB({ reset: true });
    const db = await freshDb();
    await db.put('settings', { key: 'gear', motor: 'terrova' });
    expect(db.isReady()).toBe(true);
  });

  it('del() and clear() also wait rather than no-op', async () => {
    resetFakeIndexedDB();
    installFakeIndexedDB({ reset: true });
    const db = await freshDb();

    await db.put('spreads', { name: 'summer', rods: 4 });
    await db.put('spreads', { name: 'winter', rods: 2 });
    expect((await db.getAll('spreads')).length).toBe(2);

    await db.del('spreads', 'summer');
    expect((await db.getAll('spreads')).length).toBe(1);

    await db.clear('spreads');
    expect((await db.getAll('spreads')).length).toBe(0);
  });
});

describe('db writes — an unopenable database is a failure, not a success', () => {
  /** Remove indexedDB entirely: this is private-browsing / blocked-storage. */
  function breakIndexedDB() {
    resetFakeIndexedDB();
    globalThis.window = globalThis;
    delete globalThis.indexedDB;
    delete globalThis.window.indexedDB;
  }

  it('put() rejects instead of pretending the write happened', async () => {
    breakIndexedDB();
    const db = await freshDb();

    let rejected = false;
    let message = '';
    try {
      await db.put('journal', { name: 'catches', data: [{ species: 'redfish' }] });
    } catch (err) {
      rejected = true;
      message = String(err && err.message);
    }

    expect(rejected).toBe(true);
    // The message has to name the operation and the store, or a caller that logs it learns
    // only that "something" failed.
    expect(/put/.test(message)).toBe(true);
    expect(/journal/.test(message)).toBe(true);
    expect(/did not happen/.test(message)).toBe(true);
  });

  it('del() and clear() reject too', async () => {
    breakIndexedDB();
    const db = await freshDb();

    let delRejected = false, clearRejected = false;
    try { await db.del('plans', 1); } catch { delRejected = true; }
    try { await db.clear('plans'); } catch { clearRejected = true; }

    expect(delRejected).toBe(true);
    expect(clearRejected).toBe(true);
  });

  it('reads return their empty value rather than throwing', async () => {
    breakIndexedDB();
    const db = await freshDb();

    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
      expect(await db.get('settings', 'gear')).toBe(null);
      expect(await db.getAll('plans')).toEqual([]);
    } finally {
      console.warn = realWarn;
    }

    // Empty-because-broken must be distinguishable from empty-because-empty, and the log is
    // the only channel a read has for saying which one it is.
    expect(warnings.length).toBe(2);
    expect(/get.*settings/.test(warnings[0])).toBe(true);
    expect(/getAll.*plans/.test(warnings[1])).toBe(true);
  });

  it('a healthy read on an empty store does NOT warn', async () => {
    // The other half of the previous test: the log must mean something.
    resetFakeIndexedDB();
    installFakeIndexedDB({ reset: true });
    const db = await freshDb();

    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
      expect(await db.get('settings', 'never-written')).toBe(null);
      expect(await db.getAll('plans')).toEqual([]);
    } finally {
      console.warn = realWarn;
    }
    expect(warnings.length).toBe(0);
  });
});

describe('the shared cache store — one store, namespaced, replacing three databases', () => {
  it('round-trips a value and unwraps it', async () => {
    resetFakeIndexedDB();
    installFakeIndexedDB({ reset: true });
    const db = await freshDb();

    await db.cacheSet('contours', 'lake_murray', { type: 'FeatureCollection', features: [1, 2] });
    const got = await db.cacheGet('contours', 'lake_murray');
    // cacheGet returns the VALUE, not the {key, value, ts} envelope. Three call sites read
    // `cached.value` off the old bespoke stores; getting this wrong would have handed every
    // one of them an object with no .features and looked exactly like an empty cache.
    expect(got.features.length).toBe(2);
  });

  it('a miss is null', async () => {
    resetFakeIndexedDB();
    installFakeIndexedDB({ reset: true });
    const db = await freshDb();
    expect(await db.cacheGet('contours', 'never_cached')).toBe(null);
  });

  it('namespaces do not collide on the same key', async () => {
    resetFakeIndexedDB();
    installFakeIndexedDB({ reset: true });
    const db = await freshDb();

    await db.cacheSet('contours', 'shared_key', 'from-contours');
    await db.cacheSet('supplemental', 'shared_key', 'from-supplemental');

    expect(await db.cacheGet('contours', 'shared_key')).toBe('from-contours');
    expect(await db.cacheGet('supplemental', 'shared_key')).toBe('from-supplemental');
  });

  it('maxAge treats a stale entry as absent', async () => {
    resetFakeIndexedDB();
    installFakeIndexedDB({ reset: true });
    const db = await freshDb();

    await db.cacheSet('ramps', 'tristate', { SC: {} });
    expect(await db.cacheGet('ramps', 'tristate', 60_000)).not.toBe(null);
    // Zero max age means everything is already too old.
    expect(await db.cacheGet('ramps', 'tristate', -1)).toBe(null);
    // No maxAge at all means the caller does its own freshness check, as ramps-loader does
    // per state -- it must NOT be filtered here.
    expect(await db.cacheGet('ramps', 'tristate')).not.toBe(null);
  });

  it('cacheClear drops one namespace and leaves the others', async () => {
    resetFakeIndexedDB();
    installFakeIndexedDB({ reset: true });
    const db = await freshDb();

    await db.cacheSet('contours', 'a', 1);
    await db.cacheSet('contours', 'b', 2);
    await db.cacheSet('ramps', 'tristate', 3);

    await db.cacheClear('contours');

    // The whole reason for namespacing: "clear contour cache" used to be
    // objectStore.clear() on a database contours had to itself. In a shared store that
    // would take the ramp list and every other cache with it.
    expect(await db.cacheGet('contours', 'a')).toBe(null);
    expect(await db.cacheGet('contours', 'b')).toBe(null);
    expect(await db.cacheGet('ramps', 'tristate')).toBe(3);
  });

  it('the cache lives alongside the real stores, not instead of them', async () => {
    resetFakeIndexedDB();
    installFakeIndexedDB({ reset: true });
    const db = await freshDb();

    // v6 added `cache` to TrollMapDB. The catch journal has to survive that upgrade.
    await db.put('journal', { name: 'catches', data: [{ species: 'crappie' }] });
    await db.cacheSet('contours', 'lake_murray', { features: [] });
    await db.cacheClear('contours');

    const catches = await db.get('journal', 'catches');
    expect(catches.data[0].species).toBe('crappie');
  });
});
