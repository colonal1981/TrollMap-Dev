#!/usr/bin/env python3
"""fit_trolling_runs.py - turn stitched contours into lines a boat can actually be steered along.

Personal use only, not for distribution or resale; not for navigation.

    py .\\fit_trolling_runs.py --packs "F:\\TrollMapPipeline\\chartpack" --only wateree_lake
    py .\\fit_trolling_runs.py --packs "F:\\TrollMapPipeline\\chartpack" --ship-only `
                               --registry "F:\\TrollMapPipeline\\registry"

Rewrites `<slug>/trolling_runs.geojson` in place, keeping a copy of the original first.
Reads `contours.geojson` never; the stitch is not redone.

WHY THIS IS A SEPARATE SCRIPT AND NOT A FLAG ON build_trolling_runs.py

That script measures itself at **12.4 minutes for one mid-sized lake**, and every second of it
is the STITCHER -- joining 185 shattered LineStrings back into 155 runs. Fitting a line that is
already stitched is milliseconds. Putting this behind the stitcher would mean paying five days
of card-wide rebuild to change a geometry pass that costs nothing.

So: read the runs that already exist, rewrite their geometry, and leave the expensive half
alone. `build_trolling_runs.py` is not modified.

WHAT WAS WRONG WITH THE LINE

Ryan, 2026-08-09, on a plan built from these runs: *"the lines still follow the contour exactly
... the amount of turns and going into tight coves this does is completely unusable... I would
be untangling my lines or fighting snags all day instead of fishing."* Then the diagnosis, which
was the right one: *"its because it blindly follows a contour line."*

Counted, on run #27 of Wateree as shipped: **166 points, 12.3 miles, 23 turns sharper than 60
degrees, 12 sharper than 90, worst 176 degrees.** A hairpin, in the file. `steer()` in the
stitcher replaces contour wander with the longest straight it can find, but its only test is
`chord_ok` -- does this chord stay in water at least as deep as the contour. There is no turn
constraint anywhere in the pipeline, so it will join two 400 m straights at 176 degrees quite
happily.

After this script, the same window:

    contour today   4.44 mi   29 corners   worst 124deg   med straight  140 m   shallowest 15.1 ft
    fitted          4.18 mi    3 corners   worst  18deg   med straight 1784 m   shallowest 16.1 ft

**The fitted line is DEEPER at its worst point than the line it replaces**, on both runs
measured, while dropping 26 of 29 corners. The contour was not buying depth with those turns.

THE FOUR RULES, EACH OF WHICH REPLACED A WRONG ONE

**A blocked point slides, it does not freeze.** The first version snapped any point whose move
hit thin water back where it was while its neighbours kept sliding, which manufactured a kink
exactly where it had been stopped -- run #40's tightest turn went from a 195 m radius to 35 m,
worse than the contour it was replacing. Blocked points now bisect toward the furthest legal
position.

**Depth is monotone, not absolute.** A contour traces the EDGE of a band, so sampling along it
reads the shallow side about half the time: Wateree's 19 ft line dips to 15.1 ft on its own
vertices. An absolute floor freezes the fit; relaxing the floor to whatever the line touches
throws the floor away. A move is legal if it lands at or below `depth_dm - tol`, OR if it is no
shallower than the water it is leaving.

**A corner that will not smooth ends the pass.** Where the lake itself turns -- around a point,
into the neck of an arm -- the corner is real and the fitter may not cut across the bank. Towing
two rods through it is the thing Ryan called unusable, so the run is CUT there and comes back as
two passes. Pull the lines, motor around, set again.

**When there is a choice, take the deep side.** Ryan: *"would prefer it pushes deeper than
shallower."* A nudge along the depth gradient that STOPS the moment a point reaches the run's own
charted depth -- maximising depth walks the line off the ledge into the middle of the channel,
which is the one place on the lake nobody is trying to fish.

WHAT ELSE THIS FIXES WHILE IT IS HERE, BECAUSE IT IS THE SAME PASS OVER THE SAME DATA

**`near` is rebuilt, not carried.** It is indexed by distance ALONG the run, so moving the line
invalidates every entry. Rebuilding it from the real feature positions is not optional.

**POIs are matched on `poi_type` first.** The stitcher matches on display name or class --
`'Flooded Timber'`, `'Pile'`, `'Hazard Area'` -- and most of these POIs carry neither. Counted on
Wateree: **32 obstructions and 9 of 12 piles are annotated onto nothing**, sitting in 6 to 23 ft
of water, which is exactly where a deep-diving crank is. 41 pieces of hard cover the planner has
never known existed.

**Every `near` entry gets a charted depth.** Garmin POIs carry NO depth -- every property key on
all 552 of Wateree's is `mode zoom source poi_type on_water tile name navaid class card
card_lines services`. But 103 of 107 timber/pile/obstruction/attractor POIs sit inside a charted
depth area, and the depth raster is already in memory here, so it costs nothing. Timber at 11 ft
and timber at 40 ft stop looking identical to the planner, and one entry finally serves both
jobs: a snag to lift over, and a cast worth stopping for.

ORDERING. RUN THIS LAST.

`build_water_features.py` also annotates `near` in place and knows nothing about depth stamps, so
running it after this one silently strips them. Correct order is:

    build_structure.py -> build_trolling_runs.py -> build_water_features.py -> THIS

IDS. READ THIS BEFORE RUNNING IT ON A CARD YOU HAVE SAVED PLANS AGAINST.

The app addresses a leg as `slug#index`, positionally (`plan-candidates.js:616`), and splitting a
run into passes changes what every later index means. This script writes an explicit `id` onto
every feature so that can stop being true, but until `plan-candidates.js` prefers it, **a re-fit
renumbers the runs.** Harmless before an upload. Not harmless after a plan has been saved.
"""
import argparse, json, math, os, sys, time
import numpy as np
from matplotlib.path import Path as MplPath

# Reuse rather than restate. `metres` and the water-graph index are the pipeline's own, and two
# implementations of "how far is that" would drift the first time one of them was tuned.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_trolling_runs import metres, length_m, NodeIndex, read_graph, main_component  # noqa: E402

M_PER_DEG_LAT = 110540.0

# Sampling a segment finer than the raster it is read from buys nothing but calls: consecutive
# samples land in the same cell and return the same number. The grid is 12 m and thin water is
# already widened by a full cell, so 10 m is as fine as the answer can actually be.
SMOOTH_SAMPLE_M = 10.0


def m_per_deg_lon(lat):
    return 111320.0 * math.cos(math.radians(lat))


# ── the depth field ─────────────────────────────────────────────────────────────────────────

