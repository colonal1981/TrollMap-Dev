#!/usr/bin/env python3
r"""test_the_ramp_reaches_the_river.py -- can he launch, and get to the river, without leaving
the pack he selected?

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\test_the_ramp_reaches_the_river.py
    py .\scripts\test_the_ramp_reaches_the_river.py --chartpack F:\TrollMapPipeline\chartpack

WHAT THIS IS FOR

Ryan, 2026-09-21, after a week of fixes that were all about something else: *"what i asked for was
the ability to plan a river run from packs landing to the river... which means a fishable route
from the landing into and up the river using the congaree selector on the map and in the plan
tab... i still cannot do that with what is in R2"*.

He was right, and nothing in the tree could have told him so. Every check this project had asked
whether a pack was built, not whether you could get anywhere in it. Measured that day against
chartpack/congaree_river as shipped:

    Pack's Landing -> nearest water in the pack    1,093 m
    and that nearest water                         a 2-acre orphan joined to nothing
    the canal that actually reaches the mainstem   1,313 m, of which the pack owned 1 cell in 48

After extend_river_boundary.py --from-landings and a rebuild, same measurement:

    Pack's Landing -> nearest water in the pack           30 m
    ramp to Bates Bridge, one connected piece of water    24,469 m  (15.2 mi)

THE TEST IS A FLOOD FILL OVER THE PACK'S OWN depth_areas, not over the extract and not over the
boundary. What the app draws and plans on is the pack, so the pack is what gets asked. A landing
and a far point are named per water; the water between them has to be ONE component.

NOT THE WATER GRAPH, for the same reason build_ramp_reach.trace() does not use it: Marion's graph
has the canal's two ends in its main component with no through-channel between them, and would
answer 14,712 m around the lake to a question about 1,801 m of canal.
"""
import argparse
import json
import math
import os
import sys
from collections import deque

CELL_M = 30.0

# (slug, launch, launch lat/lon, far point, far lat/lon). The far point is water he would actually
# run to, named rather than derived, because "the biggest component" is the answer a broken pack
# gives too.
CASES = [
    ('congaree_river', "Pack's Landing", 33.6592487, -80.5150928, 'Bates Bridge', 33.753417, -80.645129),
    ('congaree_river', 'Low Falls', 33.632389, -80.543511, 'Bates Bridge', 33.753417, -80.645129),
]


def mask_for(path, w, s, e, n, cell):
    import numpy as np
    import shapely
    from shapely.geometry import shape, box
    from shapely.validation import make_valid
    mlat = 111320.0
    mlon = 111320.0 * math.cos(math.radians((s + n) / 2))
    nx = int((e - w) * mlon / cell); ny = int((n - s) * mlat / cell)
    xs = w + (np.arange(nx) + 0.5) * cell / mlon
    ys = s + (np.arange(ny) + 0.5) * cell / mlat
    win = box(w, s, e, n)
    m = np.zeros((ny, nx), dtype=bool)
    with open(path, encoding='utf-8') as fh:
        d = json.load(fh)
    for f in (d.get('features') or []):
        try:
            g = shape(f['geometry'])
        except Exception:
            continue
        if g.is_empty or not g.intersects(win):
            continue
        if not g.is_valid:
            g = make_valid(g)
        x0, y0, x1, y1 = g.bounds
        i0 = max(0, int((x0 - w) * mlon / cell) - 1); i1 = min(nx, int((x1 - w) * mlon / cell) + 2)
        j0 = max(0, int((y0 - s) * mlat / cell) - 1); j1 = min(ny, int((y1 - s) * mlat / cell) + 2)
        if i1 <= i0 or j1 <= j0:
            continue
        xx, yy = np.meshgrid(xs[i0:i1], ys[j0:j1])
        m[j0:j1, i0:i1] |= shapely.contains_xy(g, xx, yy)
    return m, xs, ys, mlon, mlat


def run(pack_dir, slug, a_name, a_lat, a_lon, b_name, b_lat, b_lon, cell):
    import numpy as np
    p = os.path.join(pack_dir, slug, 'depth_areas.geojson')
    if not os.path.isfile(p):
        return False, '%s has no depth_areas.geojson' % slug
    pad = 0.02
    w = min(a_lon, b_lon) - pad; e = max(a_lon, b_lon) + pad
    s = min(a_lat, b_lat) - pad; n = max(a_lat, b_lat) + pad
    m, xs, ys, mlon, mlat = mask_for(p, w, s, e, n, cell)
    if not m.any():
        return False, '%s: no water in the window at all' % slug

    def nearest(lon, lat):
        j = int(round((lat - s) * mlat / cell - 0.5)); i = int(round((lon - w) * mlon / cell - 0.5))
        wy, wx = np.nonzero(m)
        d2 = (wy - j) ** 2 + (wx - i) ** 2
        k = int(np.argmin(d2))
        return int(wy[k]), int(wx[k]), math.sqrt(d2[k]) * cell

    aj, ai, ad = nearest(a_lon, a_lat)
    bj, bi, bd = nearest(b_lon, b_lat)
    # A RAMP SITS ON THE BANK, so it is never inside the water; build_ramp_reach measured 10-28 m
    # across three rivers before this project trusted that. One cell of slack on top of the cell
    # itself is the whole tolerance, and it is a raster's, not a judgement about ramps.
    if ad > cell * 2:
        return False, '%s: %s is %.0f m from any water in this pack' % (slug, a_name, ad)
    ny, nx = m.shape
    NB = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]
    seen = np.zeros(m.shape, dtype=bool)
    q = deque([(aj, ai)]); seen[aj, ai] = True
    while q:
        j, i = q.popleft()
        if (j, i) == (bj, bi):
            acres = seen.sum() * cell * cell / 4046.8564224
            return True, ('%s: %s -> %s, one piece of water (%.0f ac reached)'
                          % (slug, a_name, b_name, acres))
        for dj, di in NB:
            y, x = j + dj, i + di
            if 0 <= y < ny and 0 <= x < nx and m[y, x] and not seen[y, x]:
                seen[y, x] = True; q.append((y, x))
    ry, rx = np.nonzero(seen)
    return False, ('%s: %s reaches only %.0f acres and never gets to %s -- the reach stops at '
                   'lat %.5f..%.5f lon %.5f..%.5f'
                   % (slug, a_name, seen.sum() * cell * cell / 4046.8564224, b_name,
                      ys[ry.min()], ys[ry.max()], xs[rx.min()], xs[rx.max()]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chartpack', default='chartpack')
    ap.add_argument('--cell-m', type=float, default=CELL_M)
    a = ap.parse_args()
    bad = 0
    for slug, an, alat, alon, bn, blat, blon in CASES:
        try:
            ok, msg = run(a.chartpack, slug, an, alat, alon, bn, blat, blon, a.cell_m)
        except ImportError as exc:
            print('SKIP  %s (%s)' % (slug, exc))
            return 0
        print(('PASS  ' if ok else 'FAIL  ') + msg)
        bad += 0 if ok else 1
    print('\n%d case(s), %d failed' % (len(CASES), bad))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
