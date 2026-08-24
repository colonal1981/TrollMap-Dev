#!/usr/bin/env python3
"""
pull_usgs_current_conditions.py -- ONE request for every live water-quality reading, then join
it to the waters we actually care about.

    py .\\scripts\\pull_usgs_current_conditions.py
    py .\\scripts\\pull_usgs_current_conditions.py --registry F:\\TrollMapPipeline\\registry
    py .\\scripts\\pull_usgs_current_conditions.py --all-params
    py .\\scripts\\pull_usgs_current_conditions.py --bbox="-90,30,-75,37"
    py .\\scripts\\pull_usgs_current_conditions.py --self-test       (no network)

WHY THIS EXISTS

Ryan found the National Water Dashboard's OData service on 2026-08-24 and saved a live capture
to CurrentConditions.json, which is what everything below is measured against -- not guessed at.

Today the Worker asks USGS per SITE: `fetchUsgs(site, USGS_PARMS)` for up to four sites per
water block, plus a series-catalogue request each to learn which of them was worth asking. This
endpoint answers all of that in ONE call -- current values for every public site, for as many
parameter codes as you name, with each site's coordinates and site type on the row.

WHAT THE CAPTURE ACTUALLY SHOWED (320 rows, 118 sites, 2026-08-24)

  * The envelope is `{"@odata.context", "value": [...]}`. No paging was needed at this size.
  * Every one of the fifteen requested fields came back on every row.
  * `RateOfChangeUnitPerHour` is populated on 309 of 320 rows -- a per-hour trend the app
    computes nothing like for water quality.
  * `FloodStageStatusCode` is populated on 114 rows ("NOFLOOD").
  * `ValueFlagCode` carries a data-quality flag on 10 rows ("DIS").
  * `StatisticStatusCode` IS NULL ON ALL 320 ROWS. It was worth hoping this carried the
    percentile band that `conditions.js:flowVsHistory()` currently buys with a separate
    /nwis/stat request and a 366-row RDB walk. IT DOES NOT. That fetch stays where it is.
  * Site types include LK and ES, so this is not a stream-only feed.
  * Codes seen live in one national window: 00010 (112 rows), 00095 (69), 00300 (41),
    00400 pH (32), 63680 turbidity (31), 00480 (7), plus nitrate and chlorophyll/phycocyanin.
    pH and turbidity arrive in volume and the app requests neither today.

`UpdatedUtc gt <timestamp>` MAKES IT A DELTA FEED, and that is how the dashboard uses it -- a
moving cursor to keep a live map fresh. The capture spanned six hours of observations and
touched only seven of the bound sites, because it was a slice of TIME, not of geography. For
this app the useful shape is the opposite: no UpdatedUtc filter, a bounding box instead, one
bounded request for everything current in region. That is what this script sends by default;
--since turns the delta mode back on.

THIS SCRIPT STILL CHECKS THE SHAPE RATHER THAN TRUSTING IT

The endpoint is the dashboard's own backing service, is not documented anywhere this project can
cite, and could be renamed without notice. One capture on one day is not a contract. So this
still prints the DISTINCT FIELD NAMES and the DISTINCT ParameterCodes it actually received, and
if the body is not the envelope above it prints the first 600 characters and EXITS 2. A wrong
zero that reads as "no site reports temperature" is the most expensive thing this could do, and
this session already made that exact mistake once by counting discrete samples as gauges.

Treat it as an accelerator with `fetchUsgs` as the fallback, never as a sole dependency.

It follows @odata.nextLink until the pages run out, so a $top ceiling cannot silently truncate.

WHAT IT REPORTS

Joins every returned SiteNumber against `water_bindings.json` and answers, per parameter code:
how many of the bound waters have a live reading RIGHT NOW. That is a stronger answer than the
series catalogue gives -- a catalogue says a site once published a parameter; this says a value
arrived today.

Writes `registry/_usgs_current_conditions.json`. Uploads nothing. Needs no credentials.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = 'https://dashboard.waterdata.usgs.gov/service/cwis/1.0/odata/CurrentConditions'

# The subset this app can already render or has a research field for. --all-params sends the
# dashboard's full list instead.
CORE_PARAMS = [
    '00010',  # water temperature, degC
    '00011',  # water temperature, degF
    '00095',  # specific conductance
    '00300',  # dissolved oxygen, mg/L
    '00301',  # dissolved oxygen, % saturation
    '00400',  # pH
    '00480',  # salinity
    '63680',  # turbidity, FNU
]
# Copied verbatim from the dashboard's own request so we can see what else is live in region.
ALL_PARAMS = [
    '32217', '32283', '32284', '32315', '32316', '32318', '32320', '62361', '00300', '00301',
    '63689', '70387', '70390', '70394', '72240', '99141', '99220', '99398', '99404', '51289',
    '70380', '70382', '91049', '91050', '91058', '99133', '99136', '99137', '99416', '99435',
    '00630', '00650', '00665', '00666', '32295', '32322', '32330', '99134', '00400', '00095',
    '00402', '70369', '70384', '80154', '80295', '80297', '80298', '80299', '80300', '99409',
    '85583', '00010', '00011', '63675', '63680', '63682', '72213', '72337', '00076', '32319',
    '32321', '32323', '32336', '32341', '32360', '70301', '70302', '72205', '90860', '95202',
    '95204', '99401', '99407', '00047', '00048', '00090', '00401', '00480',
]

EXPECTED_HINTS = ('SiteNumber', 'ParameterCode', 'Value')


def build_url(params, bbox, top, since=None):
    quoted = ','.join("'%s'" % p for p in params)
    parts = ["(AccessLevelCode eq 'P')", '(ParameterCode in(%s))' % quoted]
    if since:
        # DELTA MODE. Only rows USGS wrote after this instant. The dashboard polls with a moving
        # cursor; for a one-shot regional picture leave this off.
        parts.append('(UpdatedUtc gt %s)' % since)
    if bbox:
        w, s, e, n = bbox
        parts.append('(Latitude gt %s) and (Latitude lt %s)' % (s, n))
        parts.append('(Longitude gt %s) and (Longitude lt %s)' % (w, e))
    q = {
        '$top': str(top),
        '$filter': ' and '.join(parts),
        '$select': ('AgencyCode,SiteNumber,SiteName,SiteTypeCode,Latitude,Longitude,'
                    'ParameterCode,TimeLocal,TimeZoneCode,Value,ValueFlagCode,'
                    'RateOfChangeUnitPerHour,StatisticStatusCode,FloodStageStatusCode'),
        '$orderby': 'SiteNumber,ParameterCode',
        'caller': 'TrollMap personal use',
    }
    return BASE + '?' + urllib.parse.urlencode(q, quote_via=urllib.parse.quote)


def get(url, timeout):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'trollmap-current-conditions/1.0 (+personal use; '
                      'https://github.com/colonal1981/TrollMap-Dev)',
        'Accept': 'application/json',
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode('utf-8', 'replace')


def rows_from(body):
    """OData envelope -> (rows, nextLink). Raises ValueError with a sample on an unknown shape."""
    try:
        j = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ValueError('body is not JSON (%s). First 600 chars:\n%s' % (exc, body[:600]))
    if isinstance(j, dict) and isinstance(j.get('value'), list):
        return j['value'], j.get('@odata.nextLink')
    if isinstance(j, list):
        return j, None
    raise ValueError('no `value` array in the response. Keys: %s\nFirst 600 chars:\n%s'
                     % (list(j)[:12] if isinstance(j, dict) else type(j).__name__, body[:600]))


FIXTURE = json.dumps({
    '@odata.context': 'x',
    'value': [
        {'AgencyCode': 'USGS', 'SiteNumber': '02147801', 'SiteName': 'LAKE WATEREE TAILRACE',
         'SiteTypeCode': 'ST', 'Latitude': 34.33, 'Longitude': -80.69, 'ParameterCode': '00010',
         'TimeLocal': '2026-08-24T15:30:00', 'TimeZoneCode': 'EDT', 'Value': '29.4',
         'ValueFlagCode': None, 'StatisticStatusCode': 'P50_P75'},
        {'AgencyCode': 'USGS', 'SiteNumber': '02147801', 'SiteName': 'LAKE WATEREE TAILRACE',
         'SiteTypeCode': 'ST', 'Latitude': 34.33, 'Longitude': -80.69, 'ParameterCode': '00300',
         'TimeLocal': '2026-08-24T15:30:00', 'TimeZoneCode': 'EDT', 'Value': '6.1',
         'ValueFlagCode': None, 'StatisticStatusCode': None},
        {'AgencyCode': 'USGS', 'SiteNumber': '09999999', 'SiteName': 'SOMEWHERE ELSE',
         'SiteTypeCode': 'ST', 'Latitude': 40.0, 'Longitude': -100.0, 'ParameterCode': '00010',
         'TimeLocal': '2026-08-24T15:30:00', 'TimeZoneCode': 'CDT', 'Value': '21.0'},
    ],
})


def self_test():
    ok = True

    def check(label, got, want):
        nonlocal ok
        if got != want:
            ok = False
            print('FAIL %-48s got %r want %r' % (label, got, want))
        else:
            print('ok   %-48s %r' % (label, got))

    rows, nxt = rows_from(FIXTURE)
    check('fixture row count', len(rows), 3)
    check('fixture nextLink', nxt, None)
    check('paging field respected', rows_from(json.dumps(
        {'value': [], '@odata.nextLink': 'http://x'}))[1], 'http://x')

    for bad, label in ((']not json[', 'non-JSON body'),
                       (json.dumps({'error': {'code': '403'}}), 'error envelope')):
        try:
            rows_from(bad)
            ok = False
            print('FAIL %-48s did not raise' % label)
        except ValueError:
            print('ok   %-48s raised ValueError' % label)

    bound = {'02147801': [{'display_name': 'Wateree Lake (Kershaw Co, SC)'}]}
    hit = summarise(rows, bound)
    check('waters matched from fixture', hit['waters_by_param']['00010'], 1)
    check('unbound sites are counted separately', hit['unbound_sites'], 1)

    u = build_url(['00010'], (-90, 30, -75, 37), 5)
    check('url carries the parameter', "%2700010%27" in u, True)
    check('url carries the bbox', 'Latitude' in urllib.parse.unquote(u), True)
    print('\n%s' % ('SELF-TEST PASSED' if ok else 'SELF-TEST FAILED'))
    return 0 if ok else 1


def summarise(rows, bound):
    by_param = collections.defaultdict(set)
    fields = collections.Counter()
    params = collections.Counter()
    unbound = set()
    for r in rows:
        if not isinstance(r, dict):
            continue
        for k in r:
            fields[k] += 1
        sn = str(r.get('SiteNumber') or '').strip()
        pc = str(r.get('ParameterCode') or '').strip()
        params[pc] += 1
        if sn in bound:
            for w in bound[sn]:
                by_param[pc].add(w['display_name'])
        elif sn:
            unbound.add(sn)
    return {'waters_by_param': {k: len(v) for k, v in by_param.items()},
            'waters_named': {k: sorted(v) for k, v in by_param.items()},
            'row_fields': dict(fields), 'rows_by_param': dict(params),
            'unbound_sites': len(unbound)}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', default='registry')
    ap.add_argument('--top', type=int, default=15000)
    ap.add_argument('--timeout', type=float, default=180.0)
    ap.add_argument('--all-params', action='store_true',
                    help="send the dashboard's full parameter list instead of the core subset")
    # ARGPARSE EATS A LEADING MINUS. Write it as --bbox="-90,30,-75,37", with the equals sign.
    ap.add_argument('--bbox', default='-90,30,-75,37',
                    help='W,S,E,N. Pass as --bbox="-90,30,-75,37". Use "none" for the whole country.')
    ap.add_argument('--since', default=None,
                    help='delta mode: only rows updated after this UTC instant, '
                         'e.g. 2026-08-24T19:31:11.686Z. Off by default.')
    ap.add_argument('--from-file', default=None,
                    help='parse a saved capture instead of fetching (for verifying the shape)')
    ap.add_argument('--self-test', action='store_true')
    a = ap.parse_args()
    if a.self_test:
        return self_test()

    p = os.path.join(a.registry, 'water_bindings.json')
    if not os.path.exists(p):
        print('FATAL: %s not found. Pass --registry <your registry folder>.' % p)
        return 2
    B = json.load(open(p, encoding='utf-8')).get('bindings') or {}
    bound = {}
    for slug, r in B.items():
        gs = [r.get('pool'), r.get('tailwater')] + list(r.get('gauges') or [])
        for g in gs:
            if isinstance(g, dict) and g.get('usgs_site'):
                bound.setdefault(g['usgs_site'], []).append(
                    {'slug': slug, 'display_name': r.get('display_name'),
                     'feature_type': r.get('feature_type')})
    print('bindings: %d waters, %d distinct USGS sites' % (len(B), len(bound)))

    bbox = None
    if a.bbox and a.bbox.lower() != 'none':
        try:
            bbox = tuple(float(x) for x in a.bbox.split(','))
            if len(bbox) != 4:
                raise ValueError
        except ValueError:
            print('FATAL: --bbox wants W,S,E,N. Quote it: --bbox="-90,30,-75,37"')
            return 2

    params = ALL_PARAMS if a.all_params else CORE_PARAMS
    url = build_url(params, bbox, a.top, a.since)

    rows, page = [], 0
    if a.from_file:
        if not os.path.exists(a.from_file):
            print('FATAL: %s not found.' % a.from_file)
            return 2
        print('parsing saved capture %s (no network)\n' % os.path.abspath(a.from_file))
        try:
            rows, _ = rows_from(open(a.from_file, encoding='utf-8').read())
        except ValueError as exc:
            print('FATAL: the saved file was not the shape this script expects.')
            print(exc)
            return 2
        url = None
    else:
        print('requesting %d parameter codes%s%s\n'
              % (len(params), ' inside %s' % (bbox,) if bbox else '',
                 ' updated since %s' % a.since if a.since else ''))
    try:
        while url:
            page += 1
            body = get(url, a.timeout)
            got, url = rows_from(body)
            rows.extend(got)
            print('   page %d: %d rows (%d total)' % (page, len(got), len(rows)))
            if page > 40:
                print('   !! stopping at 40 pages -- narrow the bbox or the parameter list')
                break
    except urllib.error.HTTPError as exc:
        print('\nFATAL: HTTP %d %s' % (exc.code, exc.reason))
        print('The endpoint is the dashboard\'s own service and is not a documented public API.')
        return 2
    except urllib.error.URLError as exc:
        print('\nFATAL: unreachable: %s' % exc.reason)
        return 2
    except ValueError as exc:
        print('\nFATAL: the response was not the shape this script expects.')
        print(exc)
        return 2

    s = summarise(rows, bound)
    print('\nrows: %d   distinct fields on a row: %d' % (len(rows), len(s['row_fields'])))
    print('FIELDS ACTUALLY RETURNED: %s' % ', '.join(sorted(s['row_fields'])))
    print()
    print('%-8s %-8s %s' % ('PARAM', 'ROWS', 'BOUND WATERS WITH A LIVE READING'))
    for pc in sorted(s['rows_by_param'], key=lambda k: -s['rows_by_param'][k]):
        print('%-8s %-8d %d of %d' % (pc, s['rows_by_param'][pc],
                                      s['waters_by_param'].get(pc, 0), len(B)))
    print('\n%d returned sites are not bound to any water in the registry.' % s['unbound_sites'])

    out = os.path.join(a.registry, '_usgs_current_conditions.json')
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump({'_note': 'One-shot pull of the USGS National Water Dashboard OData '
                            'CurrentConditions service, joined to water_bindings.json. '
                            'A SNAPSHOT, not a feed. Built by pull_usgs_current_conditions.py.',
                   'url': url or BASE, 'rows': len(rows), 'summary': s,
                   'sample_rows': rows[:5]}, fh, indent=1)
    print('wrote %s' % os.path.abspath(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
