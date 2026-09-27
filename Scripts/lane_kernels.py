#!/usr/bin/env python3
"""lane_kernels.py - the compiled inner loops of build_trolling_runs.py and fit_trolling_runs.py.

Personal use only, not for distribution or resale; not for navigation.

WHY THIS FILE EXISTS

Ryan, 2026-09-27: *"lets actually improve that script and make it not so costly to run... the
initial trolling runs and the refit take forever... need to speed them up and then run them on all
lakes"*. Profiled on a copy of Wateree the same day (`_scratch/speedlab`):

    build_trolling_runs   46.7 s   35.1 s of it in steer() -> chord_ok() -> DepthIndex, 3.7 M
                                   calls to _in_ring(), each a handful of numpy calls on a few
                                   hundred edges. The arithmetic is nothing; the call overhead is
                                   everything.
    fit_trolling_runs    196.3 s   141.6 s in smooth(), 1.1 M calls each to _seg_min/_seg_max on
                                   arrays of ~200 segments -- again overhead -- and 29.7 s building
                                   the raster with matplotlib's point-in-polygon on every cell of
                                   every polygon's bounding box.

Nothing about the ANSWER was slow. So nothing about the answer changes here.

EVERY FUNCTION IN THIS FILE REPRODUCES A COMPUTATION THE TWO SCRIPTS ALREADY DID, BIT FOR BIT.

That is the rule this file lives by, and it is why the arithmetic is written out long-hand in the
same order as the numpy it replaces rather than tidied: a lane is only as trustworthy as the depth
test that cut it, and "faster but a few cells different" would mean re-checking every lake the
card ever shipped. The scripts keep their numpy paths as the fallback when numba is missing, and
`test_lane_kernels.py` holds the two against each other on real packs.

Three details that make "bit for bit" true rather than hoped for:

- **float32 stays float32.** The rasters are float32, and numpy 2 compares a float32 array with a
  Python float IN float32 (NEP 50). Every threshold is therefore cast to float32 before it is
  compared here, and the one product numpy does in float32 (`deeper_dir * deep_bias_m`) is done in
  float32 here too.
- **No fused multiply-add.** numba compiles without fastmath unless told otherwise, so `a*b + c`
  rounds twice, as numpy does.
- **The same sample points.** `np.linspace(0, 1, n + 1)` is `k * (1.0 / n)` with the last value
  pinned to 1.0; that is what numpy computes, so that is what is computed here.
"""
import math

import numpy as np

try:
    from numba import njit
    HAVE_NUMBA = True
except Exception:                                # the scripts fall back to their numpy paths
    HAVE_NUMBA = False

    def njit(*a, **k):                           # keeps this module importable without numba
        def wrap(f):
            return f
        return wrap if not (a and callable(a[0])) else a[0]


# ════════════════════════════════════════════════════════════════════════════════════════════════
# 1. build_trolling_runs.py -- DepthIndex.shallowest_dm() and chord_ok(), compiled
# ════════════════════════════════════════════════════════════════════════════════════════════════
#
# The ray cast is DepthIndex._in_ring() exactly: edge i runs vertex i -> i-1, it counts when
# (yi > y) != (yj > y), and the point is inside when an odd number of those edges satisfy
# x < dx * (y - yi) * inv_dy + xi. Only two things are new, and neither changes an answer:
#
# - EDGES ARE BUCKETED BY LATITUDE. An edge can only satisfy the straddle test for a y between its
#   two ends, so each ring keeps its edges in horizontal strips and a query reads one strip instead
#   of the whole ring. The strip is found with the same monotone arithmetic that filed the edge, so
#   every edge that could straddle y is in the strip y lands in. The count is the same count.
# - THE GRID IS A DENSE TABLE, not a dict of tuples. Same cells, same candidate order.

