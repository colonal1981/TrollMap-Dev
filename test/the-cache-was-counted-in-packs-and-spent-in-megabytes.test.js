// THE CACHE WAS COUNTED IN PACKS AND SPENT IN MEGABYTES.
//
// Worker/water.js held eight parsed packs per isolate. That number was chosen against Garmin's MAR
// mesh, and its own note in the file does the arithmetic: Wateree's graph is 4.57 MB on the wire
// and about 6.6 MB expanded, so eight is 53 MB of a 128 MB isolate.
//
// On 2026-09-15 the coastal zones got graphs built from our own bathymetry, because Garmin never
// meshed the lowcountry creeks. ACE Basin comes out 321,844 nodes and 1,140,629 edges, 11.5 MB on
// the wire, and the arrays water.js keeps come to 15.9 MB. EIGHT OF THOSE IS 127 MB -- the whole
// isolate, before the Worker has done anything else.
//
// No count of packs is right for both a 6.6 MB graph and a 15.9 MB one, so the bound is bytes now
// and the count is a second guard for many small entries whose Map overhead byteLength cannot see.
//
// These tests exercise entryBytes() and the published accounting rather than reading the source for
// a constant, because the thing that matters is what the cache DOES when a big graph arrives.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { entryBytes, cacheStats } = await import('../Worker/water.js');
const SRC = readFileSync(join(here, '..', 'Worker', 'water.js'), 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// The real shape water.js caches for a graph, at ACE Basin's measured node and edge counts.
const graphLike = (nn, ne) => ({
  nn,
  lon: new Float64Array(nn),
  lat: new Float64Array(nn),
  depth: new Uint8Array(nn),
  head: new Uint32Array(nn + 1),
  adj: new Uint32Array(ne * 2),
  offWaterM: 120,
});

describe('an entry is measured, not counted', () => {
  it('sums the typed arrays a graph actually keeps', () => {
    // ACE Basin at --coarsen 2. 321,844 nodes and 1,140,629 edges.
    const b = entryBytes(graphLike(321844, 1140629));
    expect(b).toBe(321844 * 8 * 2 + 321844 + (321845) * 4 + 1140629 * 2 * 4);
    // 15.1 MiB, which is the number the file's own note is derived from. MiB, not MB: the isolate
    // limit is 128 MiB and the first draft of this test asserted 16 by mixing the two.
    expect(Math.round(b / 1048576)).toBe(15);
  });

  it('puts the MAR graph the old number was sized for well below it', () => {
    // 121,178 nodes, 448,208 edges -- the graph the old count of eight was sized against.
    const mar = entryBytes(graphLike(121178, 448208));
    const coastal = entryBytes(graphLike(321844, 1140629));
    expect(Math.round(mar / 1048576)).toBe(6);   // 6.4 MiB
    expect(coastal > mar * 2).toBe(true);
  });

  it('trusts a caller that already knows the size', () => {
    // packJson has the source text and nothing else does.
    expect(entryBytes({ a: 1 }, 4096)).toBe(4096);
    expect(entryBytes(null, 900)).toBe(900);
  });

  it('gives a negative cache entry a real cost, not a megabyte', () => {
    // `false` is what a missing pack caches as, and there are a lot of those.
    expect(entryBytes(false)).toBe(64);
  });

  it('falls back to a floor for a value it cannot measure, rather than inventing a number', () => {
    // The boundary index is Maps of arrays. A made-up byte count for it would be worse than a
    // named floor, and the floor is what keeps the count cap meaningful.
    expect(entryBytes({ yb: new Map(), vg: new Map() })).toBe(4096);
  });

  it('does not count a plain number as a byteLength', () => {
    // `nn` and `offWaterM` are numbers on the graph object and must not be summed.
    const b = entryBytes({ nn: 5, offWaterM: 120 });
    expect(b).toBe(4096);
  });
});

describe('the bound is bytes, with the count kept as a second guard', () => {
  it('publishes both bounds so they can be argued with', () => {
    const s = cacheStats();
    expect(s.maxEntries).toBe(8);
    expect(s.maxBytes).toBe(40 * 1024 * 1024);      // MiB, the unit the isolate limit is in
  });

  it('holds fewer than eight coastal graphs, which is the whole point', () => {
    // 40 MiB against a 15.1 MiB entry is two, not eight. Under the old bound it was 121 MiB.
    const one = entryBytes(graphLike(321844, 1140629));
    expect(Math.floor(cacheStats().maxBytes / one)).toBe(2);
    expect(8 * one > 121 * 1024 * 1024).toBe(true);    // 121 MiB of a 128 MiB isolate
    expect(8 * one > cacheStats().maxBytes).toBe(true);
  });

  it('still holds six of the MAR graphs the old number was sized for', () => {
    const mar = entryBytes(graphLike(121178, 448208));
    expect(Math.floor(cacheStats().maxBytes / mar) >= 6).toBe(true);
  });
});

describe('the eviction loop cannot empty the cache', () => {
  it('keeps at least one entry even when it alone is over budget', () => {
    // A graph bigger than the whole budget must stay usable once. Evicting it would re-fetch and
    // re-parse on every request, which is slower AND peaks higher than keeping it.
    expect(SRC).toContain('_cache.size > 1');
  });

  it('subtracts the old cost when a key is re-set', () => {
    // Without this the total only ever climbs and the cache evicts itself to one entry.
    const setFn = SRC.split('function cacheSet')[1].split('\n}')[0];
    expect(setFn).toContain('_cacheTotal -= _cacheBytes.get(k)');
  });

  it('subtracts on eviction too, or the total never comes down', () => {
    const setFn = SRC.split('function cacheSet')[1].split('\n}')[0];
    expect(setFn).toContain('_cacheTotal -= _cacheBytes.get(oldest)');
  });

  it('evicts on either bound, not only on bytes', () => {
    const setFn = SRC.split('function cacheSet')[1].split('\n}')[0];
    expect(setFn).toContain('_cache.size > CACHE_MAX');
    expect(setFn).toContain('_cacheTotal > CACHE_MAX_BYTES');
  });

  it('leaves the LRU reinsert alone, since it changes no cost', () => {
    const getFn = SRC.split('function cacheGet')[1].split('\n}')[0];
    expect(getFn.includes('_cacheTotal')).toBe(false);
  });
});
