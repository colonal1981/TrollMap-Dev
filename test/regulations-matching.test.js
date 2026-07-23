import { describe, expect, it } from 'vitest';
import { getLakeRegulations, normalizeLakeName } from '../Worker/research/clients.js';

describe('lake-specific regulation matching', () => {
  it('matches a lake contained in a combined digest exception heading', () => {
    const result = getLakeRegulations({
      general: { 'Largemouth Bass': { sizeLimit: 'Any length', creelLimit: '5' } },
      lakeSpecific: {
        'lakes blalock, greenwood, jocassee, marion, monticello, moultrie, murray, secession, wateree, wylie': {
          'Largemouth Bass': { sizeLimit: '14 inches min', creelLimit: '5 combined total' }
        }
      }
    }, 'Lake Wateree, SC');

    expect(result.hasExceptions).toBe(true);
    expect(result.lakeSpecificRegulations['Largemouth Bass'].sizeLimit).toBe('14 inches min');
  });

  it('normalizes combined headings and does not mutate cached input', () => {
    const lakeSpecific = { 'Lake Wateree': { Crappie: { sizeLimit: '8 inches min' } } };
    const result = getLakeRegulations({ general: {}, lakeSpecific }, 'Wateree Lake');
    expect(normalizeLakeName('Lake Wateree, SC')).toBe('wateree');
    expect(result.lakeSpecificRegulations).toEqual(lakeSpecific['Lake Wateree']);
    expect(lakeSpecific['Lake Wateree']).toEqual({ Crappie: { sizeLimit: '8 inches min' } });
  });
});
