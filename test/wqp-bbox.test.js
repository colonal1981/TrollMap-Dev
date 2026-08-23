import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { paddedBox, boundsOf } from '../js/utils/geojson-coords.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = readFileSync(path.join(REPO, 'js/modules/lake-research-engine.js'), 'utf8');

// 2026-08-23. North Saluda Reservoir logged "WQP: could not derive bbox — skipping" and shipped
// a profile with _wqpLimnology: null. The bbox was being read off
// <key>/garmin_shoreline.geojson, and 157 of the 373 shipped packs do not have that file — so
// 42% of the lakes were silently skipping WQP limnology altogether.
//
// The same failure had already happened once, with shoreline.geojson, and the comment left
// behind spelled it out: "a 404 here reads exactly like 'this lake has no boundary', which
// silently drops the bbox". Switching to the Garmin file fixed the lakes that had one.
//
// lake_index.json carries bounds_wsen on every row and is fetched cache: 'no-store' on every
// load. There is nothing to fetch and nothing to 404.

describe('paddedBox', () => {
  it('pads a [west, south, east, north] row outwards on every side', () => {
    // North Saluda Reservoir's own row. Compared with a tolerance because -82.36692 + 0.01 is
    // -82.35691999999999 in binary floating point, and a test that pretends otherwise is
    // testing the decimal system rather than the padding.
    const b = paddedBox([-82.421717, 35.13861, -82.36692, 35.166552], 0.01);
    const near = (a, x) => expect(Math.abs(a - x) < 1e-9).toBe(true);
    near(b.west, -82.431717); near(b.south, 35.12861);
    near(b.east, -82.35692);  near(b.north, 35.176552);
  });

  it('pads by nothing when asked for nothing', () => {
    expect(paddedBox([-1, -2, 3, 4])).toEqual({ west: -1, south: -2, east: 3, north: 4 });
  });

  it('refuses a row that is not four finite numbers', () => {
    expect(paddedBox(null, 0.01)).toBe(null);
    expect(paddedBox([], 0.01)).toBe(null);
    expect(paddedBox([-82.4, 35.1, -82.3], 0.01)).toBe(null);
    expect(paddedBox([-82.4, 35.1, -82.3, 35.2, 9], 0.01)).toBe(null);
    expect(paddedBox([-82.4, 'north', -82.3, 35.2], 0.01)).toBe(null);
    expect(paddedBox([-82.4, 35.1, -82.3, NaN], 0.01)).toBe(null);
  });

  it('refuses an inside-out box rather than querying someone else\'s lake', () => {
    // WQP answers a bad box with the wrong water, not with an error.
    expect(paddedBox([-82.3, 35.1, -82.4, 35.2], 0.01)).toBe(null);
    expect(paddedBox([-82.4, 35.2, -82.3, 35.1], 0.01)).toBe(null);
  });

  it('accepts numeric strings, which is what a hand-edited row looks like', () => {
    expect(paddedBox(['-82.4', '35.1', '-82.3', '35.2'])).toEqual({
      west: -82.4, south: 35.1, east: -82.3, north: 35.2,
    });
  });

  it('agrees with boundsOf on the same geometry', () => {
    const geo = { type: 'Polygon', coordinates: [[[-82.42, 35.14], [-82.37, 35.14], [-82.37, 35.17], [-82.42, 35.14]]] };
    const b = boundsOf(geo);
    expect(paddedBox([b.west, b.south, b.east, b.north])).toEqual(b);
  });
});

describe('the WQP bbox comes from the registry, not from a fetch', () => {
  it('reads boundsWSEN — the name the registry loader emits', () => {
    // lake_index.json says bounds_wsen; lake-registry.js maps it to boundsWSEN. Reading the
    // snake_case name off a loaded record is undefined, and undefined falls through to the
    // fetch this change exists to avoid.
    expect(/lakeRecordFor\([^)]*\)\?\.boundsWSEN/.test(ENGINE)).toBe(true);
    expect(/lakeRecordFor\([^)]*\)\?\.bounds_wsen/.test(ENGINE)).toBe(false);
  });

  it('tries the registry before it tries the network', () => {
    const fn = ENGINE.slice(ENGINE.indexOf('async function wqpBboxFor'));
    const body = fn.slice(0, fn.indexOf('\r\n}'));
    expect(body.indexOf('boundsWSEN') < body.indexOf('fetch(')).toBe(true);
  });

  it('falls back to the boundary when a water has no registry row', () => {
    // Rivers and picker-only names have no row; garmin_shoreline is missing on 157 packs, and
    // boundary.geojson is in R2 for all 373. Both fallbacks stay.
    expect(ENGINE.includes('garmin_shoreline.geojson')).toBe(true);
    expect(ENGINE.includes('/chartpacks/lake-boundary?lake=')).toBe(true);
  });

  it('asks WQP from one place, not two', () => {
    // This was two byte-identical fifty-line blocks, one in the full pipeline and one in
    // resume. A fix to either was a fix to half the runs.
    // One POST. The other mention is the sourceUrl string a WQP evidence entry is stamped with.
    const posts = ENGINE.split('await fetch(`${CF_WORKER_URL}/research/limnology-data`').length - 1;
    expect(posts).toBe(1);
    expect(ENGINE.split('await fetchWqpLimnology(lakeName);').length - 1).toBe(2);
  });
});
