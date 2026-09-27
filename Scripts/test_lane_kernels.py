#!/usr/bin/env python3
"""The compiled lane loops give the same numbers as the numpy they replace, bit for bit.

Ryan, 2026-09-27: *"lets actually improve that script and make it not so costly to run... the
initial trolling runs and the refit take forever"*. `lane_kernels.py` moved the inner loops of
build_trolling_runs.py and fit_trolling_runs.py into compiled code. It was allowed to change how
long a lake takes and nothing else, because every lane on the card was cut by these tests and a
"slightly different" depth test would mean re-checking all of them.

WHAT THESE TESTS HOLD, each against the untouched numpy/matplotlib path on the same input:

  1. The raster fill is matplotlib's own point-in-polygon, cell for cell -- including polygons
     whose vertices sit exactly on grid lines, which is where a crossings test is easiest to get
     subtly wrong.
  2. The compiled DepthIndex answers `shallowest_dm` and `chord_ok` identically, on random points
     and on the chart's own vertices and edge midpoints.
  3. The raster, the eroded raster and the gradient come out identical from DepthRaster.
  4. `_seg_min`, `_seg_max` and `smooth` return identical arrays, dtype included, on random lines
     with and without a ceiling.

Measured on real packs as well (`_scratch/speedlab`, compare.py): Wateree's trolling_runs.geojson
after all three scripts, and water_features.geojson, are byte-identical old against new.

Run:  py Scripts\\test_lane_kernels.py      (needs numba; skips cleanly without it)

Personal use only, not for distribution or resale; not for navigation.
"""
import math, os, sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import lane_kernels as K  # noqa: E402

if not K.HAVE_NUMBA:
    print('SKIP: numba is not installed, so the numpy paths are the only paths')
    sys.exit(0)

from matplotlib.path import Path as MplPath  # noqa: E402
import build_trolling_runs as B  # noqa: E402
import fit_trolling_runs as F  # noqa: E402

rng = np.random.default_rng(20260927)
FAILS = []


def check(ok, msg):
    print(('ok    ' if ok else 'FAIL  ') + msg)
    if not ok:
        FAILS.append(msg)


def star(cx, cy, rmin, rmax, n):
    ang = np.sort(rng.uniform(0, 2 * np.pi, n))
    r = rng.uniform(rmin, rmax, n)
    ring = np.c_[cx + r * np.cos(ang), cy + r * np.sin(ang)]
    return np.vstack([ring, ring[:1]])


def chart(npoly=250):
    feats = []
    for p in range(npoly):
        outer = star(-81.3 + rng.uniform(-0.03, 0.03), 34.08 + rng.uniform(-0.03, 0.03),
                     0.0005, 0.012, int(rng.integers(3, 300)))
        if p % 4 == 0:
            outer = np.round(outer, 4)             # shared, grid-like coordinates
        rings = [outer.tolist()]
        if p % 5 == 0:
            c = outer[:-1].mean(axis=0)
            rings.append(star(c[0], c[1], 0.0002, 0.0004, 12).tolist())
        feats.append({'type': 'Feature', 'properties': {'depth_max_dm': int(rng.integers(0, 300))},
                      'geometry': {'type': 'Polygon', 'coordinates': rings}})
    return feats


# 1 ──────────────────────────────────────────────────────────────────────────────────────────────
bad = tot = 0
for trial in range(200):
    ring = star(*rng.uniform(-5, 5, 2), 5, 50, int(rng.integers(3, 60)))
    if trial % 3 == 0:
        ring = np.round(ring)
    xs = np.arange(-60, 61) * 1.0
    ys = np.arange(-55, 57) * 1.0
    if trial % 2:
        xs, ys = xs * 0.7 + 0.3, ys * 0.9 - 0.1
    SX, SY = np.meshgrid(xs, ys, indexing='ij')
    want = MplPath(ring).contains_points(np.column_stack([SX.ravel(), SY.ravel()]))
    got = K.ring_inside_grid(ring, xs, ys)
    bad += int((want != got).sum())
    tot += want.size
check(bad == 0, 'raster fill matches matplotlib contains_points (%d of %d cells differ)' % (bad, tot))

# 2 ──────────────────────────────────────────────────────────────────────────────────────────────
feats = chart()
D = B.DepthIndex(feats)
fast, D.fast = D.fast, None                        # the numpy path, for reference
check(fast is not None, 'DepthIndex builds its compiled twin when numba is present')
pts = np.c_[rng.uniform(-81.34, -81.26, 60000), rng.uniform(34.04, 34.12, 60000)]
V = np.array([c for f in feats for r in f['geometry']['coordinates'] for c in r])
pts = np.vstack([pts, V[:8000], ((V[:-1] + V[1:]) / 2)[:8000]])
diff = sum(D.shallowest_dm(x, y) != fast.shallowest_dm(x, y) for x, y in pts)
check(diff == 0, 'shallowest_dm identical on %d points, vertices and edge midpoints (%d differ)'
      % (len(pts), diff))
