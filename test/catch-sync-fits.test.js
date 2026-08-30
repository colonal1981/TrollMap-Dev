// TEN MEGABYTES OF FISH PHOTOGRAPHS, PUSHED AS ONE DATABASE ROW, EVERY PAGE LOAD.
//
//     sync error: catch/catches insert failed at 10819.5 KB payload:
//     D1_ERROR: string or blob too big: SQLITE_TOOBIG        HTTP 500
//
// Two things made that. The journal is pushed as a SINGLE item -- every catch there has ever
// been, under the id `catches` -- and each catch carries `photoDataUrl`, a base64 JPEG about a
// third larger than the file it came from. So nothing synced at all: not the photos, not the
// fish, not the lure, not the date. Every catch was local-only and looked synced.
//
// And it retried forever. reportSyncFailure reads a 500 as "the server failing", which is right
// in general and wrong here -- the server was working perfectly and refusing something it can
// never accept. One oversize record became a permanent console error hiding every real failure
// behind it.
//
// A photograph is not a database row. cloud-sync.js already says exactly that about the other
// big thing this app holds -- "charts live in R2 -- excluded from D1 sync".
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');
const journal = src('js/modules/catch-journal.js');
const sync = src('js/modules/cloud-sync.js');
const live = (js) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the journal syncs without its photographs', () => {
  it('the push sends the stripped projection, not the raw catches', () => {
    expect(live(journal)).toMatch(/pushItemOnSave',\s*'catch',\s*CATCHES_DB_KEY,\s*\n?\s*\{\s*name:\s*CATCHES_DB_KEY,\s*data:\s*catchesForSync\(\)\s*\}/);
    expect(live(journal).includes('data: getCatches() }')).toBe(true);   // the LOCAL save still keeps everything
  });

  it('and the projection drops every data-url field', () => {
    for (const f of ['photoDataUrl', 'lurePhotoDataUrl', 'thumbDataUrl']) {
      expect(new RegExp(`\\b${f}\\b[^\\n]*\\.\\.\\.rest|${f},`).test(live(journal))).toBe(true);
    }
  });

  it('the local record is untouched — a catch is the costliest thing here to lose', () => {
    // saveCatches() writes getCatches() to IndexedDB. Only the wire copy is thinned.
    expect(live(journal)).toMatch(/tryPut\('journal', \{ name: CATCHES_DB_KEY, data: getCatches\(\) \}/);
  });

  it('says on the record that a photo exists on the device it was shot on', () => {
    // A phone showing no picture should be explained, not look broken.
    expect(live(journal).includes('photoOnDevice: true')).toBe(true);
  });
});

describe('a row that cannot fit is refused, not queued forever', () => {
  it('there is a cap, and it is under D1\'s', () => {
    const m = live(sync).match(/const MAX_SYNC_BYTES = (\d+) \* 1024;/);
    expect(m).toBeTruthy();
    expect(Number(m[1]) < 1024).toBe(true);
  });

  it('the push measures the body before spending a round trip on it', () => {
    const js = live(sync);
    expect(js.includes('const body = JSON.stringify(payload);')).toBe(true);
    expect(js.includes('if (body.length > MAX_SYNC_BYTES)')).toBe(true);
    // and sends that same string, rather than serialising twice
    expect(js.includes('body: body,')).toBe(true);
  });

  it('an oversize push is NOT queued — that is what made it permanent', () => {
    const js = live(sync);
    const guard = js.indexOf('if (body.length > MAX_SYNC_BYTES)');
    const ret = js.indexOf('return;', guard);
    const queued = js.indexOf('queueForLater', guard);
    expect(guard).toBeGreaterThan(-1);
    expect(ret > guard && (queued === -1 || ret < queued)).toBe(true);
  });

  it('and the drain drops one already sitting in the queue', () => {
    // The 10.8 MB item was already queued before any of this existed. Without this it replays
    // on every load for the life of the install.
    const js = live(sync);
    expect(js.includes('size > MAX_SYNC_BYTES')).toBe(true);
    expect(/dropping queued/.test(js)).toBe(true);
  });

  it('a tombstone is never size-checked, because a DELETE carries no payload', () => {
    expect(live(sync).includes('if (!item.deleted) {')).toBe(true);
  });
});
