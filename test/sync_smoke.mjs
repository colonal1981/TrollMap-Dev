/**
 * sync_smoke.mjs -- prove a deleted plan actually tombstones in the cloud.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 *   node sync_smoke.mjs <candidate js tree>
 *
 * WHY: the bug this guards against was invisible from the UI. plan-builder.js sent a DELETE
 * with the wrong X-Sync-Token, the worker answered 401, and `.catch(() => {})` ate it. The
 * plan vanished from the library, the server never learned it was deleted, and the next page
 * load pulled it straight back. Nothing logged, nothing rendered wrong -- you only saw it if
 * you deleted a plan and then reloaded.
 *
 * So the test asserts on the WIRE: what method, what URL, what token. `fetch` and `window.DB`
 * are stubbed; everything else is the shipped module.
 */
import { pathToFileURL } from 'node:url';
import { installFakeIndexedDB, resetFakeIndexedDB } from './fake-indexeddb.mjs';

const _here = new URL('.', import.meta.url).pathname;
const treeRoot = process.argv[2] || _here.replace(/\/test\/$/, '/') + 'js';

const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), method: opts.method || 'GET',
               token: (opts.headers || {})['X-Sync-Token'], body: opts.body });
  return { ok: replyOk, status: replyOk ? 200 : 401, json: async () => ({ items: [] }) };
};
let replyOk = true;

// Minimal DOM + a real-enough IndexedDB so the module loads and the offline queue works.
//
// This used to stub `window.DB` with a plain object. Stage 4 deleted that global on
// 2026-08-03 and cloud-sync.js now imports utils/db.js statically, so the stub
// connected to nothing: dbPut() failed into a swallowed catch, the queue silently
// stayed empty, and the five wire assertions above kept passing. A check that goes
// half-dead is worse than one that dies outright. Use the same shim the ported
// tests use.
globalThis.window = globalThis;
globalThis.document = { getElementById: () => null };
installFakeIndexedDB();

const sync = await import(pathToFileURL(`${treeRoot}/modules/cloud-sync.js`).href);
// same module instance cloud-sync writes through, so the queue is observable
const _db = await import(pathToFileURL(`${treeRoot}/utils/db.js`).href);
// The app opens the database at boot (main.js). Nothing opens it implicitly, and
// isReady() is `!!_db`, so a test that skips this sees every put() no-op silently --
// exactly the failure Stage 4's honest isReady() was added to expose.
await _db.openDB();
const dbGet = _db.get;

let fails = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`);
  else { console.log(`  FAIL  ${name}  ${detail}`); fails++; }
};
const settle = () => new Promise((r) => setTimeout(r, 20));

console.log('-- deleteItemOnDelete is exported and reaches window --');
check('module exports it', typeof sync.deleteItemOnDelete === 'function');
check('window alias present', typeof window.deleteItemOnDelete === 'function');

console.log('\n-- a delete goes out as DELETE, with the real token --');
calls.length = 0;
sync.deleteItemOnDelete('plan', 'wateree_pre_dawn');
await settle();
const d = calls[0] || {};
check('exactly one request', calls.length === 1, `${calls.length} sent`);
check('method is DELETE', d.method === 'DELETE', d.method);
check('token is trollmap2026', d.token === 'trollmap2026', String(d.token));
check('token is NOT the phantom literal', d.token !== 'trollmap-sync-9a8b7c6d5e');
check('url targets the item route', /\/sync\/item\/plan\/wateree_pre_dawn$/.test(d.url || ''), d.url);

console.log('\n-- push still works and still uses the same token --');
calls.length = 0;
sync.pushItemOnSave('plan', 'wateree_pre_dawn', { meta: { name: 'x' } });
await settle();
const p = calls[0] || {};
check('method is POST', p.method === 'POST', p.method);
check('same token as delete', p.token === d.token, `${p.token} vs ${d.token}`);

console.log('\n-- charts never hit D1 --');
calls.length = 0;
sync.deleteItemOnDelete('chart', 'anything');
sync.pushItemOnSave('chart', 'anything', {});
await settle();
check('no request sent for chart', calls.length === 0, `${calls.length} sent`);

console.log('\n-- a blank id is refused rather than hitting /sync/item/plan/ --');
calls.length = 0;
sync.deleteItemOnDelete('plan', '');
await settle();
check('nothing sent', calls.length === 0, `${calls.length} sent`);

console.log('\n-- THE REGRESSION THAT MATTERS: a queued delete must replay as DELETE --');
// A failed tombstone goes into pending_sync. If the drain replays it as a POST it RESURRECTS
// the record it was meant to bury -- worse than the original bug, because it looks like sync
// is working.
resetFakeIndexedDB();   // was store.clear() on the old hand-rolled stub
replyOk = false;                       // worker unreachable / 401
calls.length = 0;
sync.deleteItemOnDelete('plan', 'ghost_plan');
await settle();
const queued = (await dbGet('settings', 'pending_sync'))?.queue || [];   // read the real store, not a stub
check('delete was queued', queued.length === 1, JSON.stringify(queued));
check('queue entry is marked deleted', queued[0]?.deleted === true, JSON.stringify(queued[0]));

replyOk = true;                        // back online
calls.length = 0;
sync.pushItemOnSave('plan', 'other', { meta: { name: 'y' } });   // success -> drains the queue
await settle();
await settle();
const replay = calls.find((c) => /ghost_plan/.test(c.url));
check('queued item was replayed', !!replay, replay ? replay.method : 'never replayed');
check('replayed as DELETE, not POST', replay?.method === 'DELETE',
  replay ? `replayed as ${replay.method}` : 'n/a');
check('replay carried the token', replay?.token === 'trollmap2026', String(replay?.token));

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall checks passed');
process.exit(fails ? 1 : 0);
