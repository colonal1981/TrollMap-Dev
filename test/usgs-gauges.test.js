import { describe, it, expect } from './expect-shim.mjs';
import { extractValues, mean } from '../js/modules/usgs-gauges.js';

// Shape of a real NWIS waterservices JSON response, trimmed.
function nwis(values) {
  return {
    value: {
      timeSeries: [
        {
          values: [
            { value: values.map((v) => ({ value: String(v), dateTime: '2026-07-24T12:00:00.000-04:00' })) },
          ],
        },
      ],
    },
  };
}

describe('extractValues — NWIS payload parsing', () => {
  it('pulls numeric discharge values out of a timeSeries', () => {
    expect(extractValues(nwis([1200, 1350, 1410]))).toEqual([1200, 1350, 1410]);
  });

  it('drops the -999999 no-data sentinel', () => {
    // NWIS emits -999999 for missing readings; averaging it in would make a
    // flooding river look like a drought.
    expect(extractValues(nwis([1200, -999999, 1400]))).toEqual([1200, 1400]);
  });

  it('drops non-numeric values', () => {
    expect(extractValues(nwis([1200, 'Ice', 1400]))).toEqual([1200, 1400]);
  });

  it('handles multiple timeSeries blocks', () => {
    const payload = {
      value: {
        timeSeries: [
          { values: [{ value: [{ value: '100' }] }] },
          { values: [{ value: [{ value: '200' }] }] },
        ],
      },
    };
    expect(extractValues(payload)).toEqual([100, 200]);
  });

  it('returns [] for empty or malformed payloads instead of throwing', () => {
    expect(extractValues(null)).toEqual([]);
    expect(extractValues({})).toEqual([]);
    expect(extractValues({ value: {} })).toEqual([]);
    expect(extractValues({ value: { timeSeries: [] } })).toEqual([]);
  });
});

describe('mean', () => {
  it('averages values', () => {
    expect(mean([1000, 2000, 3000])).toBe(2000);
  });

  it('returns null on empty input so callers can skip the check', () => {
    expect(mean([])).toBeNull();
    expect(mean(null)).toBeNull();
  });
});
