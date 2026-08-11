#!/usr/bin/env python3
"""
sweep_unclaimed.py -- Garmin bathymetry that belongs to no water we know about.

WHAT THIS ANSWERS

Ryan, 2026-08-11: "are there other lakes like robinson that weren't in the registry at all but
that garmin has bathymetry for? and how do we find those?"

Lake Robinson in Greer is 803 acres, Garmin surveyed it, and it is not in the registry at all --
because the registry is built from NAMED 3DHP waterbodies and 3DHP left that polygon unnamed. No
name search can find a water that has no name. But the bathymetry is right there in the extract,
and it is the one thing that cannot be missing: 00_START_HERE's governing fact is that a contour
can only be assigned by clipping against a polygon, so a contour inside NO polygon is exactly the
app's blind spot, and it is enumerable.

    every cell Garmin charted        (extract/_garmin_coverage.json -- contours + depth_areas only)
      minus every cell inside a known boundary
      = bathymetry with no water attached

CLAIM BY POLYGON, NOT BY BOUNDING BOX. The first pass used bboxes and found Robinson but lost
Lake John D. Long and Lake Cherokee, because Broad River's 5,166-acre bbox swallows both. A bbox
over-claims, which under-reports missing water -- safe, but it hides exactly the small water this
is for.

IT RUNS IN CHUNKS because a `device_bash` call is capped at 45 s and just READING the 3,262
boundary files takes 38 s. State is a JSON file; run it until it says done.

    py .\\scripts\\sweep_unclaimed.py --seconds 35        # repeat until "COMPLETE"
    py .\\scripts\\sweep_unclaimed.py --report            # once complete

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import time
from collections import deque

CELL = 0.002                      # same grid the coverage cache uses
ACRES_PER_CELL = 10.2             # 0.002 deg square at ~34 N


def rings(g):
    t = (g or {}).get('type')
    c = (g or {}).get('coordinates')
    if t == 'Polygon':
        return c or []
    if t == 'MultiPolygon':
        return [r for p in (c or []) for r in p]
    return []


def inside(x, y, ring):
    """Ray cast. Rings here are boundary polygons, already closed."""
    n = len(ring)
    ins = False
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-15) + xi):
            ins = not ins
        j = i
    return ins


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--coverage', default=os.path.join('extract', '_garmin_coverage.json'))
    ap.add_argument('--boundaries', default=os.path.join('registry', 'boundaries'))
    ap.add_argument('--state', default=os.path.join('_scratch', 'sweep_state.json'))
    ap.add_argument('--out', default=os.path.join('outputs', 'garmin_unclaimed.json'))
    ap.add_argument('--seconds', type=float, default=35.0)
    ap.add_argument('--min-acres', type=float, default=40.0)
    ap.add_argument('--max-acres', type=float, default=20000.0)
    ap.add_argument('--report', action='store_true')
    a = ap.parse_args()

    files = sorted(glob.glob(os.path.join(a.boundaries, '*.geojson')))
    if not files:
        print('no boundaries at %s' % a.boundaries)
        return 2

    st = {'i': 0, 'claimed': []}
    if os.path.exists(a.state):
        st = json.load(open(a.state))

    cov = json.load(open(a.coverage))
    # ONLY cells Garmin charted are ever tested. A boundary's bbox holds thousands of cells and
    # almost none of them carry bathymetry, so testing the intersection instead of the footprint
    # is what makes this finish at all.
    cover = set((p[0], p[1]) for p in cov['cells'])
    claimed = set(tuple(c) for c in st['claimed'])

    if not a.report:
        t0 = time.time()
        i = st['i']
        while i < len(files) and time.time() - t0 < a.seconds:
            try:
                d = json.load(open(files[i]))
            except Exception:
                i += 1
                continue
            feats = d.get('features') if d.get('type') == 'FeatureCollection' else [d]
            for f in (feats or []):
                for r in rings((f or {}).get('geometry') or {}):
                    if len(r) < 4:
                        continue
                    xs = [p[0] for p in r]
                    ys = [p[1] for p in r]
                    for ix in range(int(math.floor(min(xs) / CELL)), int(math.ceil(max(xs) / CELL)) + 1):
                        for iy in range(int(math.floor(min(ys) / CELL)), int(math.ceil(max(ys) / CELL)) + 1):
                            k = (ix, iy)
                            if k not in cover or k in claimed:
                                continue
                            if inside(ix * CELL + CELL / 2, iy * CELL + CELL / 2, r):
                                claimed.add(k)
            i += 1
        os.makedirs(os.path.dirname(a.state) or '.', exist_ok=True)
        json.dump({'i': i, 'claimed': [list(c) for c in claimed]}, open(a.state, 'w'))
        pct = 100.0 * i / len(files)
        print('%d of %d boundaries (%.1f%%), %d covered cells claimed'
              % (i, len(files), pct, len(claimed)))
        if i < len(files):
            print('NOT DONE -- run it again')
            return 0
        print('COMPLETE -- run with --report')
        return 0

    left = cover - claimed
    print('Garmin cells:            %d' % len(cover))
    print('inside a known boundary: %d' % len(claimed))
    print('UNCLAIMED:               %d  (%.1f%%)' % (len(left), 100.0 * len(left) / max(len(cover), 1)))

    # Connected components, 8-way. Each is one candidate water.
    seen = set()
    comps = []
    for c in left:
        if c in seen:
            continue
        q = deque([c])
        seen.add(c)
        comp = []
        while q:
            x, y = q.popleft()
            comp.append((x, y))
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    n = (x + dx, y + dy)
                    if n in left and n not in seen:
                        seen.add(n)
                        q.append(n)
        comps.append(comp)

    out = []
    for c in comps:
        acres = len(c) * ACRES_PER_CELL
        if not (a.min_acres <= acres <= a.max_acres):
            continue
        xs = [p[0] for p in c]
        ys = [p[1] for p in c]
        out.append({
            'acres': round(acres),
            'lon': round(sum(xs) / len(xs) * CELL, 6),
            'lat': round(sum(ys) / len(ys) * CELL, 6),
            'bbox': [round(min(xs) * CELL, 6), round(min(ys) * CELL, 6),
                     round(max(xs) * CELL, 6), round(max(ys) * CELL, 6)],
            'cells': len(c),
        })
    out.sort(key=lambda r: -r['acres'])
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    json.dump(out, open(a.out, 'w'), indent=1)
    print('\n%d candidate waters between %.0f and %.0f acres -> %s'
          % (len(out), a.min_acres, a.max_acres, a.out))
    print('\nthe 25 biggest — paste lon,lat into apps.nationalmap.gov/viewer:')
    for r in out[:25]:
        print('   %7d ac   %.6f, %.6f' % (r['acres'], r['lon'], r['lat']))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
