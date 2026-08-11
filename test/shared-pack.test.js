import { describe, it, expect } from './expect-shim.mjs';
import { resolveR2Key, PACK_SHARED_WITH } from '../js/data/lake-keys.js';
import { isKeepAlways } from '../js/data/water-filter.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// BATES AND THE CONGAREE SELECT EACH OTHER
//
// Ryan, 2026-08-11: "bates old river is part of congaree river boundary so both the congaree and
// bates selectors need to select both."
//
// Not because they are the same water — he corrected me on exactly that, twice — but because
// 3DHP has no waterbody polygon for Bates at all. gnisid 1220360 is eleven flowlines and zero
// polygons, seven of them filed under the Congaree's own river polygon OH8SM, which IS
// registry/boundaries/congaree_river.geojson. So the 0.73 km of Bates that Garmin charted got
// clipped into chartpack/congaree_river/ and there is nowhere else for it to be.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('a water whose bathymetry ships inside another water\'s pack', () => {
  it('sends Bates Old River to the pack that actually holds its soundings', () => {
    // Before this, `bates_old_river_sc` was a real registry row with no pack in R2, and the
    // registry-slug pass treats a slug as authoritative — so selecting Bates fetched a 404.
    expect(resolveR2Key('Bates Old River')).toBe('congaree_river');
    expect(resolveR2Key('Bates Old River, SC')).toBe('congaree_river');
    expect(resolveR2Key('bates old river')).toBe('congaree_river');
  });

  it('leaves the Congaree exactly where it was', () => {
    // The other half of "both selectors select both" is free: the Congaree already loads the pack
    // that contains Bates. Nothing to do but not break it.
    expect(resolveR2Key('Congaree River')).toBe('congaree_river');
  });

  it('does not swallow a different water whose name merely contains Bates', () => {
    // Matching is on the whole normalised name, never a substring. `bates_pond` is a real,
    // separate 25-acre water in Georgetown County with its own pack.
    expect(resolveR2Key('Bates Pond')).not.toBe('congaree_river');
    expect(resolveR2Key('Bates Mill Pond')).not.toBe('congaree_river');
  });

  it('is a short, curated list and stays that way', () => {
    // This outranks the registry, so every entry is a decision someone has to have made. If it
    // grows past a handful, the answer is a build, not another row here.
    expect(Object.keys(PACK_SHARED_WITH).length <= 5).toBe(true);
  });

  it('keeps Bates visible in every picker, since it resolves now', () => {
    // KEEP_ALWAYS already carries it past the filters — worth pinning, because the row has no
    // bathymetry flag of its own and would otherwise be cut by the map gate.
    expect(isKeepAlways('Bates Old River')).toBe(true);
  });
});
