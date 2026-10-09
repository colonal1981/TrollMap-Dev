// A CHANGE ON ONE DEVICE REACHES THE OTHERS.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-09, after 25 fish were renamed in his Chrome journal (13 white perch, 11 stripers and
// a largemouth that had all been filed as White Bass / Hybrid): "and the next thing is how to make this
// persist wherever i open it... either storing in r2 or something else...". The journal was already in
// the cloud. A pull added only the fish a device lacked, so the names stayed changed only in Chrome; a
// save sent the device's whole journal over the cloud's, so a phone that had not caught up put the old
// names back; a deleted fish came back from any device that still had it. Asked whether the fix was
// this -- every fish carries when it was last changed, the later change wins, a deleted fish is
// remembered as deleted, and the Worker uses the same rule -- "yes".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stampJournal, mergeJournals, catchKey, PHOTO_FIELDS } from '../js/utils/journal-merge.js';
import { handleSyncPush } from '../Worker/trollmap-worker.js';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const T1 = '2026-10-09T20:00:00.000Z', T2 = '2026-10-09T21:00:00.000Z', T3 = '2026-10-09T22:00:00.000Z';
const T4 = '2026-10-09T23:00:00.000Z';

const perch = () => ({ species: 'White Bass / Hybrid', length: '9', date: '2026-10-09', time: '9:23 AM',
  lat: '33.62', lon: '-80.21', lake: 'Lake Marion', sourceFile: 'PXL_20261009_132300.jpg' });
const striper = () => ({ species: 'White Bass / Hybrid', length: '21', date: '2025-01-25', time: '2:33 PM',
  lat: '33.26', lon: '-80.01', sourceFile: 'PXL_20250125_193358428.jpg' });
const bass = () => ({ species: 'Largemouth Bass', length: '17', date: '2026-06-01', time: '7:10 AM', lat: '33.9', lon: '-80.4' });
const byKey = (cs) => Object.fromEntries(cs.map((c) => [catchKey(c), c]));

test('a save stamps the fish that changed and the fish that are new, and nothing else', () => {
  const before = [perch(), striper(), bass()];
  const after = [{ ...perch(), species: 'White Perch' }, striper(), { ...bass(), thumbDataUrl: 'data:x' },
                 { ...bass(), time: '8:00 AM', sourceFile: 'PXL_new.jpg' }];
  // the same fish written in another field order is the same fish
  after[1] = Object.fromEntries(Object.entries(after[1]).reverse());
  const r = stampJournal(before, after, {}, T1);
  assert.equal(r.stamped, 2);
  assert.equal(after[0].editedAt, T1, 'renamed');
  assert.equal(after[1].editedAt, undefined, 'unchanged, in another order');
  assert.equal(after[2].editedAt, undefined, 'a picture is not a change to the fish');
  assert.equal(after[3].editedAt, T1, 'new');
  // a stamp it already had is kept, and is not itself a change
  const again = stampJournal(after.map((c) => ({ ...c })), after, r.removed, T2);
  assert.equal(again.stamped, 0);
  assert.equal(after[0].editedAt, T1);
  assert.deepEqual(PHOTO_FIELDS, ['photoDataUrl', 'lurePhotoDataUrl', 'thumbDataUrl']);
});

test('a deleted fish is remembered with the time, and one that comes back is taken off the list', () => {
  const before = [perch(), striper(), bass()];
  const r = stampJournal(before, [perch(), bass()], {}, T1);
  assert.deepEqual(r.removed, { [catchKey(striper())]: T1 });
  const back = [perch(), bass(), striper()];
  const r2 = stampJournal([perch(), bass()], back, r.removed, T2);
  assert.deepEqual(r2.removed, {});
  assert.equal(back[2].editedAt, T2, 'a fish imported again is new, so it wins over its delete');
});

test('the copy changed later wins, from either side; with neither changed later, the copy already there stays', () => {
  const here = { data: [{ ...perch(), species: 'White Perch', editedAt: T1 }, striper(), { ...bass(), lure: 'Spook' }] };
  const there = { data: [perch(), { ...striper(), species: 'Striped Bass', editedAt: T2 }, { ...bass(), lure: '' }] };
  const m = byKey(mergeJournals(here, there).catches);
  assert.equal(m[catchKey(perch())].species, 'White Perch', 'stamped here beats unstamped there');
  assert.equal(m[catchKey(striper())].species, 'Striped Bass', 'stamped there beats unstamped here');
  assert.equal(m[catchKey(bass())].lure, 'Spook', 'neither stamped: the copy already there');
  const same = mergeJournals({ data: [{ ...bass(), lure: 'A', editedAt: T1 }] }, { data: [{ ...bass(), lure: 'B', editedAt: T1 }] });
  assert.equal(same.catches[0].lure, 'A', 'the same time: the copy already there');
  assert.equal(same.replaced, 0);
});

test('a deleted fish stays deleted, unless it was changed after the delete', () => {
  const k = catchKey(striper());
  const here = { data: [perch(), { ...striper(), editedAt: T1 }] };
  const there = { data: [perch()], removed: { [k]: T2 } };
  const m = mergeJournals(here, there);
  assert.equal(m.catches.length, 1);
  assert.equal(m.gone, 1);
  assert.deepEqual(m.removed, { [k]: T2 }, 'and the delete is kept, for the next device');
  // the same fish brought in again after the delete
  const again = mergeJournals({ data: m.catches, removed: m.removed }, { data: [{ ...striper(), editedAt: T3 }] });
  assert.equal(again.catches.length, 2);
  assert.deepEqual(again.removed, {});
  // two devices that each deleted it: the later time is kept
  assert.deepEqual(mergeJournals({ data: [], removed: { [k]: T3 } }, { data: [], removed: { [k]: T2 } }).removed, { [k]: T3 });
});

