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
        i = np.clip(np.round((xy[:, 0] - self.x0) / self.step).astype(int), 0, self.nx - 1)
        j = np.clip(np.round((xy[:, 1] - self.y0) / self.step).astype(int), 0, self.ny - 1)
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


def _seg_min(depth, a, b, sample_m=5.0):
    """Shallowest charted water anywhere along each segment. Uncharted sorts below every real
    depth, because unsurveyed is not the same as deep and must never win a comparison."""
    seg = b - a
    L = np.hypot(seg[:, 0], seg[:, 1])
    if not len(L):
        return np.array([])
    n = max(1, int(math.ceil(float(L.max()) / sample_m)))
    out = np.full(len(a), np.inf)
    for i in range(n + 1):
        d = depth.at(a + seg * (i / n))
        out = np.fmin(out, np.where(np.isnan(d), -1.0, d))
    return out


def smooth(xy0, depth, floor_dm, target_dm, iters, deep_bias_m):
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

        cur_seg = _no_licence(_seg_min(depth, xy[:-1], xy[1:]))
        cur_pt = _no_licence(depth.at(xy))
        alpha = np.ones(len(xy))

        def bad_at(al):
            cand = xy + step * al[:, None]
            dp = depth.at(cand)
            dp = np.where(np.isnan(dp), -1.0, dp)
            b = (dp < floor_dm) & (dp < cur_pt)
            sm = _seg_min(depth, cand[:-1], cand[1:])
            seg = (sm < floor_dm) & (sm < cur_seg)
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


def chord_pass(xy, depth, floor_dm, max_turn_deg, max_chord_m=2500.0):
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
    seg_min_all = _no_licence(_seg_min(depth, xy[:-1], xy[1:]))
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
        in_cap = out_cap = None
        was = float('inf')
        j = i + 1
        while j < n:
            was = min(was, float(seg_min_all[j - 1]))
            if j > i + 1 and (j - i - 1) % stride and j < n - 1:
                j += 1
                continue
            w = xy[j] - xy[i]
            wlen = float(np.hypot(*w))
            if wlen > max_chord_m:
                break
            turn = 0.0
            if wlen > 1e-6 and heading is not None:
                turn = abs((math.degrees(math.atan2(w[1], w[0])) - heading + 180) % 360 - 180)
            got = float(_seg_min(depth, xy[i:i + 1], xy[j:j + 1], sample_m=10.0)[0])
            # STRICT, and this replaced a rule that leaked badly. Allowing a chord to be "no
            # worse than the shallowest point of the stretch it replaces" meant ONE thin spot
            # anywhere in a stretch licensed the whole chord to run that shallow: on Wateree
            # River it put 12 of 21 fitted runs more than 6 ft above their own target depth and
            # threw away half the length doing it. A brief dip is not permission for a sustained
            # shallow mile. `was` is still computed and still bounds the short fallback below.
            if got >= floor_dm or (got >= was and wlen <= 400.0):
                if turn <= max_turn_deg:
                    # Longest wins; a chord within 5% of it that runs DEEPER wins over it.
                    if in_cap is None or wlen > in_cap[1] * 1.05:
                        in_cap = (j, wlen, turn, got)
                    elif wlen > in_cap[1] * 0.95 and got > in_cap[3]:
                        in_cap = (j, wlen, turn, got)
                elif out_cap is None or turn < out_cap[2]:
                    out_cap = (j, wlen, turn, got)
            j += 1
        pick = in_cap or out_cap or (i + 1, 0.0, 0.0, 0.0)
        out.append(pick[0])
        i = pick[0]
    return xy[out]


def seed_deep(xy, depth, target_dm, max_push_m=30.0, step_m=3.0):
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
            take = (cd > best_d) & (best_d < target_dm)
            best[take] = cand[take]
            best_d[take] = cd[take]
        off += step_m
    return best


