#!/usr/bin/env python3
"""
missing_waterbodies.py -- 3DHP polygons that have no registry boundary, and do have soundings.

    py .\\scripts\\missing_waterbodies.py                    # after sweep_unclaimed.py has run
    py .\\scripts\\missing_waterbodies.py --min-acres 100

WHY THIS AND NOT THE CELL SWEEP

`sweep_unclaimed.py` answers "where is there bathymetry inside no boundary" and it works -- it
found Lake Robinson 0.5 km from where Ryan put it. But as a WORK LIST it is unusable: 20,614
clusters, because every boundary leaves unclaimed fringe along its own edge (Robinson's rebuilt
boundary still leaves 92 acres of it), the Atlantic and Gulf are ~900,000 cells that 22 coastal
rectangles cannot claim, and a four-cell blob is trivially "compact" so shape does not separate
signal from noise. Tuning the thresholds just moves an arbitrary line around.

The three waters actually found today were all the same shape: a real 3DHP polygon with no
boundary file. So ask that instead. It needs no clustering, no fill ratio and no threshold beyond
a size floor, and the answer comes out as an `id3dhp` -- exactly what boundary_from_3dhp.py eats.

    every 3DHP waterbody polygon in the four states
      minus the ones a registry boundary already covers
      keeping only those with Garmin soundings inside them
      = water the app is blind to, with a stable id to build it from

THE BLIND SPOT IT IS FOR

The registry is built from NAMED 3DHP waterbodies. Lake Robinson in Greer is 803 acres, Garmin
surveyed 96% of it, and 3DHP left the polygon UNNAMED -- so no name search could ever reach it.
Lake John D. Long (ILUHQ) and Lake Cherokee (JL16I) are the same. This does not look at names at
all, which is the point.

REUSES THE WORK ALREADY DONE. `_scratch/sweep_claimed.json` is the set of Garmin cells inside a
known boundary, computed by sweep_unclaimed.py in ~80 s. Testing a polygon against that grid is
cheaper and simpler than polygon-against-3,262-polygons, and it is the same grid, so the two
scripts cannot disagree about what "already covered" means.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import sqlite3
import sys
from collections import defaultdict

CELL = 0.002


def _load(path, name):
    """Import a sibling script so the geometry code lives in exactly one place."""
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _unhyphen(argv, flags=('--bbox',)):
    """
    `--bbox -85.8,30.2,...` looks like a flag to argparse because it starts with a minus.

    Every western-hemisphere longitude does, so this fires on every real invocation and reports
    "expected one argument", which points nowhere near the cause. Same fix as lookup_3dhp.py --
    the `--flag=value` form is applied here rather than being something the caller must know. It
    was fixed there and not here, which is how a footgun survives being found.
    """
    out, i = [], 0
    while i < len(argv):
        if argv[i] in flags and i + 1 < len(argv) and argv[i + 1].startswith('-'):
            out.append('%s=%s' % (argv[i], argv[i + 1]))
            i += 2
            continue
        out.append(argv[i])
        i += 1
    return out


def main() -> int:
    sys.argv[1:] = _unhyphen(sys.argv[1:])
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument('--gpkg', default=os.path.join('3dhp_all_CONUS_20260112_GPKG',
                                                   '3dhp_all_CONUS_20260112_GPKG.gpkg'))
    ap.add_argument('--coverage', default=os.path.join('extract', '_garmin_coverage.json'))
    ap.add_argument('--claimed', default=os.path.join('_scratch', 'sweep_claimed.json'))
    ap.add_argument('--out', default=os.path.join('outputs', 'missing_waterbodies.json'))
    ap.add_argument('--bbox', default='-85.8,30.2,-75.3,36.9', help='W,S,E,N — the four states')
    ap.add_argument('--min-acres', type=float, default=40.0)
    ap.add_argument('--min-charted', type=float, default=0.25,
                    help='fraction of the polygon Garmin must have surveyed')
    a = ap.parse_args()

    for p in (a.gpkg, a.coverage, a.claimed):
        if not os.path.exists(p):
            print('missing %s' % p)
            if p == a.claimed:
                print('  -> run sweep_unclaimed.py first; this reuses its claimed-cell grid')
            return 2

    # Three siblings, each holding the piece it already owns, rather than a fourth copy here.
    # `albers` is the FORWARD projection and lives in lookup_3dhp.py; boundary_from_3dhp.py has
    # only the inverse (`to_wgs84`) because writing a boundary never needs to go the other way.
    L = _load(os.path.join(here, 'lookup_3dhp.py'), 'l3')
    B = _load(os.path.join(here, 'boundary_from_3dhp.py'), 'b3')
    S = _load(os.path.join(here, 'sweep_unclaimed.py'), 'sw')

    cover = set(tuple(c) for c in json.load(open(a.coverage))['cells'])
    claimed = set(tuple(c) for c in json.load(open(a.claimed)))
    rows_cover = defaultdict(set)
    for ix, iy in cover:
        rows_cover[iy].add(ix)
    print('Garmin cells %d, already inside a boundary %d' % (len(cover), len(claimed)))

    W, S_, E, N = [float(v) for v in a.bbox.split(',')]
    # The RTree is in EPSG:6350, so the query box is projected. Corners are enough: Albers is
    # conformal enough over this span that padding by the projection's own bow is unnecessary,
    # and an over-wide box only costs extra rows to filter.
    xs, ys = [], []
    for lon in (W, E):
        for lat in (S_, N):
            x, y = L.albers(lon, lat)
            xs.append(x)
            ys.append(y)
    con = sqlite3.connect('file:%s?mode=ro&immutable=1' % a.gpkg.replace('\\', '/'), uri=True)
    cur = con.cursor()
    min_km2 = a.min_acres / 247.105
    print('querying 3DHP waterbodies over %s, >= %.0f acres ...' % (a.bbox, a.min_acres), flush=True)
    cur.execute(
        'SELECT id3dhp, gnisid, gnisidlabel, featuretype, areasqkm, shape '
        'FROM hydro_3dhp_all_waterbody WHERE fid IN ('
        '  SELECT id FROM rtree_hydro_3dhp_all_waterbody_shape '
        '  WHERE maxx>=? AND minx<=? AND maxy>=? AND miny<=?) AND areasqkm >= ?',
        (min(xs), max(xs), min(ys), max(ys), min_km2))

    out = []
    seen = 0
    for id3, gnisid, label, ftype, km2, blob in cur:
        seen += 1
        try:
            parts, _ = B.wkb_rings(B.gpkg_wkb(blob))
        except Exception:
            continue
        parts = [p for p in parts if len(p) >= 4]
        if not parts:
            continue
        pxs = [q[0] for p in parts for q in p]
        pys = [q[1] for p in parts for q in p]
        if not (W <= sum(pxs) / len(pxs) <= E and S_ <= sum(pys) / len(pys) <= N):
            continue

        # Which cells this polygon occupies, and what is already known about them.
        cells = set()
        for r in parts:
            S.fill_ring(r, rows_cover, cells, cover)
        if not cells:
            continue                              # Garmin never surveyed it
        already = len(cells & claimed)
        charted = len(cells)
        # A polygon whose cells are mostly already claimed is water we have under some other
        # boundary — an arm of a lake we own, most often. Only report what is genuinely uncovered.
        if already / max(charted, 1) > 0.5:
            continue
        acres = (km2 or 0) * 247.105
        # `charted` counts only cells Garmin surveyed, so this is the surveyed FRACTION of the
        # polygon, which is the thing worth building a pack from.
        box_cells = max(1, int(((max(pxs) - min(pxs)) / CELL + 1) * ((max(pys) - min(pys)) / CELL + 1)))
        frac = charted / max(acres / 10.2, 1)
        if frac < a.min_charted:
            continue
        out.append({
            'id3dhp': id3,
            'name': label or '(unnamed in 3DHP)',
            'gnisid': gnisid,
            'acres': round(acres),
            'charted_cells': charted,
            'charted_frac': round(min(frac, 1.0), 2),
            'already_covered_frac': round(already / max(charted, 1), 2),
            'lon': round(sum(pxs) / len(pxs), 6),
            'lat': round(sum(pys) / len(pys), 6),
            'vertices': len(pxs),
        })

    out.sort(key=lambda r: -r['acres'])
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    json.dump(out, open(a.out, 'w'), indent=1)
    print('\nscanned %d polygons, %d have soundings and no boundary -> %s' % (seen, len(out), a.out))
    named = [r for r in out if r['gnisid']]
    print('   %d named in 3DHP, %d UNNAMED (the class the registry cannot see)'
          % (len(named), len(out) - len(named)))
    print('\nthe 30 biggest:')
    print('   %-8s %-30s %8s %7s   %s' % ('ID3DHP', 'NAME', 'ACRES', 'CHARTED', 'LON, LAT'))
    for r in out[:30]:
        print('   %-8s %-30s %8d %6.0f%%   %.6f, %.6f'
              % (r['id3dhp'], r['name'][:30], r['acres'], r['charted_frac'] * 100, r['lon'], r['lat']))
    print('\nbuild any of them with:')
    print('   py .\\scripts\\boundary_from_3dhp.py --id <ID3DHP> --slug <slug> --name "<name>" --state SC')
    return 0


if __name__ == '__main__':
    sys.exit(main())
