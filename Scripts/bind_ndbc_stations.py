#!/usr/bin/env python3
"""bind_ndbc_stations.py -- attach NDBC weather and water-quality stations to registry slugs.

WHY THIS EXISTS, AND WHY IT WAS MISSED FOR SO LONG.

The app's wind comes from NWS MapClick, which is a MODEL. On 2026-08-25 Ryan sent a link to
NDBC station LMFS1 -- "Lake Murray SC", a C-MAN station owned by NWS WFO Columbia, sitting on
the water he fishes most, reporting wind direction, speed and gust every ten minutes. Its
newest observation at the time was forty minutes old.

Nothing in this pipeline could have found it. NDBC stations are a SEPARATE NAMESPACE from
everything the water binder reads: LMFS1 is not in `water_bindings.json`, not in the NWPS bulk
roster, and not in the USGS catalogue. Searching the lists we already had would have returned
nothing forever, which is exactly what it did -- twice, confidently, before Ryan pointed at the
station with a browser.

WHAT THE JOIN MEASURED (2026-08-25, against `activestations.xml` created 23:25 UTC that day):
1,351 active stations nationally, 51 inside the registry box, 30 of them within 5 km of 20 of
the 204 offered waters. That number is not the number of wins -- see the two refusals below.

THE FEED IS A TEXT FILE AND NEEDS NO KEY.

    https://www.ndbc.noaa.gov/data/realtime2/<ID>.txt        met: wind, gust, air, pressure
    https://www.ndbc.noaa.gov/data/realtime2/<ID>.ocean      water quality, where published

Two-line header, fixed width, newest row first, `MM` for missing. The id is lowercase in the
XML and UPPERCASE in the path -- see `feed_id`. THE URL IS NOT STORED. It is derivable from the
id, and this registry already refused to store NWPS's `hydrograph page` for the same reason: a
second copy of a field we hold is a second thing that can drift.

TWO FILES, AND OFTEN TWO STATION IDS FOR ONE PIECE OF WATER. Measured 2026-08-25 at Oyster
Landing in the North Inlet-Winyah Bay reserve:

    NIWS1.txt    WDIR 170  WSPD 4.1  PRES 1016.0  ATMP 28.4  DEWP 23.9  PTDY +0.0
                 GST and WTMP are `MM` on EVERY row.
    NIQS1.ocean  DEPTH 2.6 m  OTMP 28.80 degC  COND 55.54 mS/cm  SAL 36.70 psu
                 O2 110.0%  6.90 ppm  TURB 12 FTU  PH 8.00

Same site, same 15-minute clock, two ids and two files, and NEITHER IS COMPLETE ALONE. That is
why a water binds every qualifying station rather than a nearest one: `met` and `water_quality`
are what say which file answers, and a coastal water usually needs both.

TWO UNITS TRAPS, NEITHER OF THEM RESOLVED HERE.
  - TURB arrives in FTU. USGS parameter 63680, which this app already reads and renders as
    turbidity, is FNU. Different instruments, different scattering angle, NOT interchangeable.
    They must not land in one field without saying which answered -- the same rule this codebase
    already applies to salinity (00480) against specific conductance (00095).
  - SAL is psu and WSPD is m/s. USGS salinity is ppt and every wind number this app shows is mph.

A MET STATION IS NOT AUTOMATICALLY A GUST STATION. `plan-preflight.js` calls a no-go at 20 mph
gusts, and NIWS1 publishes no gust at all. LMFS1 on Lake Murray does (GST 6.2 m/s at 22:50 on
2026-08-25), so Murray can answer that question from an instrument. Oyster Landing cannot.

Usage:

    py .\\scripts\\bind_ndbc_stations.py --registry F:\\TrollMapPipeline\\registry
    py .\\scripts\\bind_ndbc_stations.py --registry ... --write

Refresh the inputs with:

    curl.exe -sS --fail -o F:\\TrollMapPipeline\\ndbc_active.xml ^
        https://www.ndbc.noaa.gov/activestations.xml

Tested by `scripts/test_bind_ndbc_stations.py` -- no network, no registry.
"""

import argparse
import io
import json
import math
import os
import re
import sys

# The registry box, the same one build_water_bindings sizes its gauge sweep to. A station
# outside it cannot be within margin of any water we offer, and skipping them early keeps the
# point-in-polygon work proportional to the registry rather than to NDBC.
BOX_W, BOX_S, BOX_E, BOX_N = -84.6, 30.2, -77.1, 37.7