def split_at_thin_water(xy, depth, floor_dm, min_leg_m, step_m=10.0, bridge_m=40.0,
                        bridge_dm=6.0):
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
    """
    even, total = _resample(xy, step_m)
    if total <= 0:
        return []
    # `at_raw`, deliberately. Which stretches are in band is a MEASUREMENT; the safety buffer
    # belongs in deciding where the boat may move, not in deciding what the chart says.
    d = depth.at_raw(even)
    ok = ~(np.isnan(d) | (d < floor_dm))
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
    dfill = np.where(np.isnan(d), -1.0, d)
    i, n = 0, len(ok)
    while i < n:
        if ok[i]:
            i += 1
            continue
        j = i
        while j < n and not ok[j]:
            j += 1
        if (j - i) <= gap and i > 0 and j < n \
                and float(dfill[i:j].min()) >= floor_dm - bridge_dm:
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
    t = _turns(xy)
    bounds = [0] + [i + 1 for i, a in enumerate(t) if a > max_turn_deg] + [len(xy) - 1]
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
    slug = os.path.basename(pack.rstrip('/\\'))
    rpath = os.path.join(pack, 'trolling_runs.geojson')
    dpath = os.path.join(pack, 'depth_areas.geojson')
    if not os.path.isfile(rpath):
        return None
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
        seeded = seed_deep(xy0, depth, float(pr['depth_dm']), a.seed_push_m)
        # ONE MEANINGFUL THRESHOLD, APPLIED ONCE, AT THE END.
        #
        # Gating the in-band stretch at `min_leg_m` AND the finished pass at `min_leg_m` rejected
        # everything that only just qualified: smoothing shortens a line by cutting its corners,
        # so a 1,319 m stretch comes out at about 1,150 m and vanishes against the same gate it
        # had already passed. after_bay_reservoir fitted nothing at all for this reason while
        # carrying 13 runs with in-band water in them. The stretch gate is now only "long enough
        # to be worth smoothing"; whether it is a trolling pass is decided on the finished line.
        for stretch in split_at_thin_water(seeded, depth, floor, a.min_stretch_m,
                                           bridge_m=a.bridge_m, bridge_dm=a.bridge_dm):
            even, _ = _resample(stretch, a.resample_m)
            sm = smooth(even, depth, floor, float(pr['depth_dm']), a.iters, a.deep_bias_m)
            ch = chord_pass(sm, depth, floor, a.max_turn_deg)
            pieces.extend(split_at_hard_corners(ch, a.max_turn_deg, a.min_leg_m))
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
            draw = depth.at_raw(_resample(piece, 10.0)[0])
            if np.any(~np.isnan(draw)):
                p2['shallowest_ft'] = round(float(np.nanmin(draw)) / 3.048, 1)

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
    ap.add_argument('--grid-m', type=float, default=12.0)
    ap.add_argument('--max-cells', type=float, default=40_000_000)
    ap.add_argument('--safety-cells', type=int, default=1)
    ap.add_argument('--deep-bias-m', type=float, default=1.5)
    ap.add_argument('--bridge-m', type=float, default=40.0,
                    help='a thin patch shorter than this MAY be raster noise, not a shoal')
    ap.add_argument('--bridge-dm', type=float, default=6.0,
                    help='...but only if it is within this many decimetres of the floor; deeper '
                         'than that it is a real shoal and ends the pass however narrow it is')
    ap.add_argument('--seed-push-m', type=float, default=20.0,
                    help='how far the line may be stepped onto the deep side of its own contour '
                         'before fitting starts')
    ap.add_argument('--tol-dm', type=float, default=3.0)
    ap.add_argument('--iters', type=int, default=250)
    ap.add_argument('--jobs', type=int, default=1,
                    help='packs in parallel. Each one is independent -- its own raster, its own '
                         'file -- so this scales with cores and nothing is shared')
    ap.add_argument('--annotate-m', type=float, default=100.0)
    ap.add_argument('--reach-m', type=float, default=120.0)
    ap.add_argument('--backup-dir', default=None,
                    help='where the original trolling_runs.geojson goes; default '
                         '<packs>/../_to_delete/pre_fit_runs')
    ap.add_argument('--limit', type=int, default=0, help='stop after N packs; for testing')
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

    if a.jobs > 1:
        from multiprocessing import Pool
        with Pool(a.jobs) as pool:
            results = pool.starmap(fit_pack,
                                   [(os.path.join(a.packs, s), a) for s in slugs], chunksize=1)
    else:
        results = (fit_pack(os.path.join(a.packs, s), a) for s in slugs)

    for s, r in zip(slugs, results):
        if r is None:
            continue
        rows.append(r)
        if 'skipped' in r:
            print('  %-40s SKIP %s' % (s, r['skipped']))
            continue
        # A percentage of nothing is not 100%. A pack that fitted no runs used to report
        # "100% removed / 100% kept", which reads as a clean sweep and is the opposite.
        tail = ('   corners %5d -> %5d   %.0f%% of fitted length kept'
                % (r['corners_before'], r['corners_after'], 100.0 * r['m_out'] / r['m_in'])
                ) if r['fitted'] else '   nothing fitted'
        print('  %-40s %4d -> %4d runs   fitted %4d  split %3d  thin %3d%s   %.1fs%s'
              % (s, r['in'], r['out'], r['fitted'], r['split'], r['kept_thin'], tail,
                 r['raster_s'], '  [grid %.0f m]' % r['grid_m'] if r['coarsened'] > 1.01 else ''))

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
        print('corners on fitted runs: %d -> %d (%.0f%% removed) in %.1f min'
              % (cb, ca, 100.0 * (cb - ca) / cb if cb else 0, (time.time() - t0) / 60))
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
