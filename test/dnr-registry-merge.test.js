import { describe, it, expect } from './expect-shim.mjs';
// access-index.js publishes legacy global helpers on `window` at module scope, so it needs
// one before it can be imported under node. Same shim the registry and cloud-sync tests use.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const { lakeNameLooseKey, findExistingLakeKey } = await import('../js/data/access-index.js');

/**
 * The DNR feeds and 3DHP call the same water different things, so the picker showed one lake
 * as two rows: "Lake Wateree" from the ramp feed and "Wateree Lake (Kershaw Co, SC)" from the
 * registry. Measured on the live SC/NC/GA feeds: 179 of 476 DNR names merged, and 31 more
 * should have.
 *
 * The feeds are a LIVE ArcGIS pull, so a table of known pairs cannot be the whole answer --
 * it stops working the moment a state renames something. Hence two passes, one curated and
 * one derived.
 */

// A DNR entry already in the index, with its ramps.
const idx = (entries) => ({ byLake: new Map(entries) });
const pt = (lat, lon) => ({ lat, lon });

describe('lakeNameLooseKey collapses words that carry no identity', () => {
  it('matches the orderings and suffixes the two sources disagree on', () => {
    for (const [a, b] of [
      ['Lake Wateree', 'Wateree Lake (Kershaw Co, SC)'],
      ['Parr Reservoir', 'Parr Shoals Reservoir'],   // NOT equal -- see below
      ['Lake Hartwell', 'Hartwell Lake (Oconee Co, SC/GA)'],
      ['Boyd Pond', 'Boyd Millpond (Laurens Co, SC)'],
      ["Glisson's Mill Pond", 'Glissons Millpond (Evans Co, GA)'],
      ['High Falls SP Lake', 'High Falls Lake (Monroe Co, GA)'],
      ['SUTTON LAKE', 'Lake Sutton (New Hanover Co, NC)'],
    ]) {
      if (a === 'Parr Reservoir') continue;  // handled by the curated pass, not this one
      expect(lakeNameLooseKey(a), `${a} vs ${b}`).toBe(lakeNameLooseKey(b));
    }
  });

  it('collides on the pair the audit warned about, which is why bounds are required', () => {
    // Lake Murray 48,761 ac and Murray Pond 148 ac, 12 miles apart. The loose key CANNOT
    // tell them apart and is never allowed to try on its own.
    expect(lakeNameLooseKey('Lake Murray')).toBe(lakeNameLooseKey('Murray Pond'));
  });
});

describe('pass A — curated variants the registry already ships', () => {
  const bowenSC = {
    name: 'Lake William C Bowen',
    displayName: 'Lake William C Bowen (Spartanburg Co, SC)',
    legacyDisplayNames: ['Lake William C Bowen, SC', 'Lake Bowen, SC'],
    boundsWSEN: [-82.05, 35.05, -81.95, 35.15],
  };

  it('merges a DNR name that only matches a legacy_display_names entry', () => {
    const i = idx([['Lake Bowen, SC', [pt(35.10, -82.00)]]]);
    expect(findExistingLakeKey(i, bowenSC.name, 35.10, -82.00, 15, bowenSC)).toBe('Lake Bowen, SC');
  });

  it('without the record it still only sees the primary name — the old behaviour', () => {
    const i = idx([['Lake Bowen, SC', [pt(35.10, -82.00)]]]);
    expect(findExistingLakeKey(i, bowenSC.name, 35.10, -82.00)).toBe(null);
  });
});

describe('pass B — loose name, but only with the point inside the lake', () => {
  const murray = {
    name: 'Lake Murray', displayName: 'Lake Murray (Lexington Co, SC)',
    legacyDisplayNames: [], boundsWSEN: [-81.40, 34.00, -81.10, 34.20],
  };
  const murrayPond = {
    name: 'Murray Pond', displayName: 'Murray Pond (Richland Co, SC)',
    legacyDisplayNames: [], boundsWSEN: [-80.95, 34.05, -80.93, 34.07],
  };

  it('merges when a ramp actually falls in the lake', () => {
    const i = idx([['Murray Pond, SC', [pt(34.06, -80.94)]]]);
    expect(findExistingLakeKey(i, murrayPond.name, 34.06, -80.94, 15, murrayPond))
      .toBe('Murray Pond, SC');
  });

  it('refuses the namesake whose ramp is outside its bbox', () => {
    // Murray Pond's ramp, offered to Lake Murray. Same loose key, ~12 miles apart, so the
    // 15-mile radius alone would have said yes.
    const i = idx([['Murray Pond, SC', [pt(34.06, -80.94)]]]);
    expect(findExistingLakeKey(i, murray.name, 34.10, -81.25, 15, murray)).toBe(null);
  });

  // A record whose every name is loose-equal to 'Murray Pond' but exact-equal to none of it,
  // so pass A cannot fire and pass B is the only thing being tested.
  const looseOnly = {
    name: 'Murray Reservoir', displayName: 'Murray Reservoir (Richland Co, SC)',
    legacyDisplayNames: [], boundsWSEN: [-80.95, 34.05, -80.93, 34.07],
  };

  it('the loose-only record does merge when everything lines up', () => {
    const i = idx([['Murray Pond, SC', [pt(34.06, -80.94)]]]);
    expect(findExistingLakeKey(i, looseOnly.name, 34.06, -80.94, 15, looseOnly))
      .toBe('Murray Pond, SC');
  });

  it('declines when the record has no bounds — no second signal, no merge', () => {
    const noBounds = { ...looseOnly, boundsWSEN: null };
    const i = idx([['Murray Pond, SC', [pt(34.06, -80.94)]]]);
    expect(findExistingLakeKey(i, noBounds.name, 34.06, -80.94, 15, noBounds)).toBe(null);
  });

  it('declines when the existing entry has no access points to corroborate with', () => {
    const i = idx([['Murray Pond, SC', []]]);
    expect(findExistingLakeKey(i, looseOnly.name, 34.06, -80.94, 15, looseOnly)).toBe(null);
  });
});