# THE SAME MARGIN THE GAUGE BINDER USES. `build_water_bindings.py --margin-km` defaults to 3.0
# and that is what "near this water" already means in this registry. Picking a different number
# here would be inventing a second definition of nearness for no reason anybody could state.
DEFAULT_MARGIN_KM = 3.0

# A CO-OPS station reached through NDBC is the SAME READING WE ALREADY FETCH.
#
# Five of the thirty joins measured on 2026-08-25 were NOS/CO-OPS tide stations whose NDBC names
# carry the CO-OPS station number outright: chts1 "8665530 - Charleston", mros1 "8661070 -
# Springmaid Pier", fpkg1 "8670870 - Fort Pulaski", wlon7 "8658120 - Wilmington", jmpn7
# "8658163 - Wrightsville Beach". Worker/conditions.js already reads those through the CO-OPS
# API and binds them under `tides`.
#
# Binding them again here would put two code paths on one number, which is the thing this
# codebase refuses on principle -- see the note on CWMS pool elevation in conditions.js. The
# refusal is BY RULE and it is reported, because a duplicate nobody announces is a duplicate
# somebody rediscovers as a disagreement six weeks later.
COOPS_ID_RE = re.compile(r'\b(\d{7})\b')
COOPS_OWNERS = ('NOS', 'CO-OPS', 'NOAA/NOS')


def load_active(path):
    """Every active NDBC station, from the XML NDBC publishes for exactly this purpose.

    Attributes verified against the live file on 2026-08-25:
        id lat lon elev name owner pgm type met currents waterquality dart

    `met`, `currents` and `waterquality` are 'y'/'n' and they are the station's own statement of
    what it publishes. They are not a guess and they are not derived from a sample of the data.
    """
    try:
        raw = io.open(path, encoding='utf-8').read()
    except OSError as e:
        sys.exit('cannot read %s: %s\n  refresh it with the curl.exe line in this file\'s docstring' % (path, e))
    out = []
    for attrs in re.findall(r'<station\b([^>]*?)/>', raw):
        d = dict(re.findall(r'(\w+)="([^"]*)"', attrs))
        try:
            lat = float(d['lat'])
            lon = float(d['lon'])
        except (KeyError, ValueError):
            continue
        sid = (d.get('id') or '').strip()
        if not sid:
            continue
        elev = None
        try:
            elev = float(d['elev'])
        except (KeyError, ValueError):
            pass
        out.append({
            'id': sid,
            'name': (d.get('name') or '').strip() or None,
            'owner': (d.get('owner') or '').strip() or None,
            'program': (d.get('pgm') or '').strip() or None,
            'type': (d.get('type') or '').strip() or None,
            'lat': lat, 'lon': lon, 'elev_m': elev,
            'met': d.get('met') == 'y',
            'currents': d.get('currents') == 'y',
            'water_quality': d.get('waterquality') == 'y',
        })
    created = re.search(r'created="([^"]+)"', raw)
    return out, (created.group(1) if created else None)


def feed_id(sid):
    """NDBC writes the id lowercase in the XML and UPPERCASE in the realtime2 path."""
    return str(sid).upper()


