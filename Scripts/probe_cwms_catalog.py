#!/usr/bin/env python3
"""
probe_cwms_catalog.py -- what does the Corps actually publish, and for which of OUR waters?

    py .\\scripts\\probe_cwms_catalog.py
    py .\\scripts\\probe_cwms_catalog.py --offices SAS,SAM
    py .\\scripts\\probe_cwms_catalog.py --self-test        (parser only, no network)

WHY THIS EXISTS

`Worker/worker-data.js:fetchCwmsLakeLevel` has talked to CWMS for months, and `_bindings_cache`
holds cwms_SAS / SAM / SAW / LRN -- but those are LOCATION catalogues. They say a place exists.
They do not say what that place MEASURES, and nothing has ever asked.

Asked for the first time on 2026-08-24, and the first twenty entries of the Savannah district
answered a question that had been open all day:

    02187010.Speed-Wind.Inst.15Minutes.0.Raw-USGS_SAS      kph
    02187010.Dir-Wind.Inst.15Minutes.0.Raw-USGS_SAS        deg
    02187010.%-Humidity.Inst.15Minutes.0.Raw-USGS_SAS      %
    02187010.Precip.Total.15Minutes.15Minutes.Raw-USGS_SAS mm
    02187010.Elev-Pool.Inst.15Minutes.0.Raw-USGS_SAS       m

`02187010` is Hartwell Lake near Anderson. That is a full weather station on the lake at
15-minute resolution with ten years of record -- and it corroborates the USGS census taken the
same morning, which found Hartwell reporting measured wind, rain and humidity and NO water
temperature. Two independent doors onto the same instrument, telling the same story.

THREE THINGS THAT MAKE THIS WORTH A SCRIPT RATHER THAN A BROWSER

  615 series in SAS alone, twenty to a page behind a `next-page` cursor. Four offices.

  `like` IS A CASE-SENSITIVE REGEX MATCHED AGAINST AN UPPERCASED TS-ID, and nothing says so.
  `like=Temp-Water` returns an empty catalogue. So does `like=Elev-Pool`, which is the control
  that proved it -- `02187010.Elev-Pool.Inst.15Minutes.0.Raw-USGS_SAS` is right there in the
  unfiltered listing. Empty was the filter failing, not the Corps publishing nothing.

  The proof is in the service's own pagination cursor, which is base64 and decodes to:

      SAS/02187010.SPEED-WIND.INST.15MINUTES.0.RAW-USGS_SAS||SAS||.*||null||...||615||20
                                                              ^^^^   ^^
                                            the office ------/      /
                                            the `like` value, defaulting to `.*`

  The position key is UPPERCASE. So the working form is `like=.*TEMP-WATER.*` -- upper-cased,
  with explicit wildcards. AN EMPTY RESULT FROM AN UNTESTED FILTER IS THE MOST EXPENSIVE KIND OF
  WRONG ANSWER: it reads as a confident "there is none" and this session had already produced one
  of those today by counting discrete samples as gauges. Always run an unfiltered page first.

  This script therefore does NOT filter. It pages the whole district and filters locally, where
  the matching rules are ours and are visible.

  THE LOCATION NAME IS THE USGS SITE NUMBER, for every series sourced `Raw-USGS_*`. So the join
  back to `water_bindings.json` is exact -- no name matching, no geometry, no judgement.

EVERYTHING FROM THIS DOOR IS METRIC. cms, m, mm, C, kph -- while the SAME USGS site served
through /nwis/iv is cfs, ft, in, degF. One instrument, two unit systems, depending on which
service you ask. `conditions.js` already carries a comment about CWMS units disagreeing between
catalogue and payload; this is the neighbouring trap and the reason this script records the
declared unit on every row rather than assuming one.

Writes `registry/_cwms_inventory.json`. Read-only otherwise, and needs no credential.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

BASE = 'https://cwms-data.usace.army.mil/cwms-data/catalog/TIMESERIES'
# Savannah, Mobile, Wilmington, Nashville -- the four already cached in _bindings_cache.
OFFICES = ['SAS', 'SAM', 'SAW', 'LRN']
UA = 'trollmap-cwms-probe/1.0 (+personal use; https://github.com/colonal1981/TrollMap-Dev)'
# <location>.<Parameter>.<Type>.<Interval>.<Duration>.<Version>
TSID = re.compile(r'^([^.]+)\.([^.]+)\.([^.]+)\.([^.]+)\.([^.]+)\.(.+)$')
USGS_SITE = re.compile(r'^\d{8,15}$')


def parse_catalog(xml_text):
    """(rows, next_page_cursor). Rows carry the declared unit and the period of record.

    Parsed by TAG NAME, never by child position -- the same discipline the USGS RDB parsers in
    conditions.js needed, for the same reason: the layout is not a promise.
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise ValueError('not parseable as XML (%s). First 400 chars:\n%s'
                         % (exc, xml_text[:400]))
    rows = []
    for e in root.iter('entry'):
        name = e.get('name') or ''
        m = TSID.match(name)
        unit = e.findtext('units')
        ext = e.find('.//extents')
        earliest = late = None
        if ext is not None:
            earliest = ext.findtext('.//earliest-time')
            late = ext.findtext('.//latest-time')
        rows.append({
            'tsid': name, 'office': e.get('office'),
            'location': m.group(1) if m else None,
            'parameter': m.group(2) if m else None,
            'type': m.group(3) if m else None,
            'interval': e.findtext('interval') or (m.group(4) if m else None),
            'version': m.group(6) if m else None,
            'units': unit, 'earliest': earliest, 'latest': late,
        })
    nxt = root.findtext('next-page')
    total = root.findtext('total')
    return rows, (nxt or None), (int(total) if (total or '').isdigit() else None)


