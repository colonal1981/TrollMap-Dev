import { describe, it, expect } from './expect-shim.mjs';
import { LAKE_NAME_TO_R2_KEY as frontendMap, resolveR2Key } from '../js/data/lake-keys.js';
import { SUPPLEMENTAL_KEY_MAP, resolveSupplementalKeyWorker } from '../Worker/research/limnology.js';

describe('lake-keys parity — frontend and worker must stay identical (P1 dedupe guard)', () => {
  it('frontend map size == worker map size == 102', () => {
    // Both copies must move together — this is the guard that caught the original
    // 101 vs 74 drift.
    // 102 after the 2026-08-04 rebind to lake_index.json. Fewer names than before:
        // 15 whose packs do not exist are refused outright rather than mapped, and two
        // combined names were split into their halves.
        // (was 117 = 95 freshwater + 22 coastal, Cape Romain added 2026-08-03,
    // a stretch that previously fell in the gap between the Charleston and Santee boxes). Was 118 until 2026-08-03, when 'High Rock
    // Lake, NC' and 'Blewett Falls Lake, NC' were removed: the R2 prune retired
    // `yadkin_river_chain` and 3DHP never named those two, so they have no
    // replacement pack. A name bound to a slug with no pack is a lake that appears
    // in the list and then fails to load, which is worse than an absent name.
    // Goes back to 118 once high_rock_lake and blewett_falls_lake are built --
    // see claude/YADKIN_ORPHANS_RECOVERY_2026-08-03.md.
    //
    // This literal is doing its job. It is not a nuisance to be silenced: it fired
    // the moment two lakes left the data, which is exactly when someone should look.
    // 2026-08-04: rebound to lake_index.json. 36 slugs the app referenced did not
    // exist there -- ~20 renamed when the index was regenerated from 3DHP
    // (lake_hartwell -> hartwell_lake), 8 combined packs that had been split into
    // halves, and the rest never built. Names with no pack are now REFUSED in
    // LAKE_NAMES_WITHOUT_PACK rather than merely deleted, because deleting one lets
    // the fuzzy pass answer instead -- 'Kerr Lake, NC' was resolving to
    // w_kerr_scott_reservoir, a different lake 1/40th the size.
    // 117 as of 2026-08-04: 102 + fifteen names whose packs were built and installed that night
    // (Randleman, Kerr x2, High Rock, Falls, John H. Moss, Bonnie Doone, Blewett Falls,
    // Hiwassee, Cheoah x2, Lookout Shoals, Juliette, Blalock) plus Catawba Narrows, which
    // has no pack of its own and is aliased to lake_wylie because the reach IS Wylie's water.
    // 120 as of 2026-08-11: three spellings of the Congaree — "Congaree River", "Congaree River,
    // SC" and "Congaree River (to SC-601)" — all bound to `congaree_river`, the pack that exists.
    // Ryan: "congaree river is called congaree river we have it."
    //
    // The plain name resolved to NOTHING before the registry loaded, and after it loaded the
    // answer depended on which of TWO registry rows for the same water registered its slug first:
    // the one with the pack, or the packless duplicate `congaree_river_to_sc_601`. A water he
    // fishes should not resolve by load order. It matters doubly now that Bates Old River shares
    // that pack — see PACK_SHARED_WITH in lake-keys.js.
    // 121 as of 2026-08-14: "Lake Robinson (Greenville Co, SC)" -> lake_robinson_greer. SC has
    // TWO Lake Robinsons, 190 km apart, and BOTH registry rows carry the legacy string
    // "Lake Robinson, SC" -- so Pass 4 had no way to prefer either and answered Darlington for
    // both. Same shape as the Congaree entry above: a water he can pick should not resolve by
    // which row registered its slug first.
    expect(Object.keys(frontendMap).length).toBe(121);
    expect(Object.keys(SUPPLEMENTAL_KEY_MAP).length).toBe(121);
  });

  it('maps are deep equal', () => {
    expect(SUPPLEMENTAL_KEY_MAP).toEqual(frontendMap);
  });

  it('resolvers return identical results for all known lakes', () => {
    for (const displayName of Object.keys(frontendMap)) {
      const fe = resolveR2Key(displayName);
      const wk = resolveSupplementalKeyWorker(displayName);
      expect(wk).toBe(fe);
      expect(wk).toBe(frontendMap[displayName]);
    }
  });

  it('both resolvers refuse a name with no pack, identically', () => {
    // Added 2026-08-04. 'Catawba Narrows' used to sit in the list above as a name that
    // must resolve to something; it has no pack, so it now resolves to nothing. Agreeing
    // on NOTHING is as important as agreeing on a key — a worker that answers where the
    // frontend declines would serve contours the app never asked for.
    // The original five all have packs as of 2026-08-04 and now resolve. Replaced with
    // names that still have none: no DNR ramp to seed a boundary from, so nothing to cut.
    for (const name of ['Auman Lake, NC', 'Lake Mackintosh, NC',
                        'Lake Michie / Little River, NC', 'Lake Reidsville, NC']) {
      expect(resolveR2Key(name)).toBe(null);
      expect(resolveSupplementalKeyWorker(name)).toBe(null);
    }
  });

  it('resolvers agree on fuzzy variations (Wateree, Wylie, etc)', () => {
    const fuzzyCases = [
      'Lake Wateree',
      'Wateree',
      'Lake Murray',
      'Lake Hartwell, SC/GA',
      'Lake Wylie',
      'Fort Loudoun Lake, TN',
      'Tellico Lake, TN',
      'Lake Norman',
      'ACE Basin / Edisto, SC',
    ];
    for (const name of fuzzyCases) {
      const fe = resolveR2Key(name);
      const wk = resolveSupplementalKeyWorker(name);
      expect(wk).toBe(fe);
      expect(fe).toBeTruthy(); // should resolve, not null
    }
  });

  it('both return null for unknown (not generic fallback)', () => {
    const unknowns = ['Fake Lake XYZ, SC', 'Nonexistent Reservoir', ''];
    for (const name of unknowns) {
      expect(resolveR2Key(name)).toBeNull();
      expect(resolveSupplementalKeyWorker(name)).toBeNull();
    }
  });
});