@njit(cache=True)
def _build_strips(E_yi, E_yj, ring_start, ring_len, ring_ymin, ring_inv_h, ring_ns):
    """CSR of edge indices per (ring, strip). Returns (ring_sbase, strip_start, strip_edge)."""
    nr = ring_start.shape[0]
    ring_sbase = np.zeros(nr + 1, np.int64)
    for r in range(nr):
        ring_sbase[r + 1] = ring_sbase[r] + ring_ns[r]
    total = ring_sbase[nr]
    counts = np.zeros(total + 1, np.int64)
    for r in range(nr):
        ns = ring_ns[r]
        ymin = ring_ymin[r]
        inv = ring_inv_h[r]
        base = ring_sbase[r]
        for e in range(ring_start[r], ring_start[r] + ring_len[r]):
            a = E_yi[e]
            b = E_yj[e]
            if a == b:
                continue                          # horizontal: never straddles
            lo = a if a < b else b
            hi = b if a < b else a
            s0 = int((lo - ymin) * inv)
            s1 = int((hi - ymin) * inv)
            if s0 < 0:
                s0 = 0
            if s1 > ns - 1:
                s1 = ns - 1
            for s in range(s0, s1 + 1):
                counts[base + s + 1] += 1
    strip_start = np.zeros(total + 1, np.int64)
    for s in range(total):
        strip_start[s + 1] = strip_start[s] + counts[s + 1]
    fill = strip_start[:-1].copy()
    strip_edge = np.empty(strip_start[total], np.int64)
    for r in range(nr):
        ns = ring_ns[r]
        ymin = ring_ymin[r]
        inv = ring_inv_h[r]
        base = ring_sbase[r]
        for e in range(ring_start[r], ring_start[r] + ring_len[r]):
            a = E_yi[e]
            b = E_yj[e]
            if a == b:
                continue
            lo = a if a < b else b
            hi = b if a < b else a
            s0 = int((lo - ymin) * inv)
            s1 = int((hi - ymin) * inv)
            if s0 < 0:
                s0 = 0
            if s1 > ns - 1:
                s1 = ns - 1
            for s in range(s0, s1 + 1):
                strip_edge[fill[base + s]] = e
                fill[base + s] += 1
    return ring_sbase, strip_start, strip_edge


@njit(cache=True)
def _in_ring_k(r, x, y, E_xi, E_yi, E_yj, E_dx, E_inv, ring_ymin, ring_ymax, ring_inv_h, ring_ns,
               ring_sbase, strip_start, strip_edge):
    if not (y >= ring_ymin[r] and y < ring_ymax[r]):
        return False                              # nothing can straddle outside [ymin, ymax)
    ns = ring_ns[r]
    s = int((y - ring_ymin[r]) * ring_inv_h[r])
    if s < 0:
        s = 0
    if s > ns - 1:
        s = ns - 1
    k = ring_sbase[r] + s
    c = 0
    for q in range(strip_start[k], strip_start[k + 1]):
        e = strip_edge[q]
        yi = E_yi[e]
        if (yi > y) != (E_yj[e] > y):
            if x < E_dx[e] * (y - yi) * E_inv[e] + E_xi[e]:
                c += 1
    return (c & 1) == 1


NO_DEPTH = -(2 ** 62)                             # shallowest_dm() returning None


@njit(cache=True)
def _shallowest_k(x, y, cell, gx0, gy0, gw, gh, cell_start, cell_poly, poly_box, poly_ring0,
                  poly_nring, poly_hi, E_xi, E_yi, E_yj, E_dx, E_inv, ring_ymin, ring_ymax,
                  ring_inv_h, ring_ns, ring_sbase, strip_start, strip_edge):
    gx = int(x / cell) - gx0
    gy = int(y / cell) - gy0
    if gx < 0 or gy < 0 or gx >= gw or gy >= gh:
        return NO_DEPTH
    c = gx * gh + gy
    for q in range(cell_start[c], cell_start[c + 1]):
        p = cell_poly[q]
        if not (poly_box[p, 0] <= x <= poly_box[p, 2] and poly_box[p, 1] <= y <= poly_box[p, 3]):
            continue
        r0 = poly_ring0[p]
        if not _in_ring_k(r0, x, y, E_xi, E_yi, E_yj, E_dx, E_inv, ring_ymin, ring_ymax,
                          ring_inv_h, ring_ns, ring_sbase, strip_start, strip_edge):
            continue
        island = False
        for h in range(r0 + 1, r0 + poly_nring[p]):
            if _in_ring_k(h, x, y, E_xi, E_yi, E_yj, E_dx, E_inv, ring_ymin, ring_ymax,
                          ring_inv_h, ring_ns, ring_sbase, strip_start, strip_edge):
                island = True
                break
        if island:
            continue
        return poly_hi[p]
    return NO_DEPTH


