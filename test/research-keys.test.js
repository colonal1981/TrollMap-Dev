import { describe, it, expect } from 'vitest';
import {
  sanitizeLakeId,
  RESEARCH_CANONICAL_IDS,
  researchStorageId,
  lakeResearchMasterKey,
  lakePackageKey,
  extractJsonPossibly,
} from '../Worker/research/keys.js';

describe('sanitizeLakeId — normalization', () => {
  const cases = [
    ['Lake Wateree, SC', 'lake_wateree_sc'],
    ['Lake Murray, SC', 'lake_murray_sc'],
    ['Clarks Hill / Thurmond, SC/GA', 'clarks_hill_thurmond_sc_ga'],
    ['Lake Wateree', 'lake_wateree'],
    ['  Lake   Wateree  ', 'lake_wateree'],
    ['ACE Basin / Edisto, SC', 'ace_basin_edisto_sc'],
    ['', 'unknown_lake'],
    [null, 'unknown_lake'],
    [undefined, 'unknown_lake'],
  ];

  for (const [input, expected] of cases) {
    it(`sanitizeLakeId('${input}') → '${expected}'`, () => {
      expect(sanitizeLakeId(input)).toBe(expected);
    });
  }

  it('truncates to 80 chars', () => {
    const long = 'A'.repeat(200);
    expect(sanitizeLakeId(long).length).toBeLessThanOrEqual(80);
  });

  it('strips leading/trailing underscores', () => {
    expect(sanitizeLakeId('---Lake---')).toBe('lake');
  });
});

describe('RESEARCH_CANONICAL_IDS — Wateree-chain deduplication', () => {
  it('has Clarks Hill / Thurmond canonical', () => {
    expect(RESEARCH_CANONICAL_IDS['lake_thurmond_sc']).toBe('clarks_hill_thurmond_sc_ga');
    expect(RESEARCH_CANONICAL_IDS['clarks_hill_lake_ga']).toBe('clarks_hill_thurmond_sc_ga');
    expect(RESEARCH_CANONICAL_IDS['j_strom_thurmond_lake']).toBe('clarks_hill_thurmond_sc_ga');
  });

  it('has Wylie canonical', () => {
    expect(RESEARCH_CANONICAL_IDS['lake_wylie_nc']).toBe('lake_wylie_sc');
    expect(RESEARCH_CANONICAL_IDS['lake_wylie_sc_nc']).toBe('lake_wylie_sc');
  });

  it('has Russell canonical', () => {
    expect(RESEARCH_CANONICAL_IDS['lake_russell_sc_ga']).toBe('lake_russell_sc');
  });
});

describe('researchStorageId — canonical id resolution', () => {
  it('maps aliased lakes to canonical', () => {
    expect(researchStorageId('Lake Thurmond, SC')).toBe('clarks_hill_thurmond_sc_ga');
    expect(researchStorageId('Clarks Hill Lake, GA')).toBe('clarks_hill_thurmond_sc_ga');
    expect(researchStorageId('Lake Wylie, NC')).toBe('lake_wylie_sc');
  });

  it('returns sanitized id for non-aliased', () => {
    expect(researchStorageId('Lake Wateree, SC')).toBe('lake_wateree_sc');
    expect(researchStorageId('Lake Murray, SC')).toBe('lake_murray_sc');
  });
});

describe('lakeResearchMasterKey and lakePackageKey', () => {
  it('lakeResearchMasterKey → lakes/<id>.json', () => {
    expect(lakeResearchMasterKey('Lake Wateree, SC')).toBe('lakes/lake_wateree_sc.json');
    expect(lakeResearchMasterKey('Lake Thurmond, SC')).toBe('lakes/clarks_hill_thurmond_sc_ga.json');
  });

  it('lakePackageKey → lake_packages/<id>/<file>', () => {
    expect(lakePackageKey('Lake Wateree, SC', 'normalized.json')).toBe(
      'lake_packages/lake_wateree_sc/normalized.json'
    );
  });
});

describe('extractJsonPossibly — LLM output sanitizer', () => {
  it('parses clean JSON', () => {
    expect(extractJsonPossibly('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips code fences', () => {
    expect(extractJsonPossibly('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonPossibly('```\n{"b":2}\n```')).toEqual({ b: 2 });
  });

  it('extracts JSON from surrounding text', () => {
    expect(extractJsonPossibly('Here is result: {"c":3} thanks')).toEqual({ c: 3 });
  });

  it('returns null for non-JSON', () => {
    expect(extractJsonPossibly('not json at all')).toBeNull();
    expect(extractJsonPossibly('')).toBeNull();
    expect(extractJsonPossibly(null)).toBeNull();
  });

  it('handles nested objects', () => {
    const obj = { identity: { surfaceAreaAcres: 100 }, limnology: {} };
    expect(extractJsonPossibly(JSON.stringify(obj))).toEqual(obj);
  });
});
