#!/usr/bin/env python3
r"""channel_lanes.py - lanes down the channel, on waters Ryan trolls that way.

Personal use only, not for distribution or resale; not for navigation.

Called by fit_trolling_runs.fit_pack() for the waters in CHANNEL_WATERS; nothing to run by hand.

WHY THE CONTOUR LANES CANNOT DO IT. A trolling lane in this pipeline starts as a contour: one
depth, followed. On a lake that is the edge he trolls. On Bates Old River the bottom rises and
falls along the channel -- on his own chart (survey_chart.py) the longest line at any one depth,
2 to 23 ft, is 56-478 m before it closes around a hole, and smoothing the chart harder does not
lengthen them (14 ft: 485 m -> 423 m). The fitter's own run on that chart kept 1 lane. He does not
troll one depth there; he trolls down the channel. Ryan, 2026-10-05, pointing at the 9/27 trip:
*"if you look at this folder you can see how i troll that lake"*, and of the lanes drawn from it,
*"please"*.

THE LANE. From each launch on the water, the path through the charted water that minimises the
sum of (distance / depth) -- deep water is cheap, shallow water is dear, and there is no constant
in it to tune -- out to the charted water furthest from that launch by water. Resampled at the
fitter's --resample-m and smoothed over one sample either side. His 9/27 track runs a median 15 m
from it on Bates.

ONE CUT, WHERE THE WATER CHANGES MOST. The lane is cut once, at the station that best splits the
depth under it into a deeper and a shallower stretch (least squares, two means), when both sides
are still a pass (--structure-min-leg-m, Ryan's 600 m). On Bates that is the bottom of the east
side: 13.9 ft median before it, 7.7 after.

Everything a pass carries -- envelope, shallowest, routable, what is beside it -- is measured by
fit_trolling_runs.measure_pass(), the same function the contour lanes go through.

WHICH WATERS. Only the ones he has said he trolls down the channel. Expandable by adding a row,
with his words, the way consolidate_lake_index.py carries FEATURE_TYPE_CORRECTIONS.
"""
import heapq, json, math, os

import numpy as np

CHANNEL_WATERS = {
    'bates_old_river': 'Ryan, 2026-10-05: "if you look at this folder you can see how i troll that lake" '
                       '(27Sep26_Trip: out the top arm and down the east side, and back)',
}

_NB = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def launches(pack):
    """(name, lon, lat) for every landing build_ramp_reach.py put on this water."""
    p = os.path.join(pack, 'launches.json')
    if not os.path.isfile(p):
        return []
    with open(p, encoding='utf-8') as fh:
        body = json.load(fh)
    out = []
    for r in body.get('landings') or []:
        try:
            out.append((r.get('name') or '(unnamed launch)', float(r['lon']), float(r['lat'])))
        except (KeyError, TypeError, ValueError):
            continue
    return out


def _dijkstra(cost_of, wet, start):
    """Least cost from `start` to every wet cell, 8-connected. `cost_of(i, j, ni, nj, step)`."""
    nx, ny = wet.shape
    dist = np.full(wet.shape, np.inf)
    prev = np.full(wet.shape + (2,), -1, dtype=np.int64)
    dist[start] = 0.0
    q = [(0.0, start[0], start[1])]
    while q:
        d, i, j = heapq.heappop(q)
        if d > dist[i, j]:
            continue
        for di, dj in _NB:
            ni, nj = i + di, j + dj
            if 0 <= ni < nx and 0 <= nj < ny and wet[ni, nj]:
                nd = d + cost_of(i, j, ni, nj, math.hypot(di, dj))
                if nd < dist[ni, nj]:
                    dist[ni, nj] = nd
                    prev[ni, nj] = (i, j)
                    heapq.heappush(q, (nd, ni, nj))
    return dist, prev


def _path(prev, end):
    out = [end]
    while True:
        i, j = prev[out[-1]]
        if i < 0:
            break
        out.append((int(i), int(j)))
    return out[::-1]


def change_point(values):
    """Index k (1..n-1) that splits `values` into two runs with the least total squared deviation
    from their own means; None when there is nothing to split."""
    v = np.asarray(values, float)
    n = len(v)
    if n < 2:
        return None
    c1 = np.cumsum(v)
    c2 = np.cumsum(v * v)
    best, bk = np.inf, None
    for k in range(1, n):
        a_n, b_n = k, n - k
        sa, sb = c1[k - 1], c1[-1] - c1[k - 1]
        qa, qb = c2[k - 1], c2[-1] - c2[k - 1]
        sse = (qa - sa * sa / a_n) + (qb - sb * sb / b_n)
        if sse < best:
            best, bk = sse, k
    return bk


def channel_passes(pack, depth, lat0, a, resample, seglens, xy_of, at_raw):
    """[(xy ndarray, info dict), ...] for one pack. `depth` is fit_trolling_runs.DepthRaster; the
    helpers are passed in from there so the geometry is the fitter's own."""
    dm = depth.dm_raw
    wet = np.isfinite(dm) & (dm > 0)
    if not wet.any():
        return [], 'no charted water'
    ls = launches(pack)
    if not ls:
        return [], 'no launch on this water (launches.json lists none)'
    ft = np.where(wet, dm / 3.048, np.nan)
    step = depth.step
    wi, wj = np.nonzero(wet)
    out, seen = [], set()
    for name, lon, lat in ls:
        p = xy_of([[lon, lat]], lat0)[0]
        ci = (wi * step + depth.x0 - p[0]) ** 2 + (wj * step + depth.y0 - p[1]) ** 2
        k = int(np.argmin(ci))
        start = (int(wi[k]), int(wj[k]))
        if start in seen:
            continue
        seen.add(start)
        # furthest charted water BY WATER from this launch
        reach, _ = _dijkstra(lambda i, j, ni, nj, d: d * step, wet, start)
        far = np.where(np.isfinite(reach), reach, -1.0)
        end = np.unravel_index(int(np.argmax(far)), far.shape)
        if far[end] <= 0:
            continue
        # the deepest way there: the integral of ds / depth
        cost, prev = _dijkstra(lambda i, j, ni, nj, d: d * step * 0.5 * (1.0 / ft[i, j] + 1.0 / ft[ni, nj]),
                               wet, start)
        cells = _path(prev, (int(end[0]), int(end[1])))
        raw = np.array([[depth.x0 + i * step, depth.y0 + j * step] for i, j in cells], float)
        if len(raw) < 2:
            continue
        even, _ = resample(raw, a.resample_m)
        sm = even.copy()
        if len(sm) > 2:
            sm[1:-1] = (even[:-2] + even[1:-1] + even[2:]) / 3.0
        under = np.asarray(at_raw(sm), float) / 3.048
        under = np.where(np.isfinite(under), under, np.nanmedian(under))
        total = float(seglens(sm).sum())
        pieces = [sm]
        kcut = change_point(under)
        if kcut is not None:
            a_len = float(seglens(sm[:kcut + 1]).sum())
            if a_len >= a.structure_min_leg_m and total - a_len >= a.structure_min_leg_m:
                pieces = [sm[:kcut + 1], sm[kcut:]]
        for n, piece in enumerate(pieces):
            out.append((piece, {'launch': name, 'pass': n + 1, 'passes': len(pieces),
                                'parent_length_m': round(total, 1)}))
    return out, None