@njit(cache=True)
def _chord_ok_k(ax, ay, bx, by, dm, samples, tol_dm, cell, gx0, gy0, gw, gh, cell_start,
                cell_poly, poly_box, poly_ring0, poly_nring, poly_hi, E_xi, E_yi, E_yj, E_dx,
                E_inv, ring_ymin, ring_ymax, ring_inv_h, ring_ns, ring_sbase, strip_start,
                strip_edge):
    n = samples if samples > 2 else 2
    for i in range(1, n):
        t = i / float(n)
        x = ax + (bx - ax) * t
        y = ay + (by - ay) * t
        hi = _shallowest_k(x, y, cell, gx0, gy0, gw, gh, cell_start, cell_poly, poly_box,
                           poly_ring0, poly_nring, poly_hi, E_xi, E_yi, E_yj, E_dx, E_inv,
                           ring_ymin, ring_ymax, ring_inv_h, ring_ns, ring_sbase, strip_start,
                           strip_edge)
        if hi == NO_DEPTH or hi < dm - tol_dm:
            return False
    return True


class CompiledDepthIndex:
    """The flat, compiled twin of build_trolling_runs.DepthIndex. Built FROM one, so the polygons,
    boxes, sort order and grid cells are that object's own and nothing is re-derived."""

    STRIP_EDGES = 8.0                             # ~edges per strip; only speed depends on it

    def __init__(self, dindex):
        polys = dindex.polys
        xi, yi, yj, dx, inv = [], [], [], [], []
        ring_start, ring_len, ring_ymin, ring_ymax = [], [], [], []
        poly_ring0, poly_nring, poly_hi, poly_box = [], [], [], []
        off = 0
        nring = 0
        for flat, hi, box in polys:
            poly_ring0.append(nring)
            poly_nring.append(len(flat))
            poly_hi.append(int(hi))
            poly_box.append(box)
            for ring in flat:
                rxi, ryi, ryj, rdx, rinv = (np.asarray(v, dtype=np.float64) for v in ring)
                n = len(rxi)
                xi.append(rxi); yi.append(ryi); yj.append(ryj); dx.append(rdx); inv.append(rinv)
                ring_start.append(off)
                ring_len.append(n)
                if n:
                    ring_ymin.append(float(min(ryi.min(), ryj.min())))
                    ring_ymax.append(float(max(ryi.max(), ryj.max())))
                else:
                    ring_ymin.append(0.0)
                    ring_ymax.append(0.0)
                off += n
                nring += 1
        cat = lambda L: np.concatenate(L) if L else np.zeros(0, np.float64)
        self.E_xi, self.E_yi, self.E_yj = cat(xi), cat(yi), cat(yj)
        self.E_dx, self.E_inv = cat(dx), cat(inv)
        self.ring_start = np.asarray(ring_start, np.int64)
        self.ring_len = np.asarray(ring_len, np.int64)
        self.ring_ymin = np.asarray(ring_ymin, np.float64)
        self.ring_ymax = np.asarray(ring_ymax, np.float64)
        ns = np.maximum(1, np.minimum(4096, (self.ring_len / self.STRIP_EDGES).astype(np.int64)))
        span = self.ring_ymax - self.ring_ymin
        self.ring_ns = ns.astype(np.int64)
        self.ring_inv_h = np.where(span > 0, self.ring_ns / np.where(span > 0, span, 1.0), 0.0)
        self.ring_sbase, self.strip_start, self.strip_edge = _build_strips(
            self.E_yi, self.E_yj, self.ring_start, self.ring_len, self.ring_ymin,
            self.ring_inv_h, self.ring_ns)
        self.poly_ring0 = np.asarray(poly_ring0, np.int64)
        self.poly_nring = np.asarray(poly_nring, np.int64)
        self.poly_hi = np.asarray(poly_hi, np.int64)
        self.poly_box = np.asarray(poly_box, np.float64).reshape(-1, 4)

        # THE GRID, dense. Same keys DepthIndex filed under, same order inside each cell.
        self.cell = float(dindex.cell)
        keys = list(dindex.grid.keys())
        if keys:
            gxs = [k[0] for k in keys]
            gys = [k[1] for k in keys]
            self.gx0, self.gy0 = min(gxs), min(gys)
            self.gw, self.gh = max(gxs) - self.gx0 + 1, max(gys) - self.gy0 + 1
        else:
            self.gx0 = self.gy0 = 0
            self.gw = self.gh = 1
        counts = np.zeros(self.gw * self.gh + 1, np.int64)
        for (gx, gy), lst in dindex.grid.items():
            counts[(gx - self.gx0) * self.gh + (gy - self.gy0) + 1] = len(lst)
        self.cell_start = np.cumsum(counts)
        self.cell_poly = np.empty(int(self.cell_start[-1]), np.int64)
        for (gx, gy), lst in dindex.grid.items():
            c = (gx - self.gx0) * self.gh + (gy - self.gy0)
            self.cell_poly[self.cell_start[c]:self.cell_start[c] + len(lst)] = lst
        self._args = (self.cell, self.gx0, self.gy0, self.gw, self.gh, self.cell_start,
                      self.cell_poly, self.poly_box, self.poly_ring0, self.poly_nring,
                      self.poly_hi, self.E_xi, self.E_yi, self.E_yj, self.E_dx, self.E_inv,
                      self.ring_ymin, self.ring_ymax, self.ring_inv_h, self.ring_ns,
                      self.ring_sbase, self.strip_start, self.strip_edge)

    def shallowest_dm(self, x, y):
        v = _shallowest_k(float(x), float(y), *self._args)
        return None if v == NO_DEPTH else int(v)

    def chord_ok(self, a, b, dm, samples, tol_dm):
        # dm and tol as floats: `hi < dm - tol_dm` compares an int with whatever the contour
        # carried, exactly as Python does, and a float depth_dm must not be truncated first.
        return bool(_chord_ok_k(float(a[0]), float(a[1]), float(b[0]), float(b[1]), float(dm),
                                int(samples), float(tol_dm), *self._args))


