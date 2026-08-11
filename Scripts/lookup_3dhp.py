#!/usr/bin/env python3
"""
lookup_3dhp.py -- ask the 3DHP GeoPackage what it knows about a water.

    py .\\scripts\\lookup_3dhp.py --near -80.63639,33.78583 --radius 4000
    py .\\scripts\\lookup_3dhp.py --gnis 1220360
    py .\\scripts\\lookup_3dhp.py --name "Bates Old River"

WHY THIS EXISTS

`registry/lake_index.json` carries a `gnis` field on 1,732 of its 1,746 entries, formatted
`gnis:1220360`. The 3DHP GeoPackage on the drive carries `gnisid` as an integer on both its
waterbody and flowline tables. So any water the registry knows about can be looked up in the
source, and -- more useful -- any water it does NOT know about can be checked for.

READ FEATURETYPE AND waterbodyid3dhp FIRST, NOT THE NAME.

A water can be named in 3DHP and still have no polygon. Bates Old River is the worked example:
gnisid 1220360 returns 11 FLOWLINES totalling 6.09 km and ZERO waterbody rows. Seven of those
flowlines are featuretype 5 (artificial path) carrying `waterbodyid3dhp = OH8SM`, which is the
Congaree River's own 11.69 sq km river-area polygon; the other four carry no waterbody at all.
3DHP does not model the oxbow as its own water, so there is no polygon to clip against, and
00_START_HERE is explicit: "a contour can only be assigned by clipping against a polygon, so the
polygon list IS the app."

That is a real absence in the source. A name search alone would never reveal it, so this reports
BOTH tables and prints the waterbody each flowline points at.

--near IS THE FAST PATH AND THE HONEST ONE

The file is 60 GB and `gnisid` is not indexed, so --gnis and --name are full table scans: minutes,
not seconds. But the GeoPackage ships RTree spatial indexes (rtree_<table>_shape), so a bounding
box query is instant. --near takes lon,lat in WGS84 and answers "what does 3DHP have HERE",
which is the question that actually matters when a water is missing -- it finds polygons whose
name is null, which no name search can.

Geometry is stored in EPSG:6350, NAD83(2011) / Conus Albers, so --near projects the point with
the ellipsoidal Albers forward formula below. No pyproj on the pipeline box, hence the longhand.

NOTE: the geometry column is `shape`, NOT `geom`. Assuming `geom` is what made the first version
of this script fail with "no such column". The column name is read from gpkg_geometry_columns.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import sys

WB = 'hydro_3dhp_all_waterbody'
FL = 'hydro_3dhp_all_flowline'

# ---------------------------------------------------------------- EPSG:6350
# NAD83(2011) / Conus Albers. GRS80, standard parallels 29.5 / 45.5, origin 23 N 96 W.
_A = 6378137.0
_F = 1 / 298.257222101
_E2 = 2 * _F - _F * _F
_E = math.sqrt(_E2)


def _q(p: float) -> float:
    s = math.sin(p)
    return (1 - _E2) * (s / (1 - _E2 * s * s) - (1 / (2 * _E)) * math.log((1 - _E * s) / (1 + _E * s)))


def _m(p: float) -> float:
    s = math.sin(p)
    return math.cos(p) / math.sqrt(1 - _E2 * s * s)


_P1, _P2, _P0 = map(math.radians, (29.5, 45.5, 23.0))
_L0 = math.radians(-96.0)
_N = (_m(_P1) ** 2 - _m(_P2) ** 2) / (_q(_P2) - _q(_P1))
_C = _m(_P1) ** 2 + _N * _q(_P1)
_RHO0 = _A * math.sqrt(_C - _N * _q(_P0)) / _N


def albers(lon: float, lat: float) -> tuple[float, float]:
    """WGS84 lon/lat -> EPSG:6350 metres. Sanity check: (-96, 23) -> (0, 0)."""
    p = math.radians(lat)
    rho = _A * math.sqrt(_C - _N * _q(p)) / _N
    th = _N * (math.radians(lon) - _L0)
    return rho * math.sin(th), _RHO0 - rho * math.cos(th)


# ---------------------------------------------------------------- reporting
def _cols(cur, t):
    cur.execute('PRAGMA table_info(%s)' % t)
    return [r[1] for r in cur.fetchall()]


def _pick(have):
    return [c for c in ('id3dhp', 'gnisid', 'gnisidlabel', 'featuretype', 'lengthkm',
                        'areasqkm', 'waterbodyid3dhp') if c in have]


def _report(cur, table, label, where, args, limit):
    pick = _pick(_cols(cur, table))
    print('\n== %s ==' % label)
    try:
        cur.execute('SELECT %s FROM %s WHERE %s' % (', '.join(pick), table, where), args)
    except sqlite3.Error as e:
        print('   query failed: %s' % e)
        return []
    rows = cur.fetchall()
    print('   %d row(s)' % len(rows))
    for r in rows[:limit]:
        print('   ' + json.dumps(dict(zip(pick, r)), default=str))
    if len(rows) > limit:
        print('   ... and %d more' % (len(rows) - limit))
    return [dict(zip(pick, r)) for r in rows]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--gpkg', default=r'3dhp_all_CONUS_20260112_GPKG\3dhp_all_CONUS_20260112_GPKG.gpkg')
    ap.add_argument('--near', default=None, help='LON,LAT in WGS84 -- uses the RTree, instant')
    ap.add_argument('--radius', type=float, default=4000.0, help='metres, with --near (default 4000)')
    ap.add_argument('--gnis', default=None, help='numeric GNIS id, with or without the gnis: prefix (SLOW: full scan)')
    ap.add_argument('--name', default=None, help='substring of gnisidlabel, case-insensitive (SLOW: full scan)')
    ap.add_argument('--limit', type=int, default=30)
    a = ap.parse_args()

    if not os.path.exists(a.gpkg):
        print('no gpkg at %s' % a.gpkg)
        return 2
    if not (a.near or a.gnis or a.name):
        print('give --near LON,LAT (fast) or --gnis / --name (slow full scan)')
        return 2

    con = sqlite3.connect('file:%s?mode=ro&immutable=1' % a.gpkg.replace('\\', '/'), uri=True)
    cur = con.cursor()

    # The column is `shape`, not `geom`. Read it rather than assume it.
    geomcol = {}
    try:
        cur.execute('SELECT table_name, column_name FROM gpkg_geometry_columns')
        geomcol = dict(cur.fetchall())
    except sqlite3.Error:
        pass

    LBL = {WB: 'WATERBODY (a polygon -- this is what a boundary can be built from)',
           FL: 'FLOWLINE (a line -- NO polygon, so nothing to clip against)'}
    out = {}

    if a.near:
        lon, lat = [float(v) for v in a.near.replace(' ', '').split(',')]
        x, y = albers(lon, lat)
        print('point %.6f,%.6f -> EPSG:6350 %.1f, %.1f   radius %.0f m' % (lon, lat, x, y, a.radius))
        for t in (WB, FL):
            g = geomcol.get(t, 'shape')
            where = ('fid IN (SELECT id FROM rtree_%s_%s WHERE maxx>=? AND minx<=? AND maxy>=? AND miny<=?)'
                     % (t, g))
            out[t] = _report(cur, t, LBL[t], where,
                             (x - a.radius, x + a.radius, y - a.radius, y + a.radius), a.limit)
    elif a.gnis:
        g = str(a.gnis).replace('gnis:', '').replace(',', '').strip()
        print('scanning 60 GB for gnisid=%s -- this takes minutes, --near is instant' % g, flush=True)
        for t in (WB, FL):
            out[t] = _report(cur, t, LBL[t], 'gnisid = ?', (int(g),), a.limit)
    else:
        print('scanning 60 GB for a name -- this takes minutes, --near is instant', flush=True)
        for t in (WB, FL):
            out[t] = _report(cur, t, LBL[t], 'lower(gnisidlabel) LIKE ?',
                             ('%%%s%%' % a.name.lower(),), a.limit)

    fl = out.get(FL) or []
    wb = out.get(WB) or []
    if fl and not wb:
        parents = sorted({r.get('waterbodyid3dhp') for r in fl if r.get('waterbodyid3dhp')})
        print('\nFLOWLINE ONLY -- no waterbody row came back. That is why there is no boundary: 3DHP has')
        print('no polygon here to clip against, and this pipeline assigns every contour by clipping')
        print('against a polygon. It is a real absence in the source, not a gap in our extraction.')
        if parents:
            print('The flowlines point at somebody else\'s polygon: %s' % ', '.join(parents))
            print('Look that id up with --near before assuming it is the right shape -- a river-area')
            print('polygon is drawn at channel width and will not cover a wide oxbow or backwater.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
