// TWO FACTS THIS APP HAD FOR SOME WATERS AND NOT OTHERS.
//
// Ryan, 2026-08-25: *"any data that is available for any and all lakes should be available for
// any and all lakes"* and *"nothing hand written... everything expandable... if i decide to add
// every single lake that garmin has in the US into the app tomorrow this stuff should be able to
// expand with it"*.
//
//   `out.trend` came from NWPS /stageflow, which needs an NWS handbook-5 lid. 45 of 221 bound
//   waters carry no lid on any gauge, so they got no trend at all — and all 45 have a USGS site.
//   `flood_category` was hardcoded null on every USGS reading, on a comment saying USGS does not
//   publish one. Not through /nwis/iv. It publishes one here.
//
// FIXTURE IS REAL. Every row below is transcribed from CurrentConditions.json, a live capture
// Ryan saved on 2026-08-24 — 320 rows, 118 sites. The field set and the fill rates in these
// tests are that file's, not an invention: Value absent on 10 of 320, RateOfChangeUnitPerHour
// present on 309, FloodStageStatusCode on 114, ValueFlagCode on 10.
import { describe, it, expect } from './expect-shim.mjs';
import { dashboardIndex, dashboardTrend, dashboardUrl } from '../Worker/conditions.js';

const row = (over = {}) => ({
  AgencyCode: 'USGS', SiteNumber: '01095434', SiteName: 'Gates Brook Near West Boylston, MA',
  SiteTypeCode: 'ST', ParameterCode: '00010', TimeLocal: '2026-08-24T15:20:00Z',
  TimeZoneCode: 'EDT', Value: 17.9, ValueFlagCode: null, RateOfChangeUnitPerHour: -0.1,
  StatisticStatusCode: null, FloodStageStatusCode: null, ...over,
});

