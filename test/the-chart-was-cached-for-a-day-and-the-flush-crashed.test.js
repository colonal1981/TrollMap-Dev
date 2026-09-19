import { describe, it, expect } from './expect-shim.mjs';
import { installFakeIndexedDB, resetFakeIndexedDB } from './fake-indexeddb.mjs';
// BEFORE any import that opens the DB -- js/utils/db.js memoises the open, so a module that has
// already tried and failed against a bare Node global stays failed for the rest of the file.
resetFakeIndexedDB();
installFakeIndexedDB();
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');
const live = (js) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CHART WAS CACHED FOR A DAY AND THE ONE BUTTON THAT COULD FLUSH IT CRASHED
//
// Ryan, 2026-09-19, after the Congaree pack was extended 26 km downstream, rebuilt and uploaded —
// with every byte of it verified present in R2:
//
//   "hard reload was done before i ran the plan... and i did another one.. same result so then i
//    cleared the cache using the button in the contour data tab... that crashed the app...
//    reloaded and still do not see contours beyond the confluence"
//
// Three separate things, and the reload was never one of them:
//
//   1. Both chart layers cache in IndexedDB for CACHE_TTL, which is a DAY. A reload does not
//      touch IndexedDB, so a pipeline push cannot reach the map for 24 hours.
//   2. The flush button covered `contours` only. Depth areas are `supplemental`. So even working,
//      it could not have fixed what he was looking at.
//   3. cacheClear() read the whole shared store with getAll() — VALUES, not keys — to compare key
//      prefixes. On a pack carrying 11.4 MB of depth areas and 5.7 MB of contours that is what
//      crashed. It had worked for months on half the payload.
//
// He then declined to delete the database by hand, which is correct: that store also holds the
// ramp list. The scoped button is the mechanism, so the button has to work.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('cacheClear deletes by key range and never reads the values', () => {
  const db = live(src('js/utils/db.js'));
  const fn = db.slice(db.indexOf('export async function cacheClear'));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);

  it('does not call getAll — that is the crash', () => {
    expect(/getAll\s*\(/.test(body)).toBe(false);
  });

  it('deletes a bounded key range instead, through the helper that already existed', () => {
    expect(/\.bound\(prefix,/.test(body)).toBe(true);
    // del()/tryDel() already open the store, resolve off the request and report the failure.
    // A second copy of that plumbing here was the first thing I wrote and it was waste.
    expect(/tryDel\(CACHE_STORE,/.test(body)).toBe(true);
  });

  it('still scopes itself to one namespace, so the ramp list survives', () => {
    // The whole reason the store is shared and the keys are prefixed.
    expect(/\$\{ns\}\$\{NS_SEP\}/.test(body)).toBe(true);
    expect(/objectStore\s*\(\s*CACHE_STORE\s*\)\s*\.clear\(/.test(body)).toBe(false);
  });
});

// ── AND THE BEHAVIOUR, AGAINST THE DOUBLE, BECAUSE THE SOURCE TESTS ABOVE PROVE SHAPE ONLY ───
//
// test/fake-indexeddb.mjs deleted by exact key and ignored a key range, so until it was taught
// IDBKeyRange this whole fix would have measured as "removed nothing" and the source assertions
// above would still have been green. That is the failure mode worth a test.
describe('cacheClear, run for real, takes one namespace and leaves the rest', () => {
  it('drops every contour entry and not one ramp entry', async () => {
    const { cacheSet, cacheGet, cacheClear } = await import('../js/utils/db.js');

    await cacheSet('contours', 'congaree_river', { features: [1, 2, 3] });
    await cacheSet('contours', 'wateree_lake', { features: [4] });
    await cacheSet('supplemental', 'congaree_river/depth_areas.geojson', { features: [5] });
    await cacheSet('ramps', 'tristate', { rows: 900 });

    expect(await cacheClear('contours')).toBe(true);

    // Gone.
    expect(await cacheGet('contours', 'congaree_river')).toBe(null);
    expect(await cacheGet('contours', 'wateree_lake')).toBe(null);
    // Untouched -- this is the whole reason the store is shared and the keys are prefixed, and
    // it is why Ryan was right to refuse to delete the database by hand.
    expect((await cacheGet('ramps', 'tristate'))?.rows).toBe(900);
    expect(await cacheGet('supplemental', 'congaree_river/depth_areas.geojson')).not.toBe(null);

    // And the other namespace goes on its own call, which is what the button now makes.
    expect(await cacheClear('supplemental')).toBe(true);
    expect(await cacheGet('supplemental', 'congaree_river/depth_areas.geojson')).toBe(null);
    expect((await cacheGet('ramps', 'tristate'))?.rows).toBe(900);
  });
});

describe('the flush button covers the whole chart, not half of it', () => {
  const cd = live(src('js/modules/contour-data.js'));
  const sl = live(src('js/modules/supplemental-layers.js'));

  it('clears the contour namespace AND the supplemental one', () => {
    expect(/cacheClear\(CACHE_NS\)/.test(cd)).toBe(true);
    expect(/clearSupplementalCache\(\)/.test(cd)).toBe(true);
  });

  it('and asks the module that owns that namespace rather than re-typing its name', () => {
    // A hand-copied 'supplemental' string here is a second place to keep in step.
    expect(cd.includes("cacheClear('supplemental')")).toBe(false);
    expect(/export async function clearSupplementalCache/.test(sl)).toBe(true);
  });

  it('drops the built layers too, or the next paint redraws what was just deleted', () => {
    const fn = sl.slice(sl.indexOf('export async function clearSupplementalCache'));
    const body = fn.slice(0, fn.indexOf('\n}') + 2);
    for (const held of ['_depthAreaGeoJSON', '_depthAreaAll', '_activeLakeKey']) {
      expect(body.includes(`${held} = null`)).toBe(true);
    }
  });

  it('re-fetches the chart it just dropped rather than leaving a blank map', () => {
    expect(/loadContourByR2Key\(key\)/.test(cd)).toBe(true);
  });
});

describe('and the day-long TTL is still there, named, because it is the root cause', () => {
  it('both chart caches hold for 24 h, which no reload shortens', () => {
    for (const f of ['js/modules/contour-data.js', 'js/modules/supplemental-layers.js']) {
      expect(/CACHE_TTL\s*=\s*24 \* 60 \* 60 \* 1000/.test(src(f))).toBe(true);
    }
  });
});
