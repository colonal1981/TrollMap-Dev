#!/usr/bin/env python3
"""
boundary_gaps.py -- shipped packs that are missing an arm of their own lake.

    py .\\scripts\\boundary_gaps.py

WHAT THIS IS FOR

Two of the biggest lakes on the card are each missing a whole limb, and nothing in the app could
have said so. Measured 2026-08-11:

    hartwell_lake   boundary holds 34,068 charted acres
                    KCHBX is a further 19,849, 100% charted, 0% overlap
                    34,068 + 19,849 = 53,917  ->  that is Hartwell

    norris_lake     boundary holds 25,021 charted acres
                    LP20T is a further  8,966, 100% charted, 0% overlap
                    25,021 +  8,966 = 33,987  ->  that is Norris

Both missing pieces are UNNAMED in 3DHP. Ryan, looking at LP20T in the viewer: "the only labels i
see are powell river" -- and Norris is the Clinch and the Powell dammed at their confluence. 3DHP
names the FLOWLINE through the arm and leaves the impoundment polygon unnamed, so anything that
matched waterbodies by name took the piece called "Norris Lake" and silently dropped the piece the
Powell runs through. Hartwell is the same: two polygons named "Hartwell Lake", one unnamed.

That water is surveyed, it is sitting in the tiles, and it has never been clipped into a pack.

HOW IT DECIDES "ARM" RATHER THAN "DIFFERENT LAKE"

Adjacency on the cell grid, not distance between centroids. A candidate polygon whose cells sit
within `--gap` cells of a boundary's cells is continuous with that water -- an arm. One that is
isolated is its own lake, which is `missing_waterbodies.py`'s business, not this script's.

Centroid distance cannot make that call: Lake Robinson in Greer is 5.7 km from Lake Cunningham and
is a separate lake, while the Powell arm's centroid is 12.4 km from Norris's and is the same water.
Two touching cell sets are the same water however far apart their middles are.

READ-ONLY. It writes one report and changes nothing.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import glob
import importlib.util
import json
import math
import os
import sqlite3
import sys
import time
from collections import defaultdict

CELL = 0.002
ACRES_PER_CELL = 10.2


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _unhyphen(argv, flags=('--bbox',)):
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
    ap.add_argument('--boundaries', default=os.path.join('registry', 'boundaries'))
    ap.add_argument('--out', default=os.path.join('outputs', 'boundary_gaps.json'))
    ap.add_argument('--bbox', default='-85.8,30.2,-75.3,36.9')
    ap.add_argument('--min-acres', type=float, default=100.0,
                    help='ignore missing pieces smaller than this')
    ap.add_argument('--gap', type=int, default=2,
                    help='cells of separation still counted as touching (1 cell ~ 220 m)')
    a = ap.parse_args()

    L = _load(os.path.join(here, 'lookup_3dhp.py'), 'l3')
    B = _load(os.path.join(here, 'boundary_from_3dhp.py'), 'b3')
    S = _load(os.path.join(here, 'sweep_unclaimed.py'), 'sw')

    cover = set(tuple(c) for c in json.load(open(a.coverage))['cells'])
    rows = defaultdict(set)
    for ix, iy in cover:
        rows[iy].add(ix)
    print('Garmin cells: %d' % len(cover))

    # ── every boundary's charted cells, and which slug owns each ─────────────────────────────
    owner = {}
    per_slug = {}
    files = sorted(glob.glob(os.path.join(a.boundaries, '*.geojson')))
    t0 = time.time()
    for i, fp in enumerate(files):
        slug = os.path.basename(fp)[:-8]
        try:
            d = json.load(open(fp))
        except Exception:
            continue
        feats = d.get('features') if d.get('type') == 'FeatureCollection' else [d]
        cells = set()
        for f in (feats or []):
            for r in S.rings((f or {}).get('geometry') or {}):
                if len(r) >= 4:
                    S.fill_ring(r, rows, cells, cover)
        if not cells:
            continue
        per_slug[slug] = cells
        for c in cells:
            owner.setdefault(c, slug)
        if (i + 1) % 800 == 0:
            print('  %d/%d boundaries, %.0fs' % (i + 1, len(files), time.time() - t0), flush=True)
    claimed = set(owner)
    print('%d boundaries with charted water, %d cells claimed, %.0fs'
          % (len(per_slug), len(claimed), time.time() - t0))

    # ── unnamed, charted 3DHP lake polygons ──────────────────────────────────────────────────
    W, S_, E, N = [float(v) for v in a.bbox.split(',')]
    xs, ys = [], []
    for lon in (W, E):
        for lat in (S_, N):
            x, y = L.albers(lon, lat)
            xs.append(x)
            ys.append(y)
    con = sqlite3.connect('file:%s?mode=ro&immutable=1' % a.gpkg.replace('\\', '/'), uri=True)
    cur = con.cursor()
    print('querying 3DHP lake polygons ...', flush=True)
    cur.execute(
        'SELECT id3dhp, gnisidlabel, areasqkm, shape FROM hydro_3dhp_all_waterbody WHERE fid IN ('
        '  SELECT id FROM rtree_hydro_3dhp_all_waterbody_shape '
        '  WHERE maxx>=? AND minx<=? AND maxy>=? AND miny<=?) '
        'AND featuretype=3 AND areasqkm >= ?',
        (min(xs), max(xs), min(ys), max(ys), a.min_acres / 247.105))

    gaps = defaultdict(list)
    scanned = 0
    for id3, label, km2, blob in cur:
        scanned += 1
        try:
            parts, _ = B.wkb_rings(B.gpkg_wkb(blob))
        except Exception:
            continue
        cells = set()
        for r in [p for p in parts if len(p) >= 4]:
            S.fill_ring(r, rows, cells, cover)
        if not cells:
            continue
        outside = cells - claimed
        # Mostly already owned: this is water we have, not a gap.
        if len(outside) / len(cells) < 0.5:
            continue
        if len(outside) * ACRES_PER_CELL < a.min_acres:
            continue

        # WHICH pack does it touch? Walk a ring of `--gap` cells around the uncovered part and
        # see whose cells are there. Touching is the test; distance between centroids is not.
        votes = defaultdict(int)
        g = a.gap
        for (ix, iy) in outside:
            for dx in range(-g, g + 1):
                for dy in range(-g, g + 1):
                    s = owner.get((ix + dx, iy + dy))
                    if s:
                        votes[s] += 1
        if not votes:
            continue                            # isolated -> a missing LAKE, not a missing arm
        slug = max(votes, key=votes.get)
        gaps[slug].append({
            'id3dhp': id3,
            'name': label or '(unnamed in 3DHP)',
            'missing_acres': round(len(outside) * ACRES_PER_CELL),
            'polygon_acres': round((km2 or 0) * 247.105),
            'touching_cells': votes[slug],
        })

    out = []
    for slug, items in gaps.items():
        held = round(len(per_slug.get(slug, ())) * ACRES_PER_CELL)
        miss = sum(i['missing_acres'] for i in items)
        out.append({
            'slug': slug,
            'boundary_holds_acres': held,
            'missing_acres': miss,
            'missing_pct_of_true': round(100.0 * miss / max(held + miss, 1)),
            'pieces': sorted(items, key=lambda i: -i['missing_acres']),
        })
    out.sort(key=lambda r: -r['missing_acres'])
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    json.dump(out, open(a.out, 'w'), indent=1)

    print('\nscanned %d lake polygons; %d packs are missing water -> %s' % (scanned, len(out), a.out))
    print('\n%-34s %10s %10s %6s  %s' % ('PACK', 'HOLDS', 'MISSING', 'LOST', 'BIGGEST PIECE'))
    for r in out[:40]:
        p = r['pieces'][0]
        print('%-34s %9d %10d %5d%%  %s %d ac'
              % (r['slug'][:34], r['boundary_holds_acres'], r['missing_acres'],
                 r['missing_pct_of_true'], p['id3dhp'], p['missing_acres']))
    tot = sum(r['missing_acres'] for r in out)
    print('\n%d acres of surveyed water sit outside the boundary of a pack that should hold it.' % tot)
    print('Every one of these is already in the tiles. None of it has ever been in the app.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