class DepthRaster:
    """
    `shallowest_dm` on a grid, matching `build_trolling_runs.DepthIndex`: the MIN `depth_max_dm`
    over every polygon containing the cell, holes honoured. A shoal drawn inside a larger deep
    polygon has to win, or the fit cuts a corner across a 3 ft point.

    TWO RASTERS, ANSWERING DIFFERENT QUESTIONS. `dm_raw` is the chart. `dm` is the chart with
    thin water widened by `safety_cells`, and it is the only one the fitter is allowed to plan
    against. Measuring with the eroded one reported the shipped contour as dipping to 5.9 ft when
    the chart says 15.1 -- the buffer talking, not the lake. A safety margin belongs in the
    decision and never in the number.
    """

    def __init__(self, features, bbox, step_m, lat0, safety_cells=1, max_cells=40_000_000):
        k = m_per_deg_lon(lat0)
        x0, y0 = bbox[0] * k, bbox[1] * M_PER_DEG_LAT
        x1, y1 = bbox[2] * k, bbox[3] * M_PER_DEG_LAT
        # Coarsen rather than die on the big reservoirs. Thurmond at 12 m is 11 M cells and the
        # erosion needs a working copy of each; Kerr is worse. The cap is on CELLS, so a small
        # lake keeps full resolution and only the giants give any up -- and it is reported.
        need = ((x1 - x0) / step_m + 2) * ((y1 - y0) / step_m + 2)
        self.coarsened = 1.0
        if need > max_cells:
            self.coarsened = math.sqrt(need / max_cells)
            step_m *= self.coarsened
        self.x0, self.y0, self.step = x0, y0, step_m
        self.nx = int((x1 - x0) / step_m) + 2
        self.ny = int((y1 - y0) / step_m) + 2

        # INDEX THE GRID, DO NOT MASK IT.
        #
        # The obvious version builds one array of every grid point and boolean-masks it to each
        # polygon's bounding box. On Wateree River that is 2,267 polygons against 1.7 M points --
        # 3.8 billion comparisons, and it measured at 24.2 s for a raster the rest of the script
        # consumes in three. Converting the bbox to integer cell ranges and slicing touches only
        # the cells the polygon could possibly cover.
        dm = np.full((self.nx, self.ny), np.nan, dtype=np.float32)

        self.n_poly = 0
        for f in features:
            g = f.get('geometry') or {}
            t = g.get('type')
            if t not in ('Polygon', 'MultiPolygon'):
                continue
            hi = (f.get('properties') or {}).get('depth_max_dm')
            if hi is None:
                continue
            hi = float(hi)
            parts = [g['coordinates']] if t == 'Polygon' else g['coordinates']
            for rings in parts:
                if not rings or len(rings[0]) < 4:
                    continue
                outer = _xy(rings[0], lat0)
                bx0, by0 = outer.min(axis=0)
                bx1, by1 = outer.max(axis=0)
                i0 = max(0, int(math.floor((bx0 - x0) / step_m)))
                i1 = min(self.nx - 1, int(math.ceil((bx1 - x0) / step_m)))
                j0 = max(0, int(math.floor((by0 - y0) / step_m)))
                j1 = min(self.ny - 1, int(math.ceil((by1 - y0) / step_m)))
                if i1 < i0 or j1 < j0:
                    continue
                ii = np.arange(i0, i1 + 1)
                jj = np.arange(j0, j1 + 1)
                SX, SY = np.meshgrid(x0 + ii * step_m, y0 + jj * step_m, indexing='ij')
                sub = np.column_stack([SX.ravel(), SY.ravel()])
                inside = MplPath(outer).contains_points(sub)
                for hole in rings[1:]:
                    if len(hole) >= 4:
                        inside &= ~MplPath(_xy(hole, lat0)).contains_points(sub)
                if not inside.any():
                    continue
                block = dm[i0:i1 + 1, j0:j1 + 1]
                flat = block.reshape(-1)
                cur = flat[inside]
                flat[inside] = np.where(np.isnan(cur), hi, np.minimum(cur, hi))
                dm[i0:i1 + 1, j0:j1 + 1] = flat.reshape(block.shape)
                self.n_poly += 1

        self.dm_raw = dm
        self.dm = self._erode(self.dm_raw, safety_cells) if safety_cells > 0 else self.dm_raw
        filled = np.where(np.isnan(self.dm), -50.0, self.dm)
        gxg, gyg = np.gradient(filled, self.step)
        n = np.hypot(gxg, gyg)
        n = np.where(n < 1e-9, 1.0, n)
        self.gx, self.gy = gxg / n, gyg / n
        self._inv = 1.0 / self.step

    @staticmethod
    def _erode(dm, k):
        """
        Every cell takes the shallowest value within k cells, uncharted winning outright.

        Two reasons, and they agree. Arithmetic: sampling a line at 6 m across a 12 m grid can
        clip the corner of a single thin cell without ever landing in it, which is how a fit
        floored at 14.1 ft came back dipping to 9.8 ft while every test it ran read clean.
        Widening the hazard closes that for good where a finer sample rate only makes it rarer.

        Real-world, and Ryan's: *"i cant follow the line exactly no matter what with my current
        trolling motor as it has no gps steering capability... it is more a guideline than an
        actual track."* One cell is 12 m, about the error he owns up to, and it is the honest
        margin to plan inside.
        """
        # Separable: a k-cell square minimum is a k-cell min along x then along y, which is
        # 4k shifted comparisons instead of (2k+1)^2 -- and it keeps one working array rather
        # than allocating a full-grid temporary per offset.
        big = np.where(np.isnan(dm), -1.0, dm).astype(np.float32)
        for axis in (0, 1):
            acc = big.copy()
            for d in range(1, k + 1):
                for sgn in (-1, 1):
                    sh = np.full_like(big, np.inf, dtype=np.float32)
                    o = d * sgn
                    src = slice(max(0, o), big.shape[axis] + min(0, o))
                    dst = slice(max(0, -o), big.shape[axis] + min(0, -o))
                    if axis == 0:
                        sh[dst, :] = big[src, :]
                    else:
                        sh[:, dst] = big[:, src]
                    np.fmin(acc, sh, out=acc)
            big = acc
        return np.where(big < 0, np.nan, big).astype(np.float32)

    def _ij(self, xy):
        # Hand-rolled rather than np.round + np.clip. This is the hottest function in the whole
        # script -- 95,000 calls for three runs -- and np.clip goes through three layers of numpy
        # Python wrapper per call, which cost more than the arithmetic it was guarding.
        i = ((xy[:, 0] - self.x0) * self._inv + 0.5).astype(np.intp)
        j = ((xy[:, 1] - self.y0) * self._inv + 0.5).astype(np.intp)
        np.clip(i, 0, self.nx - 1, out=i)
        np.clip(j, 0, self.ny - 1, out=j)
        return i, j

    def at(self, xy):
        i, j = self._ij(xy)
        return self.dm[i, j]

    def at_raw(self, xy):
        i, j = self._ij(xy)
        return self.dm_raw[i, j]

    def deeper_dir(self, xy):
        i, j = self._ij(xy)
        return np.column_stack([self.gx[i, j], self.gy[i, j]])


# ── geometry ────────────────────────────────────────────────────────────────────────────────

def _xy(coords, lat0):
    k = m_per_deg_lon(lat0)
    return np.array([[c[0] * k, c[1] * M_PER_DEG_LAT] for c in coords], float)


def _ll(xy, lat0):
    k = m_per_deg_lon(lat0)
    return [[round(float(p[0] / k), 6), round(float(p[1] / M_PER_DEG_LAT), 6)] for p in xy]


def _seglens(xy):
    return np.hypot(*(np.diff(xy, axis=0).T))


def _turns(xy):
    d = np.diff(xy, axis=0)
    keep = np.hypot(d[:, 0], d[:, 1]) > 0.5
    d = d[keep]
    if len(d) < 2:
        return np.array([])
    h = np.degrees(np.arctan2(d[:, 1], d[:, 0]))
    return np.abs((np.diff(h) + 180) % 360 - 180)


def _resample(xy, step):
    L = _seglens(xy)
    cum = np.concatenate([[0.0], np.cumsum(L)])
    total = cum[-1]
    if total <= 0:
        return xy, 0.0
    n = max(2, int(round(total / step)) + 1)
    s = np.linspace(0, total, n)
    return np.column_stack([np.interp(s, cum, xy[:, 0]), np.interp(s, cum, xy[:, 1])]), total


def _seg_max(depth, a, b, sample_m=5.0):
    """
    DEEPEST water anywhere along each segment -- the ceiling's half of the band test.

    Uncharted sorts LOW here, the opposite of _seg_min, and for the same reason: on this side of
    the comparison a big number is the failure, so unsurveyed must not manufacture one. Land is
    caught by the floor test; it is not this function's job.
    """
    seg = b - a
    L = np.hypot(seg[:, 0], seg[:, 1])
    if not len(L):
        return np.array([])
    n = max(1, int(math.ceil(float(L.max()) / sample_m)))
    t = np.linspace(0.0, 1.0, n + 1)
    pts = a[:, None, :] + seg[:, None, :] * t[None, :, None]
    d = depth.at_raw(pts.reshape(-1, 2)).reshape(len(a), n + 1)
    return np.where(np.isnan(d), -1.0, d).max(axis=1)


def _no_licence(v):
    """
    Uncharted water must never GRANT permission, only ever withhold it.

    Every comparison in the fitter has two sides: the candidate position and the baseline it has
    to be no worse than. On the candidate side, uncharted has to sort BELOW every real depth, or
    the line walks onto land. On the baseline side the same convention inverts the meaning --
    a point currently over uncharted water gets a baseline of -1, and then `candidate >= baseline`
    is true of literally anywhere, so that point becomes a free agent and drags its neighbours
    with it. That is how a 19 ft line came back with a pass dipping to 4.9 ft while every rule in
    the file said it could not.

    So on the baseline side, uncharted becomes +inf: no licence at all, and the candidate has to
    satisfy the absolute floor on its own merits.
    """
    return np.where(np.isnan(v) | (v < 0), np.inf, v)


def _seg_min(depth, a, b, sample_m=5.0, raw=False):
    """
    Shallowest water anywhere along each segment. Uncharted sorts below every real depth,
    because unsurveyed is not the same as deep and must never win a comparison.

    `raw=True` reads the chart; the default reads the chart with thin water widened. Which one
    is wanted follows the standing rule in this file: a safety margin belongs in a DECISION, a
    measurement reads the chart.

    ONE RASTER LOOKUP FOR THE WHOLE THING, not one per sample step. The loop this replaced was
    fine in the smoother -- n is about five there and each call covered every segment at once --
    and a disaster in chord_pass, where a 2.5 km chord is ONE segment and 250 steps, so it made
    250 numpy calls on one-element arrays and call overhead dwarfed the work.
    """
    seg = b - a
    L = np.hypot(seg[:, 0], seg[:, 1])
    if not len(L):
        return np.array([])
    n = max(1, int(math.ceil(float(L.max()) / sample_m)))
    t = np.linspace(0.0, 1.0, n + 1)
    pts = a[:, None, :] + seg[:, None, :] * t[None, :, None]
    look = depth.at_raw if raw else depth.at
    d = look(pts.reshape(-1, 2)).reshape(len(a), n + 1)
    return np.where(np.isnan(d), -1.0, d).min(axis=1)