def coops_ids_for(binding):
    """The CO-OPS station numbers this water already binds under `tides`."""
    out = set()
    for t in (binding.get('tides') or []):
        i = str((t or {}).get('id') or '').strip()
        if i:
            out.add(i)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', required=True)
    ap.add_argument('--active', default=None, help='default <registry>/../ndbc_active.xml')
    ap.add_argument('--margin-km', type=float, default=DEFAULT_MARGIN_KM)
    ap.add_argument('--write', action='store_true',
                    help='write `ndbc` into water_bindings.json')
    a = ap.parse_args()

    reg = a.registry
    active_path = a.active or os.path.join(os.path.dirname(os.path.abspath(reg)), 'ndbc_active.xml')

    # The geometry lives in the water binder and is not reimplemented here. Importing it also
    # means the bounding-box reject and the squared-distance shore scan added on 2026-08-25
    # apply to this join for free.
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import build_water_bindings as wb

    stations, created = load_active(active_path)
    print('NDBC active roster: %d station(s)%s' % (len(stations), (' created %s' % created) if created else ''))
    box = [s for s in stations
           if BOX_W <= s['lon'] <= BOX_E and BOX_S <= s['lat'] <= BOX_N]
    print('   inside the registry box: %d   (met %d, water quality %d, currents %d)' % (
        len(box), sum(1 for s in box if s['met']),
        sum(1 for s in box if s['water_quality']), sum(1 for s in box if s['currents'])))

    idx_path = os.path.join(reg, 'lake_index.json')
    with io.open(idx_path, encoding='utf-8') as fh:
        index = json.load(fh)
    bpath = os.path.join(reg, 'water_bindings.json')
    with io.open(bpath, encoding='utf-8') as fh:
        bdoc = json.load(fh)
    bindings = bdoc.get('bindings', bdoc)

    bound = {}
    n_coops = n_silent = n_bound = 0
    boundaries = os.path.join(reg, 'boundaries')

    for slug in sorted(bindings):
        gpath = os.path.join(boundaries, slug + '.geojson')
        if not os.path.exists(gpath):
            continue
        geom = wb.load_boundary(gpath)
        if not geom:
            continue
        polys, verts = geom
        already = coops_ids_for(bindings[slug])
        keep = []
        for s in box:
            if wb.point_in_polys(s['lon'], s['lat'], polys):
                km = 0.0
            else:
                km = wb.km_to_shore(s['lon'], s['lat'], verts)
                if km > a.margin_km:
                    continue

            # REFUSAL 1: a CO-OPS station we already read through the CO-OPS API.
            hit = COOPS_ID_RE.search(s['name'] or '')
            is_coops = (hit and hit.group(1) in already) or \
                       any(o in (s['owner'] or '') for o in COOPS_OWNERS)
            if is_coops:
                print('   SKIP  %-8s %-34s %-26s already read via CO-OPS' % (
                    s['id'], (s['name'] or '')[:34], slug[:26]))
                n_coops += 1
                continue

            # REFUSAL 2: a station that publishes nothing. Measured 2026-08-25: lmss1 "Lake
            # Marion, SC" and chds1 "Strom Thurmond Dam, SC" are both in the ACTIVE roster with
            # met=n, waterquality=n and currents=n. Ryan checked Marion in a browser and
            # confirmed it is not reporting. A station bound here would put an empty field on a
            # card with no reason beside it, which is the failure this project keeps naming.
            if not (s['met'] or s['water_quality'] or s['currents']):
                print('   SKIP  %-8s %-34s %-26s publishes nothing (met=n wq=n cur=n)' % (
                    s['id'], (s['name'] or '')[:34], slug[:26]))
                n_silent += 1
                continue

            e = dict(s)
            e['km_outside'] = round(km, 2)
            e['feed_id'] = feed_id(s['id'])
            keep.append(e)

        if keep:
            keep.sort(key=lambda x: (x['km_outside'], x['id']))
            bound[slug] = keep
            n_bound += len(keep)

    print('\n%d water(s) bound to %d NDBC station(s).' % (len(bound), n_bound))
    print('   refused as an existing CO-OPS reading: %d' % n_coops)
    print('   refused as publishing nothing:         %d' % n_silent)
    print()
    for slug in sorted(bound):
        nm = (index.get(slug) or {}).get('display_name', slug)
        for s in bound[slug]:
            what = ' '.join(k for k, v in (('met', s['met']), ('waterquality', s['water_quality']),
                                           ('currents', s['currents'])) if v)
            print('   %-40s %-8s %-26s %5.2f km  [%s]' % (
                nm[:40], s['feed_id'], (s['name'] or '')[:26], s['km_outside'], what))

    if a.write:
        # A water that HAD stations and now has none must lose the block, or a station that went
        # offline stays on the card forever with nothing behind it.
        for slug in list(bindings):
            if slug in bound:
                bindings[slug]['ndbc'] = bound[slug]
            elif 'ndbc' in bindings[slug]:
                del bindings[slug]['ndbc']
        with io.open(bpath, 'w', encoding='utf-8') as fh:
            json.dump(bdoc, fh)
        print('\nwrote ndbc bindings -> %s' % bpath)
        print('REMINDER: `ndbc` must be in FOREIGN_KEYS in build_water_bindings.py, or the next'
              ' rebind erases it. That is exactly how the operator join was lost for nine days.')
    else:
        print('\n(dry run -- pass --write to store these)')


if __name__ == '__main__':
    main()