# ════════════════════════════════════════════════════════════════════════════════════════════════
# 2. fit_trolling_runs.py -- the raster, compiled
# ════════════════════════════════════════════════════════════════════════════════════════════════
#
# DepthRaster filled each polygon by asking matplotlib's Path.contains_points about every cell
# centre in the polygon's bounding box: O(cells x edges), and on Wateree 29.7 s of the fit.
#
# This asks the SAME question the same way -- matplotlib's crossings test from _path.h
# (point_in_path_impl), same edges in the same order, same inequality -- but walks it by edge
# instead of by cell. Along one row of cell centres the test for one edge,
#
#     ((vty1 - ty) * (vtx0 - vtx1) >= (vtx1 - tx) * (vty0 - vty1)) == yflag1
#
# is monotone in tx, because the only term that moves is (vtx1 - tx) times a constant, and floating
# subtraction and multiplication are both monotone. So the cells an edge toggles along a row are a
# prefix or a suffix of it, found by binary search on the exact expression rather than by a
# computed crossing point. Parity is then a running XOR along the row. Same cells, every time.

@njit(cache=True)
def _ring_inside_grid(rx, ry, xs, ys):
    """matplotlib `Path(ring).contains_points` over the grid xs x ys ('ij'), as uint8 (na, nb)."""
    na = xs.shape[0]
    nb = ys.shape[0]
    out = np.zeros((na, nb), np.uint8)
    nv = rx.shape[0]
    if nv < 3:                                    # matplotlib: fewer than 3 vertices -> nothing
        return out
    diff = np.zeros((na + 1, nb), np.uint8)
    for k in range(nv):
        if k < nv - 1:
            vtx0 = rx[k]
            vty0 = ry[k]
            vtx1 = rx[k + 1]
            vty1 = ry[k + 1]
        else:                                     # the closing edge, last -> first
            vtx0 = rx[nv - 1]
            vty0 = ry[nv - 1]
            vtx1 = rx[0]
            vty1 = ry[0]
        if vty0 == vty1:
            continue                              # yflag0 == yflag1 for every row
        lo = vty0 if vty0 < vty1 else vty1
        hi = vty1 if vty0 < vty1 else vty0
        b = np.searchsorted(ys, lo, side='right')  # first row with ty > lo
        dd = vty0 - vty1
        dxv = vtx0 - vtx1
        while b < nb and ys[b] <= hi:
            ty = ys[b]
            yflag0 = vty0 >= ty
            yflag1 = vty1 >= ty
            if yflag0 != yflag1:
                A = (vty1 - ty) * dxv
                # s = first column where the inequality's truth value flips
                lo_i = 0
                hi_i = na
                if dd > 0:                        # P false ... true: find first true
                    while lo_i < hi_i:
                        mid = (lo_i + hi_i) >> 1
                        if A >= (vtx1 - xs[mid]) * dd:
                            hi_i = mid
                        else:
                            lo_i = mid + 1
                    s = lo_i                      # P true on [s, na)
                    if yflag1:
                        a0, a1 = s, na
                    else:
                        a0, a1 = 0, s
                else:                             # P true ... false: find first false
                    while lo_i < hi_i:
                        mid = (lo_i + hi_i) >> 1
                        if not (A >= (vtx1 - xs[mid]) * dd):
                            hi_i = mid
                        else:
                            lo_i = mid + 1
                    s = lo_i                      # P true on [0, s)
                    if yflag1:
                        a0, a1 = 0, s
                    else:
                        a0, a1 = s, na
                if a0 < a1:
                    diff[a0, b] ^= 1
                    diff[a1, b] ^= 1
            b += 1
    for bb in range(nb):
        acc = 0
        for a in range(na):
            acc ^= diff[a, bb]
            out[a, bb] = acc
    return out