def smooth(xy0, depth, floor_dm, ceil_dm, target_dm, iters, deep_bias_m):
    """Constrained Laplacian. See the module docstring for why each constraint is the shape it
    is; every one of them replaced a version that measured better and fished worse."""
    xy = xy0.copy()
    lam = 0.5
    stalled = 0
    for _ in range(iters):
        prop = xy.copy()
        prop[1:-1] = xy[1:-1] + lam * (xy[:-2] + xy[2:] - 2 * xy[1:-1])
        if deep_bias_m > 0 and target_dm is not None:
            # `at_raw`. Whether a point has REACHED its target depth is a measurement, and the
            # safety buffer reads about a band shallower than the chart everywhere -- so testing
            # against it meant `want` stayed true for most of the line forever, the bias pushed
            # every iteration, the line never settled, and the convergence exit could never fire.
            # That was the whole runtime: 4.9 s per run doing nothing after the first second.
            d_now = depth.at_raw(prop)
            want = np.isnan(d_now) | (d_now < target_dm)
            if want.any():
                prop[want] = prop[want] + depth.deeper_dir(prop[want]) * deep_bias_m
        prop[0], prop[-1] = xy0[0], xy0[-1]

        step = prop - xy
        # 0.25 m, not 0.02. Laplacian smoothing converges geometrically, so the last stretch to a
        # centimetre costs more iterations than everything before it and moves the line by less
        # than a paddle width. Ryan is hand-steering this without GPS on the trolling motor -- a
        # quarter metre is two orders of magnitude finer than he can hold. Chasing 2 cm was most
        # of the runtime.
        if float(np.abs(step).max()) < 0.25:
            break

        # ONE SCAN, NOT TWO. `_seg_min` samples each segment from t=0 to t=1 inclusive, so the
        # vertices are already in it -- the separate per-point lookup that used to sit here was
        # asking the raster the same question a second time, and raster lookups are what this
        # loop is made of. A point is judged by the segments it owns, which is what actually
        # matters: the boat travels along them, it does not teleport between vertices.
        cur_seg = _no_licence(_seg_min(depth, xy[:-1], xy[1:], sample_m=SMOOTH_SAMPLE_M))
        cur_max = _seg_max(depth, xy[:-1], xy[1:], sample_m=SMOOTH_SAMPLE_M)
        alpha = np.ones(len(xy))

        def bad_at(al):
            cand = xy + step * al[:, None]
            sm = _seg_min(depth, cand[:-1], cand[1:], sample_m=SMOOTH_SAMPLE_M)
            sx = _seg_max(depth, cand[:-1], cand[1:], sample_m=SMOOTH_SAMPLE_M)
            # Monotone on BOTH sides: a move may not go shallower than the floor unless it was
            # already, and may not go deeper than the ceiling unless it was already. Corner
            # cutting on a contour is inherently outward, toward the deep side, so without the
            # second half the smoother walks the whole line off the ledge one iteration at a time.
            seg = ((sm < floor_dm) & (sm < cur_seg)) | ((sx > ceil_dm) & (sx > cur_max))
            b = np.zeros(len(xy), bool)
            b[:-1] |= seg                       # a point owns the segments on either side
            b[1:] |= seg
            return b

        bad = bad_at(alpha)
        for _ in range(5):                      # 5 halvings bottoms out at 1/32 of the step
            if not bad.any():
                break
            alpha[bad] *= 0.5
            bad = bad_at(alpha)
        # Enforced, not hoped for: zeroing one point changes the segments its neighbours own, so
        # the settle can chase itself. An unconverged iteration is DISCARDED -- `xy` is legal on
        # entry, so keeping it is always a safe answer.
        clean = False
        for _ in range(6):
            if not bad.any():
                clean = True
                break
            alpha[bad] = 0.0
            bad = bad_at(alpha)
        if clean:
            xy = xy + step * alpha[:, None]
            xy[0], xy[-1] = xy0[0], xy0[-1]
            stalled = 0
        else:
            # A discarded iteration leaves `xy` untouched, so the next one proposes exactly the
            # same move and is discarded again -- the settled-line early exit can never fire and
            # the loop burns its full budget making no progress. Wateree River went from 1.8 s
            # to over 70 s on this alone. Three in a row means the constraints have the line
            # pinned and there is nothing further to find.
            stalled += 1
            if stalled >= 3:
                break
    return xy


def chord_pass(xy, depth, floor_dm, ceil_dm, target_dm, max_turn_deg, max_chord_m=2500.0,
               bridge_dm=6.0):
    """
    Long straight pulls joined by corners no sharper than `max_turn_deg`.

    Smoothing alone leaves small-scale jitter wherever a point had no legal move and stood still
    while its neighbours slid -- invisible on a chart, miserable on the water, a heading
    correction every sixty metres. So the last pass reaches as far as a straight chord stays
    legal AND does not bend more than the cap off the chord already being run.

    The fallback matters: where nothing is inside the cap it takes the GENTLEST legal turn, not
    the next vertex. Taking the next vertex is how a fitter capped at 35 degrees produced an 89
    degree corner on run #40, worse than the contour it replaced.
    """
    n = len(xy)
    if n < 3:
        return xy
    # Precomputed once: the shallowest water on each SEGMENT of the input line. `was` for a chord
    # i..j is then a running minimum instead of a fresh scan, which is the difference between
    # O(n^2) sampling and O(n). Wateree River timed out on the scan-per-candidate version.
    # And candidates are strided: the chord end is tried every ~100 m rather than every 25 m
    # vertex. A guideline steered by hand does not need its corner placed to a quarter of a boat
    # length, and it cuts the chord tests by four.
    stride = max(1, int(round(100.0 / max(1.0, float(np.median(_seglens(xy)))))))
    out = [0]
    i = 0
    while i < n - 1:
        heading = None
        if len(out) >= 2:
            v = xy[i] - xy[out[-2]]
            if np.hypot(*v) > 1e-6:
                heading = math.degrees(math.atan2(v[1], v[0]))
        # EVERY CANDIDATE END IN ONE BATCH. Testing them one at a time meant one _seg_min call
        # per candidate, ~25 per vertex, each its own numpy round trip.
        far = np.hypot(*(xy[i + 1:] - xy[i]).T)
        reach = int(np.searchsorted(np.maximum.accumulate(far), max_chord_m, side='right'))
        hi = min(n - 1, i + 1 + reach)
        js = [j for j in range(i + 1, hi + 1)
              if j == i + 1 or j == hi or (j - i - 1) % stride == 0]
        if not js:
            js = [min(i + 1, n - 1)]
        ends = xy[js]
        starts = np.repeat(xy[i][None, :], len(js), axis=0)
        # TWO TESTS, EACH ON THE RASTER THAT ANSWERS IT.
        #
        # In band: the CHART, against the same floor-minus-bridge the in-band split already
        # used, so a chord may not put the line anywhere the stretch it replaces could not have
        # been. On water: the BUFFER, purely to reject a chord that clips land or unsurveyed
        # ground, which is what the safety margin is for.
        #
        # What used to be here was "no worse than the shallowest point of the stretch you
        # replace", measured on the buffer -- and the buffer sits a band or more below the chart
        # near a drop-off, so a 400 m chord was licensed into 24 ft water on a 39 ft floor.
        # That clause has now leaked twice. It is gone rather than tightened.
        gots = _seg_min(depth, starts, ends, sample_m=10.0, raw=True)
        deep = _seg_max(depth, starts, ends, sample_m=10.0)
        safe = _seg_min(depth, starts, ends, sample_m=10.0)
        wlens = np.hypot(*(ends - xy[i]).T)
        if heading is None:
            turns = np.zeros(len(js))
        else:
            turns = np.abs((np.degrees(np.arctan2(ends[:, 1] - xy[i][1], ends[:, 0] - xy[i][0]))
                            - heading + 180) % 360 - 180)
            turns[wlens <= 1e-6] = 0.0

        in_cap = out_cap = None
        for k, j in enumerate(js):
            got, wlen, turn = float(gots[k]), float(wlens[k]), float(turns[k])
            # STRICT, and this replaced a rule that leaked badly. Allowing a chord to be "no
            # worse than the shallowest point of the stretch it replaces" meant ONE thin spot
            # anywhere licensed the whole chord to run that shallow: on Wateree River it put 12
            # of 21 fitted runs more than 6 ft above their own target depth. A brief dip is not
            # permission for a sustained shallow mile. `was` still bounds the short fallback.
            if got >= floor_dm - bridge_dm and float(deep[k]) <= ceil_dm + bridge_dm \
                    and safe[k] >= 0.0:
                if turn <= max_turn_deg:
                    # Longest wins, and the tiebreak now prefers the chord CLOSEST TO TARGET.
                    # It used to prefer the deeper one, on the reasoning that deep is safe --
                    # true of grounding, false of fishing. Between two equal chords, the one
                    # nearer the depth being trolled is the better line, in both directions.
                    off = abs(float(deep[k] + got) / 2.0 - target_dm)
                    if in_cap is None or wlen > in_cap[1] * 1.05:
                        in_cap = (j, wlen, turn, off)
                    elif wlen > in_cap[1] * 0.95 and off < in_cap[3]:
                        in_cap = (j, wlen, turn, off)
                elif out_cap is None or turn < out_cap[2]:
                    out_cap = (j, wlen, turn, 0.0)

        pick = in_cap or out_cap or (i + 1, 0.0, 0.0, 0.0)
        out.append(pick[0])
        i = pick[0]
    return xy[out]


