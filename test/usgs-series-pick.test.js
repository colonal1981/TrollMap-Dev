// WHEN A GAUGE HAS TWO SENSORS, WHICH ONE IS THE READING?
//
// Ten of the sites this app binds publish more than one live series on a parameter code it
// maps. Until 2026-08-25 the winner was whichever series happened to arrive last (JSON) or sit
// in the leftmost column (RDB) -- two paths in the same function, disagreeing with each other,
// neither choosing on any principle.
//
// The evidence is not from memory. The state series catalogues already cached for the binder
// list the duplicates, and USGS's own monitoring-location payload names the sensors:
//
//   Lake Murray (Lexington Co, SC)  02168500   00010  'TOP' and 'BOTTOM'
//   Lake Marion (Clarendon Co, SC)  02169921   00062  '[NAVD88]' and '[NGVD29]'
//   Charleston Harbor, SC           021720712  00065  '' and 'AUX'
//
// Two things were riding on the coin flip: the surface temperature of a lake that also reports
// from the bottom, and Lake Marion's pool level, where the two series are in vertical datums
// about a foot apart.
import { describe, it, expect } from './expect-shim.mjs';
import { seriesRank, rdbSeriesDescriptions, newerStamp, fetchUsgs } from '../Worker/worker-data.js';

/** Swap global fetch for one call, always restoring it. */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

/** A WaterML series as nwis/iv actually shapes it, trimmed to what fetchUsgs reads. */
function series(code, methodDescription, points) {
  return {
    variable: { variableCode: [{ value: code }] },
    values: [{
      method: [{ methodDescription }],
      value: points.map(([value, dateTime]) => ({ value, dateTime, qualifiers: ['P'] })),
    }],
  };
}

const jsonOf = (timeSeries) => async () => ({
  ok: true, status: 200, json: async () => ({ value: { timeSeries } }),
});

describe('seriesRank — surface first, and never a tie broken by arrival order', () => {
  it('prefers TOP over BOTTOM for water temperature', () => {
    expect(seriesRank('00010', 'TOP') < seriesRank('00010', 'BOTTOM')).toBe(true);
  });

  it('prefers TOP over MIDDLE, and MIDDLE over BOTTOM', () => {
    expect(seriesRank('00010', 'TOP') < seriesRank('00010', 'MIDDLE')).toBe(true);
    expect(seriesRank('00010', 'MIDDLE') < seriesRank('00010', 'BOTTOM')).toBe(true);
  });

  it('reads the Roanoke and Cooper River spellings, not just the tidy ones', () => {
    // Real loc_web_ds strings from the SC and NC catalogues.
    expect(seriesRank('00480', 'BOT,SALB COM FRO SCB') > seriesRank('00480', 'TOP,SALT COM FRO SCT')).toBe(true);
    expect(seriesRank('00010', 'BOTTOM, [BOTTOM]') > seriesRank('00010', 'TOP, [TOP]')).toBe(true);
  });

  it('applies the same order to every column parameter, not only temperature', () => {
    for (const code of ['00010', '00300', '00095', '00480', '63680']) {
      expect(seriesRank(code, 'TOP') < seriesRank(code, 'BOTTOM')).toBe(true);
    }
  });

  it('leaves a single unlabelled series alone', () => {
    // Nothing to choose between, and it must not be demoted below a sensor that is not there.
    expect(seriesRank('00060', '')).toBe(0);
    expect(seriesRank('00065', '')).toBe(0);
  });

  it('keeps an untagged elevation ahead of a named structure', () => {
    // Lake Murray publishes an "Emergency Spillway (ES)" series on 00062. A spillway is not
    // the lake.
    expect(seriesRank('00062', '') < seriesRank('00062', 'Emergency Spillway (ES)')).toBe(true);
  });

  it('keeps the legacy datum ahead of NAVD88 on elevation', () => {
    // A continuity decision, not a geodetic one: normalPool is stated against the legacy
    // series, and NAVD88 sits about a foot below NGVD29 in the lower Santee.
    expect(seriesRank('00062', '[NGVD29]') < seriesRank('00062', '[NAVD88]')).toBe(true);
    expect(seriesRank('62615', '[NAVD 88]') > seriesRank('62615', '')).toBe(true);
  });

  it('keeps a primary gage-height sensor ahead of its AUX backup', () => {
    expect(seriesRank('00065', '') < seriesRank('00065', 'AUX')).toBe(true);
  });
});

describe('rdbSeriesDescriptions — the comment block this file used to throw away', () => {
  const rdb = [
    '# Data provided for site 02168500',
    '#    TS_ID       Parameter Description',
    '#    177216      00010     Temperature, water, degrees Celsius, TOP',
    '#    177218      00010     Temperature, water, degrees Celsius, BOTTOM',
    '#',
    'agency_cd\tsite_no\tdatetime\ttz_cd\t177216_00010\t177216_00010_cd\t177218_00010\t177218_00010_cd',
    '5s\t15s\t20d\t6s\t14n\t10s\t14n\t10s',
    'USGS\t02168500\t2026-08-25 09:00\tEDT\t29.4\tP\t14.1\tP',
  ].join('\n');

  it('maps TS_ID to the sensor description', () => {
    const m = rdbSeriesDescriptions(rdb);
    expect(m['177216']).toBe('Temperature, water, degrees Celsius, TOP');
    expect(m['177218']).toBe('Temperature, water, degrees Celsius, BOTTOM');
  });

  it('ignores the boilerplate and the header line', () => {
    const m = rdbSeriesDescriptions(rdb);
    expect(Object.keys(m).length).toBe(2);
  });

  it('survives a response with no comment block at all', () => {
    expect(Object.keys(rdbSeriesDescriptions('a\tb\nUSGS\t1\n')).length).toBe(0);
    expect(Object.keys(rdbSeriesDescriptions('')).length).toBe(0);
  });

  it('picks the TOP column out of an RDB that carries both', async () => {
    const res = await withFetch(
      async (url) => (String(url).includes('format=json')
        ? { ok: true, status: 200, json: async () => ({ value: { timeSeries: [] } }) }
        : { ok: true, status: 200, text: async () => rdb }),
      () => fetchUsgs('02168500', '00010'));
    expect(res.tempC).toBe(29.4);
  });
});