def get(url, timeout):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/xml'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode('utf-8', 'replace')


SAMPLE = """<catalog><entries>
<entry office="SAS" name="02187010.Speed-Wind.Inst.15Minutes.0.Raw-USGS_SAS">
<units>kph</units><interval>15Minutes</interval>
<extents><extents><earliest-time>2016-05-26T22:00:00Z</earliest-time>
<latest-time>2026-08-21T20:00:00Z</latest-time></extents></extents></entry>
<entry office="SAS" name="02176930.Temp-Water.Inst.15Minutes.0.Raw-USGS_SAS">
<units>C</units><interval>15Minutes</interval>
<extents><extents><earliest-time>2026-05-30T23:30:00Z</earliest-time>
<latest-time>2026-08-21T18:45:00Z</latest-time></extents></extents></entry>
</entries><next-page>Q1VSU09S</next-page><page-size>20</page-size><total>615</total></catalog>"""


def self_test():
    ok = True

    def check(label, got, want):
        nonlocal ok
        if got != want:
            ok = False
            print('FAIL %-50s got %r want %r' % (label, got, want))
        else:
            print('ok   %-50s %r' % (label, got))

    rows, nxt, total = parse_catalog(SAMPLE)
    check('rows parsed', len(rows), 2)
    check('location is the usgs site number', rows[0]['location'], '02187010')
    check('parameter split off the tsid', rows[0]['parameter'], 'Speed-Wind')
    check('declared unit kept, not assumed', rows[0]['units'], 'kph')
    check('period of record start', rows[0]['earliest'], '2016-05-26T22:00:00Z')
    check('Temp-Water is recognised', rows[1]['parameter'], 'Temp-Water')
    check('temperature unit is C, not F', rows[1]['units'], 'C')
    check('cursor found', nxt, 'Q1VSU09S')
    check('total found', total, 615)
    check('usgs site pattern matches', bool(USGS_SITE.match('02187010')), True)
    check('a named project is not a usgs site', bool(USGS_SITE.match('Hartwell')), False)
    try:
        parse_catalog('<not xml')
        ok = False
        print('FAIL %-50s did not raise' % 'malformed xml')
    except ValueError:
        print('ok   %-50s raised ValueError' % 'malformed xml')
    print('\n%s' % ('SELF-TEST PASSED' if ok else 'SELF-TEST FAILED'))
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', default='registry')
    ap.add_argument('--offices', default=','.join(OFFICES))
    ap.add_argument('--page-size', type=int, default=500)
    ap.add_argument('--timeout', type=float, default=120.0)
    ap.add_argument('--max-pages', type=int, default=60)
    ap.add_argument('--self-test', action='store_true')
    a = ap.parse_args()
    if a.self_test:
        return self_test()

    p = os.path.join(a.registry, 'water_bindings.json')
    if not os.path.exists(p):
        print('FATAL: %s not found. Pass --registry <your registry folder>.' % p)
        return 2
    B = json.load(open(p, encoding='utf-8')).get('bindings') or {}
    site_to_waters = {}
    for slug, r in B.items():
        for g in [r.get('pool'), r.get('tailwater')] + list(r.get('gauges') or []):
            if isinstance(g, dict) and g.get('usgs_site'):
                site_to_waters.setdefault(g['usgs_site'], []).append(r.get('display_name'))
    print('bindings: %d waters, %d distinct USGS sites\n' % (len(B), len(site_to_waters)))

    allrows = []
    for office in [o.strip().upper() for o in a.offices.split(',') if o.strip()]:
        url = '%s?%s' % (BASE, urllib.parse.urlencode(
            {'office': office, 'page-size': a.page_size}))
        page = 0
        while url and page < a.max_pages:
            page += 1
            try:
                body = get(url, a.timeout)
                rows, cursor, total = parse_catalog(body)
            except urllib.error.HTTPError as exc:
                print('  %s page %d: HTTP %d %s' % (office, page, exc.code, exc.reason)); break
            except urllib.error.URLError as exc:
                print('  %s page %d: unreachable: %s' % (office, page, exc.reason)); break
            except ValueError as exc:
                print('  %s page %d: %s' % (office, page, exc)); break
            allrows.extend(rows)
            print('  %s page %-3d %4d rows (total reported: %s)' % (office, page, len(rows), total))
            if not cursor or not rows:
                break
            url = '%s?%s' % (BASE, urllib.parse.urlencode(
                {'office': office, 'page-size': a.page_size, 'page': cursor}))
            time.sleep(0.4)

    if not allrows:
        print('\nNothing came back. Nothing is concluded from that -- see the docstring on `like`.')
        return 2

    print('\ntimeseries catalogued: %d' % len(allrows))
    par = collections.Counter(r['parameter'] for r in allrows)
    print('\n%-22s %-7s %s' % ('PARAMETER', 'SERIES', 'UNITS SEEN'))
    for k, n in par.most_common(30):
        us = sorted({r['units'] for r in allrows if r['parameter'] == k and r['units']})
        print('%-22s %-7d %s' % (k, n, ','.join(us[:4])))

    hits = collections.defaultdict(lambda: collections.defaultdict(set))
    for r in allrows:
        loc = r['location'] or ''
        if loc in site_to_waters:
            for w in site_to_waters[loc]:
                hits[w][r['parameter']].add(r['units'] or '?')
    print('\n%d of your bound USGS sites appear in the Corps catalogue, covering %d waters.'
          % (len({r['location'] for r in allrows if r['location'] in site_to_waters}), len(hits)))
    print('\n%-46s %s' % ('WATER', 'WHAT THE CORPS PUBLISHES FOR IT'))
    for w in sorted(hits):
        print('%-46s %s' % ((w or '')[:46], ', '.join(sorted(hits[w]))))

    out = os.path.join(a.registry, '_cwms_inventory.json')
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump({'_note': 'Every CWMS timeseries in the queried districts, with its declared '
                            'unit and period of record, joined to water_bindings.json by USGS '
                            'site number. UNITS ARE METRIC on this service. Built by '
                            'probe_cwms_catalog.py.',
                   'series': len(allrows),
                   'by_parameter': {k: n for k, n in par.most_common()},
                   'waters': {w: {p: sorted(u) for p, u in d.items()} for w, d in hits.items()},
                   'rows': allrows}, fh, indent=1)
    print('\nwrote %s' % os.path.abspath(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
