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
import { seriesRank, rdbSeriesDescriptions, newerStamp, applyElevation, fetchUsgs }
  from '../Worker/worker-data.js';

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


describe('applyElevation — three codes, one field, and it used to be arrival order', () => {
  // Site 02077280 at the Hyco Lake dam (Person Co, NC) answered live on 2026-08-25 with
  // 00062 = 8.81 AND 62614 = 408.6 in the same response. Four hundred feet apart, and which one
  // reached `out.elevation` depended on the order USGS happened to serialise them.
  const hyco = [{ code: '00062', value: 8.81 }, { code: '62614', value: 408.6 }];

  it('is stable whichever order the codes arrive in', () => {
    const a = applyElevation({}, hyco);
    const b = applyElevation({}, hyco.slice().reverse());
    expect(a.elevation).toBe(b.elevation);
    expect(a.elevation_code).toBe(b.elevation_code);
  });

  it('carries the loser instead of discarding it', () => {
    const out = applyElevation({}, hyco);
    expect(out.elevation_alternatives.length).toBe(1);
    expect(out.elevation_alternatives[0].code).toBe('62614');
    expect(out.elevation_alternatives[0].value).toBe(408.6);
  });

  it('names the datum on both, because they are not the same measurement', () => {
    const out = applyElevation({}, hyco);
    expect(out.elevation_datum).toBe('above datum (USGS does not name it in the code)');
    expect(out.elevation_alternatives[0].datum).toBe('NGVD 1929');
  });

  it('says how far apart they are, because 400 ft is a different problem from 1 ft', () => {
    expect(applyElevation({}, hyco).elevation_disagrees_ft).toBe(399.79);
    // Lake Murray (Lexington Co, SC): 00062 = 356.57 against 62615 = 355.26, a datum question.
    expect(applyElevation({}, [{ code: '00062', value: 356.57 }, { code: '62615', value: 355.26 }])
      .elevation_disagrees_ft).toBe(1.31);
  });

  it('a single code says nothing about a disagreement that is not there', () => {
    const out = applyElevation({}, [{ code: '00062', value: 76.42 }]);
    expect(out.elevation).toBe(76.42);
    expect(out.elevation_alternatives).toBe(undefined);
    expect(out.elevation_disagrees_ft).toBe(undefined);
  });

  it('preserves what this app has shown: the unnamed datum wins', () => {
    // NOT a claim that it is the better datum. Murray, Marion and the other operator lakes
    // publish a full pool on that scale, and preferring the named datum would move every one of
    // them to fix Hyco.
    expect(applyElevation({}, [{ code: '62615', value: 355.26 }, { code: '00062', value: 356.57 }])
      .elevation).toBe(356.57);
    expect(applyElevation({}, [{ code: '62614', value: 408.6 }, { code: '62615', value: 407.3 }])
      .elevation_code).toBe('62615');
  });

  it('nothing usable in, nothing written', () => {
    expect(applyElevation({}, []).elevation).toBe(undefined);
    expect(applyElevation({}, null).elevation).toBe(undefined);
    expect(applyElevation({}, [{ code: '00062', value: NaN }]).elevation).toBe(undefined);
  });

  it('end to end: fetchUsgs no longer flips on the Hyco pair', async () => {
    const pair = (first, second) => jsonOf([
      series(first.code, '', [[String(first.v), '2026-08-25T01:00:00-04:00']]),
      series(second.code, '', [[String(second.v), '2026-08-25T01:00:00-04:00']]),
    ]);
    const a = await withFetch(pair({ code: '00062', v: 8.81 }, { code: '62614', v: 408.6 }),
      () => fetchUsgs('02077280', '00062,62614'));
    const b = await withFetch(pair({ code: '62614', v: 408.6 }, { code: '00062', v: 8.81 }),
      () => fetchUsgs('02077280b', '00062,62614'));
    expect(a.elevation).toBe(8.81);
    expect(b.elevation).toBe(8.81);
    expect(a.elevation_disagrees_ft).toBe(399.79);
  });
});