diff = 0
for _ in range(5000):
    i, j = rng.integers(0, len(pts), 2)
    dm = int(rng.integers(0, 300))
    diff += B.chord_ok(pts[i], pts[j], dm, D, 6, 3) != fast.chord_ok(pts[i], pts[j], dm, 6, 3)
check(diff == 0, 'chord_ok identical on 5,000 chords (%d differ)' % diff)

# 3 ──────────────────────────────────────────────────────────────────────────────────────────────
bbox, lat0 = (-81.345, 34.035, -81.255, 34.125), 34.08
F._FAST = False
R0 = F.DepthRaster(feats, bbox, 12.0, lat0, 1)
F._FAST = True
R1 = F.DepthRaster(feats, bbox, 12.0, lat0, 1)
same = lambda a, b: a.dtype == b.dtype and np.array_equal(a, b, equal_nan=True)
check(same(R0.dm_raw, R1.dm_raw) and same(R0.dm, R1.dm) and same(R0.gx, R1.gx)
      and same(R0.gy, R1.gy), 'DepthRaster: chart, eroded chart and gradient identical')

# 4 ──────────────────────────────────────────────────────────────────────────────────────────────
bad_seg = bad_sm = 0
R = R0
for k in range(150):
    n = int(rng.integers(2, 120))
    x = R.x0 + rng.uniform(200, (R.nx - 20) * R.step)
    y = R.y0 + rng.uniform(200, (R.ny - 20) * R.step)
    th, L = rng.uniform(0, 2 * np.pi), rng.uniform(100, 3000)
    s = np.linspace(0, L, n)
    xy = np.c_[x + np.cos(th) * s + rng.normal(0, 15, n), y + np.sin(th) * s + rng.normal(0, 15, n)]
    dm = float(rng.integers(10, 250))
    floor, ceil = dm - 3.0, (dm + 24.0 if k % 3 else math.inf)
    out = []
    for fast_on in (False, True):
        F._FAST = fast_on
        out.append((F.smooth(xy, R, floor, ceil, dm, 250, 1.5),
                    F._seg_min(R, xy[:-1], xy[1:], 10.0),
                    F._seg_min(R, xy[:-1], xy[1:], 7.0, raw=True),
                    F._seg_max(R, xy[:-1], xy[1:], 10.0)))
    bad_sm += not same(out[0][0], out[1][0])
    bad_seg += sum(not same(a, b) for a, b in zip(out[0][1:], out[1][1:]))
F._FAST = True
check(bad_seg == 0, '_seg_min / _seg_max identical, dtype included (%d of 450 differ)' % bad_seg)
check(bad_sm == 0, 'smooth() identical on 150 lines, with and without a ceiling (%d differ)' % bad_sm)

# 5 ──────────────────────────────────────────────────────────────────────────────────────────────
import build_water_features as W  # noqa: E402
wf = [{'properties': {'depth_max_ft': float(rng.uniform(0, 300))}, 'geometry': f['geometry']}
      for f in feats]
W._FAST = False
g0 = W.Grid(wf)
W._FAST = True
g1 = W.Grid(wf)
check(bytes(g0.g) == bytes(g1.g), 'build_water_features Grid: the 25 m byte grid is identical')

# 6 ──────────────────────────────────────────────────────────────────────────────────────────────
pairs = rng.normal(0, 1, (200000, 2)) * rng.choice([1e-6, 1e-3, 1.0, 1e3], (200000, 1))
diff = sum(math.hypot(a, b) != K.py_hypot(a, b) for a, b in pairs.tolist())
check(diff == 0, "py_hypot is CPython's math.hypot bit for bit (%d of 200,000 differ)" % diff)
pts = np.c_[rng.normal(-81.3, 0.05, 50000), rng.normal(34.08, 0.05, 50000)]
diff = sum(B.metres(p, q) != K.metres_k(p[0], p[1], q[0], q[1])
           for p, q in zip(pts.tolist(), (pts + rng.normal(0, 0.001, pts.shape)).tolist()))
check(diff == 0, 'metres_k is metres() bit for bit (%d of 50,000 differ)' % diff)
lines = [np.cumsum(rng.normal(0, 1e-4, (int(rng.integers(3, 400)), 2)), axis=0).tolist()
         for _ in range(300)]
B._FAST = False
ref = [(B.rdp(c, 5.0), B.length_m(c)) for c in lines]
B._FAST = True
new = [(B.rdp(c, 5.0), B.length_m(c)) for c in lines]
check(ref == new, 'rdp() keeps the same vertices and length_m() sums the same (300 lines)')

print('\n%d failed' % len(FAILS))
sys.exit(1 if FAILS else 0)