describe('newerStamp', () => {
  it('takes the later of two timestamps', () => {
    expect(newerStamp('2026-08-25T09:00:00-04:00', '2026-08-25T09:30:00-04:00'))
      .toBe('2026-08-25T09:30:00-04:00');
    expect(newerStamp('2026-08-25T09:30:00-04:00', '2026-08-25T09:00:00-04:00'))
      .toBe('2026-08-25T09:30:00-04:00');
  });

  it('accepts either side being missing', () => {
    expect(newerStamp(null, '2026-08-25T09:00:00-04:00')).toBe('2026-08-25T09:00:00-04:00');
    expect(newerStamp('2026-08-25T09:00:00-04:00', null)).toBe('2026-08-25T09:00:00-04:00');
    expect(newerStamp(null, null)).toBe(null);
  });
});

describe('fetchUsgs — the two waters where the coin flip cost something', () => {
  it('Lake Murray: reports the TOP thermistor, whichever order USGS sends them', async () => {
    const top = series('00010', 'TOP', [['29.4', '2026-08-25T09:00:00-04:00']]);
    const bottom = series('00010', 'BOTTOM', [['14.1', '2026-08-25T09:00:00-04:00']]);
    const a = await withFetch(jsonOf([top, bottom]), () => fetchUsgs('02168500', '00010'));
    const b = await withFetch(jsonOf([bottom, top]), () => fetchUsgs('02168500', '00010'));
    expect(a.tempC).toBe(29.4);
    expect(b.tempC).toBe(29.4);
  });

  it('Lake Marion: reports the legacy datum and files NAVD88 under its own name', async () => {
    const ngvd = series('00062', '[NGVD29]', [['76.42', '2026-08-25T09:00:00-04:00']]);
    const navd = series('00062', '[NAVD88]', [['75.48', '2026-08-25T09:00:00-04:00']]);
    const a = await withFetch(jsonOf([ngvd, navd]), () => fetchUsgs('02169921', '00062'));
    const b = await withFetch(jsonOf([navd, ngvd]), () => fetchUsgs('02169921', '00062'));
    expect(a.elevation).toBe(76.42);
    expect(b.elevation).toBe(76.42);
    // The loser is a reading this app already has a field and readers for, not a discard.
    expect(a.elevationNavd88).toBe(75.48);
    expect(b.elevationNavd88).toBe(75.48);
  });

  it('63160 still owns elevationNavd88 when the site publishes one', async () => {
    const res = await withFetch(jsonOf([
      series('63160', '', [['75.11', '2026-08-25T09:00:00-04:00']]),
      series('00062', '[NAVD88]', [['75.48', '2026-08-25T09:00:00-04:00']]),
    ]), () => fetchUsgs('02169921', '00062,63160'));
    expect(res.elevationNavd88).toBe(75.11);
  });

  it('Charleston Harbor: the primary gage beats the AUX sensor', async () => {
    const res = await withFetch(jsonOf([
      series('00065', 'AUX', [['3.10', '2026-08-25T09:00:00-04:00']]),
      series('00065', '', [['3.42', '2026-08-25T09:00:00-04:00']]),
    ]), () => fetchUsgs('021720712', '00065'));
    expect(res.gageHeight).toBe(3.42);
  });

  it('a bottom sensor is still a reading when it is the only one', async () => {
    const res = await withFetch(jsonOf([
      series('00010', 'BOTTOM', [['14.1', '2026-08-25T09:00:00-04:00']]),
    ]), () => fetchUsgs('02171637', '00010'));
    expect(res.tempC).toBe(14.1);
  });

  it('observed_at is the newest reading on the site, not whichever series came last', async () => {
    const res = await withFetch(jsonOf([
      series('00060', '', [['412', '2026-08-25T09:45:00-04:00']]),
      series('00010', 'TOP', [['29.4', '2026-08-25T09:00:00-04:00']]),
    ]), () => fetchUsgs('02168500', '00010,00060'));
    expect(res.timestamp).toBe('2026-08-25T09:45:00-04:00');
  });

  it('-999999 is still not a reading', async () => {
    const res = await withFetch(jsonOf([
      series('00010', 'TOP', [['-999999', '2026-08-25T09:00:00-04:00']]),
      series('00010', 'BOTTOM', [['14.1', '2026-08-25T09:00:00-04:00']]),
    ]), () => fetchUsgs('02171637', '00010'));
    // The TOP sensor reported nothing usable, so the reading that exists is the one that wins.
    expect(res.tempC).toBe(14.1);
  });

  it('a single-sensor site is untouched by any of this', async () => {
    const res = await withFetch(jsonOf([
      series('00065', '', [['6.89', '2026-08-25T09:00:00-04:00']]),
      series('00060', '', [['412', '2026-08-25T09:00:00-04:00']]),
    ]), () => fetchUsgs('02175148', '00065,00060'));
    expect(res.gageHeight).toBe(6.89);
    expect(res.streamflow).toBe(412);
  });
});
