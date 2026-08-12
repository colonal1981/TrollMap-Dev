#!/usr/bin/env python3
r"""attach_arms.py -- give a pack back the limb of its own lake that nobody ever clipped in.

    py .\scripts\attach_arms.py                 # dry run, changes nothing
    py .\scripts\attach_arms.py --go            # write, after backing every original up
    py .\scripts\attach_arms.py --slug hartwell_lake --slug norris_lake --go

WHAT THIS IS FOR

Ryan, 2026-08-12: *"we need to fix the disjointed lakes... recut their full boundaries with the
missing pieces attached."*

`boundary_gaps.py` found 28 shipped packs in region that are each missing a limb of their own
water -- **45,959 acres across 36 polygons**, all of it surveyed by Garmin and none of it ever
clipped into a pack:

    hartwell_lake         holds 34,068 ac   +19,849 (KCHBX)   -> 53,917, which is Hartwell
    norris_lake           holds 25,021 ac   + 8,987 (LP20T)   -> 34,008, which is Norris
    coast_bogue_sound_nc  holds 61,873 ac   + 4,690 (LWR1L)
    lake_worth            holds    204 ac   +   617 (JYRH9)   <- 75% of that lake was missing
    selman_lakes          holds    163 ac   +   598 (KHK52, M92ZX)

The cause is the unnamed-polygon blind spot: 3DHP names the FLOWLINE through an arm and leaves
the impoundment polygon unnamed, so a registry built by name took the piece labelled "Norris
Lake" and silently dropped the piece the Powell runs through. Garmin's own 5/1 labels inside
these arms read *Clinch River*, *Big Creek*, *River Bed - Tugaloo River*.

WHY THIS IS AN ATTACH AND NOT A UNION

`boundary_gaps.py` only proposes a piece whose cells are **less than 50% already covered**, and
the two big ones measure **0% overlap**. Disjoint polygons do not need a geometric union -- they
need to become parts of one MultiPolygon, which is exactly what the clip already handles for the
7 packs here that are MultiPolygon today. So this needs no shapely, no buffering and no
tolerance, and it cannot round a shoreline it was only meant to extend.

**The overlap is re-measured HERE anyway, per piece, before anything is written.** `boundary_gaps`
ran on 2026-08-11 and boundaries have moved since. Attaching a piece that is already inside the
boundary would duplicate that water in every downstream layer, and duplicated geometry is far
harder to notice than missing geometry. `--max-overlap` refuses above 20%.

AFTERWARDS, THE PACK MUST BE REBUILT

A boundary change invalidates the clip. Every pack touched here needs `build_all_chartpacks.py`
re-run over it, and `build_water_graphs.py` too -- it reads boundaries, and 00_START_HERE is
explicit that a boundary change invalidates the graph even though a contour re-cut does not.
The list of slugs to rebuild is printed at the end and written to
`outputs/arms_attached.tsv`.

Originals are copied to `registry/boundaries/_before_arms/<slug>.geojson` before the first
write. Not `.bak` beside the file: `registry/boundaries/*.geojson` is globbed by half a dozen
scripts and a `hartwell_lake.geojson.bak` would be skipped by the glob, while a stray
`hartwell_lake_bak.geojson` would be read as a lake.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import math
import os
import shutil
import sqlite3
import sys

REGION = {'SC', 'NC', 'GA', 'TN'}
CELL = 0.002


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def rings_of(g):
    t = (g or {}).get('type')
    c = (g or {}).get('coordinates')
    if t == 'Polygon':
        return [c or []]
    if t == 'MultiPolygon':
        return list(c or [])
    return []


def cells(parts, cover=None):
    """Rasterise to the 0.002-deg grid. Used only to measure overlap between two boundaries,
    so it does not need to be exact -- it needs to be the SAME approximation on both sides."""
    out = set()
    for poly in parts:
        for r in poly[:1]:                       # outer ring only; holes cannot add coverage
            if len(r) < 4:
                continue
            ys = [p[1] for p in r]
            lo = int(math.floor(min(ys) / CELL))
            hi = int(math.ceil(max(ys) / CELL))
            n = len(r)
            for iy in range(lo, hi + 1):
                y = iy * CELL + CELL / 2
                xs = []
                j = n - 1
                for i in range(n):
                    yi, yj = r[i][1], r[j][1]
                    if (yi > y) != (yj > y):
                        xi, xj = r[i][0], r[j][0]
                        xs.append(xi + (xj - xi) * (y - yi) / ((yj - yi) or 1e-15))
                    j = i
                xs.sort()
                for k in range(0, len(xs) - 1, 2):
                    a = int(math.floor((xs[k] - CELL / 2) / CELL)) + 1
                    b = int(math.floor((xs[k + 1] - CELL / 2) / CELL))
                    for ix in range(a, b + 1):
                        out.add((ix, iy))
    return out


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--worklist', default=os.path.join('outputs', 'unnamed_water_worklist.tsv'))
    ap.add_argument('--gpkg', default=os.path.join('3dhp_all_CONUS_20260112_GPKG',
                                                   '3dhp_all_CONUS_20260112_GPKG.gpkg'))
    ap.add_argument('--boundaries', default=os.path.join('registry', 'boundaries'))
    ap.add_argument('--slug', action='append', default=[], help='only these packs; repeatable')
    ap.add_argument('--max-overlap', type=float, default=0.20,
                    help='refuse a piece already this covered by the boundary')
    ap.add_argument('--pad-km', type=float, default=1.0)
    ap.add_argument('--go', action='store_true', help='write. Default is a dry run.')
    a = ap.parse_args()

    B = _load(os.path.join(here, 'boundary_from_3dhp.py'), 'b3')
    L = _load(os.path.join(here, 'lookup_3dhp.py'), 'l3')

    want = set(a.slug)
    by = {}
    for r in csv.DictReader(open(a.worklist, encoding='utf-8'), delimiter='\t'):
        if not (r.get('kind') or '').startswith('ARM') or r.get('state') not in REGION:
            continue
        slug = r['kind'][7:].strip()
        if want and slug not in want:
            continue
        by.setdefault(slug, []).append(r)

    print('%d pack(s) to repair, %d piece(s), %s acres\n'
          % (len(by), sum(len(v) for v in by.values()),
             format(sum(int(x['acres']) for v in by.values() for x in v), ',')))

    con = sqlite3.connect('file:%s?mode=ro&immutable=1' % a.gpkg.replace('\\', '/'), uri=True)
    cur = con.cursor()
    try:
        cur.execute('SELECT column_name FROM gpkg_geometry_columns WHERE table_name=?',
                    ('hydro_3dhp_all_waterbody',))
        row = cur.fetchone()
        geom = row[0] if row else 'shape'
    except sqlite3.Error:
        geom = 'shape'

    bak = os.path.join(a.boundaries, '_before_arms')
    done, refused, changed = [], [], []
    for slug in sorted(by, key=lambda s: -sum(int(x['acres']) for x in by[s])):
        fp = os.path.join(a.boundaries, slug + '.geojson')
        if not os.path.exists(fp):
            print('%-30s NO BOUNDARY at %s' % (slug[:30], fp))
            continue
        doc = json.load(open(fp, encoding='utf-8'))
        feats = doc.get('features') if doc.get('type') == 'FeatureCollection' else [doc]
        base = []
        for f in (feats or []):
            base.extend(rings_of((f or {}).get('geometry') or {}))
        if not base:
            print('%-30s boundary has no usable polygon' % slug[:30])
            continue
        have = cells(base)

        add, notes = [], []
        for r in by[slug]:
            rid, lon, lat = r['id3dhp'], float(r['lon']), float(r['lat'])
            d = a.pad_km / 111.32
            pts = [L.albers(lon + dx, lat + dy) for dx in (-d, d) for dy in (-d, d)]
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            cur.execute(
                'SELECT id3dhp, areasqkm, %s FROM hydro_3dhp_all_waterbody WHERE fid IN ('
                ' SELECT id FROM rtree_hydro_3dhp_all_waterbody_shape '
                ' WHERE maxx>=? AND minx<=? AND maxy>=? AND miny<=?)' % geom,
                (min(xs), max(xs), min(ys), max(ys)))
            hit = None
            for row in cur:
                if row[0] == rid:
                    hit = row
                    break
            if hit is None:
                notes.append('%s MISS (no RTree hit)' % rid)
                continue
            parts, _ = B.wkb_rings(B.gpkg_wkb(hit[2]))
            parts = [p for p in parts if len(p) >= 4]
            if not parts:
                notes.append('%s no ring' % rid)
                continue
            pc = cells([[p] for p in parts])
            ov = len(pc & have) / max(len(pc), 1)
            if ov > a.max_overlap:
                notes.append('%s REFUSED, %.0f%% already inside' % (rid, ov * 100))
                refused.append((slug, rid, round(ov * 100)))
                continue
            add.extend([[p] for p in parts])
            notes.append('%s +%s ac, %.0f%% overlap' % (rid, format(int(r['acres']), ','), ov * 100))

        print('%-30s %d part(s) -> %d   %s'
              % (slug[:30], len(base), len(base) + len(add), '; '.join(notes)))
        if not add:
            continue
        done.append((slug, len(add), sum(int(x['acres']) for x in by[slug])))
        changed.append(slug)
        if a.go:
            os.makedirs(bak, exist_ok=True)
            bfp = os.path.join(bak, slug + '.geojson')
            if not os.path.exists(bfp):
                shutil.copy2(fp, bfp)
            props = ((feats[0] or {}).get('properties') or {}) if feats else {}
            props = dict(props)
            props['arms_attached'] = [x['id3dhp'] for x in by[slug]]
            json.dump({'type': 'FeatureCollection', 'features': [{
                'type': 'Feature', 'properties': props,
                'geometry': {'type': 'MultiPolygon', 'coordinates': base + add}}]},
                open(fp, 'w', encoding='utf-8'))

    print('\n%s%d boundaries would gain a limb, %d piece(s) refused as already covered'
          % ('' if a.go else '[DRY RUN] ', len(done), len(refused)))
    if a.go and changed:
        os.makedirs('outputs', exist_ok=True)
        with open(os.path.join('outputs', 'arms_attached.tsv'), 'w', encoding='utf-8') as fh:
            fh.write('slug\tparts_added\tacres_gained\n')
            for s, n, ac in done:
                fh.write('%s\t%d\t%d\n' % (s, n, ac))
        print('originals -> %s' % bak)
        print('-> outputs/arms_attached.tsv')
    if changed:
        print('\nA BOUNDARY CHANGE INVALIDATES THE CLIP AND THE WATER GRAPH. Rebuild these:')
        print('   --only-lakes "%s"' % ','.join(changed[:6])
              + (' ... %d more' % (len(changed) - 6) if len(changed) > 6 else ''))
        print('   build_all_chartpacks.py AND build_water_graphs.py -- the graph reads')
        print('   boundaries, so a boundary move severs or reconnects it. A contour re-cut')
        print('   alone does not, which is why this is easy to forget.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
