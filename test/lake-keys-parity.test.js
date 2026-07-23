import { describe, it, expect } from 'vitest';
import { LAKE_NAME_TO_R2_KEY as frontendMap, resolveR2Key } from '../js/data/lake-keys.js';
import { SUPPLEMENTAL_KEY_MAP, resolveSupplementalKeyWorker } from '../Worker/research/limnology.js';

describe('lake-keys parity — frontend and worker must stay identical (P1 dedupe guard)', () => {
  it('frontend map size == worker map size == 101', () => {
    expect(Object.keys(frontendMap).length).toBe(101);
    expect(Object.keys(SUPPLEMENTAL_KEY_MAP).length).toBe(101);
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
