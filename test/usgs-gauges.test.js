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

// The OGC API returns a GeoJSON FeatureCollection, one feature per observation, and `value`
// is a string "to preserve precision". These pin the new shape alongside the NWIS ones above,
// which stay until waterservices is decommissioned in Q1 2027.
function ogc(values) {
  return {
    type: 'FeatureCollection',
    features: values.map((v) => ({
      type: 'Feature',
      properties: { monitoring_location_id: 'USGS-02171700', parameter_code: '00060',
                    value: v === null ? null : String(v), time: '2026-08-06T12:00:00Z' },
    })),
  };
}

describe('extractValues — OGC payload parsing', () => {
  it('pulls numeric discharge out of a FeatureCollection', () => {
    expect(extractValues(ogc([1200, 1350, 1410]))).toEqual([1200, 1350, 1410]);
  });

  it('drops the -999999 sentinel in the new shape too', () => {
    expect(extractValues(ogc([1200, -999999, 1400]))).toEqual([1200, 1400]);
  });

  it('drops non-numeric values', () => {
    expect(extractValues(ogc([1200, 'Ice', 1400]))).toEqual([1200, 1400]);
  });

  it('an empty-string value is skipped, NOT read as 0 cfs', () => {
    // Number('') === 0. A phantom 0 cfs inside a 30-day mean turns a flooding river into a
    // drought, which is the exact signal this module exists to raise.
    expect(extractValues(ogc([1200, '', 1400]))).toEqual([1200, 1400]);
    expect(extractValues(ogc([1200, null, 1400]))).toEqual([1200, 1400]);
  });

  it('accepts a bare feature array as well as a FeatureCollection', () => {
    expect(extractValues(ogc([500, 600]).features)).toEqual([500, 600]);
  });

  it('returns [] for empty or malformed payloads instead of throwing', () => {
    expect(extractValues({ type: 'FeatureCollection', features: [] })).toEqual([]);
    expect(extractValues({ features: null })).toEqual([]);
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
