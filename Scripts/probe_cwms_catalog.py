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


def location_index(bindings):
    """Every CWMS location name this app has a water for, and which water(s).

    TWO KEYS, NOT ONE, AND THE SECOND ONE IS WHERE THE DATA IS.

    The first version joined on the USGS site number alone, because for every series sourced
    `Raw-USGS_*` the CWMS location name IS the site number and that join is exact. It is exact
    and it is a fifth of the picture: of 3,328 series catalogued across SAS, SAM, SAW and LRN on
    2026-08-24, only 181 joined. The other 3,147 sit on NAMED PROJECT LOCATIONS -- `Hartwell`
    (84 series), `Russell` (104), `Thurmond` (82) -- which no site number will ever match.

    Those are the Corps' own instruments on the Corps' own dams: pool and tailwater elevation,
    the guide curve out to 2030, inflow, turbine and spill release, storage, scheduled
    generation, and a day-of-year percentile envelope back to 1954. `water_bindings.json`
    already carries the key to them, as `usace[].cwms_name`, and this script simply never read
    it -- so the report said "the Corps publishes Stage and Flow for this lake" about a lake for
    which it also publishes twenty other things.

    A CHILD LOCATION IS RECORDED, NOT MERGED. `Hartwell-Unit1` and `Thurmond-O2System-Line3` are
    real locations with real series, and they are turbine and transmission telemetry -- of no use
    to anyone choosing where to fish. They join to the water under `via='cwms_child'` so they can
    be counted and then set aside, rather than either vanishing or padding the lake's parameter
    list.
    """
    by_site, by_project = {}, {}
    for slug, r in (bindings or {}).items():
        name = r.get('display_name') or slug
        for g in [r.get('pool'), r.get('tailwater')] + list(r.get('gauges') or []):
            if isinstance(g, dict) and g.get('usgs_site'):
                by_site.setdefault(str(g['usgs_site']), set()).add(name)
        for u in (r.get('usace') or []):
            if isinstance(u, dict) and u.get('cwms_name'):
                by_project.setdefault(str(u['cwms_name']), set()).add(name)
    return {'by_site': by_site, 'by_project': by_project}