def ring_inside_grid(ring_xy, xs, ys):
    """Flat boolean mask in `np.meshgrid(xs, ys, indexing='ij')` ravel order."""
    r = np.ascontiguousarray(ring_xy, dtype=np.float64)
    return _ring_inside_grid(r[:, 0].copy(), r[:, 1].copy(),
                             np.ascontiguousarray(xs, np.float64),
                             np.ascontiguousarray(ys, np.float64)).ravel().astype(bool)


# ════════════════════════════════════════════════════════════════════════════════════════════════
# 3. fit_trolling_runs.py -- raster reads and the smoother, compiled
# ════════════════════════════════════════════════════════════════════════════════════════════════

@njit(cache=True)
def _cell(x, y, x0, y0, inv, nx, ny):
    # ((x - x0) * inv + 0.5).astype(intp), then clipped: truncation toward zero, as astype does.
    i = int((x - x0) * inv + 0.5)
    j = int((y - y0) * inv + 0.5)
    if i < 0:
        i = 0
    elif i > nx - 1:
        i = nx - 1
    if j < 0:
        j = 0
    elif j > ny - 1:
        j = ny - 1
    return i, j


@njit(cache=True)
def lookup(dm, x0, y0, inv, nx, ny, xy):
    n = xy.shape[0]
    out = np.empty(n, dm.dtype)
    for k in range(n):
        i, j = _cell(xy[k, 0], xy[k, 1], x0, y0, inv, nx, ny)
        out[k] = dm[i, j]
    return out


@njit(cache=True)
def lookup2(gx, gy, x0, y0, inv, nx, ny, xy):
    n = xy.shape[0]
    out = np.empty((n, 2), gx.dtype)
    for k in range(n):
        i, j = _cell(xy[k, 0], xy[k, 1], x0, y0, inv, nx, ny)
        out[k, 0] = gx[i, j]
        out[k, 1] = gy[i, j]
    return out


@njit(cache=True)
def _seg_extreme(dm, x0, y0, inv, nx, ny, a, b, sample_m, want_max):
    """_seg_min / _seg_max: NaN reads -1, then the min (or max) along each segment, float32."""
    nseg = a.shape[0]
    out = np.empty(nseg, np.float32)
    if nseg == 0:
        return out
    Lmax = -1.0
    for k in range(nseg):
        L = math.hypot(b[k, 0] - a[k, 0], b[k, 1] - a[k, 1])
        if k == 0 or L > Lmax:
            Lmax = L
    n = int(math.ceil(Lmax / sample_m))
    if n < 1:
        n = 1
    t = np.empty(n + 1, np.float64)
    step = 1.0 / n
    for s in range(n):
        t[s] = s * step
    t[n] = 1.0
    neg = np.float32(-1.0)
    for k in range(nseg):
        sx = b[k, 0] - a[k, 0]
        sy = b[k, 1] - a[k, 1]
        best = np.float32(0.0)
        for s in range(n + 1):
            px = a[k, 0] + sx * t[s]
            py = a[k, 1] + sy * t[s]
            i, j = _cell(px, py, x0, y0, inv, nx, ny)
            v = dm[i, j]
            if v != v:
                v = neg
            if s == 0:
                best = v
            elif want_max:
                if v > best:
                    best = v
            else:
                if v < best:
                    best = v
        out[k] = best
    return out


