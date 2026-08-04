import { describe, it, expect } from './expect-shim.mjs';
import { LAKE_NAME_TO_R2_KEY as frontendMap, resolveR2Key } from '../js/data/lake-keys.js';
import { SUPPLEMENTAL_KEY_MAP, resolveSupplementalKeyWorker } from '../Worker/research/limnology.js';

describe('lake-keys parity — frontend and worker must stay identical (P1 dedupe guard)', () => {
  it('frontend map size == worker map size == 117', () => {
    // Both copies must move together — this is the guard that caught the original
    // 101 vs 74 drift.
    // 117 = 95 freshwater + 22 coastal (Cape Romain / Bulls Bay added 2026-08-03,
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
    expect(Object.keys(frontendMap).length).toBe(117);
    expect(Object.keys(SUPPLEMENTAL_KEY_MAP).length).toBe(117);
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

  it('resolvers agree on fuzzy variations (Wateree, Wylie, etc)', () => {
    const fuzzyCases = [
      'Lake Wateree',
      'Wateree',
      'Lake Murray',
      'Catawba Narrows',
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
