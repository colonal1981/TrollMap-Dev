import { describe, it, expect } from './expect-shim.mjs';
import { coerceStockingsArray, coerceSpeciesArray, coerceList, coerceLabels,
         numberFromText, IDENTITY_MEASURES,
         pruneRetiredFields, RETIRED_PROFILE_FIELDS } from '../js/utils/coerce.js';

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

// Every sentence below is verbatim from Lake Jocassee's own research run on 2026-08-23 --
// _extractedFacts in lake_jocassee_sc_research.json, quoted out of a FERC licence and two
// Federal Register notices. The profile that run shipped carried
// surfaceAreaAcres 92.47980111 and normalPoolFt 22538711101080, because the old parseNum
// deleted every non-digit and read the remains as one number.
const M = IDENTITY_MEASURES;

describe('numberFromText — the sentences that produced the bad profile', () => {
  it('reads acres past a shoreline length in the same sentence', () => {
    const fact = 'Lake Jocassee has a shoreline length of 92.4 miles and a surface area of '
               + '7,980 acres at full pool elevation of 1,110 feet.';
    expect(numberFromText(fact, M.surfaceAreaAcres)).toBe(7980);   // was 92.47980111
  });

  it('reads a hyphenated acreage', () => {
    const fact = 'All water utilized for generation originates from the 7,980-acre lower reservoir (Lake Jocassee)';
    expect(numberFromText(fact, M.surfaceAreaAcres)).toBe(7980);
  });

  it('refuses a storage capacity in acre-feet that names two elevations', () => {
    const fact = 'The usable storage capacity is 225,387 acre-feet between elevations 1,110 and 1,080 feet.';
    expect(numberFromText(fact, M.normalPoolFt)).toBe(null);       // was 22538711101080
  });

  it('refuses an operating range rather than picking an end of it', () => {
    expect(numberFromText('Lake Jocassee is licensed to operate between 1,080 and 1,110 feet', M.normalPoolFt)).toBe(null);
    expect(numberFromText('the project boundary generally follows the 1,110- to 1,120-foot contour elevation around Lake Jocassee', M.normalPoolFt)).toBe(null);
  });

  it('refuses a minimum elevation when asked for the normal pool', () => {
    const fact = 'For periods of normal inflow, Duke Energy will operate Lake Jocassee at a normal minimum elevation of 1,096 feet.';
    expect(numberFromText(fact, M.normalPoolFt)).toBe(null);
  });

  it('takes the normal maximum when a sentence states both ends by name', () => {
    const fact = 'which has a normal maximum elevation of 1,110 feet msl and normal minimum elevation of 1,080 feet msl.';
    expect(numberFromText(fact, M.normalPoolFt)).toBe(1110);
  });
});

describe('numberFromText — the rules that make those answers repeatable', () => {
  it('never concatenates: no output is longer than any number in the input', () => {
    const fact = 'capacity 225,387 acre-feet between 1,110 and 1,080 feet';
    for (const measure of Object.values(M)) {
      const v = numberFromText(fact, measure);
      if (v != null) expect(String(v).replace('.', '').length <= 6).toBe(true);
    }
  });

  it('reads thousands separators', () => {
    expect(numberFromText('a surface area of 7,980 acres', M.surfaceAreaAcres)).toBe(7980);
    expect(numberFromText('a surface area of 12,345 acres', M.surfaceAreaAcres)).toBe(12345);
  });

  it('does not read acre-feet as feet', () => {
    expect(numberFromText('storage of 225,387 acre-feet', M.normalPoolFt)).toBe(null);
    expect(numberFromText('storage of 225,387 acre-feet', M.maxDepthFt)).toBe(null);
  });

  it('carries a unit backwards across a range but not across prose', () => {
    // "1,110 and 1,080 feet" states two elevations -> ambiguous.
    expect(numberFromText('elevations 1,110 and 1,080 feet', M.normalPoolFt)).toBe(null);
    // "92.4 miles and a surface area of 7,980 acres" does not make 92.4 an acreage.
    expect(numberFromText('92.4 miles and a surface area of 7,980 acres', M.surfaceAreaAcres)).toBe(7980);
  });

  it('prefers the number its own field introduces', () => {
    const fact = 'average depth of 156 feet and a maximum depth of 300 feet';
    expect(numberFromText(fact, M.averageDepthFt)).toBe(156);
    expect(numberFromText(fact, M.maxDepthFt)).toBe(300);
  });

  it('returns null for a sentence with no number, and for junk', () => {
    expect(numberFromText('the reservoir is deep', M.maxDepthFt)).toBe(null);
    expect(numberFromText('', M.maxDepthFt)).toBe(null);
    expect(numberFromText(null, M.maxDepthFt)).toBe(null);
    expect(numberFromText(undefined, M.surfaceAreaAcres)).toBe(null);
  });

  it('reads a year', () => {
    expect(numberFromText('The reservoir was impounded in 1973.', M.yearImpounded)).toBe(1973);
  });
});

