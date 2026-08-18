#!/usr/bin/env python3
"""
boundary_from_3dhp.py -- a registry boundary from a 3DHP id, with no name matching anywhere.

    py .\\scripts\\boundary_from_3dhp.py --id J7WR7 --slug lake_robinson_greer `
       --name "Lake Robinson (Greenville Co)" --state SC

WHY AN ID AND NOT A NAME

Ryan, 2026-08-11, having found a viewer whose identify tool actually works:

    > with the map i can actually give you an id that you can match instead of a name
    > like for lake greer you could use this for the extraction i would assume -- J7WR7

That is the whole fix for a class of missing water. The registry is built from NAMED 3DHP
waterbodies, so a polygon 3DHP left unnamed can never enter it, no matter how good the name
matching gets. Three of them turned up in one afternoon:

    J7WR7   803.7 ac   Lake Robinson, Greer   -- South Tyger River runs through it
    ILUHQ    68.1 ac   Lake John D. Long
    JL16I    51.4 ac   Lake Cherokee

All three have real geometry and no GNIS label. `id3dhp` is what the viewer shows when you click
the polygon, it is unique by construction, and it needs no fuzzy matching, no county tie-break and
no nearest-neighbour guess -- which is what put HB Robinson's coordinates on Prestwood Lake.

WHAT IT DOES NOT DO

It writes ONE boundary. It does not touch `lake_index.json`, build a pack, or upload anything --
those are the next steps in the runbook and each one wants its own look. `--dry-run` prints the
vertex count and bounds without writing.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import struct
import sys

# ── EPSG:6350, NAD83(2011) / Conus Albers — the CRS 3DHP geometry is stored in ────────────────
_A = 6378137.0
_F = 1 / 298.257222101
_E2 = 2 * _F - _F * _F
_E = math.sqrt(_E2)


def _q(p):
    s = math.sin(p)
    return (1 - _E2) * (s / (1 - _E2 * s * s) - (1 / (2 * _E)) * math.log((1 - _E * s) / (1 + _E * s)))


def _m(p):
    s = math.sin(p)
    return math.cos(p) / math.sqrt(1 - _E2 * s * s)


_P1, _P2, _P0 = map(math.radians, (29.5, 45.5, 23.0))
_L0 = math.radians(-96.0)
_N = (_m(_P1) ** 2 - _m(_P2) ** 2) / (_q(_P2) - _q(_P1))
_C = _m(_P1) ** 2 + _N * _q(_P1)
_RHO0 = _A * math.sqrt(_C - _N * _q(_P0)) / _N


def to_wgs84(x, y):
    """EPSG:6350 metres -> (lon, lat). Snyder's iterative inverse; converges in a few passes."""
    rho = math.hypot(x, _RHO0 - y)
    th = math.atan2(x, _RHO0 - y)
    q = (_C - (rho * rho * _N * _N) / (_A * _A)) / _N
    p = math.asin(max(-0.999999, min(0.999999, q / 2)))
    for _ in range(12):
        s = math.sin(p)
        den = 1 - _E2 * s * s
        c = math.cos(p)
        if abs(c) < 1e-12:
            break
        p += (den * den / (2 * c)) * (q / (1 - _E2) - s / den
                                      + (1 / (2 * _E)) * math.log((1 - _E * s) / (1 + _E * s)))
        if not (-1.6 < p < 1.6):
            p = max(-1.5707, min(1.5707, p))
            break
    return math.degrees(_L0 + th / _N), math.degrees(p)


