#!/usr/bin/env python3
"""
sweep_unclaimed.py -- Garmin bathymetry that belongs to no water we know about.

WHAT THIS ANSWERS

Ryan, 2026-08-11: "are there other lakes like robinson that weren't in the registry at all but
that garmin has bathymetry for? and how do we find those?"

Lake Robinson in Greer is 803 acres, Garmin surveyed it, and it was not in the registry at all --
because the registry is built from NAMED 3DHP waterbodies and 3DHP left that polygon unnamed. No
name search can find a water that has no name. But the bathymetry cannot hide: 00_START_HERE's
governing fact is that a contour can only be assigned by clipping against a polygon, so a contour
inside NO polygon is exactly the app's blind spot, and it is enumerable.

    every cell Garmin charted        (extract/_garmin_coverage.json -- contours + depth_areas only)
      minus every cell inside a known boundary
      = bathymetry with no water attached

CLAIM BY POLYGON, NOT BY BOUNDING BOX. A bbox pass found Robinson but lost Lake John D. Long and
Lake Cherokee, because Broad River's 5,166-acre bbox swallows both. A bbox over-claims, which
under-reports missing water -- safe, but it hides exactly the small water this is for.

WHY IT IS FAST NOW, AND WAS NOT

The first version ray-cast every candidate cell against every ring: O(cells x vertices). Ryan:
"the sweep is running and it is slow." It was. `congaree_river` is one ring of 19,782 vertices, and
a polygon that size covering a few thousand cells costs tens of millions of operations on its own.

This rasterises instead. For each cell ROW, every edge of the ring is crossed once, the crossings
are sorted, and the spans between pairs are filled -- O(rows x vertices), which on a big polygon is
hundreds of times less work. Measured on `congaree_river`, one ring of 19,782 vertices: 0.35 s
against a projected 26 s, ~75x. Lake Robinson still turns up 0.5 km from where Ryan put it.

WHERE IT DISAGREES WITH THE SLOW VERSION, AND WHY THAT IS ACCEPTABLE

Sampled against the ray-cast over five boundaries -- 1,250 cells, 1,247 agree, 99.76%. Every
disagreement is on a multi-ring water (Wateree has 55 rings, Murray 138) and has one cause: rings()
flattens Polygon and MultiPolygon into a plain list and LOSES which rings are outers and which are
HOLES. Each ring is filled independently and unioned, so an island inside a lake gets claimed as
water rather than subtracted from it.

That is a real defect and it is left in deliberately. It can only ever CLAIM cells, never release
them, so its effect is to under-report missing water -- this sweep says "here is water nobody
knows about" and the failure mode makes it say that less often, not more. A cell wrongly claimed
is a lake island we already own; a cell wrongly released would be a phantom lake sending someone
to build a pack for an island. If this is ever reused for something where the bias runs the other
way, fix the hole handling first.

    py .\\scripts\\sweep_unclaimed.py            # one pass, no chunking needed
    py .\\scripts\\sweep_unclaimed.py --report   # cluster and list

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import time
from collections import deque, defaultdict

CELL = 0.002                      # same grid the coverage cache uses
ACRES_PER_CELL = 10.2             # a 0.002 deg square at ~34 N


def rings(g):
    t = (g or {}).get('type')
    c = (g or {}).get('coordinates')
    if t == 'Polygon':
        return c or []
    if t == 'MultiPolygon':
        return [r for p in (c or []) for r in p]
    return []


def fill_ring(ring, want_rows, claimed, cover):
    """
    Scanline-rasterise one ring onto the cell grid, claiming only cells Garmin charted.

    `want_rows` maps a row index -> the set of column indices Garmin covers in that row. Rows with
    no coverage are skipped outright, which is most of them: a boundary's bbox is mostly land.
    """
    ys = [p[1] for p in ring]
    lo = int(math.floor(min(ys) / CELL))
    hi = int(math.ceil(max(ys) / CELL))
    n = len(ring)
    for iy in range(lo, hi + 1):
        cols = want_rows.get(iy)
        if not cols:
            continue
        y = iy * CELL + CELL / 2
        xs = []
        j = n - 1
        for i in range(n):
            yi = ring[i][1]
            yj = ring[j][1]
            if (yi > y) != (yj > y):
                xi = ring[i][0]
                xj = ring[j][0]
                xs.append(xi + (xj - xi) * (y - yi) / ((yj - yi) or 1e-15))
            j = i
        if not xs:
            continue
        xs.sort()
        # Even-odd: fill between consecutive pairs.
        for k in range(0, len(xs) - 1, 2):
            a = int(math.floor((xs[k] - CELL / 2) / CELL)) + 1
            b = int(math.floor((xs[k + 1] - CELL / 2) / CELL))
            if b < a:
                continue
            for ix in range(a, b + 1):
                if ix in cols:
                    claimed.add((ix, iy))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--coverage', default=os.path.join('extract', '_garmin_coverage.json'))
    ap.add_argument('--boundaries', default=os.path.join('registry', 'boundaries'))
    ap.add_argument('--claimed', default=os.path.join('_scratch', 'sweep_claimed.json'))
    ap.add_argument('--out', default=os.path.join('outputs', 'garmin_unclaimed.json'))
    ap.add_argument('--min-acres', type=float, default=40.0)
    ap.add_argument('--max-acres', type=float, default=20000.0)
    ap.add_argument('--index', default=os.path.join('registry', 'lake_index.json'))
    ap.add_argument('--near-km', type=float, default=25.0,
                    help='keep only clusters within this many km of a water in lake_index.json; '
                         '0 disables the filter')
    ap.add_argument('--report', action='store_true')
    a = ap.parse_args()

    cov = json.load(open(a.coverage))
    cover = set((p[0], p[1]) for p in cov['cells'])
    rows = defaultdict(set)
    for ix, iy in cover:
        rows[iy].add(ix)
    print('Garmin cells: %d across %d rows' % (len(cover), len(rows)))

    if not a.report:
        files = sorted(glob.glob(os.path.join(a.boundaries, '*.geojson')))
        if not files:
            print('no boundaries at %s' % a.boundaries)
            return 2
        claimed = set()
        t0 = time.time()
        for i, fp in enumerate(files):
            try:
                d = json.load(open(fp))
            except Exception:
                continue
            feats = d.get('features') if d.get('type') == 'FeatureCollection' else [d]
            for f in (feats or []):
                for r in rings((f or {}).get('geometry') or {}):
                    if len(r) >= 4:
                        fill_ring(r, rows, claimed, cover)
            if (i + 1) % 500 == 0:
                print('  %d/%d boundaries, %d cells claimed, %.0fs'
                      % (i + 1, len(files), len(claimed), time.time() - t0), flush=True)
        os.makedirs(os.path.dirname(a.claimed) or '.', exist_ok=True)
        json.dump([list(c) for c in claimed], open(a.claimed, 'w'))
        print('done in %.0fs -- %d of %d Garmin cells are inside a known boundary'
              % (time.time() - t0, len(claimed), len(cover)))
        print('now run with --report')
        return 0

    if not os.path.exists(a.claimed):
        print('no %s yet -- run without --report first' % a.claimed)
        return 2
    claimed = set(tuple(c) for c in json.load(open(a.claimed)))
    left = cover - claimed
    print('inside a known boundary: %d' % len(claimed))
    print('UNCLAIMED:               %d  (%.1f%%)' % (len(left), 100.0 * len(left) / max(len(cover), 1)))

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
                    nb = (x + dx, y + dy)
                    if nb in left and nb not in seen:
                        seen.add(nb)
                        q.append(nb)
        comps.append(comp)

    # ── KEEP ONLY WATER RYAN WOULD ACTUALLY DRIVE TO ──────────────────────────────────────────
    #
    # The first report came back 73.2% unclaimed across 22,092 clusters, and the biggest were
    # Jacksonville, Norfolk and two in Alabama. Nothing was wrong with the arithmetic: the Garmin
    # card spans lon -87.1..-75.2 and lat 30.3..36.8, `registry/lakes.json` carries 3,262 rows
    # across FIFTEEN states, and `registry/boundaries/` matches it -- but `lake_index.json`, which
    # is what the app offers, is the four states and 1,746 rows. So most of that 73% is real
    # unclaimed water that is simply not his.
    #
    # A per-state bounding box would be the obvious filter and a bad one: SC's box holds chunks of
    # Georgia and North Carolina, and the open Atlantic sits inside every coastal state's box.
    # Proximity to water the app already knows about is better on both counts -- a lake missing
    # from the registry sits among lakes that are in it, and the middle of the ocean does not.
    keep_near = None
    if a.near_km > 0 and os.path.exists(a.index):
        idx = json.load(open(a.index))
        recs = idx if isinstance(idx, list) else (idx.get('lakes') or list(idx.values()))
        pts = [r['centroid'] for r in recs
               if isinstance(r, dict) and isinstance(r.get('centroid'), list) and len(r['centroid']) == 2]
        # Bucket the known waters by ~0.25 deg so the test is a few dozen comparisons, not 1,746.
        B = 0.25
        grid = defaultdict(list)
        for lon, lat in pts:
            grid[(int(lon / B), int(lat / B))].append((lon, lat))
        span = int(a.near_km / 111.32 / B) + 1

        def near_known(lon, lat):
            gx, gy = int(lon / B), int(lat / B)
            for dx in range(-span, span + 1):
                for dy in range(-span, span + 1):
                    for px, py in grid.get((gx + dx, gy + dy), ()):
                        if math.hypot((px - lon) * math.cos(math.radians(lat)), py - lat) * 111.32 <= a.near_km:
                            return True
            return False
        keep_near = near_known
        print('filtering to within %.0f km of one of %d waters in %s' % (a.near_km, len(pts), a.index))

    out = []
    dropped_far = 0
    for c in comps:
        acres = len(c) * ACRES_PER_CELL
        if not (a.min_acres <= acres <= a.max_acres):
            continue
        xs = [p[0] for p in c]
        ys = [p[1] for p in c]
        if keep_near and not keep_near(sum(xs) / len(xs) * CELL, sum(ys) / len(ys) * CELL):
            dropped_far += 1
            continue
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
    print('\n%d clusters total, %d between %.0f and %.0f acres%s -> %s'
          % (len(comps), len(out), a.min_acres, a.max_acres,
             (', %d dropped as too far from any known water' % dropped_far) if dropped_far else '',
             a.out))
    print('\nthe 30 biggest — paste lon,lat into apps.nationalmap.gov/viewer:')
    for r in out[:30]:
        print('   %7d ac   %.6f, %.6f' % (r['acres'], r['lon'], r['lat']))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
