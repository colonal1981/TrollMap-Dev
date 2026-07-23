import { describe, it, expect } from 'vitest';
import { parseLakeBaseName, expandLakeAbbrev } from '../Worker/research/keys.js';

// Bug #1: TWRA seed not firing.
// TrollMap calls the lake "Ft. Loudoun Reservoir, TN" but the R2 TWRA profile
// and the baseLower-keyed lookup tables (TWRA_LAKE_PAGES, LAKE_SYSTEM_ALIASES,
// LAKE_OWNER_DOMAINS in research/discover.js) are keyed "fort loudoun". The
// "Ft." abbreviation + period made baseLower "ft. loudoun" so every lookup
// missed and the TWRA seed never fired. parseLakeBaseName now expands the
// abbreviation so all variants collapse to baseLower "fort loudoun".
describe('parseLakeBaseName — Ft. / Fort Loudoun normalization (TWRA seed fix)', () => {
  const loudounVariants = [
    'Ft. Loudoun Reservoir, TN',
    'Ft Loudoun Reservoir, TN',
    'Ft. Loudoun Lake, TN',
    'Fort Loudoun Reservoir, TN',
    'Fort Loudoun Lake, TN',
  ];

  for (const input of loudounVariants) {
    it(`resolve ${JSON.stringify(input)} → baseLower "fort loudoun"`, () => {
      const baseLower = parseLakeBaseName(input).toLowerCase();
      expect(baseLower).toBe('fort loudoun');
    });
  }

  it('preserves the title-case base name (used in seed titles / Grokipedia URLs)', () => {
    expect(parseLakeBaseName('Ft. Loudoun Reservoir, TN')).toBe('Fort Loudoun');
    expect(parseLakeBaseName('Fort Loudoun Lake, TN')).toBe('Fort Loudoun');
  });
});

describe('parseLakeBaseName — unaffected lakes stay stable', () => {
  // These lakes have no abbreviations; normalization must be a no-op so we do
  // not silently change any existing baseLower-keyed lookup.
  const cases = [
    ['Lake Wateree, SC', 'wateree'],
    ['Lake Murray, SC', 'murray'],
    ['Lake Marion, SC', 'marion'],
    ['Norris Lake, TN', 'norris'],
    ['Norris Reservoir, TN', 'norris'],
    ['Watauga Lake, TN', 'watauga'],
    ['Tellico Lake, TN', 'tellico'],
    ['Lake Keowee, SC', 'keowee'],
  ];

  for (const [input, expected] of cases) {
    it(`resolve ${JSON.stringify(input)} → baseLower ${JSON.stringify(expected)}`, () => {
      expect(parseLakeBaseName(input).toLowerCase()).toBe(expected);
    });
  }
});

describe('expandLakeAbbrev — abbreviation expansion only', () => {
  const cases = [
    ['Ft. Loudoun', 'Fort Loudoun'],
    ['Ft Loudoun', 'Fort Loudoun'],
    ['Fort Loudoun', 'Fort Loudoun'],   // full word is a no-op
    ['Norris', 'Norris'],
    ['Clarks Hill', 'Clarks Hill'],
    ['', ''],
  ];

  for (const [input, expected] of cases) {
    it(`expandLakeAbbrev(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
      expect(expandLakeAbbrev(input)).toBe(expected);
    });
  }

  it('does not mangle "ft" appearing as part of another word', () => {
    // "craft" / "left" must not have their leading "ft" treated as Fort.
    expect(expandLakeAbbrev('Craft Lake')).toBe('Craft Lake');
    expect(expandLakeAbbrev('Left Fork')).toBe('Left Fork');
  });
});