def seed_deep(xy, depth, target_dm, ceil_dm, max_push_m=30.0, step_m=3.0):
    """
    Step the line off the band boundary and onto the deep side of it, before anything else runs.

    THIS IS THE STEP WHOSE ABSENCE BROKE EVERY EARLIER VERSION. A contour IS the boundary between
    two depth bands, so a cell lookup anywhere along it returns the shallower band roughly half
    the time -- and once the safety erosion widens thin water by a cell, it returns the shallower
    band nearly always. Every rule that asked "is this line in its own depth band" therefore
    answered no, everywhere, and the workarounds all amounted to weakening the rule until it
    said yes: relax the floor, grandfather the minimum, allow no-worse-than-before. Each one
    leaked somewhere else.

    Pushing the line 10-30 m onto the deep side removes the question. After this the line reads
    its own depth honestly, so the floor can be strict and stay strict.

    It is also what Ryan asked for on its own merits -- *"would prefer it pushes deeper than
    shallower"* -- and what anyone does by hand: you run just outside the line, not on it.
    """
    if len(xy) < 3:
        return xy
    # BY THE CONTOUR'S OWN NORMAL, NOT BY THE DEPTH GRADIENT. Garmin's depth field is a stack of
    # bands, so it is piecewise constant: its gradient is zero everywhere inside a band and a
    # cliff at the edges, which normalises to a meaningless direction for most of the line. The
    # contour's normal is always defined and always perpendicular to the thing being followed.
    #
    # Measured on Wateree run #27 (58 dm): on the line itself, 82% of samples read its own depth
    # or deeper. Offset 10 m to whichever side is deeper, 98%. At 20 m, 99%.
    t = np.gradient(xy, axis=0)
    t /= (np.hypot(t[:, 0], t[:, 1])[:, None] + 1e-9)
    nrm = np.column_stack([-t[:, 1], t[:, 0]])
    best = xy.copy()
    best_d = np.where(np.isnan(depth.at_raw(xy)), -1.0, depth.at_raw(xy))
    off = step_m
    while off <= max_push_m:
        for sgn in (1.0, -1.0):
            cand = xy + nrm * (off * sgn)
            cd = np.where(np.isnan(depth.at_raw(cand)), -1.0, depth.at_raw(cand))
            # Only ever accept a step that both improves the reading AND is still short of the
            # target -- once a point is in its own band it stops moving, so the line ends up just
            # outside the contour rather than out in the middle of the channel.
            # Only step toward the target, and never past the ceiling. The old test was
            # "deeper is better as long as we have not reached the target yet", which happily
            # jumped a point from 12 ft to 40 ft in one move because 40 is also > 12.
            take = (cd > best_d) & (best_d < target_dm) & (cd <= ceil_dm)
            best[take] = cand[take]
            best_d[take] = cd[take]
        off += step_m
    return best


def _turns_aligned(xy):
    """Heading change at each interior vertex, index-aligned: t[k] is the turn at xy[k+1].
    A zero-length segment has no heading, so its turn is reported as 0 rather than dropped."""
    d = np.diff(xy, axis=0)
    L = np.hypot(d[:, 0], d[:, 1])
    if len(d) < 2:
        return np.array([])
    h = np.degrees(np.arctan2(d[:, 1], d[:, 0]))
    t = np.abs((np.diff(h) + 180) % 360 - 180)
    t[(L[:-1] <= 0.5) | (L[1:] <= 0.5)] = 0.0
    return t


