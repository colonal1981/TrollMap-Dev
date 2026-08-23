import { describe, it, expect } from './expect-shim.mjs';
import { coerceStockingsArray, coerceSpeciesArray, coerceList, coerceLabels } from '../js/utils/coerce.js';

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

// Regression coverage for "h.cover.join is not a function" -- Lake Jocassee, 2026-08-23.
// The habitat agent returned `cover: "none"`. A non-empty string passes `if (v?.length)` and
// then has no `.join`, so syncLakeIntelData() threw and the whole briefing was replaced by the
// manual checklist. Same shape as the two crashes above it; third field, same lesson.
describe('coerceList', () => {
  it('turns a bare string into a one-item list (the exact crash scenario)', () => {
    expect(coerceList('none')).toEqual(['none']);
    expect(coerceList('none').join(', ')).toBe('none');
  });

  it('does NOT split a string on commas -- that would invent structure', () => {
    // coerceSpeciesArray splits, on purpose, because a species list is written that way.
    // A display field is not a list just because it contains a comma.
    expect(coerceList('brush, laydowns')).toEqual(['brush, laydowns']);
    expect(coerceSpeciesArray('brush, laydowns')).toEqual(['brush', 'laydowns']);
  });

  it('returns [] for null, undefined and empty string', () => {
    expect(coerceList(null)).toEqual([]);
    expect(coerceList(undefined)).toEqual([]);
    expect(coerceList('')).toEqual([]);
  });

  it('passes an array through and drops the holes', () => {
    expect(coerceList(['brush', null, '', 'timber'])).toEqual(['brush', 'timber']);
    expect(coerceList([])).toEqual([]);
  });

  it('takes an object\'s values', () => {
    expect(coerceList({ a: 'ledges', b: 'humps' })).toEqual(['ledges', 'humps']);
    expect(coerceList({})).toEqual([]);
  });

  it('keeps objects intact so a caller can still format them', () => {
    const pt = { lat: 34.9, lon: -82.9 };
    expect(coerceList([pt])).toEqual([pt]);
  });

  it('result always has .join -- which is the whole point', () => {
    for (const v of [null, undefined, '', 'none', ['a'], { k: 'v' }, 0, false]) {
      expect(typeof coerceList(v).join).toBe('function');
    }
  });
});

describe('coerceLabels', () => {
  it('reads .label off well-formed source rows', () => {
    expect(coerceLabels([{ label: 'SCDNR', url: 'x' }, { label: 'USGS' }])).toEqual(['SCDNR', 'USGS']);
  });

  it('accepts bare strings from a run that did not build objects', () => {
    expect(coerceLabels('SCDNR')).toEqual(['SCDNR']);
    expect(coerceLabels(['SCDNR', { name: 'USGS' }])).toEqual(['SCDNR', 'USGS']);
  });

  it('drops a row with no label rather than printing [object Object]', () => {
    expect(coerceLabels([{ url: 'https://example.gov' }, { label: 'SCDNR' }])).toEqual(['SCDNR']);
  });
});