@njit(cache=True)
def _bad_at(xy, step, al, dm, dmr, x0, y0, inv, nx, ny, floor32, ceil32, cur_seg, cur_max,
            sample_m):
    n = xy.shape[0]
    cand = np.empty_like(xy)
    for k in range(n):
        cand[k, 0] = xy[k, 0] + step[k, 0] * al[k]
        cand[k, 1] = xy[k, 1] + step[k, 1] * al[k]
    sm = _seg_extreme(dm, x0, y0, inv, nx, ny, cand[:-1], cand[1:], sample_m, False)
    sx = _seg_extreme(dmr, x0, y0, inv, nx, ny, cand[:-1], cand[1:], sample_m, True)
    bad = np.zeros(n, np.bool_)
    for k in range(n - 1):
        seg = ((sm[k] < floor32) and (sm[k] < cur_seg[k])) or \
              ((sx[k] > ceil32) and (sx[k] > cur_max[k]))
        if seg:
            bad[k] = True
            bad[k + 1] = True
    return bad


@njit(cache=True)
def smooth_k(xy0, dm, dmr, gx, gy, x0, y0, inv, nx, ny, floor32, ceil32, target32, has_target,
             iters, deep_bias32, deep_bias, sample_m):
    """fit_trolling_runs.smooth(), step for step. See that function for why each rule exists."""
    n = xy0.shape[0]
    xy = xy0.copy()
    lam = 0.5
    stalled = 0
    inf32 = np.float32(np.inf)
    for _ in range(iters):
        prop = xy.copy()
        for k in range(1, n - 1):
            for c in range(2):
                prop[k, c] = xy[k, c] + lam * (xy[k - 1, c] + xy[k + 1, c] - 2 * xy[k, c])
        if deep_bias > 0 and has_target:
            want = np.zeros(n, np.bool_)
            for k in range(n):
                i, j = _cell(prop[k, 0], prop[k, 1], x0, y0, inv, nx, ny)
                d = dmr[i, j]
                want[k] = (d != d) or (d < target32)
            for k in range(n):
                if want[k]:
                    i, j = _cell(prop[k, 0], prop[k, 1], x0, y0, inv, nx, ny)
                    prop[k, 0] = prop[k, 0] + gx[i, j] * deep_bias32
                    prop[k, 1] = prop[k, 1] + gy[i, j] * deep_bias32
        prop[0, 0] = xy0[0, 0]
        prop[0, 1] = xy0[0, 1]
        prop[n - 1, 0] = xy0[n - 1, 0]
        prop[n - 1, 1] = xy0[n - 1, 1]

        step = prop - xy
        mx = 0.0
        for k in range(n):
            for c in range(2):
                v = abs(step[k, c])
                if v > mx:
                    mx = v
        if mx < 0.25:
            break

        cur_seg = _seg_extreme(dm, x0, y0, inv, nx, ny, xy[:-1], xy[1:], sample_m, False)
        for k in range(cur_seg.shape[0]):         # _no_licence
            v = cur_seg[k]
            if v != v or v < 0:
                cur_seg[k] = inf32
        cur_max = _seg_extreme(dmr, x0, y0, inv, nx, ny, xy[:-1], xy[1:], sample_m, True)
        alpha = np.ones(n, np.float64)

        bad = _bad_at(xy, step, alpha, dm, dmr, x0, y0, inv, nx, ny, floor32, ceil32, cur_seg,
                      cur_max, sample_m)
        for _h in range(5):
            if not bad.any():
                break
            for k in range(n):
                if bad[k]:
                    alpha[k] *= 0.5
            bad = _bad_at(xy, step, alpha, dm, dmr, x0, y0, inv, nx, ny, floor32, ceil32,
                          cur_seg, cur_max, sample_m)
        clean = False
        for _z in range(6):
            if not bad.any():
                clean = True
                break
            for k in range(n):
                if bad[k]:
                    alpha[k] = 0.0
            bad = _bad_at(xy, step, alpha, dm, dmr, x0, y0, inv, nx, ny, floor32, ceil32,
                          cur_seg, cur_max, sample_m)
        if clean:
            nxy = np.empty_like(xy)
            for k in range(n):
                nxy[k, 0] = xy[k, 0] + step[k, 0] * alpha[k]
                nxy[k, 1] = xy[k, 1] + step[k, 1] * alpha[k]
            xy = nxy
            xy[0, 0] = xy0[0, 0]
            xy[0, 1] = xy0[0, 1]
            xy[n - 1, 0] = xy0[n - 1, 0]
            xy[n - 1, 1] = xy0[n - 1, 1]
            stalled = 0
        else:
            stalled += 1
            if stalled >= 3:
                break
    return xy


