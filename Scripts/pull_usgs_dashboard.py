#!/usr/bin/env python3
"""
pull_usgs_dashboard.py -- the USGS National Water Dashboard's OData service, all four useful
collections, joined to the waters this app actually cares about.

    py .\\scripts\\pull_usgs_dashboard.py                          live values, our bbox
    py .\\scripts\\pull_usgs_dashboard.py --collection Statistics  the daily percentile bands
    py .\\scripts\\pull_usgs_dashboard.py --collection FloodStages
    py .\\scripts\\pull_usgs_dashboard.py --collection Sites
    py .\\scripts\\pull_usgs_dashboard.py --bbox="-90,30,-75,37" --params 00010,00060,00045
    py .\\scripts\\pull_usgs_dashboard.py --from-file F:\\TrollMapPipeline\\CurrentConditions.json
    py .\\scripts\\pull_usgs_dashboard.py --self-test               parser only, no network

WHAT THE SERVICE ACTUALLY IS  (read off $metadata, saved 2026-08-24)

Six entity sets: Sites, CurrentConditions, Statistics, FloodStages, and two log collections that
are of no use here. THERE IS NO WEATHER, PRECIPITATION-FORECAST OR CAMERA COLLECTION -- the
dashboard draws those layers from other services. What IS true is that CurrentConditions is not
restricted to water-quality codes: 00060 discharge, 00065 stage and 00045 precipitation come out
of the same collection as 00010 and 00300, so streamflow, rain gauges and water quality really
are one query. Weather and cameras are not, and this app already reads NIMS directly for cameras.

`@odata.context` on the service document points at `int-noms.er.usgs.gov` -- this is an INTERNAL
USGS service exposed through the dashboard, not a documented public API. Accelerator with
`fetchUsgs` as the fallback, never a sole dependency.

WHY THE FULL FIELD LIST MATTERS

The dashboard's own request asks for 15 of vCurrentCondition's 76 properties. The ones it leaves
behind are the valuable half:

  ParameterName / ParameterUnit   THE UNIT ARRIVES WITH THE READING. conditions.js already
                                  learned this the hard way on CWMS, where the catalogue says
                                  metres and the data endpoint says feet and guessing either way
                                  turns 660 ft into 2,165. Nothing here has to be hardcoded.
  IsPrimary                       WHICH SERIES IS THE REAL ONE. Site 02147801 publishes two
                                  temperature series with different periods of record -- 2017-2023
                                  and 2021-2026 -- and `parseDailyStats` picks whichever sorts
                                  first without saying which. This field is the answer.
  LatencyMinutes                  how stale the reading is, stated rather than inferred.
  RecordIntervalMinutes           the cadence of the series.
  StatisticStatusCode/Description where today sits against the record, DENORMALISED ONTO THE ROW.
  FloodStage* + NwsIdentifier     action/minor/moderate/major stage in feet, and the NWS
                                  handbook-5 id -- which is the join key to `lid` in
                                  water_bindings.json.
  ValueFlagDescription            a flagged reading says so in words.

WHY `Statistics` IS THE POINT OF THIS SCRIPT

vStatistic carries, per site per parameter per calendar day:

    Month, Day, SampleSize, BeginYear, EndYear,
    MeanValue, MinValue/MinYear, MaxValue/MaxYear,
    P05, P10, P20, P25, P50, P75, P80, P90, P95

Nine percentiles where `conditions.js:flowVsHistory()` asks /nwis/stat for five, with the sample
size and the year range attached, in JSON, for ANY parameter code -- temperature included. It is
strictly better than the fixed-width RDB path in every dimension, and it is the thing
THE_HYBRID_RESEARCH_PLAN proposed precomputing into R2 as `gauge_stats.json`.

NO ENTITY IN THIS SERVICE DECLARES A NAVIGATION PROPERTY, so `$expand` cannot join collections.
It does not need to: the live row already carries its own statistic and flood-stage status
denormalised. Two requests is the ceiling, not four.

THIS SCRIPT CHECKS THE SHAPE RATHER THAN TRUSTING IT. It prints the field names and parameter
codes it actually received, follows @odata.nextLink so a $top ceiling cannot silently truncate,
and on an unexpected body prints the first 600 characters and EXITS 2. A wrong zero reading as
"nothing reports temperature" is the most expensive thing this could do, and this session already
made that mistake once by counting discrete samples as gauges.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = 'https://dashboard.waterdata.usgs.gov/service/cwis/1.0/odata'

# Built from $metadata, not from guesswork. Only fields this app could plausibly use.
SELECT = {
    'CurrentConditions': (
        'AgencyCode,SiteNumber,SiteName,SiteTypeCode,Latitude,Longitude,StateAbbreviation,'
        'CountyName,HydrologicUnitCode,DrainageAreaSqMi,AltitudeFeet,'
        'ParameterCode,ParameterName,ParameterGroup,ParameterUnit,IsPrimary,'
        'TimeUtc,TimeLocal,TimeZoneCode,Value,ValueFlagCode,ValueFlagDescription,'
        'RecordIntervalMinutes,RateOfChangeUnitPerHour,LatencyMinutes,'
        'StatisticID,StatisticStatusCode,StatisticStatusDescription,'
        'FloodStageStatusCode,FloodStageStatusDescription,ActionFloodStageFeet,'
        'MinorFloodStageFeet,ModerateFloodStageFeet,MajorFloodStageFeet,NwsIdentifier,UpdatedUtc'),
    'Statistics': (
        'AgencyCode,SiteNumber,SiteName,Latitude,Longitude,StateAbbreviation,CountyName,'
        'ParameterCode,ParameterName,ParameterUnit,Month,Day,SampleSize,BeginYear,EndYear,'
        'MeanValue,MinValue,MinYear,MaxValue,MaxYear,'
        'P05,P10,P20,P25,P50,P75,P80,P90,P95,UpdatedUtc'),
    'FloodStages': (
        'AgencyCode,SiteNumber,SiteName,Latitude,Longitude,StateAbbreviation,CountyName,'
        'ParameterCode,TimeLocal,Value,FloodStageStatusCode,FloodStageStatusDescription,'
        'NwsIdentifier,NwsOffice,NwsForecastStatus,ActionFeet,MinorFeet,ModerateFeet,MajorFeet'),
    'Sites': (
        'AgencyCode,SiteNumber,SiteName,SiteTypeCode,SiteTypeName,Latitude,Longitude,'
        'StateAbbreviation,CountyName,HydrologicUnitCode,DrainageAreaSqMi,AltitudeFeet,'
        'TimeZoneCode,UpdatedUtc'),
}
# THE DASHBOARD'S OWN LAYERS, READ OFF ITS NETWORK TRAFFIC (HAR captured 2026-08-24).
#
# EVERY DATA LAYER ON THAT MAP IS THIS ONE COLLECTION WITH A DIFFERENT PARAMETER LIST. There is
# no weather collection and no precipitation collection -- weather and rain are PARAMETER CODES.
# Union the lists and one request answers level, flow, water quality, rain and weather together.
# The only two layers that are not this: the NEXRAD radar mosaic, which is raster tiles from the
# Iowa Environmental Mesonet and carries no values, and the cameras, which come from NIMS -- and
# Worker/cameras.js already reads NIMS directly.
LAYERS = {
    # 95 codes. Site types ES,LK,OC,OC-CO,ST,ST-CA,ST-DCH,ST-TS,WE -- not stream-only.
    'level': ['30207', '30210', '30211', '30212', '30213', '62600', '62601', '62610', '62611',
              '62612', '62613', '62614', '62615', '62616', '62617', '62618', '62619', '62620',
              '62621', '62622', '62623', '62624', '63158', '63159', '63160', '63161', '72019',
              '72020', '72150', '72170', '72171', '72178', '72199', '72214', '72215', '72226',
              '72227', '72228', '72229', '72230', '72231', '72232', '72251', '72264', '72265',
              '72275', '72276', '72279', '72292', '72293', '72333', '72335', '72336', '72344',
              '72345', '72346', '72347', '72361', '72362', '72363', '72364', '72365', '72366',
              '72367', '72368', '72369', '72370', '72371', '72372', '72373', '72374', '72375',
              '72376', '72377', '72378', '72379', '72380', '72381', '72382', '72383', '72384',
              '72385', '72386', '72387', '72388', '72389', '72390', '72391', '72397', '99019',
              '99020', '99065', '00062', '00065', '00072'],
    # 23 codes. 00060 is discharge; 72137 is tidally filtered discharge, which conditions.js
    # already reads on the coast.
    'flow': ['30208', '30209', '50042', '50050', '50051', '62856', '72122', '72123', '72137',
             '72138', '72139', '72177', '72243', '74072', '81395', '81799', '99060', '99061',
             '00056', '00058', '00059', '00060', '00061'],
    # 78 codes -- the list Ryan captured first.
    'quality': ['32217', '32283', '32284', '32315', '32316', '32318', '32320', '62361', '00300',
                '00301', '63689', '70387', '70390', '70394', '72240', '99141', '99220', '99398',
                '99404', '51289', '70380', '70382', '91049', '91050', '91058', '99133', '99136',
                '99137', '99416', '99435', '00630', '00650', '00665', '00666', '32295', '32322',
                '32330', '99134', '00400', '00095', '00402', '70369', '70384', '80154', '80295',
                '80297', '80298', '80299', '80300', '99409', '85583', '00010', '00011', '63675',
                '63680', '63682', '72213', '72337', '00076', '32319', '32321', '32323', '32336',
                '32341', '32360', '70301', '70302', '72205', '90860', '95202', '95204', '99401',
                '99407', '00047', '00048', '00090', '00401', '00480'],
    # 5 codes. 00045 is precipitation total in inches -- MEASURED rain, where every precip number
    # in this app today comes from an Open-Meteo model cell.
    'rain': ['72192', '72194', '99772', '00045', '00193'],
    # 51 codes. 00020/00021 air temperature C/F, 00035 wind speed, 00036 wind direction,
    # 00052 relative humidity, 00025 barometric pressure, 62608/62609 solar radiation.
    'weather': ['00020', '00021', '62602', '62603', '62605', '62607', '72204', '72412', '75969',
                '00025', '72130', '72159', '72358', '00052', '62608', '62609', '72124', '72174',
                '72175', '72179', '72185', '72252', '72406', '72407', '72408', '72409', '99986',
                '99987', '00030', '61729', '00036', '61727', '61728', '62625', '72269', '82127',
                '00035', '62968', '62969', '72125', '72182', '72186', '72200', '72201', '72202',
                '72398', '72426', '72431', '99988', '99989', '00201'],
}
# What this app can actually render today, plus the two it should learn: measured rain and
# measured wind. --layer all sends every code the dashboard knows about.
DEFAULT_PARAMS = {
    'CurrentConditions': ['00010', '00060', '00065', '00062', '00095', '00300', '00301', '00400',
                          '00045', '00480', '63680', '00020', '00035', '00036', '00052', '72137'],
    'Statistics':        ['00010', '00060', '00065'],
    'FloodStages':       [],
    'Sites':             [],
}
PARAM_KEY = {'Statistics': 'ParameterCode', 'CurrentConditions': 'ParameterCode',
             'FloodStages': 'ParameterCode', 'Sites': None}


def build_url(coll, params, bbox, top, since=None, month=None, day=None):
    parts = []
    if coll != 'FloodStages':
        parts.append("(AccessLevelCode eq 'P')")
    if params and PARAM_KEY.get(coll):
        parts.append('(%s in(%s))' % (PARAM_KEY[coll], ','.join("'%s'" % p for p in params)))
    if bbox:
        w, s, e, n = bbox
        parts.append('(Latitude gt %s) and (Latitude lt %s)' % (s, n))
        parts.append('(Longitude gt %s) and (Longitude lt %s)' % (w, e))
    if coll == 'Statistics' and month and day:
        parts.append('(Month eq %d) and (Day eq %d)' % (month, day))
    if since:
        parts.append('(UpdatedUtc gt %s)' % since)
    q = {'$top': str(top), '$select': SELECT[coll], 'caller': 'TrollMap personal use'}
    if parts:
        q['$filter'] = ' and '.join(parts)
    q['$orderby'] = 'SiteNumber'
    return '%s/%s?%s' % (BASE, coll, urllib.parse.urlencode(q, quote_via=urllib.parse.quote))


def get(url, timeout):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'trollmap-dashboard/1.0 (+personal use; '
                      'https://github.com/colonal1981/TrollMap-Dev)',
        'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode('utf-8', 'replace')


def rows_from(body):
    try:
        j = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ValueError('body is not JSON (%s). First 600 chars:\n%s' % (exc, body[:600]))
    if isinstance(j, dict) and isinstance(j.get('value'), list):
        return j['value'], j.get('@odata.nextLink')
    if isinstance(j, list):
        return j, None
    raise ValueError('no `value` array. Keys: %s\nFirst 600 chars:\n%s'
                     % (list(j)[:12] if isinstance(j, dict) else type(j).__name__, body[:600]))


def bound_sites(registry):
    p = os.path.join(registry, 'water_bindings.json')
    if not os.path.exists(p):
        return None, 'FATAL: %s not found. Pass --registry <your registry folder>.' % p
    B = json.load(open(p, encoding='utf-8')).get('bindings') or {}
    if not B:
        return None, 'FATAL: %s has no bindings.' % p
    out = {}
    for slug, r in B.items():
        for g in [r.get('pool'), r.get('tailwater')] + list(r.get('gauges') or []):
            if isinstance(g, dict) and g.get('usgs_site'):
                out.setdefault(g['usgs_site'], []).append(
                    {'slug': slug, 'display_name': r.get('display_name'),
                     'feature_type': r.get('feature_type')})
    return (out, len(B)), None


FIXTURE = json.dumps({'value': [
    {'SiteNumber': '02147801', 'ParameterCode': '00010', 'ParameterUnit': 'deg C',
     'IsPrimary': True, 'Value': 29.4, 'LatencyMinutes': 12.0, 'SiteName': 'WATEREE TAILRACE'},
    {'SiteNumber': '02147801', 'ParameterCode': '00010', 'ParameterUnit': 'deg C',
     'IsPrimary': False, 'Value': 28.9, 'LatencyMinutes': 12.0, 'SiteName': 'WATEREE TAILRACE'},
    {'SiteNumber': '09999999', 'ParameterCode': '00010', 'ParameterUnit': 'deg C',
     'IsPrimary': True, 'Value': 21.0, 'LatencyMinutes': 5.0, 'SiteName': 'ELSEWHERE'},
]})


def summarise(rows, bound):
    by_param, fields, params, unbound = collections.defaultdict(set), collections.Counter(), \
        collections.Counter(), set()
    units, secondary = {}, 0
    for r in rows:
        if not isinstance(r, dict):
            continue
        for k in r:
            fields[k] += 1
        sn = str(r.get('SiteNumber') or '').strip()
        pc = str(r.get('ParameterCode') or '').strip()
        if pc:
            params[pc] += 1
            if r.get('ParameterUnit'):
                units.setdefault(pc, r['ParameterUnit'])
        if r.get('IsPrimary') is False:
            secondary += 1
        if sn in bound:
            for w in bound[sn]:
                by_param[pc].add(w['display_name'])
        elif sn:
            unbound.add(sn)
    return {'waters_by_param': {k: len(v) for k, v in by_param.items()},
            'waters_named': {k: sorted(v) for k, v in by_param.items()},
            'row_fields': dict(fields), 'rows_by_param': dict(params),
            'units': units, 'secondary_series_rows': secondary,
            'unbound_sites': len(unbound)}


def self_test():
    ok = True

    def check(label, got, want):
        nonlocal ok
        if got != want:
            ok = False
            print('FAIL %-50s got %r want %r' % (label, got, want))
        else:
            print('ok   %-50s %r' % (label, got))

    rows, nxt = rows_from(FIXTURE)
    check('fixture rows', len(rows), 3)
    check('nextLink is followed when present',
          rows_from(json.dumps({'value': [], '@odata.nextLink': 'http://x'}))[1], 'http://x')
    for bad, lbl in (('}nope{', 'non-JSON body'), (json.dumps({'error': {}}), 'error envelope')):
        try:
            rows_from(bad)
            ok = False
            print('FAIL %-50s did not raise' % lbl)
        except ValueError:
            print('ok   %-50s raised ValueError' % lbl)

    s = summarise(rows, {'02147801': [{'display_name': 'Wateree Lake (Kershaw Co, SC)'}]})
    check('bound waters counted once, not per series', s['waters_by_param']['00010'], 1)
    check('secondary series are counted', s['secondary_series_rows'], 1)
    check('unit carried off the row', s['units']['00010'], 'deg C')
    check('unbound sites separated', s['unbound_sites'], 1)

    u = build_url('Statistics', ['00010'], (-90, 30, -75, 37), 5, month=8, day=24)
    d = urllib.parse.unquote(u)
    check('Statistics url has the calendar day', 'Month eq 8' in d and 'Day eq 24' in d, True)
    check('Statistics url selects nine percentiles',
          all(('P%s' % p) in d for p in ('05', '10', '20', '25', '50', '75', '80', '90', '95')), True)
    check('CurrentConditions url asks IsPrimary',
          'IsPrimary' in urllib.parse.unquote(build_url('CurrentConditions', ['00010'], None, 5)),
          True)
    check('Sites needs no parameter filter',
          'ParameterCode' not in urllib.parse.unquote(build_url('Sites', [], None, 5)), True)
    print('\n%s' % ('SELF-TEST PASSED' if ok else 'SELF-TEST FAILED'))
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--collection', default='CurrentConditions', choices=sorted(SELECT))
    ap.add_argument('--registry', default='registry')
    ap.add_argument('--top', type=int, default=15000)
    ap.add_argument('--timeout', type=float, default=180.0)
    ap.add_argument('--params', default=None, help='comma-separated parameter codes')
    ap.add_argument('--layer', default=None,
                    help="the dashboard's own layer lists: %s, or 'all' for the union"
                         % ', '.join(sorted(LAYERS)))
    # ARGPARSE EATS A LEADING MINUS. Write it with the equals sign: --bbox="-90,30,-75,37"
    ap.add_argument('--bbox', default='-90,30,-75,37',
                    help='W,S,E,N. Pass as --bbox="-90,30,-75,37". "none" for the whole country.')
    ap.add_argument('--since', default=None, help='delta mode: rows updated after this UTC instant')
    ap.add_argument('--day', default=None, help='Statistics only: MM-DD (default: today)')
    ap.add_argument('--from-file', default=None, help='parse a saved capture, no network')
    ap.add_argument('--self-test', action='store_true')
    a = ap.parse_args()
    if a.self_test:
        return self_test()

    got, err = bound_sites(a.registry)
    if err:
        print(err)
        return 2
    bound, n_waters = got
    print('bindings: %d waters, %d distinct USGS sites' % (n_waters, len(bound)))

    bbox = None
    if a.bbox and a.bbox.lower() != 'none':
        try:
            bbox = tuple(float(x) for x in a.bbox.split(','))
            if len(bbox) != 4:
                raise ValueError
        except ValueError:
            print('FATAL: --bbox wants W,S,E,N. Quote it: --bbox="-90,30,-75,37"')
            return 2

    month = day = None
    if a.collection == 'Statistics':
        if a.day:
            try:
                month, day = (int(x) for x in a.day.split('-'))
            except ValueError:
                print('FATAL: --day wants MM-DD, e.g. --day=08-24')
                return 2
        else:
            today = dt.date.today()
            month, day = today.month, today.day
        print('Statistics for calendar day %02d-%02d' % (month, day))

    if a.layer:
        if a.layer == 'all':
            params = sorted({c for v in LAYERS.values() for c in v})
        elif a.layer in LAYERS:
            params = LAYERS[a.layer]
        else:
            print('FATAL: --layer wants one of: %s, all' % ', '.join(sorted(LAYERS)))
            return 2
    elif a.params:
        params = [p.strip() for p in a.params.split(',') if p.strip()]
    else:
        params = DEFAULT_PARAMS[a.collection]
    url = build_url(a.collection, params, bbox, a.top, a.since, month, day)

    rows, page = [], 0
    if a.from_file:
        if not os.path.exists(a.from_file):
            print('FATAL: %s not found.' % a.from_file)
            return 2
        print('parsing saved capture %s (no network)\n' % os.path.abspath(a.from_file))
        try:
            rows, _ = rows_from(open(a.from_file, encoding='utf-8').read())
        except ValueError as exc:
            print('FATAL: the saved file was not the shape this script expects.\n%s' % exc)
            return 2
        url = None
    else:
        print('%s: %d parameter code(s)%s\n'
              % (a.collection, len(params), ' inside %s' % (bbox,) if bbox else ''))
    try:
        while url:
            page += 1
            body = get(url, a.timeout)
            batch, url = rows_from(body)
            rows.extend(batch)
            print('   page %d: %d rows (%d total)' % (page, len(batch), len(rows)))
            if page > 40:
                print('   !! stopping at 40 pages -- narrow the bbox or the parameter list')
                break
    except urllib.error.HTTPError as exc:
        print('\nFATAL: HTTP %d %s -- this is the dashboard\'s internal service, not a public API.'
              % (exc.code, exc.reason))
        return 2
    except urllib.error.URLError as exc:
        print('\nFATAL: unreachable: %s' % exc.reason)
        return 2
    except ValueError as exc:
        print('\nFATAL: the response was not the shape this script expects.\n%s' % exc)
        return 2

    s = summarise(rows, bound)
    print('\nrows: %d   distinct fields on a row: %d' % (len(rows), len(s['row_fields'])))
    print('FIELDS RETURNED: %s' % ', '.join(sorted(s['row_fields'])))
    if s['secondary_series_rows']:
        print('%d rows are NON-PRIMARY series -- filter on IsPrimary before using a value.'
              % s['secondary_series_rows'])
    if s['rows_by_param']:
        print()
        print('%-8s %-10s %-12s %s' % ('PARAM', 'ROWS', 'UNIT', 'BOUND WATERS'))
        for pc in sorted(s['rows_by_param'], key=lambda k: -s['rows_by_param'][k]):
            print('%-8s %-10d %-12s %d of %d'
                  % (pc, s['rows_by_param'][pc], (s['units'].get(pc) or '?')[:12],
                     s['waters_by_param'].get(pc, 0), n_waters))
    print('\n%d returned sites are not bound to any water in the registry.' % s['unbound_sites'])

    out = os.path.join(a.registry, '_usgs_%s.json' % a.collection.lower())
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump({'_note': 'Snapshot of the USGS National Water Dashboard OData service, '
                            'collection %s, joined to water_bindings.json. Built by '
                            'pull_usgs_dashboard.py. A SNAPSHOT, not a feed.' % a.collection,
                   'collection': a.collection, 'rows': len(rows), 'summary': s,
                   'sample_rows': rows[:5]}, fh, indent=1)
    print('wrote %s' % os.path.abspath(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