# ── GeoPackage geometry ───────────────────────────────────────────────────────────────────────
def gpkg_wkb(blob):
    """Strip the GeoPackage binary header and hand back plain WKB."""
    flags = blob[3]
    env = (flags >> 1) & 0x07
    return blob[8 + {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[env]:]


def wkb_polygons(b, off=0):
    """
    WKB -> [[outer, hole, hole, ...], ...] in lon/lat, RINGS GROUPED BY POLYGON.

    THE GROUPING IS THE POINT AND LOSING IT IS SILENT. WKB already says which rings are holes:
    inside a Polygon, ring 0 is the outer boundary and every ring after it is a hole. The
    previous reader returned one flat list and the boundary writer turned each ring into its own
    outer ring, so every ISLAND BECAME WATER. On a lake with no islands that is invisible, which
    is why it survived from Lake Robinson until the Cooper: 221 rings, 220 of them nested,
    written as 28,742 acres of solid water against 3DHP's 17,071. Subtracting the islands gives
    17,104 -- 0.2% from the source -- so the rings were always right and only the nesting was
    thrown away.

    THE DIMENSION MATTERS AND GETTING IT WRONG IS SILENT. 3DHP is 3D hydrography, so geometry
    carries Z and the type code is 1000+. Reading two doubles per point out of a stream that holds
    three walks the offset off the end of every ring and produces coordinates in the Indian Ocean
    without raising anything. Cost an hour on the Bates lookup.
    """
    order = '<' if b[off] == 1 else '>'
    off += 1
    raw = struct.unpack_from(order + 'I', b, off)[0]
    off += 4
    t = raw % 1000
    dim = 2 + (1 if 1000 <= raw < 3000 else 0) + (1 if raw >= 2000 else 0)
    step = 8 * dim
    fmt = order + 'd' * dim
    out = []

    def ring(off):
        (npt,) = struct.unpack_from(order + 'I', b, off)
        off += 4
        pts = []
        for _ in range(npt):
            v = struct.unpack_from(fmt, b, off)
            off += step
            pts.append(to_wgs84(v[0], v[1]))
        return pts, off

    if t == 3:                                   # Polygon: ring 0 outer, the rest are holes
        (nr,) = struct.unpack_from(order + 'I', b, off)
        off += 4
        rings = []
        for _ in range(nr):
            r, off = ring(off)
            rings.append(r)
        if rings:
            out.append(rings)
    elif t in (4, 5, 6, 7):                      # Multi* / GeometryCollection
        (ng,) = struct.unpack_from(order + 'I', b, off)
        off += 4
        for _ in range(ng):
            g, off = wkb_polygons(b, off)
            out += g
    elif t == 2:                                 # LineString -- no hierarchy to keep
        r, off = ring(off)
        out.append([r])
    return out, off


def wkb_rings(b, off=0):
    """Every ring, flat, hierarchy discarded.

    KEPT ON PURPOSE. missing_waterbodies.py reads this to count vertices and test cell coverage,
    and for that a hole and an outer ring are the same thing. A BOUNDARY is the caller that
    cannot use it, so the boundary writer takes wkb_polygons() instead. One reader, two views.
    """
    polys, off = wkb_polygons(b, off)
    return [r for p in polys for r in p], off


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--gpkg', default=os.path.join('3dhp_all_CONUS_20260112_GPKG',
                                                   '3dhp_all_CONUS_20260112_GPKG.gpkg'))
    ap.add_argument('--id', required=True, help='id3dhp, e.g. J7WR7 — what the viewer shows')
    ap.add_argument('--slug', help='registry slug; defaults to the id lowercased')
    ap.add_argument('--name', help='display name for the properties block')
    ap.add_argument('--state', default=None)
    ap.add_argument('--out-dir', default=os.path.join('registry', 'boundaries'))
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()

    if not os.path.exists(a.gpkg):
        print('no gpkg at %s' % a.gpkg)
        return 2

    con = sqlite3.connect('file:%s?mode=ro&immutable=1' % a.gpkg.replace('\\', '/'), uri=True)
    cur = con.cursor()
    try:
        cur.execute('SELECT column_name FROM gpkg_geometry_columns WHERE table_name=?',
                    ('hydro_3dhp_all_waterbody',))
        row = cur.fetchone()
        geom = row[0] if row else 'shape'         # `shape`, NOT `geom` — assuming otherwise cost a query
    except sqlite3.Error:
        geom = 'shape'

    # id3dhp is not indexed, so this is a scan — minutes on 60 GB. It runs once per water and the
    # alternative is asking the caller for a bounding box they do not have.
    print('looking up %s (a full scan; this takes a few minutes)...' % a.id, flush=True)
    cur.execute('SELECT id3dhp, gnisid, gnisidlabel, featuretype, areasqkm, %s '
                'FROM hydro_3dhp_all_waterbody WHERE id3dhp = ?' % geom, (a.id,))
    rows = cur.fetchall()
    # CLOSED HERE, not left to interpreter exit. fetchall has already materialised everything
    # including the geometry blob, so nothing below needs the connection -- and on Windows an
    # open handle means the file cannot be deleted or moved by anyone else. The end-to-end test
    # caught this the first time it ran on Ryan's machine: every assertion passed and then
    # TemporaryDirectory could not clean up its own fixture. Harmless against a 60 GB read-only
    # GeoPackage the process is about to exit from; not harmless as a habit.
    con.close()
    if not rows:
        print('no waterbody with id3dhp = %s' % a.id)
        print('check it is a WATERBODY id and not a flowline id — a flowline has no polygon at all,')
        print('which is the whole reason Bates Old River cannot have a boundary.')
        return 1
    if len(rows) > 1:
        print('!! %d rows share that id — taking the largest' % len(rows))
        rows.sort(key=lambda r: -(r[4] or 0))

    r = rows[0]
    # wkb_polygons, NOT wkb_rings: a boundary that flattens the hierarchy charts its own islands.
    polys, _ = wkb_polygons(gpkg_wkb(r[5]))
    polys = [[ring for ring in p if len(ring) >= 4] for p in polys]
    polys = [p for p in polys if p]
    if not polys:
        print('the row has no usable ring')
        return 1
    parts = [ring for p in polys for ring in p]
    holes = sum(len(p) - 1 for p in polys)

    xs = [q[0] for p in parts for q in p]
    ys = [q[1] for p in parts for q in p]
    acres = (r[4] or 0) * 247.105
    print('\n  id3dhp      %s' % r[0])
    print('  name        %s' % (r[2] or '(unnamed in 3DHP)'))
    print('  gnisid      %s' % r[1])
    print('  area        %.1f acres' % acres)
    print('  polygons    %d, with %d hole(s)' % (len(polys), holes))
    print('  rings       %d, %d vertices' % (len(parts), len(xs)))
    print('  bounds      %.6f, %.6f  ..  %.6f, %.6f' % (min(xs), min(ys), max(xs), max(ys)))
    print('  centre      %.6f, %.6f' % (sum(xs) / len(xs), sum(ys) / len(ys)))

    slug = a.slug or a.id.lower()
    fc = {
        'type': 'FeatureCollection',
        'features': [{
            'type': 'Feature',
            'properties': {
                'slug': slug,
                'name': a.name or r[2] or slug,
                'state': a.state,
                'source': '3dhp:%s' % r[0],
                'gnis': ('gnis:%s' % r[1]) if r[1] else None,
                'area_acres': round(acres, 1),
            },
            # Each entry of `polys` is already [outer, hole, hole, ...] -- exactly the shape
            # GeoJSON wants. The old form was [[p] for p in parts], which promoted every hole
            # to an outer ring and charted 11,637 acres of Cooper River islands as water.
            'geometry': ({'type': 'Polygon', 'coordinates': polys[0]} if len(polys) == 1
                         else {'type': 'MultiPolygon', 'coordinates': polys}),
        }],
    }

    if a.dry_run:
        print('\n--dry-run: nothing written')
        return 0
    os.makedirs(a.out_dir, exist_ok=True)
    dest = os.path.join(a.out_dir, '%s.geojson' % slug)
    if os.path.exists(dest):
        print('\n!! %s already exists — refusing to overwrite. Move it aside first.' % dest)
        return 1
    json.dump(fc, open(dest, 'w'))
    print('\nwrote %s' % dest)
    print('\nNEXT, and each wants its own look:')
    print('  1. add the row to registry/lakes.json and registry/tile_lake_map.json')
    print('     -- tile_lake_map is a HARD GATE; a slug missing from by_lake silently never builds')
    print('  2. build_all_chartpacks.py for this slug')
    print('  3. structure -> graphs -> runs -> features, in that order')
    print('  4. consolidate_lake_index.py, then upload')
    return 0


if __name__ == '__main__':
    sys.exit(main())