# ════════════════════════════════════════════════════════════════════════════════════════════════
# 4. CPython's own arithmetic, for the few places the scripts measure distance in plain Python
# ════════════════════════════════════════════════════════════════════════════════════════════════
#
# `metres()` and `rdp()` in build_trolling_runs.py call math.hypot, and CPython's math.hypot is NOT
# the C library's hypot. Measured on the pipeline PC, 2026-09-27: over 12 M random pairs, numpy's
# and numba's hypot (the MSVC runtime's) disagreed with math.hypot in the last bit 1 time in 6.
# One bit is enough to flip a `d > mx` in Douglas-Peucker and keep a different vertex. So
# `py_hypot` below is CPython's vector_norm() for two arguments, ported line for line from
# Modules/mathmodule.c (3.14), with the exact product done by Dekker splitting instead of fma --
# both give the exact rounding error of x*y, which is all dl_mul() is for.

@njit(cache=True)
def _two_prod(x, y):
    z = x * y
    t = x * 134217729.0                           # Veltkamp split, 2**27 + 1
    xh = t - (t - x)
    xl = x - xh
    t = y * 134217729.0
    yh = t - (t - y)
    yl = y - yh
    zz = ((xh * yh - z) + xh * yl + xl * yh) + xl * yl
    return z, zz


@njit(cache=True)
def py_hypot(a, b):
    """CPython's math.hypot(a, b), bit for bit (vector_norm with n == 2)."""
    x0 = abs(a)
    x1 = abs(b)
    found_nan = (x0 != x0) or (x1 != x1)
    mx = 0.0
    if x0 > mx:
        mx = x0
    if x1 > mx:
        mx = x1
    if math.isinf(mx):
        return mx
    if found_nan:
        return math.nan
    if mx == 0.0:
        return mx
    m, max_e = math.frexp(mx)
    dbl_min = 2.2250738585072014e-308
    if max_e < -1023:
        x0 = x0 / dbl_min
        x1 = x1 / dbl_min
        mx = mx / dbl_min
        m, max_e = math.frexp(mx)
        return dbl_min * _vector_norm2(x0, x1, max_e)
    return _vector_norm2(x0, x1, max_e)


@njit(cache=True)
def _vector_norm2(x0, x1, max_e):
    scale = math.ldexp(1.0, -max_e)
    csum = 1.0
    frac1 = 0.0
    frac2 = 0.0
    for k in range(2):
        x = x0 if k == 0 else x1
        x = x * scale
        pr_hi, pr_lo = _two_prod(x, x)
        s = csum + pr_hi                          # dl_fast_sum(csum, pr.hi)
        slo = (csum - s) + pr_hi
        csum = s
        frac1 += pr_lo
        frac2 += slo
    h = math.sqrt(csum - 1.0 + (frac1 + frac2))
    pr_hi, pr_lo = _two_prod(-h, h)
    s = csum + pr_hi
    slo = (csum - s) + pr_hi
    csum = s
    frac1 += pr_lo
    frac2 += slo
    x = csum - 1.0 + (frac1 + frac2)
    h += x / (2.0 * h)
    return h / scale


_DEG2RAD = math.pi / 180.0                        # CPython's degToRad, Py_MATH_PI / 180.0


@njit(cache=True)
def metres_k(ax, ay, bx, by):
    """build_trolling_runs.metres(), bit for bit."""
    return py_hypot((bx - ax) * 111320.0 * math.cos(((ay + by) / 2) * _DEG2RAD),
                    (by - ay) * 110570.0)


@njit(cache=True)
def metres_path(xs, ys):
    """metres() between consecutive vertices -- the terms length_m() sums (it keeps the sum)."""
    n = xs.shape[0]
    out = np.empty(max(0, n - 1), np.float64)
    for i in range(1, n):
        out[i - 1] = metres_k(xs[i - 1], ys[i - 1], xs[i], ys[i])
    return out


