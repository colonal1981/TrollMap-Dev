import { describe, it, expect } from 'vitest';
import { LAKE_NAME_TO_R2_KEY, resolveR2Key } from '../js/data/lake-keys.js';

describe('LAKE_NAME_TO_R2_KEY — single source of truth (101 entries)', () => {
  it('has 101 entries (full map, not truncated worker copy)', () => {
    expect(Object.keys(LAKE_NAME_TO_R2_KEY).length).toBe(101);
  });

  it('contains critical keys that were missing in old worker copy', () => {
    // These were missing in old Worker/research/limnology.js 74-entry copy
    expect(LAKE_NAME_TO_R2_KEY['Catawba Narrows, SC/NC']).toBe('catawba_narrows');
    expect(LAKE_NAME_TO_R2_KEY['Fort Loudoun Lake, TN']).toBe('fort_loudoun_lake');
    expect(LAKE_NAME_TO_R2_KEY['Fort Loundon Reservoir, TN']).toBe('fort_loudoun_lake'); // typo alias
    expect(LAKE_NAME_TO_R2_KEY['ACE Basin / Edisto, SC']).toBe('sc_ga_coastal');
    expect(LAKE_NAME_TO_R2_KEY['Lake Bowen, SC']).toBe('lake_bowen');
    expect(LAKE_NAME_TO_R2_KEY['Lake Blalock, SC']).toBe('lake_blalock');
  });

  it('contains Wateree chain and Russell chain aliases', () => {
    expect(LAKE_NAME_TO_R2_KEY['Lake Wateree, SC']).toBe('lake_wateree_fishing_creek');
    expect(LAKE_NAME_TO_R2_KEY['Fishing Creek Reservoir, SC']).toBe('lake_wateree_fishing_creek');
    expect(LAKE_NAME_TO_R2_KEY['Lake Russell, SC/GA']).toBe('lake_thurmond_russell');
    expect(LAKE_NAME_TO_R2_KEY['Clarks Hill / Thurmond, SC/GA']).toBe('lake_thurmond_russell');
    expect(LAKE_NAME_TO_R2_KEY['Richard B. Russell Lake, GA']).toBe('lake_thurmond_russell');
  });
});

describe('resolveR2Key — fuzzy resolver (canonical)', () => {
  const cases = [
    ['Lake Wateree, SC', 'lake_wateree_fishing_creek'],
    ['Lake Wateree', 'lake_wateree_fishing_creek'],
    ['Wateree', 'lake_wateree_fishing_creek'],
    ['Lake Wateree (Duke Energy)', 'lake_wateree_fishing_creek'], // partial match handles suffix
    ['Lake Murray, SC', 'lake_murray'],
    ['Lake Marion, SC', 'lake_marion'],
    ['Catawba Narrows, SC/NC', 'catawba_narrows'],
    ['Catawba Narrows', 'catawba_narrows'],
    ['Lake Wylie, SC/NC', 'lake_wylie'],
    ['Lake Wylie', 'lake_wylie'],
    ['Fort Loudoun Lake, TN', 'fort_loudoun_lake'],
    ['Fort Loudoun Reservoir, TN', 'fort_loudoun_lake'],
    ['Tellico Lake, TN', 'tellico_lake'],
    ['Lake Norman, NC', 'lake_norman_mountain_island'],
    ['Mountain Island Lake, NC', 'lake_norman_mountain_island'],
    ['ACE Basin / Edisto, SC', 'sc_ga_coastal'],
    ['Charleston Harbor, SC', 'sc_ga_coastal'],
    ['Lake Hickory, NC', 'lake_hickory_rhodhiss'],
    ['Lake James, NC', 'lake_james'],
    ['Lake Lanier, GA', 'lake_lanier'],
    ['Lake Burton, GA', 'lake_burton'],
    ['Watauga Lake, TN', 'watauga_boone_chain'],
    ['Boone Lake, TN', 'watauga_boone_chain'],
    ['Watauga / Boone Chain, TN/NC', 'watauga_boone_chain'],
  ];

  for (const [input, expected] of cases) {
    it(`resolveR2Key('${input}') → '${expected}'`, () => {
      expect(resolveR2Key(input)).toBe(expected);
    });
  }

  it('returns null for unknown lake (not generic fallback)', () => {
    // Old worker fallback generated lake_${base} which masked misses and broke shoreline R2 lookups
    expect(resolveR2Key('Fake Lake That Does Not Exist, SC')).toBeNull();
    expect(resolveR2Key('Nonexistent Reservoir')).toBeNull();
    expect(resolveR2Key('')).toBeNull();
    expect(resolveR2Key(null)).toBeNull();
  });

  it('handles state suffix stripping', () => {
    expect(resolveR2Key('Lake Marion')).toBe('lake_marion');
    expect(resolveR2Key('Lake Marion, SC')).toBe('lake_marion');
    // NC/GA suffix
    expect(resolveR2Key('Lake Wylie, SC/NC')).toBe('lake_wylie');
    expect(resolveR2Key('Lake Wylie')).toBe('lake_wylie');
  });

  it('is case-insensitive partial match for Duke Energy / county suffix variations', () => {
    expect(resolveR2Key('Lake Wateree (Duke Energy)')).toBe('lake_wateree_fishing_creek');
    expect(resolveR2Key('Lake Wateree - Kershaw County, SC')).toBe('lake_wateree_fishing_creek');
  });
});