def join_location(loc, index):
    """(waters, via) for one catalogue location. `via` is site | project | child | None.

    Exact match first, on both keys. Only then the `<project>-<component>` shape, and only
    against a project this app is actually bound to -- so `Hartwell-Unit1` resolves and
    `Hartwell-Something-Nobody-Bound` does not resolve to Hartwell by accident of prefix.
    """
    loc = str(loc or '')
    if not loc:
        return [], None
    if loc in index['by_site']:
        return sorted(index['by_site'][loc]), 'site'
    if loc in index['by_project']:
        return sorted(index['by_project'][loc]), 'project'
    for sep in ('-', '_'):
        head = loc.split(sep)[0]
        if head and head != loc and head in index['by_project']:
            return sorted(index['by_project'][head]), 'child'
    return [], None


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
    IDX = location_index({
        'hartwell_lake': {'display_name': 'Hartwell Lake (Anderson Co, SC/GA)',
                          'pool': {'usgs_site': '02187010'},
                          'usace': [{'cwms_name': '02187010'}, {'cwms_name': 'Hartwell'},
                                    {'cwms_name': 'Hartwell-Powerhouse'}]},
        'thurmond': {'display_name': 'J. Strom Thurmond Reservoir (Lincoln Co, GA/SC)',
                     'gauges': [{'usgs_site': '02193900'}],
                     'usace': [{'cwms_name': 'Thurmond'}]},
    })
    check('a site number still joins', join_location('02187010', IDX)[1], 'site')
    check('a NAMED PROJECT joins now', join_location('Hartwell', IDX),
          (['Hartwell Lake (Anderson Co, SC/GA)'], 'project'))
    check('an exact child location is its own row, not a prefix guess',
          join_location('Hartwell-Powerhouse', IDX)[1], 'project')
    check('an unbound child resolves to its project and is FLAGGED as one',
          join_location('Hartwell-Unit1', IDX), (['Hartwell Lake (Anderson Co, SC/GA)'], 'child'))
    check('underscore components too', join_location('Thurmond_Basin', IDX)[1], 'child')
    # THE PREFIX RULE IS NOT A SUBSTRING RULE. `Hartwellville` must not become Hartwell, and a
    # sentinel for a project nobody bound must not acquire a water by looking similar.
    check('a longer name is not a prefix match', join_location('Hartwellville', IDX), ([], None))
    check('an unbound project joins nothing', join_location('Buford', IDX), ([], None))
    check('an unbound child joins nothing', join_location('Buford-Unit1', IDX), ([], None))
    check('empty location is refused', join_location('', IDX), ([], None))
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
    index = location_index(B)
    print('bindings: %d waters, %d distinct USGS sites, %d Corps project locations\n'
          % (len(B), len(index['by_site']), len(index['by_project'])))

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

    # `hits` is what the Corps publishes AT the water. `telemetry` is what it publishes at the
    # machinery inside the dam -- turbine units, transmission lines, the oxygen system. Both are
    # counted; only the first is a fishing fact, and keeping them apart is what stops a lake's
    # parameter list from filling up with Power-Real and Opening.
    hits = collections.defaultdict(lambda: collections.defaultdict(set))
    telemetry = collections.defaultdict(lambda: collections.defaultdict(set))
    by_via = collections.Counter()
    locs_seen = collections.defaultdict(set)
    unjoined = collections.Counter()
    for r in allrows:
        waters, via = join_location(r['location'], index)
        by_via[via or 'none'] += 1
        r['water_via'] = via
        r['waters'] = waters
        if not waters:
            unjoined[r['location'] or '?'] += 1
            continue
        bucket = telemetry if via == 'child' else hits
        for w in waters:
            bucket[w][r['parameter']].add(r['units'] or '?')
            locs_seen[w].add(r['location'])

    joined = by_via['site'] + by_via['project'] + by_via['child']
    print('\n%d of %d catalogued series join to one of your waters '
          '(%d by USGS site number, %d on the project itself, %d on machinery inside it).'
          % (joined, len(allrows), by_via['site'], by_via['project'], by_via['child']))
    print('%d series are on Corps locations this app has no water for.' % by_via['none'])
    print('\n%-46s %s' % ('WATER', 'WHAT THE CORPS PUBLISHES AT IT'))
    for w in sorted(set(hits) | set(telemetry)):
        print('%-46s %s' % ((w or '')[:46], ', '.join(sorted(hits.get(w, {})))))
        extra = sorted(telemetry.get(w, {}))
        if extra:
            print('%-46s   (inside the dam: %s)' % ('', ', '.join(extra)))
    if unjoined:
        print('\nTHE TEN BIGGEST UNJOINED LOCATIONS -- each is a Corps project this app either '
              'does not carry\nor did not bind a usace[] row for. Worth a look before concluding '
              'a water has nothing.')
        for loc, n in unjoined.most_common(10):
            print('   %-34s %4d series' % (loc[:34], n))

    out = os.path.join(a.registry, '_cwms_inventory.json')
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump({'_note': 'Every CWMS timeseries in the queried districts, with its declared '
                            'unit and period of record, joined to water_bindings.json on TWO '
                            'keys: the USGS site number (exact, for Raw-USGS_* series) and the '
                            'Corps project name from usace[].cwms_name (which is where four '
                            'fifths of the series live). Each row carries how it joined in '
                            '`water_via`: site | project | child | null. `child` is machinery '
                            'inside the dam -- turbine units, transmission lines -- kept out of '
                            "the water's parameter list and counted separately in `telemetry`. "
                            'UNITS ARE METRIC on this service. Built by probe_cwms_catalog.py.',
                   'series': len(allrows),
                   'joined': {k: n for k, n in by_via.most_common()},
                   'by_parameter': {k: n for k, n in par.most_common()},
                   'waters': {w: {p: sorted(u) for p, u in d.items()} for w, d in hits.items()},
                   'telemetry': {w: {p: sorted(u) for p, u in d.items()}
                                 for w, d in telemetry.items()},
                   'locations_per_water': {w: sorted(v) for w, v in locs_seen.items()},
                   'unjoined_locations': {k: n for k, n in unjoined.most_common(60)},
                   'rows': allrows}, fh, indent=1)
    print('\nwrote %s' % os.path.abspath(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
