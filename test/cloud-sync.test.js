/**
 * test/cloud-sync.test.js -- a deleted plan must actually tombstone in the cloud.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 *   node --test test/
 *
 * WHY THIS FILE EXISTS
 *
 * `plan-builder.js` used to hand-roll its own DELETE with
 * `X-Sync-Token: 'trollmap-sync-9a8b7c6d5e'`, a literal found nowhere else in the app. The
 * worker's isAuthorized() is a strict `got === want` against 'trollmap2026', so every one of
 * those came back 401 -- and the call site swallowed it with `.catch(() => {})`.
 *
 * Nothing logged. Nothing rendered wrong. The plan vanished from the library, the server never
 * learned it was deleted, and pullUpdatesOnLoad() restored it on the next page load. You only
 * ever saw it by deleting a plan and then reloading.
 *
 * So this asserts on the WIRE -- method, URL, token -- because that is the layer where the bug
 * lived. `fetch` and `window.DB` are stubbed; everything else is the shipped module.
 */
import { describe, it, expect } from './expect-shim.mjs';
import { installFakeIndexedDB } from './fake-indexeddb.mjs';

// BEFORE importing cloud-sync.js. It reaches utils/db.js by static import now, and
// utils/db.js caches the database handle on first open -- install late and the fake is
// ignored while the test still appears to work.
installFakeIndexedDB({ reset: true });

const calls = [];
let replyOk = true;

globalThis.window = globalThis;
globalThis.document = { getElementById: () => null };
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), method: opts.method || 'GET',
               token: (opts.headers || {})['X-Sync-Token'] });
  return { ok: replyOk, status: replyOk ? 200 : 401, json: async () => ({ items: [] }) };
};

// The real db module against the fake IndexedDB -- cloud-sync's offline queue is a genuine
// `settings/pending_sync` record now, not a stub's Map.
const db = await import('../js/utils/db.js');
await db.openDB();

const sync = await import('../js/modules/cloud-sync.js');
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('cloud-sync — the tombstone reaches the worker', () => {
  it('exports deleteItemOnDelete and exposes it on window', () => {
    expect(typeof sync.deleteItemOnDelete).toBe('function');
    expect(typeof window.deleteItemOnDelete).toBe('function');
  });

  it('sends DELETE with the real token', async () => {
    calls.length = 0;
    sync.deleteItemOnDelete('plan', 'wateree_pre_dawn');
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].token).toBe('trollmap2026');
    expect(calls[0].url).toMatch(/\/sync\/item\/plan\/wateree_pre_dawn$/);
  });

  it('never sends the phantom literal again', async () => {
    calls.length = 0;
    sync.deleteItemOnDelete('plan', 'x');
    sync.pushItemOnSave('plan', 'x', { meta: { name: 'x' } });
    await settle();
    expect(calls.map((c) => c.token)).toEqual(['trollmap2026', 'trollmap2026']);
  });

  it('push and delete agree on the token', async () => {
    calls.length = 0;
    sync.deleteItemOnDelete('plan', 'a');
    sync.pushItemOnSave('plan', 'a', { meta: { name: 'a' } });
    await settle();
    expect(calls[0].token).toBe(calls[1].token);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[1].method).toBe('POST');
  });
});

describe('cloud-sync — requests that must not be sent', () => {
  it('charts never reach D1 — they live in R2', async () => {
    calls.length = 0;
    sync.deleteItemOnDelete('chart', 'anything');
    sync.pushItemOnSave('chart', 'anything', {});
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('a blank id is refused rather than hitting /sync/item/plan/', async () => {
    // The worker's item route is /sync/item/:type/:id and will not match an empty id, so this
    // would 404 silently. plan-builder's delete path could produce one before the key
    // derivation was shared with the save path.
    calls.length = 0;
    sync.deleteItemOnDelete('plan', '');
    await settle();
    expect(calls).toHaveLength(0);
  });
});

describe('cloud-sync — a queued delete replays as a DELETE', () => {
  // THE REGRESSION THAT WOULD HURT MOST. A failed tombstone goes into pending_sync. If the
  // drain replays it as a POST it RESURRECTS the record it was meant to bury -- worse than the
  // original bug, because from the outside sync looks like it is working.
  it('queues the delete when the worker rejects it', async () => {
    await db.clear('settings');
    replyOk = false;
    calls.length = 0;
    sync.deleteItemOnDelete('plan', 'ghost_plan');
    await settle();
    const queue = (await db.get('settings', 'pending_sync'))?.queue || [];
    expect(queue).toHaveLength(1);
    expect(queue[0].deleted).toBe(true);
  });

  it('replays it as DELETE, not POST, once back online', async () => {
    replyOk = true;
    calls.length = 0;
    sync.pushItemOnSave('plan', 'other', { meta: { name: 'y' } });  // success drains the queue
    await settle();
    await settle();
    const replay = calls.find((c) => /ghost_plan/.test(c.url));
    expect(replay).toBeDefined();
    expect(replay.method).toBe('DELETE');
    expect(replay.token).toBe('trollmap2026');
  });
});
