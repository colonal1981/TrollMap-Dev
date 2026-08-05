/**
 * shared-latest-pointer.test.js — latest.json stopped being a second copy of the document.
 *
 * storeSharedDocument() wrote the full record to versions/<versionId>.json and then wrote the
 * identical bytes to latest.json. 1,616 shared documents were sitting in R2 as 3,375 objects.
 * Since 2026-08-05 latest.json is an index entry that points at the version.
 *
 * The two things that can go wrong here are both quiet:
 *
 *   - a legacy inline latest.json gets narrowed to a pointer whose version object is missing,
 *     which deletes the only copy of that document's sections, and
 *   - a reader assumes one shape and gets the other, so a document that is fine in R2 reads as
 *     "not found" for a URL that is definitely in the registry.
 *
 * Both are covered below against a fake R2 bucket that behaves like the real one, including
 * list() capping at 1,000 keys per call -- which is how the generation manifest came to be
 * silently short.
 */
import { describe, it, expect } from './expect-shim.mjs';
import {
  isLatestPointer, latestPointerFor, getSharedDocument, getSharedLatestSummary,
  storeSharedDocument, handleSharedPublish, handleSharedStatus, SHARED_ROOT,
} from '../Worker/research/shared.js';

function fakeBucket(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    store,
    async get(key) {
      if (!store.has(key)) return null;
      const body = store.get(key);
      return { httpMetadata: {}, text: async () => body };
    },
    async head(key) { return store.has(key) ? { key, size: store.get(key).length } : null; },
    async put(key, value) { store.set(key, typeof value === 'string' ? value : String(value)); },
    async delete(key) { store.delete(key); },
    // The real list() returns at most 1,000 keys and sets truncated. Reproducing that is the
    // point of this fake -- a bucket that returns everything hides the bug being guarded.
    async list({ prefix = '', cursor } = {}) {
      const keys = [...store.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + 1000);
      const end = start + page.length;
      return {
        objects: page.map(k => ({ key: k, size: store.get(k).length })),
        truncated: end < keys.length,
        cursor: String(end),
      };
    },
  };
}

const docFor = (n, sectionCount = 3) => ({
  id: `doc-${n}`,
  versionId: `v${1000 + n}`,
  canonicalUrl: `https://example.gov/report-${n}.pdf`,
  title: `Report ${n}`,
  authority: 'scdnr',
  scope: 'lake',
  lakeSlugs: ['lake-wateree'],
  indexStatus: 'indexed',
  contentFingerprint: `fp:${n}`,
  fetchedAt: '2026-07-01T00:00:00.000Z',
  lastCheckedAt: '2026-07-01T00:00:00.000Z',
  sections: Array.from({ length: sectionCount }, (_, i) => ({
    sectionId: `doc-${n}-s0${i}`,
    heading: `Section ${i}`,
    chunks: [{ chunkId: `c${i}`, text: 'x'.repeat(4000) }],
  })),
});

const env = (bucket) => ({ R2_TROLLMAP_CHARTPACKS: bucket, SHARED_RESEARCH_ENABLED: 'true' });
const req = () => new Request('https://w.dev/research/shared/publish', { method: 'POST' });

describe('latest.json is an index entry, not a second copy', () => {
  it('storing a document writes the sections exactly once', async () => {
    const b = fakeBucket();
    const doc = docFor(1);
    await storeSharedDocument(env(b), doc);

    const vKey = `${SHARED_ROOT}/documents/doc-1/versions/v1001.json`;
    const lKey = `${SHARED_ROOT}/documents/doc-1/latest.json`;
    expect(b.store.has(vKey)).toBe(true);
    expect(b.store.has(lKey)).toBe(true);

    // The whole point: latest is now a rounding error next to the version.
    expect(b.store.get(lKey).length < b.store.get(vKey).length / 10).toBe(true);
    expect(JSON.parse(b.store.get(lKey)).sections).toBe(3);        // a COUNT
    expect(JSON.parse(b.store.get(vKey)).sections.length).toBe(3); // the array
  });

  it('reads back the full document through the pointer', async () => {
    const b = fakeBucket();
    await storeSharedDocument(env(b), docFor(2));
    const got = await getSharedDocument(env(b), 'doc-2');
    expect(got.id).toBe('doc-2');
    expect(got.sections.length).toBe(3);
    expect(got.sections[0].chunks[0].text.length).toBe(4000);
  });

  it('still reads a pre-2026-08-05 inline latest.json', async () => {
    // Nothing was backfilled, so this shape is what is actually in the bucket right now.
    const legacy = docFor(3);
    const b = fakeBucket({ [`${SHARED_ROOT}/documents/doc-3/latest.json`]: legacy });
    const got = await getSharedDocument(env(b), 'doc-3');
    expect(got.sections.length).toBe(3);
    expect(isLatestPointer(legacy)).toBe(false);
    expect(isLatestPointer(latestPointerFor(legacy))).toBe(true);
  });

  it('a specific version is still addressable', async () => {
    const b = fakeBucket();
    await storeSharedDocument(env(b), docFor(4));
    expect((await getSharedDocument(env(b), 'doc-4', 'v1004')).id).toBe('doc-4');
    expect(await getSharedDocument(env(b), 'doc-4', 'v9999')).toBe(null);
  });

  it('the summary reads the same off either stored shape', async () => {
    const b = fakeBucket({ [`${SHARED_ROOT}/documents/doc-5/latest.json`]: docFor(5) });
    const fromLegacy = await getSharedLatestSummary(env(b), 'doc-5');
    const b2 = fakeBucket();
    await storeSharedDocument(env(b2), docFor(5));
    const fromPointer = await getSharedLatestSummary(env(b2), 'doc-5');
    expect(fromLegacy).toEqual(fromPointer);
    expect(fromLegacy.sections).toBe(3);
  });
});

