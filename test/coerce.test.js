import { describe, it, expect } from 'vitest';
import { coerceStockingsArray, coerceSpeciesArray } from '../js/utils/coerce.js';

// Regression coverage for the "biology.knownStockings.map is not a function"
// crash during profile assembly (e.g. resuming the Species Intelligence agent
// with a malformed biology section loaded from the saved profile).

describe('coerceStockingsArray', () => {
  it('returns [] for null / undefined / empty string', () => {
    expect(coerceStockingsArray(null)).toEqual([]);
    expect(coerceStockingsArray(undefined)).toEqual([]);
    expect(coerceStockingsArray('')).toEqual([]);
  });

  it('passes through a well-formed array of { species } objects', () => {
    const input = [{ species: 'Striped Bass', agency: 'SCDNR' }, { species: 'Largemouth Bass' }];
    expect(coerceStockingsArray(input)).toEqual(input);
  });

  it('coerces a non-empty STRING (the exact crash scenario) into objects', () => {
    // knownStockings persisted as a plain string previously broke profile assembly.
    const result = coerceStockingsArray('Striped Bass; Largemouth Bass');
    expect(result).toEqual([{ species: 'Striped Bass' }, { species: 'Largemouth Bass' }]);
    expect(result.map(s => s.species).join(', ')).toBe('Striped Bass, Largemouth Bass');
  });

  it('parses a JSON-string array without throwing', () => {
    const result = coerceStockingsArray('["Walleye","Sauger"]');
    expect(result).toEqual([{ species: 'Walleye' }, { species: 'Sauger' }]);
  });

  it('wraps a single stocking object', () => {
    expect(coerceStockingsArray({ species: 'Catfish', note: 'annual' })).toEqual([{ species: 'Catfish', note: 'annual' }]);
  });

  it('filters empty/blank entries and string items', () => {
    expect(coerceStockingsArray(['', ' ', 'Bluegill', null])).toEqual([{ species: 'Bluegill' }]);
  });

  it('result is always an array (so .map/.join never throw downstream)', () => {
    for (const v of ['a string', { species: 'x' }, ['y'], null, 42, '']) {
      const out = coerceStockingsArray(v);
      expect(Array.isArray(out)).toBe(true);
      expect(() => out.map(s => s.species).join(', ')).not.toThrow();
    }
  });
});

describe('coerceSpeciesArray', () => {
  it('returns [] for null / undefined / empty string', () => {
    expect(coerceSpeciesArray(null)).toEqual([]);
    expect(coerceSpeciesArray('')).toEqual([]);
  });

  it('passes through a well-formed string array', () => {
    expect(coerceSpeciesArray(['Largemouth Bass', 'Striped Bass'])).toEqual(['Largemouth Bass', 'Striped Bass']);
  });

  it('coerces a delimited STRING into an array (predatorSpecies crash scenario)', () => {
    expect(coerceSpeciesArray('Largemouth Bass, Striped Bass and Crappie')).toEqual([
      'Largemouth Bass', 'Striped Bass', 'Crappie',
    ]);
  });

  it('parses a JSON-string array', () => {
    expect(coerceSpeciesArray('["Walleye","Sauger"]')).toEqual(['Walleye', 'Sauger']);
  });

  it('wraps a single object via .species', () => {
    expect(coerceSpeciesArray({ species: 'Blue Catfish' })).toEqual(['Blue Catfish']);
  });

  it('result is always an array (so .join never throws downstream)', () => {
    for (const v of ['Largemouth Bass', { species: 'x' }, ['y'], null, 42, '']) {
      const out = coerceSpeciesArray(v);
      expect(Array.isArray(out)).toBe(true);
      expect(() => out.join(', ')).not.toThrow();
    }
  });
});
