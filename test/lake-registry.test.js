/**
 * test/lake-registry.test.js -- the registry resolves lake names to the right lake.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 *   node --test test/
 *
 * WHY THIS FILE EXISTS
 *
 * On 2026-08-02 two independent last-writer-wins bugs meant 12 of 434 shipped lakes resolved
 * to a DIFFERENT lake's record, and 10 resolved to a different lake's R2 key. Neither failed
 * loudly: the key is well-formed, the fetch succeeds, and the wrong lake's contours draw over
 * the water you are actually sitting on.
 *
 * No test in the suite could have caught it, because nothing imported `lake-registry.js` at
 * all. This is that test.
 *
 * It asserts INVARIANTS, not counts. "434 shipped lakes" is a fact about one build of
 * lake_index.json and would need editing every time the index changes -- which is how a test
 * turns into a chore and then into a deleted test. "No two shipped lakes share a display
 * name" is true of every correct index forever.
 *
 * The fixture is 40 records covering every case that has ever bitten this project: both
 * shipped-vs-shipped collisions, a four-way namesake, the four border lakes, the two lakes the
 * default access filter once hid, and a lake 3DHP never named.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from './expect-shim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, 'fixtures/lake_index.sample.json'), 'utf8'));

globalThis.window = globalThis;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => raw });

const reg = await import('../js/data/lake-registry.js');
const R = await reg.loadLakeRegistry();
const shipped = R.list.filter((r) => r.shipped);
const picker = reg.lakeNamesForPicker();

describe('lake-registry — resolution', () => {
  it('loads every record that has a centroid', () => {
    expect(R.list.length).toBe(Object.keys(raw).length);
  });

  it('resolves a slug, an exact display name and a loose name', () => {
    expect(reg.lakeRecordFor('wateree_lake')?.slug).toBe('wateree_lake');
    const w = reg.lakeRecordFor('wateree_lake');
    expect(reg.lakeRecordFor(w.displayName)?.slug).toBe('wateree_lake');
    expect(reg.lakeRecordFor('Wateree')?.slug).toBe('wateree_lake');
  });

  it('returns null rather than guessing', () => {
    expect(reg.lakeRecordFor('Absolutely Not A Lake 12345')).toBeNull();
    expect(reg.lakeRecordFor('')).toBeNull();
    expect(reg.lakeRecordFor(null)).toBeNull();
  });
});

describe('lake-registry — display names are unambiguous', () => {
  // THE 2026-08-02 BUG. byName was built in JSON enumeration order (last writer wins) while
  // normIndex was built largest-first (first writer wins), so the two disagreed.
  it('no two SHIPPED lakes share a display name', () => {
    const seen = new Map();
    const clash = [];
    for (const r of shipped) {
      if (seen.has(r.displayName)) clash.push(`${r.displayName}: ${seen.get(r.displayName)} vs ${r.slug}`);
      seen.set(r.displayName, r.slug);
    }
    expect(clash).toEqual([]);
  });

  it('every shipped lake resolves to ITSELF, not to a namesake', () => {
    const wrong = shipped
      .filter((r) => reg.lakeRecordFor(r.displayName)?.slug !== r.slug)
      .map((r) => `${r.displayName} -> ${reg.lakeRecordFor(r.displayName)?.slug} (want ${r.slug})`);
    expect(wrong).toEqual([]);
  });

  it('the four-way namesake keeps its members apart', () => {
    // Long Pond, GA is four different ponds. County separates three of them; the fourth pair
    // shares Baker County and is unshipped, so the picker never offers it.
    const ponds = R.list.filter((r) => r.name === 'Long Pond');
    expect(ponds.length).toBeGreaterThan(1);
    const shippedPonds = ponds.filter((r) => r.shipped);
    expect(new Set(shippedPonds.map((r) => r.displayName)).size).toBe(shippedPonds.length);
  });

  it('the two shipped-vs-shipped pairs are distinguishable', () => {
    for (const bare of ['Forest Lake', 'Long Lake']) {
      const pair = R.list.filter((r) => r.name === bare && r.shipped);
      expect(pair.length).toBe(2);
      expect(pair[0].displayName).not.toBe(pair[1].displayName);
      expect(reg.lakeRecordFor(pair[0].displayName).slug).toBe(pair[0].slug);
      expect(reg.lakeRecordFor(pair[1].displayName).slug).toBe(pair[1].slug);
    }
  });
});

describe('lake-registry — naming rules', () => {
  it('every shipped lake carries a county and a state', () => {
    const bad = shipped.filter((r) => !/ \(.+ Co, [A-Z/]+\)$/.test(r.displayName))
                       .map((r) => r.displayName);
    expect(bad).toEqual([]);
  });

  it('border lakes keep BOTH states', () => {
    // Their centroid sits in one state; naming purely by the county's state would drop the
    // other half of a lake Ryan fishes from both banks.
    for (const slug of ['lake_wylie', 'tugaloo_lake', 'yonah_lake', 'webster_lake']) {
      const r = R.bySlug.get(slug);
      if (!r) continue;
      expect(r.displayName).toMatch(/ Co, [A-Z]{2}\/[A-Z]{2}\)$/);
    }
  });

  it('the acreage fallback is a no-op against a county-named index', () => {
    // disambiguateDisplayNames() is a safety net for an index built without counties. If it
    // fires here, consolidate_lake_index.py did not run or could not find counties_500k.geojson.
    const renamed = R.list.filter((r) => / \([\d,]+ ac\)$/.test(r.displayName));
    expect(renamed.map((r) => r.displayName)).toEqual([]);
  });
});

describe('lake-registry — names saved in old plans and catches still resolve', () => {
  // Renaming is only safe if the old string still finds the lake. A saved plan holds whatever
  // the picker said the day it was saved.
  for (const q of ['Wateree Lake, SC', 'Lake Wateree, SC', 'Lake Lanier, GA',
                   'Jordan Lake, NC', 'Lake Wylie, NC/SC', 'Lake Hartwell, SC/GA']) {
    it(`"${q}"`, () => {
      expect(reg.lakeRecordFor(q)).not.toBeNull();
    });
  }
});

describe('lake-registry — the picker', () => {
  it('offers no duplicate rows', () => {
    const dupes = picker.filter((n, i) => picker.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  it('every offered name resolves back to a record', () => {
    expect(picker.filter((n) => !reg.lakeRecordFor(n))).toEqual([]);
  });

  it('offers lakes whose access is Restricted', () => {
    // The default filter is `shipped`, NOT an access class. Ryan, 2026-08-02: "i am willing to
    // bet if it has contours i can fish it". Wittee and Ferry are Restricted (state forest)
    // and were hidden by an earlier default; that is the regression this guards.
    for (const slug of ['wittee_lake', 'ferry_lake']) {
      const r = R.bySlug.get(slug);
      if (!r || !r.shipped) continue;
      expect(picker).toContain(r.displayName);
    }
  });
});

describe('lake-registry — lakeDbEntryFor, the LAKE_DB-shaped view', () => {
  const e = reg.lakeDbEntryFor('Wateree');

  it('returns a usable entry', () => {
    expect(e).not.toBeNull();
    expect(e.slug).toBe('wateree_lake');
  });

  it('center is [lat, lon, zoom] and is not transposed', () => {
    expect(Number.isFinite(e.center[0])).toBe(true);
    expect(Number.isFinite(e.center[1])).toBe(true);
    // GeoJSON is [lon, lat]; Leaflet wants [lat, lon]. Getting this backwards puts every lake
    // in the Indian Ocean, so pin it to the region rather than trusting the conversion.
    expect(e.center[0]).toBeGreaterThan(24);
    expect(e.center[0]).toBeLessThan(40);
    expect(e.center[1]).toBeLessThan(-70);
  });

  it('bounds are [[s,w],[n,e]] with south below north', () => {
    if (!e.bounds) return;
    expect(e.bounds[0][0]).toBeLessThan(e.bounds[1][0]);
  });

  it('ramps are a plain name -> [lat, lon] map', () => {
    const bad = Object.entries(e.ramps)
      .filter(([, v]) => !Array.isArray(v) || v.length !== 2 || !v.every(Number.isFinite));
    expect(bad).toEqual([]);
  });
});