describe('publish is the migration, and it does not eat documents', () => {
  it('compacts an inline latest.json when its version object exists', async () => {
    const doc = docFor(6);
    const b = fakeBucket({
      [`${SHARED_ROOT}/documents/doc-6/latest.json`]: doc,
      [`${SHARED_ROOT}/documents/doc-6/versions/v1006.json`]: doc,
    });
    const before = b.store.get(`${SHARED_ROOT}/documents/doc-6/latest.json`).length;
    const res = await handleSharedPublish(req(), env(b));
    const body = await res.json();

    expect(body.compacted).toBe(1);
    expect(body.orphanVersions).toBe(0);
    const after = b.store.get(`${SHARED_ROOT}/documents/doc-6/latest.json`);
    expect(after.length < before / 10).toBe(true);
    // ...and the document is still fully readable afterwards.
    expect((await getSharedDocument(env(b), 'doc-6')).sections.length).toBe(3);
  });

  it('REFUSES to compact when the version object is missing', async () => {
    // This is the data-loss case. The inline record is the only copy of the sections; turning
    // it into a pointer at a version that is not there would destroy the document, and it would
    // read as an ordinary 404 forever after.
    const doc = docFor(7);
    const b = fakeBucket({ [`${SHARED_ROOT}/documents/doc-7/latest.json`]: doc });
    const body = await (await handleSharedPublish(req(), env(b))).json();

    expect(body.compacted).toBe(0);
    expect(body.orphanVersions).toBe(1);
    expect((await getSharedDocument(env(b), 'doc-7')).sections.length).toBe(3);
  });

  it('leaves already-compacted documents alone', async () => {
    const b = fakeBucket();
    await storeSharedDocument(env(b), docFor(8));
    const body = await (await handleSharedPublish(req(), env(b))).json();
    expect(body.compacted).toBe(0);
    expect(body.documentCount).toBe(1);
  });

  it('bounds itself and reports what is left for the next run', async () => {
    const seed = {};
    for (let n = 0; n < 260; n++) {
      const d = docFor(n, 1);
      seed[`${SHARED_ROOT}/documents/doc-${n}/latest.json`] = d;
      seed[`${SHARED_ROOT}/documents/doc-${n}/versions/v${1000 + n}.json`] = d;
    }
    const b = fakeBucket(seed);
    const first = await (await handleSharedPublish(req(), env(b))).json();
    expect(first.compacted).toBe(250);
    expect(first.inlineRemaining).toBe(10);

    const second = await (await handleSharedPublish(req(), env(b))).json();
    expect(second.compacted).toBe(10);
    expect(second.inlineRemaining).toBe(0);
  });
});

describe('the generation manifest covers every document, not the first page', () => {
  it('paginates past the 1,000-key list() cap', async () => {
    // 1,200 documents is 2,400 objects, so the old single list() saw 1,000 keys, of which only
    // some were latest.json -- and the manifest reported that as the whole registry.
    const seed = {};
    for (let n = 0; n < 1200; n++) {
      const d = docFor(n, 1);
      seed[`${SHARED_ROOT}/documents/doc-${n}/latest.json`] = latestPointerFor(d);
      seed[`${SHARED_ROOT}/documents/doc-${n}/versions/v${1000 + n}.json`] = d;
    }
    const b = fakeBucket(seed);
    const body = await (await handleSharedPublish(req(), env(b))).json();
    expect(body.documentCount).toBe(1200);

    const status = await (await handleSharedStatus(new Request('https://w.dev/x'), env(b))).json();
    expect(status.storedDocuments).toBe(1200);
    expect(status.inlineLatestRemaining).toBe(0);
  });

  it('status names how many inline copies are still out there', async () => {
    const seed = {};
    for (let n = 0; n < 5; n++) seed[`${SHARED_ROOT}/documents/doc-${n}/latest.json`] = docFor(n);
    const status = await (await handleSharedStatus(new Request('https://w.dev/x'), env(fakeBucket(seed)))).json();
    expect(status.inlineLatestRemaining).toBe(5);
    expect(status.note).toContain('publish');
  });
});