def split_to_band(xy, depth, floor_dm, ceil_dm, min_leg_m, step_m=10.0, bridge_m=40.0,
                  bridge_dm=6.0, deep_bridge_m=None, deep_bridge_dm=None):
    """
    Cut the run into the stretches that are ACTUALLY at the depth they claim, and drop the rest.

    A stitched contour is 32 km long and crosses the whole lake. Wateree's 19 ft line dips to
    8.9 ft somewhere along it -- real water, correctly charted, and not a place to troll a 19 ft
    line. Fitting the run whole meant every rule in the file was arguing about what to do in
    water the contour should never have been followed into, and the answer kept being "no worse
    than it already was", which is not the same as "deep enough".

    Doing this FIRST makes the guarantee structural instead of negotiated: every stretch handed
    to the fitter is at or below its own floor for its entire length, so every pass that comes
    out the far side is too. It also replaces the tenth-percentile gate this used to have -- a
    run does not pass or fail as a whole, it contributes the parts of itself that qualify.

    ── THE TWO SIDES ARE NOT THE SAME RULE. 2026-08-10. ──────────────────────────────────────

    This function was the single largest source of fragmentation in the whole pipeline, and
    nothing else came close. Measured on 60 Wateree contours: about 9% of 10 m samples fall
    outside the band, but they are SCATTERED SINGLETONS rather than shoals, and the bridge that
    exists to paper over them spanned 40 m and tolerated 2 ft. So most of them cut anyway. A 4 km
    run with 36 scattered failures came out as 37 pieces averaging 108 m, and `--min-leg-m` then
    swept up the debris -- which is why three days were spent arguing about a length threshold
    that was never the cause.

        bridge 40 m / 2 ft   (as shipped)   752 pieces   median  116 m   482 km kept
        bridge 150 m / 5 ft                 303 pieces   median  399 m   504 km kept
        bridge 300 m / 8 ft                 142 pieces   median  964 m   526 km kept

    More water kept AND five times fewer pieces. The fragmentation was pure loss.

    But the two sides of the band are different rules and must not be loosened together:

    THE FLOOR IS A SAFETY RULE. A genuine shoal at bait depth ends a pass, and bridging over one
    puts baits on the bottom. It stays tight: bridge chart noise, never a shoal.

    THE CEILING IS NOT. Water deeper than a contour's label is no hazard to a kayak, it is just
    deeper water -- and under the eligibility rule in js/modules/plan-candidates.js, for
    suspended fish it is exactly where the fish are. Roughly 5% of samples per run exceed the
    ceiling, and every one of them was cutting a pass in half for no safety reason at all.

    The ceiling still exists, because Ryan's original complaint was real -- "it pulled me too
    deep... the 16 and 18ft run spends more the day nowhere near 16 or 18ft water" -- but the
    answer to that is HONESTY, not amputation. The pass carries `shallowest_ft`, `deepest_ft` and
    `mean_depth_ft`, so a route that drifts to 30 ft can say so and be judged on it. A route
    labelled "18-30 ft" answers his complaint; a route chopped into eleven pieces does not.
    """
    if deep_bridge_m is None:
        deep_bridge_m = bridge_m
    if deep_bridge_dm is None:
        deep_bridge_dm = bridge_dm
    even, total = _resample(xy, step_m)
    if total <= 0:
        return []
    # `at_raw`, deliberately. Which stretches are in band is a MEASUREMENT; the safety buffer
    # belongs in deciding where the boat may move, not in deciding what the chart says.
    d = depth.at_raw(even)
    # A BAND, NOT A FLOOR. Every test in this file used to guard only against going shallow, so
    # nothing stopped the line drifting off the ledge into the channel: Wateree's 18 ft leg came
    # back with a median of 29.9 ft under it and a maximum of 41. Ryan: "it pulled me too
    # deep... the 16 and 18ft run spends more the day nowhere near 16 or 18ft water". A contour
    # you are trolling is a depth to STAY ON, and that has two sides.
    ok = ~(np.isnan(d) | (d < floor_dm) | (d > ceil_dm))
    # CLOSE THE PINHOLES BEFORE CUTTING ON THEM.
    #
    # 92% of run #27's contour reads at or below its floor on the raw chart -- but the other 8%
    # is scattered single cells, not one shoal, so cutting on every one of them left a longest
    # surviving stretch of about 120 m and the whole 32 km run produced no pass at all. A 10 m
    # sample below the floor on a 12 m grid is the raster clipping a band edge. A 40 m one is a
    # shoal. Only the second should end a pass.
    # BRIDGE BY DEPTH AS WELL AS BY LENGTH. Bridging on length alone let a 40 m patch of 7.9 ft
    # water be papered over on a line whose floor is 18 ft -- which is a boat on the bottom, not
    # a sampling artefact. A dip of one band is the raster clipping an edge; a dip of four is a
    # shoal, and a shoal ends the pass no matter how narrow it is.
    gap = max(1, int(round(bridge_m / step_m)))
    deep_gap = max(1, int(round(deep_bridge_m / step_m)))
    dfill = np.where(np.isnan(d), -1.0, d)
    i, n = 0, len(ok)
    while i < n:
        if ok[i]:
            i += 1
            continue
        j = i
        while j < n and not ok[j]:
            j += 1
        # WHICH SIDE FAILED DECIDES WHICH BRIDGE APPLIES. A gap that is purely too deep is
        # allowed a far longer and far more generous span than one that involves shallow water
        # or uncharted cells, because only the second can put a bait on the bottom. A MIXED gap
        # -- some too shallow, some too deep -- is treated as shallow: the strict rule wins any
        # time it is implicated at all.
        seg = dfill[i:j]
        nan_here = bool(np.isnan(d[i:j]).any())
        all_deep = (not nan_here) and bool((seg > ceil_dm).all())
        if all_deep:
            fits = (j - i) <= deep_gap and float(seg.max()) <= ceil_dm + deep_bridge_dm
        else:
            fits = ((j - i) <= gap
                    and float(seg.min()) >= floor_dm - bridge_dm
                    and float(seg.max()) <= ceil_dm + bridge_dm)
        if fits and i > 0 and j < n:
            ok[i:j] = True
        i = j
    out, i = [], 0
    while i < n:
        if not ok[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and ok[j + 1]:
            j += 1
        if j > i:
            piece = even[i:j + 1]
            if float(_seglens(piece).sum()) >= min_leg_m:
                out.append(piece)
        i = j + 1
    return out


def split_at_hard_corners(xy, max_turn_deg, min_leg_m):
    """A corner that will not smooth is not a turn, it is the end of a pass."""
    # ALIGNED TURNS. `_turns` drops segments under 0.5 m before differencing, so every index
    # after a dropped one is shifted -- and this function maps those indices straight back onto
    # the vertex array to decide where to cut. One short segment and it cuts in the wrong place,
    # which is how a pass came back containing a 55 degree corner under a 35 degree cap.
    t = _turns_aligned(xy)
    bounds = [0] + [k + 1 for k, a in enumerate(t) if a > max_turn_deg] + [len(xy) - 1]
    pieces = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        if b - a < 1:
            continue
        piece = xy[a:b + 1]
        if float(_seglens(piece).sum()) >= min_leg_m:
            pieces.append(piece)
    return pieces


# ── what a run passes ───────────────────────────────────────────────────────────────────────

# MATCHED ON `poi_type`, WHICH IS THE FIELD THAT IS ALWAYS THERE.
#
# `build_trolling_runs.POI_KINDS` keys on the display `name` or `class` -- 'Flooded Timber',
# 'Pile', 'Hazard Area'. Counted on Wateree, most of these POIs carry neither: 32 obstructions
# and 9 of 12 piles have `name: None, class: None` and were annotated onto nothing at all. They
# sit in 6 to 23 ft, which is exactly where a deep-diving crank is.
POI_TYPE_KINDS = {
    'flooded_timber': 'timber',
    'obstruction': 'obstruction',
    'pile': 'pile',
    'shallow_area': 'shallow',
    'hazard_area': 'hazard',
    'danger_buoy': 'hazard',
    'caution_buoy': 'hazard',
    'fish_attractor_buoy': 'attractor',
    'bridge': 'bridge',
}
# Deliberately NOT annotated: `garmin_3_26` (the purple triangles -- five-byte records with no
# type field, settled 2026-08-06 as dock markers carrying nothing), `place_name`, `height_marker`,
# `parking`, `boat_ramp`, `marina`, `mile_marker`, `nav_buoy`, `slow_no_wake`, `restricted_area`.
# Regulatory zones and shore furniture are real, but they are not cover and not a snag.


def load_annotation_points(pack):
    """[(lon, lat, kind, depth_ft or None)] from every layer that describes the bottom."""
    pts = []

    p = os.path.join(pack, 'pois.geojson')
    if os.path.isfile(p):
        try:
            with open(p, 'r', encoding='utf-8') as fh:
                for x in (json.load(fh).get('features') or []):
                    pr = x.get('properties') or {}
                    k = POI_TYPE_KINDS.get(pr.get('poi_type'))
                    if not k:
                        continue
                    c = (x.get('geometry') or {}).get('coordinates')
                    if c and len(c) >= 2:
                        pts.append((c[0], c[1], k, None))
        except Exception:
            pass

    p = os.path.join(pack, 'structure.geojson')
    if os.path.isfile(p):
        try:
            with open(p, 'r', encoding='utf-8') as fh:
                for x in (json.load(fh).get('features') or []):
                    pr = x.get('properties') or {}
                    c = (x.get('geometry') or {}).get('coordinates')
                    if pr.get('kind') and c and len(c) >= 2:
                        pts.append((c[0], c[1], pr['kind'], pr.get('depth_ft')))
        except Exception:
            pass

    # points, coves, creek mouths -- build_water_features.py's own output, folded in here so one
    # pass produces the complete list rather than two passes each half-overwriting the other.
    p = os.path.join(pack, 'water_features.geojson')
    if os.path.isfile(p):
        try:
            with open(p, 'r', encoding='utf-8') as fh:
                for x in (json.load(fh).get('features') or []):
                    pr = x.get('properties') or {}
                    c = (x.get('geometry') or {}).get('coordinates')
                    if pr.get('kind') and c and len(c) >= 2:
                        pts.append((c[0], c[1], pr['kind'], pr.get('deep_side_ft')))
        except Exception:
            pass
    return pts


def annotate(props, coords, grid, cell, annotate_m, depth, lat0):
    """
    Rebuild `near` against THIS geometry, and stamp a charted depth on every entry.

    `near` is indexed by distance along the run, so a moved line invalidates every entry it
    inherited. Rebuilding is not an optimisation, it is the only correct thing to do.

    The depth stamp is the half that never existed. Garmin POIs carry no depth -- not for timber,
    not for obstructions, not for piles -- so a planner reading `{t: "timber", d: 39}` cannot
    tell a cast target from a snag. With `ft` on it, one entry does both jobs.
    """
    s = 0.0
    seen, near = set(), []
    for vi, v in enumerate(coords):
        if vi:
            s += metres(coords[vi - 1], v)
        gx, gy = int(v[0] / cell), int(v[1] / cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q in grid.get((gx + dx, gy + dy), ()):
                    d = metres(v, (q[0], q[1]))
                    if d > annotate_m:
                        continue
                    key = (round(q[0], 6), round(q[1], 6), q[2])
                    if key in seen:
                        continue
                    seen.add(key)
                    e = {'s': round(s), 't': q[2], 'd': round(d)}
                    ft = q[3]
                    if ft is None and depth is not None:
                        # Read the chart, on the RAW raster -- the safety buffer is for deciding
                        # where the boat may go, never for reporting how deep a feature sits.
                        v_dm = float(depth.at_raw(_xy([[q[0], q[1]]], lat0))[0])
                        if not math.isnan(v_dm):
                            ft = round(v_dm / 3.048, 1)
                    if ft is not None:
                        e['ft'] = ft
                    near.append(e)
    if not near:
        for k in ('near', 'near_counts', 'ledge_n', 'ledge_min_ft', 'ledge_max_ft'):
            props.pop(k, None)
        return
    near.sort(key=lambda e: e['s'])
    # Ledges are SUMMARISED, not listed -- 6,926 on Wateree against 55 stands of timber, so every
    # run collects hundreds and the count discriminates nothing. Same rule as the stitcher's.
    led = [e for e in near if e['t'] == 'ledge']
    for k in ('ledge_n', 'ledge_min_ft', 'ledge_max_ft'):
        props.pop(k, None)
    if led:
        props['ledge_n'] = len(led)
        props['ledge_min_ft'] = min(e.get('ft', 0) for e in led)
        props['ledge_max_ft'] = max(e.get('ft', 0) for e in led)
    keep = [e for e in near if e['t'] != 'ledge']
    props['near'] = keep
    counts = {}
    for e in keep:
        counts[e['t']] = counts.get(e['t'], 0) + 1
    props['near_counts'] = counts


# ── one pack ────────────────────────────────────────────────────────────────────────────────

def fit_pack(pack, a):
    t_pack = time.time()
    slug = os.path.basename(pack.rstrip('/\\'))
    rpath = os.path.join(pack, 'trolling_runs.geojson')
    dpath = os.path.join(pack, 'depth_areas.geojson')
    if not os.path.isfile(rpath):
        return None
    # IDEMPOTENT BY DEFAULT, BECAUSE RUNNING THIS TWICE DESTROYS WATER.
    #
    # 2026-08-09: Ryan re-ran Wateree to pick up a fix and it fitted the ALREADY-FITTED file --
    # 1,820 runs in, not the original 1,632. A second pass smooths an already-smoothed line and
    # re-applies the minimum-leg rule to pieces that have already been trimmed once, so the
    # length went 3,114 km -> 1,168 -> 902. Nothing errored and the summary looked healthy,
    # because every number it printed was measured against the wrong baseline.
    #
    # So a pack that has been through is SKIPPED unless --refit says otherwise. Every feature
    # this script writes carries a `fitted` flag, true or false, and no other producer writes
    # that key, so its presence is an unambiguous record. Read from the head of the file, not
    # the whole thing, because the point is to skip cheaply.
    #
    # This also makes a card-wide pass resumable for free: a machine that reboots four hours in
    # picks up where it stopped instead of starting over.
    if not a.refit and _already_fitted(rpath):
        return {'slug': slug, 'skipped': 'already fitted -- pass --refit to do it again, but '
                                         'restore the original first or it fits its own output'}
    if not os.path.isfile(dpath):
        return {'slug': slug, 'skipped': 'no depth_areas.geojson'}

    with open(rpath, 'r', encoding='utf-8') as fh:
        runs = (json.load(fh).get('features') or [])
    if not runs:
        return {'slug': slug, 'skipped': 'no runs'}

    xs, ys = [], []
    for f in runs:
        for c in f['geometry']['coordinates']:
            xs.append(c[0]); ys.append(c[1])
    lat0 = (min(ys) + max(ys)) / 2.0
    pad_deg = 400.0 / M_PER_DEG_LAT
    bbox = (min(xs) - pad_deg, min(ys) - pad_deg, max(xs) + pad_deg, max(ys) + pad_deg)

    t0 = time.time()
    with open(dpath, 'r', encoding='utf-8') as fh:
        da = (json.load(fh).get('features') or [])
    depth = DepthRaster(da, bbox, a.grid_m, lat0, a.safety_cells, a.max_cells)
    t_raster = time.time() - t0

    pts = load_annotation_points(pack)
    cell = max(a.annotate_m, 50.0) / 111320.0 * 1.5
    grid = {}
    for q in pts:
        grid.setdefault((int(q[0] / cell), int(q[1] / cell)), []).append(q)

    idx = mainset = None
    gpath = os.path.join(pack, 'water_graph.bin')
    if os.path.isfile(gpath):
        try:
            n, edges = read_graph(gpath)
            idx = NodeIndex(gpath)
            mainset = main_component(n, edges)
        except Exception:
            idx = mainset = None

    out = []
    st = {'in': len(runs), 'fitted': 0, 'split': 0, 'kept_closed': 0, 'kept_short': 0,
          'kept_thin': 0, 'm_in': 0.0, 'm_out': 0.0,
          'corners_before': 0, 'corners_after': 0, 'passes': 0}

    for f in runs:
        pr = dict(f['properties'])
        coords = f['geometry']['coordinates']
        pr.pop('id', None)
        parent_len = pr.get('length_m') or length_m(coords)

        if pr.get('closed') or parent_len < a.min_fit_m or len(coords) < 4:
            # A closed ring at depth is a hump, and you circle it -- smoothing a closed curve
            # with its ends pinned collapses it toward a point. Short runs are not passes.
            st['kept_closed' if pr.get('closed') else 'kept_short'] += 1
            pr['fitted'] = False
            annotate(pr, coords, grid, cell, a.annotate_m, depth, lat0)
            out.append({'type': 'Feature', 'properties': pr,
                        'geometry': {'type': 'LineString', 'coordinates': coords}})
            continue

        xy0 = _xy(coords, lat0)
        floor = float(pr['depth_dm']) - a.tol_dm
        st['corners_before'] += int(np.sum(_turns(_resample(xy0, 10.0)[0]) > 12))

        pieces = []
        ceil = float(pr['depth_dm']) + a.ceiling_dm
        seeded = seed_deep(xy0, depth, float(pr['depth_dm']), ceil, a.seed_push_m)
        # ONE MEANINGFUL THRESHOLD, APPLIED ONCE, AT THE END.
        #
        # Gating the in-band stretch at `min_leg_m` AND the finished pass at `min_leg_m` rejected
        # everything that only just qualified: smoothing shortens a line by cutting its corners,
        # so a 1,319 m stretch comes out at about 1,150 m and vanishes against the same gate it
        # had already passed. after_bay_reservoir fitted nothing at all for this reason while
        # carrying 13 runs with in-band water in them. The stretch gate is now only "long enough
        # to be worth smoothing"; whether it is a trolling pass is decided on the finished line.
        for stretch in split_to_band(seeded, depth, floor, ceil, a.min_stretch_m,
                                     bridge_m=a.bridge_m, bridge_dm=a.bridge_dm,
                                     deep_bridge_m=a.deep_bridge_m,
                                     deep_bridge_dm=a.deep_bridge_dm):
            # BOUND THE POINT COUNT, NOT JUST THE SPACING.
            #
            # At a fixed 25 m, a 12 km stretch is 480 points and the smoother is O(points x
            # iterations x raster reads) -- so cost grew with the SQUARE of stretch length while
            # the answer did not. Wateree took thirty times parr_shoals' runtime for three times
            # its data, entirely here.
            #
            # A long stretch does not need finer vertices than a short one: it is being replaced
            # by straight chords at the end regardless, and this is a guideline steered by hand.
            # Capping at `max_pts` makes a 12 km stretch 60 m-spaced instead of 25, which is well
            # inside what can be held without GPS steering.
            slen = float(_seglens(stretch).sum())
            step = max(a.resample_m, slen / max(20, a.max_pts))
            even, _ = _resample(stretch, step)
            # ...BUT A COARSER SAMPLING OF A BEND IS A CHORD ACROSS IT.
            #
            # Resampled points sit on the original line, the straight segments between them do
            # not, and at 60 m one of those can cut the inside of a bend into water the contour
            # never touched. That line then becomes the smoother's own baseline, and the
            # monotone rule faithfully preserves it -- which is how one Wateree pass came back
            # 16 ft above its 40 ft target while every constraint downstream was satisfied.
            #
            # So the coarsening has to earn itself: halve the spacing until no segment of the
            # resampled line leaves the band. Bounded, and it only pays where it matters.
            while step > a.resample_m and len(even) > 2 and \
                    bool((_seg_min(depth, even[:-1], even[1:], SMOOTH_SAMPLE_M) < floor).any()):
                step = max(a.resample_m, step / 2.0)
                even, _ = _resample(stretch, step)
            sm = smooth(even, depth, floor, ceil, float(pr['depth_dm']), a.iters, a.deep_bias_m)
            ch = chord_pass(sm, depth, floor, ceil, float(pr['depth_dm']), a.max_turn_deg,
                            bridge_dm=a.bridge_dm)
            for piece in split_at_hard_corners(ch, a.max_turn_deg, a.min_leg_m):
                # ASSERT THE INVARIANT ON THE OUTPUT, not only along the way.
                #
                # Every stage enforces the depth rule against the line it was handed, and every
                # time one of those baselines turned out to be fabricated -- an erosion, a
                # resample, an uncharted cell -- the guarantee quietly stopped holding while
                # each stage still reported success. Three separate bugs, same shape.
                #
                # So the finished pass is re-tested against the chart from scratch, and any part
                # of it that is not in band is cut off. Cheap, and it makes the guarantee a
                # property of the OUTPUT rather than a claim about the process.
                pieces.extend(split_to_band(piece, depth, floor, ceil, a.min_leg_m,
                                            bridge_m=a.bridge_m, bridge_dm=a.bridge_dm,
                                            deep_bridge_m=a.deep_bridge_m,
                                            deep_bridge_dm=a.deep_bridge_dm))
        if not pieces:
            st['kept_thin'] += 1
            pr['fit_note'] = ('no fitted pass of %.0f m survived: this contour is not %.1f ft '
                              'deep for that far at a time'
                              % (a.min_leg_m, floor / 3.048))
            # Every piece came out under min_leg_m: the water here does not hold a pass. Keep the
            # contour rather than inventing one, and say so in the properties.
            pr['fitted'] = False
            annotate(pr, coords, grid, cell, a.annotate_m, depth, lat0)
            out.append({'type': 'Feature', 'properties': pr,
                        'geometry': {'type': 'LineString', 'coordinates': coords}})
            continue

        st['fitted'] += 1
        if len(pieces) > 1:
            st['split'] += 1
        st['passes'] += len(pieces)
        # NO SILENT TRUNCATION. Pieces under `min_leg_m` are discarded, and on a meandering
        # river that can be most of a run's length. It is a defensible drop -- a 400 m sliver
        # between two hard corners is not a trolling pass, and selectCandidates would refuse it
        # at 1,500 m anyway -- but it is not something a run should do quietly.
        st['m_in'] += float(parent_len)
        st['m_out'] += float(sum(_seglens(p).sum() for p in pieces))

        for k, piece in enumerate(pieces):
            ll = _ll(piece, lat0)
            p2 = dict(pr)
            p2['fitted'] = True
            p2['length_m'] = round(float(_seglens(piece).sum()), 1)
            p2['vertices'] = len(ll)
            p2['closed'] = False
            p2.pop('area_m2', None)
            p2['parent_length_m'] = round(float(parent_len), 1)
            if len(pieces) > 1:
                p2['pass'] = k + 1
                p2['passes'] = len(pieces)
            tt = _turns(_resample(piece, 10.0)[0])
            st['corners_after'] += int(np.sum(tt > 12))
            p2['worst_corner_deg'] = round(float(tt.max()), 1) if len(tt) else 0.0
            # WHAT WATER IS ACTUALLY UNDER THIS PASS.
            #
            # Ryan, 2026-08-10: "if the app thinks the fish are somewhere between 17 and 25 then
            # that means that the average depth of that trolling run needs to be between that
            # number... if the fish are not deeper than 25 ft and i can safely stay below 25ft
            # then the trolling run should not run deeper than 25 feet... and that number needs
            # to be flexible because it will be different on every lake at different times of the
            # year."
            #
            # WHICH water to troll is a fishing decision. It changes with the lake, the season and
            # the species, and this script runs once, months before anyone knows what will be
            # planned on it, so it cannot make that call and must not try. What it CAN do is the
            # measurement, and that is all this is: the real chart depth every 10 m along the
            # finished pass, reduced to numbers the app can decide with.
            #
            # `at_raw` and never `at`. `at` is the chart with thin water widened a cell for
            # safety, which is the right input to a DECISION about where the boat may go and the
            # wrong input to a REPORT of how deep the water is. Reporting off the eroded raster is
            # what once had a contour "dipping to 5.9 ft" where the chart says 15.1.
            #
            # The 10 m spacing is even, which is what makes the mean length-weighted instead of
            # vertex-weighted: a bend carries more vertices per metre and would otherwise pull the
            # average toward itself.
            draw = depth.at_raw(_resample(piece, 10.0)[0])
            ok = ~np.isnan(draw)
            if np.any(ok):
                good = draw[ok]
                p2['shallowest_ft'] = round(float(good.min()) / 3.048, 1)
                p2['deepest_ft'] = round(float(good.max()) / 3.048, 1)
                p2['mean_depth_ft'] = round(float(good.mean()) / 3.048, 1)
                # Uncharted water is not shallow water and it is not deep water -- it is water
                # nobody sounded, and it has already caused two bugs by being treated as one or
                # the other. So the share that IS charted is stated, and the app can tell a mean
                # taken over the whole pass from one taken over a third of it.
                p2['charted_frac'] = round(float(ok.mean()), 3)

            # ── THE NUMBER THAT DECIDES A SNAG. 2026-08-11. ────────────────────────────────
            #
            # Everything above measures the water ON the line. Ryan does not troll the line:
            #
            #     "remember i do not have gps steering... i am going to be weaving between those
            #      lines no matter what we decide"     -- and, on how far: "call it no more than
            #      50 meters"... later revised: "50 meters is probably too much lets try maybe
            #      25m i dont think i sway 150 ft to a side"
            #
            # So the depth that matters is the SHALLOWEST WATER HE COULD REACH, not the depth
            # underneath a centreline he cannot hold. On Wateree run #7 those differ by more
            # than they have any right to: the line never comes shallower than 18.0 ft, and
            # within 25 m there is 3.9 ft. A bait set from the first number is on the bottom.
            #
            # This is a MEASUREMENT and stays one -- no clearance, no margin, no bait depth.
            # What clears what is a decision the app makes on the day, from the lure that is
            # actually on the rod. See claude/WHAT_SMARTPLAN_IS_2026-08-09.md.
            #
            # Sampled across the pass at `envelope_step_m` and across the boat at
            # `envelope_m` either side, perpendicular to travel. One raster call for the whole
            # pass: the cost is a rounding error next to 250 smoothing iterations.
            ev = _resample(piece, a.envelope_step_m)[0]
            if len(ev) >= 2:
                tan = np.zeros_like(ev)
                tan[1:-1] = ev[2:] - ev[:-2]
                tan[0] = ev[1] - ev[0]
                tan[-1] = ev[-1] - ev[-2]
                tl = np.hypot(tan[:, 0], tan[:, 1])
                tl[tl == 0] = 1.0
                nrm = np.stack([-tan[:, 1] / tl, tan[:, 0] / tl], axis=1)
                offs = np.linspace(-a.envelope_m, a.envelope_m, 7)
                probe = np.concatenate([ev + nrm * o for o in offs], axis=0)
                v = np.asarray(depth.at_raw(probe), dtype=float).reshape(len(offs), len(ev))
                # +inf FOR UNCHARTED, NOT NaN. Both give the same answer, but `nanmin` over a
                # station where all seven probes are unsurveyed warns "All-NaN slice encountered"
                # -- which is true, harmless, and fires thousands of times across a card-wide run,
                # where it would drown a warning that actually mattered. +inf never wins a minimum,
                # so a real depth beats it and an all-uncharted station stays +inf and falls out as
                # -1 below. The condition is removed rather than the message suppressed.
                lo = np.where(np.isfinite(v), v, np.inf).min(axis=0) / 3.048
                # THREE PROFILES OUT OF ONE PROBE, because all three are already in `v` and the
                # raster work is done. They answer three different questions and the app needs
                # all of them:
                #
                #   shallow  what can snag a bait          -> the decision
                #   deep     how much depth 25 m buys      -> how steep the edge is, and so how
                #                                             much attention this pass wants
                #   line     what the chart says HERE      -> the centreline, kept so the gap
                #                                             between it and `shallow` is visible
                #
                # The middle offset IS the line, so it costs an index rather than a lookup.
                hi = np.where(np.isfinite(v), v, -np.inf).max(axis=0) / 3.048
                mid = v[len(offs) // 2] / 3.048
                # -1 means nobody sounded it. NOT zero, and not the deepest thing nearby --
                # uncharted has been mistaken for both in this file before and cost two bugs.
                q = lambda arr: [(-1 if not np.isfinite(x) else int(round(x))) for x in arr]
                env = q(lo)
                p2['envelope_ft'] = env
                p2['envelope_deep_ft'] = q(hi)
                p2['envelope_line_ft'] = q(mid)
                p2['envelope_m'] = a.envelope_m
                p2['envelope_step_m'] = a.envelope_step_m
                real = [x for x in env if x >= 0]
                if real:
                    # THE HONEST SHALLOWEST, and it replaces the centreline one because the
                    # centreline one describes a boat that does not exist. The old value is kept
                    # under its own name rather than deleted -- it is still what the chart says
                    # about the line, and the gap between the two is worth being able to see.
                    p2['shallowest_line_ft'] = p2.get('shallowest_ft')
                    p2['shallowest_ft'] = float(min(real))

            # Reachability is a property of a PASS, not of the run it was cut from: one half can
            # sit in a pocket the other half can be reached from.
            if idx is not None:
                step = max(1, len(ll) // 8)
                best = (None, float('inf'))
                for c in ll[::step]:
                    j, d = idx.nearest(c)
                    if j is not None and d < best[1]:
                        best = (j, d)
                j, d = best
                if j is not None and d <= a.reach_m:
                    p2['reach_node'] = j
                    p2['reach_m'] = round(d, 1)
                    p2['routable'] = bool(mainset and j in mainset)
                else:
                    p2.pop('reach_node', None)
                    p2.pop('reach_m', None)
                    p2['routable'] = False

            annotate(p2, ll, grid, cell, a.annotate_m, depth, lat0)
            out.append({'type': 'Feature', 'properties': p2,
                        'geometry': {'type': 'LineString', 'coordinates': ll}})

    # Same ordering the stitcher uses, so the app's positional `slug#index` keeps meaning the
    # same KIND of thing -- and an explicit id so it can stop being positional at all.
    out.sort(key=lambda f: -f['properties']['length_m'])
    for i, f in enumerate(out):
        f['properties']['id'] = '%s#%d' % (slug, i)

    st.update({'slug': slug, 'out': len(out), 'raster_s': round(t_raster, 1),
               'pack_s': round(time.time() - t_pack, 1),
               'grid_m': round(depth.step, 1), 'coarsened': round(depth.coarsened, 2),
               'poi_kinds': sorted({q[2] for q in pts})})
    if a.dry_run:
        return st

    # NEVER OVERWRITE AN EXISTING BACKUP. Running this twice used to move the FITTED file over
    # the original, so the second run destroyed the only copy of the contour geometry -- the
    # backup silently became a backup of the output. A second run keeps its own dated copy.
    bak = os.path.join(a.backup_dir, slug)
    os.makedirs(bak, exist_ok=True)
    dest = os.path.join(bak, 'trolling_runs.geojson')
    if os.path.exists(dest):
        n = 2
        while os.path.exists('%s.refit%d' % (dest, n)):
            n += 1
        dest = '%s.refit%d' % (dest, n)
    os.replace(rpath, dest)
    tmp = rpath + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump({'type': 'FeatureCollection', 'features': out}, fh)
    os.replace(tmp, rpath)
    return st


def _hms(sec):
    """Seconds under a minute, m:ss over it. `0.1 min` is six seconds of resolution on a number
    someone is watching to decide whether to let the card-wide run continue."""
    sec = float(sec)
    if sec < 60:
        return '%.1fs' % sec
    return '%d:%02d' % (int(sec // 60), int(round(sec % 60)))


def _fit_one(args):
    """`Pool.imap_unordered` passes one argument, so unpack here.

    MODULE LEVEL ON PURPOSE. Windows starts workers with `spawn`, not `fork`, which pickles the
    callable by qualified name -- a closure or a local would not survive the trip.
    """
    return fit_pack(*args)


def _absorb(r, rows, a, total):
    """One finished pack: record it, print its line, flush the report.

    PRINTED AS IT LANDS, NOT AT THE END. The single-job path was always a generator, so it
    streamed. `--jobs > 1` used `Pool.starmap`, which blocks until every pack is finished, so a
    card-wide run printed its header and then went silent for hours -- no way to tell grinding
    from hung. `_hms` above exists precisely because this is "a number someone is watching to
    decide whether to let the card-wide run continue", and the parallel path was the one place
    that number could never arrive in time to be watched.

    `imap_unordered` is what fixes it, and it is why the slug is read off the RESULT rather than
    zipped against the input order: results now arrive in whatever order the pool finishes them,
    which is the whole point. Every return path from `fit_pack` already carries `slug`.
    """
    if r is None:
        return                     # no trolling_runs.geojson here; nothing to say about it
    rows.append(r)
    n = len(rows)
    if 'skipped' in r:
        print('  [%d/%d] %-40s SKIP %s' % (n, total, r['slug'], r['skipped']), flush=True)
    else:
        # A percentage of nothing is not 100%. A pack that fitted no runs used to report
        # "100% removed / 100% kept", which reads as a clean sweep and is the opposite.
        tail = ('   corners %5d -> %5d   %.0f%% of fitted length kept'
                % (r['corners_before'], r['corners_after'], 100.0 * r['m_out'] / r['m_in'])
                ) if r['fitted'] else '   nothing fitted'
        # WALL CLOCK FOR THE PACK, with the raster called out separately. This used to print
        # `raster_s` alone, which reads as the pack's cost and is not -- on a big lake the raster
        # is seconds and the fitting is minutes, so the one number shown was the small one.
        print('  [%d/%d] %-40s %4d -> %4d runs   fitted %4d  split %3d  thin %3d%s   %s '
              '(raster %.1fs)%s'
              % (n, total, r['slug'], r['in'], r['out'], r['fitted'], r['split'], r['kept_thin'],
                 tail, _hms(r['pack_s']), r['raster_s'],
                 '  [grid %.0f m]' % r['grid_m'] if r['coarsened'] > 1.01 else ''), flush=True)
    # THE REPORT SURVIVES A KILL. Rewritten after every pack rather than once at the end: this
    # run is hours long, and a machine that reboots at hour six used to leave nothing behind.
    # The fitted packs themselves were always safe -- each writes its own file and
    # `_already_fitted` makes the run resumable -- so this closes the last gap. Swallowing the
    # error is deliberate: a locked or full report file must not kill six hours of fitting.
    if a.report:
        try:
            with open(a.report, 'w', encoding='utf-8') as fh:
                json.dump(rows, fh, indent=1)
        except Exception:
            pass


def _already_fitted(path, probe=200_000):
    """Has this pack been through the fitter? Reads the head of the file, not all of it."""
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            head = fh.read(probe)
        return '"fitted"' in head
    except Exception:
        return False


def ship_only_slugs(registry):
    p = os.path.join(registry, 'charted.json')
    with open(p, 'r', encoding='utf-8') as fh:
        d = json.load(fh)
    rows = d.get('lakes') or d.get('records') or d
    if isinstance(rows, dict):
        rows = list(rows.values())
    keep = set()
    for r in rows:
        if isinstance(r, dict) and not r.get('skipped') and r.get('slug'):
            keep.add(r['slug'])
    return keep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--packs', required=True)
    ap.add_argument('--only', default=None, help='one slug. Wins over --ship-only.')
    ap.add_argument('--ship-only', action='store_true')
    ap.add_argument('--registry', default=None)
    ap.add_argument('--max-turn-deg', type=float, default=35.0,
                    help='sharpest corner the line may ask for; sharper than this ends the pass')
    ap.add_argument('--min-leg-m', type=float, default=1500.0,
                    help='a piece shorter than this is not a trolling pass. 1500 m is not a '
                         'taste: it is selectCandidates() own floor (plan-candidates.js, '
                         'minM 1500), so anything shorter is a pass the app will never offer')
    ap.add_argument('--min-fit-m', type=float, default=800.0,
                    help='runs shorter than this keep the contour geometry')
    ap.add_argument('--min-stretch-m', type=float, default=500.0,
                    help='in-band stretch short enough not to bother smoothing; the real test '
                         'is --min-leg-m on the finished pass')
    ap.add_argument('--resample-m', type=float, default=25.0)
    ap.add_argument('--max-pts', type=int, default=200,
                    help='most vertices the smoother will carry for one stretch; longer '
                         'stretches get proportionally coarser spacing rather than more points')
    ap.add_argument('--grid-m', type=float, default=12.0)
    ap.add_argument('--max-cells', type=float, default=40_000_000)
    ap.add_argument('--safety-cells', type=int, default=1)
    ap.add_argument('--deep-bias-m', type=float, default=1.5)
    # THE DEEP SIDE GETS ITS OWN, MUCH LOOSER PAIR. See split_to_band: a gap that is only too
    # deep cannot put a bait on the bottom, and cutting on it was the largest single source of
    # fragmentation in the pipeline. 300 m and 30 dm (about 10 ft) came off the measured sweep on
    # 60 Wateree contours -- it takes stage one from 752 pieces at a 116 m median to 142 at 964 m
    # while KEEPING more water, not less. Set them equal to --bridge-m/--bridge-dm to get the old
    # symmetric behaviour back.
    ap.add_argument('--deep-bridge-m', type=float, default=300.0,
                    help='how far a purely-too-deep gap may be bridged; the shallow side uses '
                         '--bridge-m and stays tight because only it is a safety rule')
    ap.add_argument('--deep-bridge-dm', type=float, default=30.0,
                    help='how far past the ceiling a bridged gap may reach')
    ap.add_argument('--bridge-m', type=float, default=40.0,
                    help='a thin patch shorter than this MAY be raster noise, not a shoal')
    ap.add_argument('--bridge-dm', type=float, default=6.0,
                    help='...but only if it is within this many decimetres of the floor; deeper '
                         'than that it is a real shoal and ends the pass however narrow it is')
    ap.add_argument('--seed-push-m', type=float, default=20.0,
                    help='how far the line may be stepped onto the deep side of its own contour '
                         'before fitting starts')
    ap.add_argument('--tol-dm', type=float, default=3.0,
                    help='how far BELOW its own depth a pass may run (decimetres)')
    ap.add_argument('--ceiling-dm', type=float, default=24.0,
                    help='how far ABOVE its own depth a pass may run; 24 dm is about 8 ft, so '
                         'an 18 ft line stays roughly 17-26 ft. Without this the line drifts '
                         'off the ledge into the channel, which is not what is being trolled')
    ap.add_argument('--iters', type=int, default=250)
    ap.add_argument('--only-lakes', default=None,
                    help='comma list, a file path, or @file of SLUGS, matching the four build '
                         'scripts. Combines with --ship-only; --only still wins over both.')
    ap.add_argument('--jobs', type=int, default=1,
                    help='packs in parallel. Each one is independent -- its own raster, its own '
                         'file -- so this scales with cores and nothing is shared')
    # HOW FAR HE ACTUALLY WANDERS, and how often to ask. 25 m either side is his own revision
    # of 50: "i dont think i sway 150 ft to a side... that is probably over stating it by a lot".
    # 40 m along is one sample per ~20 seconds of trolling, which is finer than he can steer.
    ap.add_argument('--envelope-m', type=float, default=25.0,
                    help='half-width of the wander envelope the shallowest depth is read across')
    ap.add_argument('--envelope-step-m', type=float, default=40.0,
                    help='spacing of envelope samples along the pass')
    ap.add_argument('--annotate-m', type=float, default=100.0)
    ap.add_argument('--reach-m', type=float, default=120.0)
    ap.add_argument('--backup-dir', default=None,
                    help='where the original trolling_runs.geojson goes; default '
                         '<packs>/../_to_delete/pre_fit_runs')
    ap.add_argument('--limit', type=int, default=0, help='stop after N packs; for testing')
    ap.add_argument('--refit', action='store_true',
                    help='fit a pack that has already been fitted. Restore the original from '
                         '_to_delete/pre_fit_runs first -- otherwise it smooths its own output '
                         'and trims already-trimmed passes, and the summary will not say so')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--report', default=None)
    a = ap.parse_args()

    if a.backup_dir is None:
        a.backup_dir = os.path.join(os.path.dirname(a.packs.rstrip('/\\')),
                                    '_to_delete', 'pre_fit_runs')

    if a.only:
        slugs = [a.only]
    else:
        slugs = sorted(d for d in os.listdir(a.packs)
                       if os.path.isdir(os.path.join(a.packs, d)))
        if a.only_lakes:
            # The fifth script to need this and the last to get it. --ship-only is NOT a
            # substitute: it selects from charted.json, which still carries every lake the
            # region cut removed, so a "scoped" fit ran 858 packs against a 455-lake card.
            raw = a.only_lakes
            if raw.startswith('@'):
                raw = open(raw[1:], encoding='utf-8').read()
            elif os.path.exists(raw):
                raw = open(raw, encoding='utf-8').read()
            want = {x.strip() for x in raw.replace('\n', ',').split(',') if x.strip()}
            missing = want - set(slugs)
            slugs = [d for d in slugs if d in want]
            print('--only-lakes: %d of %d requested slugs have a pack directory'
                  % (len(slugs), len(want)))
            if missing:
                print('   %d named but not present: %s'
                      % (len(missing), ', '.join(sorted(missing)[:6])))
            if not slugs:
                sys.exit('STOP: --only-lakes matched no pack directory at all. Nothing fitted.')
        if a.ship_only:
            if not a.registry:
                print('--ship-only needs --registry'); sys.exit(2)
            try:
                keep = ship_only_slugs(a.registry)
            except Exception as e:
                # EXIT rather than fall back to the whole card. Same rule the stitcher uses: a
                # flag that silently means its opposite is worse than a flag that fails.
                print('--ship-only: could not read charted.json: %s' % e); sys.exit(2)
            slugs = [s for s in slugs if s in keep]

    if a.limit:
        slugs = slugs[:a.limit]
    print('%d pack(s)%s%s' % (len(slugs), ' [DRY RUN]' if a.dry_run else '',
                              ('  x%d jobs' % a.jobs) if a.jobs > 1 else ''))
    rows, t0 = [], time.time()

    # ONE PACK, ONE LINE, AS SOON AS IT IS DONE -- on both paths. See `_absorb`.
    total = len(slugs)
    if a.jobs > 1:
        from multiprocessing import Pool
        with Pool(a.jobs) as pool:
            for r in pool.imap_unordered(
                    _fit_one, [(os.path.join(a.packs, s), a) for s in slugs], chunksize=1):
                _absorb(r, rows, a, total)
    else:
        for s in slugs:
            _absorb(fit_pack(os.path.join(a.packs, s), a), rows, a, total)

    done = [r for r in rows if 'skipped' not in r]
    if done:
        done = [r for r in done if r['fitted']] or done
        cb = sum(r['corners_before'] for r in done)
        ca = sum(r['corners_after'] for r in done)
        print('\n%d packs, %d runs in, %d out, %d split into passes'
              % (len(done), sum(r['in'] for r in done), sum(r['out'] for r in done),
                 sum(r['split'] for r in done)))
        mi = sum(r['m_in'] for r in done)
        mo = sum(r['m_out'] for r in done)
        el = time.time() - t0
        slowest = max(done, key=lambda r: r['pack_s'])
        print('corners on fitted runs: %d -> %d (%.0f%% removed) in %s wall clock'
              % (cb, ca, 100.0 * (cb - ca) / cb if cb else 0, _hms(el)))
        print('slowest pack: %s at %s;  median %s;  %s of CPU across %d packs'
              % (slowest['slug'], _hms(slowest['pack_s']),
                 _hms(sorted(r['pack_s'] for r in done)[len(done) // 2]),
                 _hms(sum(r['pack_s'] for r in done)), len(done)))
        print('fitted length: %.0f km in, %.0f km out (%.0f%% kept; the rest was pieces under '
              'the %.0f m minimum leg)' % (mi / 1000, mo / 1000,
                                           100.0 * mo / mi if mi else 100.0, a.min_leg_m))
        if not a.dry_run:
            print('originals moved to %s' % a.backup_dir)
    if a.report:
        with open(a.report, 'w', encoding='utf-8') as fh:
            json.dump(rows, fh, indent=1)
        print('report -> %s' % a.report)


if __name__ == '__main__':
    main()