@njit(cache=True)
def rdp_keep(xs, ys, eps):
    """build_trolling_runs.rdp()'s kept-vertex mask, bit for bit (same tests, same ties)."""
    n = xs.shape[0]
    keep = np.zeros(n, np.bool_)
    keep[0] = True
    keep[n - 1] = True
    st_i = np.empty(n + 2, np.int64)
    st_j = np.empty(n + 2, np.int64)
    top = 0
    st_i[0] = 0
    st_j[0] = n - 1
    top = 1
    while top > 0:
        top -= 1
        i = st_i[top]
        j = st_j[top]
        if j - i < 2:
            continue
        ax = xs[i]
        ay = ys[i]
        bx = xs[j]
        by = ys[j]
        dx = bx - ax
        dy = by - ay
        den = dx * dx + dy * dy
        mx = 0.0
        mi = -1
        for k in range(i + 1, j):
            px = xs[k]
            py = ys[k]
            if den == 0:
                d = py_hypot(px - ax, py - ay)
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / den
                if not (t < 1.0):                 # Python's min(1.0, t), which keeps the 1.0
                    t = 1.0
                if not (t > 0.0):                 # ...and max(0.0, t), which keeps the 0.0
                    t = 0.0
                d = py_hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > mx:
                mx = d
                mi = k
        if mx > eps:
            keep[mi] = True
            st_i[top] = i
            st_j[top] = mi
            top += 1
            st_i[top] = mi
            st_j[top] = j
            top += 1
    return keep


@njit(cache=True)
def nearest_k(px, py, cell, gx0, gy0, gw, gh, cell_start, cell_node, nxs, nys, max_rings):
    """build_trolling_runs.NodeIndex.nearest(), bit for bit: same ring order, same strict `<`."""
    gx = int(px / cell)
    gy = int(py / cell)
    best = math.inf
    bi = -1
    for r in range(max_rings):
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                if r and max(abs(dx), abs(dy)) != r:
                    continue
                cx = gx + dx - gx0
                cy = gy + dy - gy0
                if cx < 0 or cy < 0 or cx >= gw or cy >= gh:
                    continue
                c = cx * gh + cy
                for q in range(cell_start[c], cell_start[c + 1]):
                    j = cell_node[q]
                    d = metres_k(px, py, nxs[j], nys[j])
                    if d < best:
                        best = d
                        bi = j
        if bi >= 0 and best <= r * cell * 111320.0:
            break
    return bi, best


# ════════════════════════════════════════════════════════════════════════════════════════════════
# 5. build_water_features.py -- Grid._fill(), compiled
# ════════════════════════════════════════════════════════════════════════════════════════════════
#
# The scanline fill of one outer ring into the 25 m byte grid: per row, every edge crossing the
# row's centre, crossings sorted, filled in pairs, a cell only ever raised. Same expressions in
# the same order; it was 44 of Murray's 67 seconds in pure Python.

@njit(cache=True)
def grid_fill_k(rx, ry, S, W, dx, dy, nx, ny, g, val):
    n = rx.shape[0]
    if n == 0:
        return
    ymin = ry[0]
    ymax = ry[0]
    for k in range(n):
        if ry[k] < ymin:
            ymin = ry[k]
        if ry[k] > ymax:
            ymax = ry[k]
    j0 = int((ymin - S) / dy)
    if j0 < 0:
        j0 = 0
    j1 = int((ymax - S) / dy)
    if j1 > ny - 1:
        j1 = ny - 1
    xints = np.empty(max(n, 1), np.float64)
    v8 = np.uint8(val)
    for j in range(j0, j1 + 1):
        yc = S + (j + 0.5) * dy
        m = 0
        for k in range(n - 1):
            x0 = rx[k]
            y0 = ry[k]
            x1 = rx[k + 1]
            y1 = ry[k + 1]
            if (y0 > yc) != (y1 > yc):
                den = y1 - y0
                if den == 0.0:
                    den = 1e-12
                xints[m] = x0 + (yc - y0) * (x1 - x0) / den
                m += 1
        xs = np.sort(xints[:m])
        base = j * nx
        for a in range(0, m - 1, 2):
            i0 = int((xs[a] - W) / dx)
            if i0 < 0:
                i0 = 0
            i1 = int((xs[a + 1] - W) / dx)
            if i1 > nx - 1:
                i1 = nx - 1
            for i in range(i0, i1 + 1):
                if g[base + i] < v8:
                    g[base + i] = v8
