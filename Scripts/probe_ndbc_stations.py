#!/usr/bin/env python3
"""
probe_ndbc_stations.py -- which of the bound NWS gauge ids are ALSO live NDBC weather stations?

    py .\\scripts\\probe_ndbc_stations.py
    py .\\scripts\\probe_ndbc_stations.py --registry F:\\TrollMapPipeline\\registry --jobs 8
    py .\\scripts\\probe_ndbc_stations.py --self-test        (parser only, no network)

WHY THIS EXISTS

Ryan, 2026-08-24, pointing at https://www.weather.gov/cae/lakeobs.html:
*"this isn't water temp... this is weather but are we fetching anything like this already"*

We are not. The app reads Open-Meteo -- a GRIDDED FORECAST MODEL -- for wind, and
`plan-preflight.js` decides go / no-go off it: over 15 mph sustained or 20 mph gusts is a no-go.
That page points at anemometers sitting ON four South Carolina lakes, reporting every ten
minutes. A model cell over a 50,000-acre reservoir and an instrument on the dam are not the same
number, and the one deciding whether a kayak launches should be the instrument.

THE IDENTIFIERS ARE ALREADY IN THE REGISTRY. NDBC serves these partner stations under NWS
handbook-5 ids -- the same id space as `water_bindings.json`'s `lid`. Measured 2026-08-24:

    WATS1  Lake Wateree Dam            already bound to Wateree Lake (Kershaw Co, SC)
    CHDS1  J. Strom Thurmond Dam       already bound to J. Strom Thurmond Reservoir (Lincoln Co, GA/SC)
    LMFS1  Lake Murray, Flotilla Is.   NOT bound
    LMSS1  Lake Marion, Santee St. Pk. NOT bound

So this is not a new source needing a new hand table. It is a question about ids the registry
already holds, and the honest way to answer it is to ask NDBC about every one of them rather
than to scrape one weather office's page and hand-copy four.

WHAT IT DOES

For every distinct `lid` in water_bindings.json it GETs

    https://www.ndbc.noaa.gov/data/realtime2/<LID>.txt

a two-header fixed-column file, newest row first. A 404 means NDBC does not serve that id and is
an ordinary result, not an error. For the ids that answer, it reads the most recent rows and
records WHICH FIELDS ARE ACTUALLY PRESENT -- NDBC writes the literal string `MM` for a missing
value, and a station that reports wind but not water temperature is the common case, not a fault.

    LOOKED AT SEVERAL ROWS, NOT ONE. A single row can carry MM on a field the station publishes
    fine the rest of the hour. Deciding "this station has no water temperature" off one sample is
    the same mistake as reading a lake's depth off one ping.

Writes `registry/_ndbc_stations.json`: lid -> fields present, newest observation, and every water
that lid is bound to. Prints a summary of how many waters gain a measured wind, a measured gust
and a measured water temperature.

READ-ONLY against the app. It writes one report file under --registry and uploads nothing.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import sys
import urllib.error
import urllib.request

NDBC = 'https://www.ndbc.noaa.gov/data/realtime2/%s.txt'

# NDBC column -> what it is. Only the ones worth knowing about on a lake.
FIELDS = {
    'WDIR': 'wind direction (degT)',
    'WSPD': 'wind speed (m/s)',
    'GST':  'gust (m/s)',
    'ATMP': 'air temperature (degC)',
    'WTMP': 'water temperature (degC)',
    'PRES': 'pressure (hPa)',
    'DEWP': 'dew point (degC)',
}
MISSING = {'MM', 'M', '', '-'}


def parse_realtime2(text, rows_to_read=6):
    """NDBC realtime2 -> {'fields': {...}, 'latest': {...}, 'rows_seen': n} or None.

    Two comment lines, then rows NEWEST FIRST. Columns are located BY HEADER NAME, never by
    position -- the same discipline the USGS RDB parsers in conditions.js needed for `loc_web_ds`,
    and for the same reason: the layout is not a promise.
    """
    lines = [l for l in str(text or '').split('\n') if l.strip()]
    if len(lines) < 3 or not lines[0].startswith('#'):
        return None
    head = lines[0].lstrip('#').split()
    data = [l for l in lines[1:] if not l.startswith('#')]
    if not data:
        return None

    def cell(row, name):
        i = head.index(name) if name in head else -1
        if i < 0 or i >= len(row):
            return None
        v = row[i].strip()
        return None if v in MISSING else v

    present = {}
    latest = {}
    rows = [r.split() for r in data[:max(1, rows_to_read)]]
    for name in FIELDS:
        for r in rows:
            v = cell(r, name)
            if v is not None:
                try:
                    present[name] = float(v)
                except ValueError:
                    continue
                break
    first = rows[0]
    for name in ('YY', 'MM', 'DD', 'hh', 'mm'):
        i = head.index(name) if name in head else -1
        if 0 <= i < len(first):
            latest[name] = first[i]
    stamp = None
    if all(k in latest for k in ('YY', 'MM', 'DD', 'hh', 'mm')):
        stamp = '%s-%s-%sT%s:%sZ' % (latest['YY'], latest['MM'], latest['DD'],
                                     latest['hh'], latest['mm'])
    return {'fields': sorted(present), 'values': present, 'observed_utc': stamp,
            'rows_seen': len(rows)}


def fetch(lid, timeout):
    req = urllib.request.Request(NDBC % lid.upper(), headers={
        'User-Agent': 'trollmap-ndbc-probe/1.0 (+personal use; '
                      'https://github.com/colonal1981/TrollMap-Dev)',
        'Accept': 'text/plain',
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return parse_realtime2(r.read().decode('utf-8', 'replace')), None
    except urllib.error.HTTPError as exc:
        # 404 IS AN ANSWER, NOT A FAILURE. Most NWS gauge ids are not NDBC stations.
        return None, ('not an NDBC station' if exc.code == 404 else 'HTTP %d' % exc.code)
    except urllib.error.URLError as exc:
        return None, 'unreachable: %s' % exc.reason
    except Exception as exc:                                  # noqa: BLE001
        return None, '%s: %s' % (type(exc).__name__, exc)


SAMPLE_WATS1 = (
    "#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE\n"
    "#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft\n"
    "2026 08 24 18 30 330  3.1  5.1    MM    MM    MM  MM     MM  35.1    MM    MM   MM   MM    MM\n"
    "2026 08 24 18 20 350  4.6  6.2    MM    MM    MM  MM     MM  34.2    MM    MM   MM   MM    MM\n"
)
SAMPLE_LATE_VALUE = (
    "#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE\n"
    "#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft\n"
    "2026 08 24 18 30 330  3.1  5.1    MM    MM    MM  MM     MM  35.1    MM    MM   MM   MM    MM\n"
    "2026 08 24 18 20 350  4.6  6.2    MM    MM    MM  MM     MM  34.2  28.9    MM   MM   MM    MM\n"
)


def self_test():
    ok = True

    def check(label, got, want):
        nonlocal ok
        if got != want:
            ok = False
            print('FAIL %-46s got %r want %r' % (label, got, want))
        else:
            print('ok   %-46s %r' % (label, got))

    a = parse_realtime2(SAMPLE_WATS1)
    check('WATS1 fields', a['fields'], ['ATMP', 'GST', 'WDIR', 'WSPD'])
    check('WATS1 wind speed m/s', a['values']['WSPD'], 3.1)
    check('WATS1 no water temperature', 'WTMP' in a['values'], False)
    check('WATS1 observation stamp', a['observed_utc'], '2026-08-24T18:30Z')

    # A value on the SECOND row must still count. Reading one row would call this station
    # water-temperature-less, which is exactly the bug the rows_to_read window exists to stop.
    b = parse_realtime2(SAMPLE_LATE_VALUE)
    check('second-row WTMP is found', b['values'].get('WTMP'), 28.9)
    c = parse_realtime2(SAMPLE_LATE_VALUE, rows_to_read=1)
    check('one-row window would have missed it', 'WTMP' in c['values'], False)

    check('empty input', parse_realtime2(''), None)
    check('headers only', parse_realtime2(SAMPLE_WATS1.split('\n')[0] + '\n'), None)
    check('junk input', parse_realtime2('not a station file'), None)
    print('\n%s' % ('SELF-TEST PASSED' if ok else 'SELF-TEST FAILED'))
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', default='registry')
    ap.add_argument('--jobs', type=int, default=8)
    ap.add_argument('--timeout', type=float, default=30.0)
    ap.add_argument('--rows', type=int, default=6, help='how many recent rows decide "present"')
    ap.add_argument('--self-test', action='store_true', help='parser tests only, no network')
    a = ap.parse_args()
    if a.self_test:
        return self_test()

    p = os.path.join(a.registry, 'water_bindings.json')
    if not os.path.exists(p):
        print('FATAL: %s not found. Pass --registry <your registry folder>.' % p)
        return 2
    B = json.load(open(p, encoding='utf-8')).get('bindings') or {}
    if not B:
        print('FATAL: %s has no bindings.' % p)
        return 2

    lids = {}
    for slug, r in B.items():
        gs = [('pool', r.get('pool')), ('tailwater', r.get('tailwater'))]
        gs += [('gauge', g) for g in (r.get('gauges') or [])]
        for role, g in gs:
            if isinstance(g, dict) and g.get('lid'):
                lids.setdefault(g['lid'].upper(), []).append(
                    {'slug': slug, 'display_name': r.get('display_name'),
                     'feature_type': r.get('feature_type'), 'role': role})
    print('bindings: %d waters, %d distinct NWS gauge ids' % (len(B), len(lids)))
    print('asking NDBC about each one (%d at a time)...\n' % a.jobs)

    hits, misses = {}, {}
    with cf.ThreadPoolExecutor(max_workers=max(1, a.jobs)) as ex:
        futs = {ex.submit(fetch, lid, a.timeout): lid for lid in sorted(lids)}
        done = 0
        for f in cf.as_completed(futs):
            lid = futs[f]
            done += 1
            got, err = f.result()
            if got:
                hits[lid] = got
            else:
                misses[lid] = err
            if done % 50 == 0:
                print('   %d/%d ...' % (done, len(futs)))

    unreachable = {k: v for k, v in misses.items() if v and not v.startswith('not an NDBC')}
    print('\n%d of %d gauge ids are live NDBC stations' % (len(hits), len(lids)))
    if unreachable:
        print('%d could not be checked (network, not absence) -- rerun to settle them'
              % len(unreachable))

    def waters_with(field):
        out = set()
        for lid, rec in hits.items():
            if field in rec['values']:
                for w in lids[lid]:
                    out.add(w['display_name'])
        return out

    wind = waters_with('WSPD')
    gust = waters_with('GST')
    wtmp = waters_with('WTMP')
    atmp = waters_with('ATMP')
    print()
    print('waters gaining a MEASURED wind speed:       %3d of %d' % (len(wind), len(B)))
    print('waters gaining a MEASURED gust:             %3d of %d' % (len(gust), len(B)))
    print('waters gaining a MEASURED air temperature:  %3d of %d' % (len(atmp), len(B)))
    print('waters gaining a MEASURED water temperature:%3d of %d' % (len(wtmp), len(B)))
    print()
    print('%-8s %-46s %-22s %s' % ('LID', 'WATER', 'OBSERVED (UTC)', 'FIELDS'))
    for lid in sorted(hits, key=lambda k: (lids[k][0]['display_name'] or '')):
        rec = hits[lid]
        for w in lids[lid][:1]:
            print('%-8s %-46s %-22s %s'
                  % (lid, (w['display_name'] or '')[:46], rec['observed_utc'] or '?',
                     ','.join(rec['fields'])))

    out = os.path.join(a.registry, '_ndbc_stations.json')
    payload = {
        '_note': 'NWS handbook-5 gauge ids from water_bindings.json that NDBC serves as live '
                 'weather stations. Built by probe_ndbc_stations.py. `values` is the newest '
                 'non-MM reading found within the --rows window and is a SAMPLE, not a feed.',
        'checked': len(lids), 'answered': len(hits),
        'unreachable': unreachable,
        'stations': {lid: {**hits[lid], 'waters': lids[lid]} for lid in sorted(hits)},
    }
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, indent=1, sort_keys=False)
    print('\nwrote %s' % os.path.abspath(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