describe('dashboardUrl — the filter is the binding, not a bounding box', () => {
  it('filters on the site numbers it was handed', () => {
    const u = decodeURIComponent(dashboardUrl(['02175148', '02176150']));
    expect(u.includes("SiteNumber in('02175148','02176150')")).toBe(true);
  });

  it('asks only for the public tier', () => {
    expect(decodeURIComponent(dashboardUrl(['02175148'])).includes("AccessLevelCode eq 'P'"))
      .toBe(true);
  });

  it('carries no bbox, no state and no lake name — nothing that would need widening by hand', () => {
    const u = decodeURIComponent(dashboardUrl(['02175148']));
    for (const banned of ['Latitude', 'Longitude', 'StateCode', 'bbox']) {
      expect(`${banned}: ${u.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it('a site added tomorrow needs no edit here — the list is the whole input', () => {
    const u = decodeURIComponent(dashboardUrl(['12345678', '02175148', '13313000']));
    // Sorted and deduped so the URL is stable and the cache key with it.
    expect(u.includes("SiteNumber in('02175148','12345678','13313000')")).toBe(true);
  });

  it('deduplicates, because pool and gauge are often the same site', () => {
    const u = decodeURIComponent(dashboardUrl(['02175148', '02175148']));
    expect(u.includes("in('02175148')")).toBe(true);
  });

  it('refuses anything that is not a site number rather than putting it in a filter string', () => {
    // A CWMS project name and an NWS lid both live beside site numbers in a binding.
    expect(decodeURIComponent(dashboardUrl(['Hartwell', 'ERJS1', '02175148']))
      .includes("in('02175148')")).toBe(true);
    expect(dashboardUrl(["'); DROP--"])).toBe(null);
  });

  it('no sites, no request', () => {
    expect(dashboardUrl([])).toBe(null);
    expect(dashboardUrl(null)).toBe(null);
    expect(dashboardUrl([null, '', undefined])).toBe(null);
  });
});

describe('dashboardIndex', () => {
  it('indexes site then parameter code', () => {
    const ix = dashboardIndex([
      row({ SiteNumber: '02175148', ParameterCode: '00065', Value: 6.89 }),
      row({ SiteNumber: '02175148', ParameterCode: '00060', Value: 412 }),
    ]);
    expect(ix.get('02175148').get('00065').value).toBe(6.89);
    expect(ix.get('02175148').get('00060').value).toBe(412);
  });

  it('drops a row with no reading — 10 of 320 in the capture have none', () => {
    // A rate of change with no value is not a reading, and a null that renders as zero is worse
    // than an absence.
    const ix = dashboardIndex([row({ Value: null, RateOfChangeUnitPerHour: -0.1 })]);
    expect(ix.size).toBe(0);
  });

  it('carries the flood status and never invents one', () => {
    const ix = dashboardIndex([
      row({ SiteNumber: '1', ParameterCode: '00065', FloodStageStatusCode: 'NOFLOOD' }),
      row({ SiteNumber: '2', ParameterCode: '00065', FloodStageStatusCode: null }),
    ]);
    expect(ix.get('1').get('00065').flood).toBe('NOFLOOD');
    // Null is "USGS states nothing here", which is not "not flooding".
    expect(ix.get('2').get('00065').flood).toBe(null);
  });

  it('carries the quality flag without interpreting it', () => {
    const ix = dashboardIndex([row({ ValueFlagCode: 'DIS' })]);
    expect(ix.get('01095434').get('00010').flag).toBe('DIS');
  });

  it('a missing rate is null, not zero', () => {
    const ix = dashboardIndex([row({ RateOfChangeUnitPerHour: null })]);
    expect(ix.get('01095434').get('00010').rate_per_hour).toBe(null);
  });

  it('survives junk', () => {
    expect(dashboardIndex(null).size).toBe(0);
    expect(dashboardIndex([null, {}, { SiteNumber: 'x' }]).size).toBe(0);
  });
});

describe('dashboardTrend — the same shape a caller already knows', () => {
  const ix = (rows) => dashboardIndex(rows).get('02175148');

  it('prefers a reservoir elevation, then stage, then flow', () => {
    const t = dashboardTrend(ix([
      row({ SiteNumber: '02175148', ParameterCode: '00060', Value: 412, RateOfChangeUnitPerHour: 3 }),
      row({ SiteNumber: '02175148', ParameterCode: '00062', Value: 76.4, RateOfChangeUnitPerHour: -0.02 }),
    ]));
    expect(t.measures).toBe('Reservoir elevation');
    expect(t.latest).toBe(76.4);
    expect(t.rate_per_hour).toBe(-0.02);
    expect(t.units).toBe('ft');
  });

  it('falls to stage when there is no elevation', () => {
    const t = dashboardTrend(ix([
      row({ SiteNumber: '02175148', ParameterCode: '00065', Value: 6.89, RateOfChangeUnitPerHour: 0.18 }),
    ]));
    expect(t.measures).toBe('Gage height');
    expect(t.rate_per_hour).toBe(0.18);
  });

  it('DOES NOT synthesise a 24-hour change from an hourly rate', () => {
    // stageflowTrend refuses to extrapolate a 24 h change out of a short window, and multiplying
    // a rate by 24 is the same invention wearing a fact's clothes.
    const t = dashboardTrend(ix([
      row({ SiteNumber: '02175148', ParameterCode: '00065', Value: 6.89, RateOfChangeUnitPerHour: 0.18 }),
    ]));
    expect(t.change_24h).toBe(null);
    expect(t.change_7d).toBe(null);
    expect(t.covers_hours).toBe(null);
  });

  it('says where it came from, because NWPS answers the same field', () => {
    const t = dashboardTrend(ix([
      row({ SiteNumber: '02175148', ParameterCode: '00065', Value: 6.89, RateOfChangeUnitPerHour: 0.18 }),
    ]));
    expect(t.source).toBe('USGS National Water Dashboard — CurrentConditions');
  });

  it('a reading with no rate is not a trend', () => {
    expect(dashboardTrend(ix([
      row({ SiteNumber: '02175148', ParameterCode: '00065', Value: 6.89, RateOfChangeUnitPerHour: null }),
    ]))).toBe(null);
  });

  it('temperature alone is not a trend — this field is about the water level', () => {
    expect(dashboardTrend(ix([
      row({ SiteNumber: '02175148', ParameterCode: '00010', Value: 27.4, RateOfChangeUnitPerHour: 0.2 }),
    ]))).toBe(null);
  });

  it('nothing in, null out', () => {
    expect(dashboardTrend(null)).toBe(null);
    expect(dashboardTrend(new Map())).toBe(null);
  });
});