// Lake Jocassee, 2026-08-23. Re-running the habitat agent returned the same eight humps and
// eight ledges byte for byte -- 400-500 "acre" humps in 3-7 ft of water, seven of the eight
// outside the lake, one 27 km away in Lake Glenville. Nothing has produced humpCoordinates
// since the coordinates moved into the pack, and the merge preserves any key an agent did not
// return, so there was nothing left to overwrite them WITH.
describe('pruneRetiredFields', () => {
  const jocassee = () => ({
    habitat: {
      structuralElements: {
        channelLedges: 'mid-depth contour density indicates multiple ledges',
        humps: 'multiple closed contour loops suggest several offshore humps',
        humpCoordinates: [{ id: 'hump_1', lat: 35.24383, lon: -83.0828, areaAcres: 498.4, depth: 4 }],
        ledgeCoordinates: [{ id: 'ledge_1', lat: 35.23683, lon: -82.9888 }],
        flats: 'shallow flats near the headwaters',
      },
      cover: 'none',
    },
    identity: { maxDepthFt: 360 },
  });

  it('drops the coordinate arrays a re-run cannot reach', () => {
    const p = jocassee();
    pruneRetiredFields(p);
    expect('humpCoordinates' in p.habitat.structuralElements).toBe(false);
    expect('ledgeCoordinates' in p.habitat.structuralElements).toBe(false);
  });

  it('reports what it dropped, with the count', () => {
    const dropped = pruneRetiredFields(jocassee());
    expect(dropped).toEqual([
      'habitat.structuralElements.humpCoordinates (1)',
      'habitat.structuralElements.ledgeCoordinates (1)',
    ]);
  });

  it('leaves every other field alone', () => {
    const p = jocassee();
    pruneRetiredFields(p);
    expect(p.habitat.structuralElements.channelLedges).toBe('mid-depth contour density indicates multiple ledges');
    expect(p.habitat.structuralElements.flats).toBe('shallow flats near the headwaters');
    expect(p.habitat.cover).toBe('none');
    expect(p.identity.maxDepthFt).toBe(360);
  });

  it('is silent on a profile that never had them', () => {
    expect(pruneRetiredFields({ habitat: { cover: [] } })).toEqual([]);
    expect(pruneRetiredFields({})).toEqual([]);
    expect(pruneRetiredFields(null)).toEqual([]);
    expect(pruneRetiredFields('not a profile')).toEqual([]);
  });

  it('does not walk into a missing branch', () => {
    expect(pruneRetiredFields({ habitat: null })).toEqual([]);
    expect(pruneRetiredFields({ habitat: { structuralElements: null } })).toEqual([]);
  });

  it('drops a key that is present but empty, so it stops being carried forward', () => {
    const p = { habitat: { structuralElements: { humpCoordinates: [] } } };
    expect(pruneRetiredFields(p)).toEqual(['habitat.structuralElements.humpCoordinates (0)']);
    expect('humpCoordinates' in p.habitat.structuralElements).toBe(false);
  });

  it('the list stays short on purpose', () => {
    // A row goes in when a producer is deleted and comes out once every saved profile has been
    // through one assembly. If this ever needs raising, the reason belongs in the comment
    // above the list, not in the number.
    expect(RETIRED_PROFILE_FIELDS.length <= 6).toBe(true);
    for (const path of RETIRED_PROFILE_FIELDS) expect(Array.isArray(path)).toBe(true);
  });
});