test('a newer copy from the cloud keeps the picture this device has', () => {
  const here = { data: [{ ...perch(), photoDataUrl: 'data:image/jpeg;base64,AAAA' }] };
  const there = { data: [{ ...perch(), species: 'White Perch', editedAt: T1, photoOnDevice: true }] };
  const [c] = mergeJournals(here, there).catches;
  assert.equal(c.species, 'White Perch');
  assert.equal(c.photoDataUrl, 'data:image/jpeg;base64,AAAA');
});

// D1 as handleSyncPush uses it: one SELECT of the stored journal and one upsert.
function fakeD1() {
  const rows = new Map();
  return {
    rows,
    exec: async () => {},
    prepare(sql) {
      let args = [];
      const stmt = {
        bind: (...a) => { args = a; return stmt; },
        first: async () => (/SELECT payload, deleted FROM sync_items WHERE type='catch' AND id='catches'/.test(sql)
          ? rows.get('catch/catches') || null : null),
        run: async () => {
          const [id, type, payload, lastModified, deleted] = args;
          rows.set(`${type}/${id}`, { payload, lastModified, deleted });
          return {};
        },
      };
      return stmt;
    },
  };
}
const push = (env, type, id, body) => handleSyncPush({ json: async () => body }, env, type, id);
const stored = (env) => JSON.parse(env.DB.rows.get('catch/catches').payload);

test('the Worker merges a pushed journal with the one it has: an out-of-date phone cannot put old names back', async () => {
  const env = { DB: fakeD1() };
  // Chrome: two fish renamed, one deleted
  const chrome = { name: 'catches', lastModified: T1,
    data: [{ ...perch(), species: 'White Perch', editedAt: T1 }, { ...striper(), species: 'Striped Bass', editedAt: T1 }],
    removed: { [catchKey(bass())]: T1 } };
  assert.equal((await push(env, 'catch', 'catches', chrome)).status, 200);
  // the phone has not caught up: the old names, the deleted fish, and one new fish logged on the water
  const fresh = { ...bass(), time: '3:10 PM', sourceFile: 'PXL_20261010_191000.jpg', editedAt: T2 };
  await push(env, 'catch', 'catches', { name: 'catches', lastModified: T2, data: [perch(), striper(), bass(), fresh] });
  const cloud = stored(env);
  const m = byKey(cloud.data);
  assert.equal(m[catchKey(perch())].species, 'White Perch');
  assert.equal(m[catchKey(striper())].species, 'Striped Bass');
  assert.equal(m[catchKey(bass())], undefined, 'the delete stuck');
  assert.ok(m[catchKey(fresh)], "and the phone's new fish is in");
  assert.equal(cloud.data.length, 3);
  // and when the phone next opens, its pull takes the names
  const phone = mergeJournals({ data: [perch(), striper(), bass(), fresh] }, cloud);
  const p = byKey(phone.catches);
  assert.equal(p[catchKey(perch())].species, 'White Perch');
  assert.equal(p[catchKey(striper())].species, 'Striped Bass');
  assert.equal(p[catchKey(bass())], undefined);
  assert.equal(phone.replaced, 2);
  assert.equal(phone.gone, 1);
  // a re-import of the deleted fish after the delete brings it back everywhere
  await push(env, 'catch', 'catches', { name: 'catches', lastModified: T4, data: [...phone.catches, { ...bass(), editedAt: T4 }], removed: phone.removed });
  assert.ok(byKey(stored(env).data)[catchKey(bass())]);
  assert.deepEqual(stored(env).removed, {});
});

test('only the catch journal is merged; every other row is still replaced', async () => {
  const env = { DB: fakeD1() };
  await push(env, 'plan', 'p1', { meta: { name: 'A' }, lastModified: T1 });
  await push(env, 'plan', 'p1', { meta: { name: 'B' }, lastModified: T2 });
  assert.equal(JSON.parse(env.DB.rows.get('plan/p1').payload).meta.name, 'B');
  // a first journal, with nothing stored, is stored as sent
  await push(env, 'catch', 'catches', { name: 'catches', data: [perch()], lastModified: T1 });
  assert.deepEqual(stored(env).data, [perch()]);
});

test('the save stamps, the pull merges, and the Worker merges, all through journal-merge.js', () => {
  const cj = read('js/modules/catch-journal.js');
  const save = cj.slice(cj.indexOf('async function saveCatches()'), cj.indexOf('async function saveQueue()'));
  assert.ok(save.indexOf("const last = await dbGet('journal', CATCHES_DB_KEY);")
    < save.indexOf("stampJournal(last?.data || [], getCatches(), last?.removed, new Date().toISOString())"));
  assert.ok(save.indexOf('stampJournal(') < save.indexOf("await tryPut('journal'"), 'stamped before it is saved');
  assert.match(save, /catch \(err\) \{\s*console\.warn\(/, 'a last save that cannot be read never stops the save');
  const sync = read('js/modules/cloud-sync.js');
  assert.match(sync, /await dbPut\('journal', \{ name: 'catches', data: m\.catches, removed: m\.removed \}\);/);
  const w = read('Worker/trollmap-worker.js');
  assert.match(w, /import \{ mergeJournals \} from '\.\.\/js\/utils\/journal-merge\.js';/);
  assert.match(w, /type === 'catch' && id === 'catches' && !deleted \? await withStoredJournal\(env\.DB, pushed\) : pushed/);
});
