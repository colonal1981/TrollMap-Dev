import { describe, it, expect } from './expect-shim.mjs';
import { resolveR2Key, registerR2Key } from '../js/data/lake-keys.js';
import { isKeepAlways } from '../js/data/water-filter.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// BATES OLD RIVER ANSWERS FOR ITSELF
//
// This file used to pin the opposite. Ryan, 2026-08-11: "bates old river is part of congaree
// river boundary so both the congaree and bates selectors need to select both" — because 3DHP
// has no waterbody polygon for Bates at all (gnisid 1220360 is eleven flowlines and zero
// polygons, seven of them filed under the Congaree's own river polygon OH8SM), so the 0.73 km
// of Bates that Garmin charted got clipped into chartpack/congaree_river/ and there was
// nowhere else for it to be. `PACK_SHARED_WITH` sent the name there, ahead of the registry.
//
// On 2026-08-22 Bates got a boundary cut from the centreline instead of from a polygon that
// does not exist, and a registry row to go with it: bates_old_river, 66.5 acres, 8,478 of its
// 10,508 Quickdraw soundings, charted 0.293, shipped. So the curated row came out, and these
// assertions are its inverse.
//
// THE TRIPWIRE IS ON THE BEHAVIOUR, NOT ON THE NAME. `expect(PACK_SHARED_WITH).toBe(undefined)`
// would pass the day someone re-added the table under a different identifier. What must stay
// true is that no answer outranks the registry slug, and that an unregistered Bates does not
// silently borrow a neighbour's pack.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('a water that used to ship inside another water\'s pack', () => {
  it('does not send Bates to the Congaree before anything is registered', () => {
    // The old table was consulted FIRST, so this returned congaree_river with an empty
    // registry. Nothing may answer for Bates ahead of its own slug now.
    expect(resolveR2Key('Bates Old River')).not.toBe('congaree_river');
    expect(resolveR2Key('Bates Old River, SC')).not.toBe('congaree_river');
    expect(resolveR2Key('bates old river')).not.toBe('congaree_river');
  });

  it('sends Bates to its own pack once the registry has loaded', () => {
    // This is what access-index.js does per row as lake_index.json arrives. All three spellings
    // are real: display_name, legacy_display_name, and the bare name the alias table carries.
    registerR2Key('Bates Old River (Richland Co, SC)', 'bates_old_river');
    registerR2Key('Bates Old River, SC', 'bates_old_river');
    registerR2Key('Bates Old River', 'bates_old_river');

    expect(resolveR2Key('Bates Old River (Richland Co, SC)')).toBe('bates_old_river');
    expect(resolveR2Key('Bates Old River, SC')).toBe('bates_old_river');
    expect(resolveR2Key('bates old river')).toBe('bates_old_river');
  });

  it('leaves the Congaree exactly where it was', () => {
    // The Congaree keeps its own pack. Bates leaving does not move it.
    expect(resolveR2Key('Congaree River')).toBe('congaree_river');
  });

  it('does not swallow a different water whose name merely contains Bates', () => {
    // bates_pond is a real, separate 25-acre water in Georgetown County with its own pack, and
    // it is in R2 under its own key. Neither the Congaree nor Bates Old River may claim it.
    expect(resolveR2Key('Bates Pond')).not.toBe('congaree_river');
    expect(resolveR2Key('Bates Pond')).not.toBe('bates_old_river');
    expect(resolveR2Key('Bates Mill Pond')).not.toBe('congaree_river');
    expect(resolveR2Key('Bates Mill Pond')).not.toBe('bates_old_river');
  });

  it('keeps Bates visible in every picker', () => {
    // KEEP_ALWAYS carries it past the map gate. It has real bathymetry of its own now, but the
    // pin stays: this is one of Ryan's home waters and the gate is not the place to lose it.
    expect(isKeepAlways('Bates Old River')).toBe(true);
  });
});
