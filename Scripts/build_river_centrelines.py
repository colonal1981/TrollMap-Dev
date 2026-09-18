#!/usr/bin/env python3
r"""
build_river_centrelines.py -- give every river a centreline, a direction and a curvature, and stamp
those onto the structure that is already in its chartpack.

Personal use only, not for distribution or resale; not for navigation.

WHY THIS EXISTS, AND WHY IT IS NOT A NEW DETECTOR.

Measured 2026-09-16 on the Congaree: of the 189 scour holes build_structure.py already found, the
ones that sit in a bend are on the OUTSIDE of it 43 to 7. Chance would be 50/50, and it holds at
every curvature window tried -- 41:9 at 400 m, 43:7 at 600 m, 45:9 at 1000 m -- so it is not an
artifact of a tuned parameter. It is also what river physics predicts: the outside of a bend is
where the water scours. build_structure.py has been finding outside bends since the day it ran and
calling them `hole`.

So this adds no features and finds nothing new. It measures the river's own centreline and stamps
four numbers onto the 22,940 structure and water-feature records that already exist on the 57
rivers, so the planner can finally tell an outside bend from an inside one and knows which way the
water is moving past each of them.

THERE IS NO BEND THRESHOLD IN HERE, DELIBERATELY. A threshold would be an invented number and the
radius is a measured one. `bend_r_m` is carried as the radius itself and `bend_side` is which side
of whatever curvature exists -- a sign, which needs no cutoff. Whoever consumes it decides what
counts as a bend, from the distribution this script prints.

WHAT SUPPLIES THE DIRECTION. The 3DHP flowline, which is on the drive. Measured across all 34,770
segments lying inside the 57 river boundaries: `flowdirection` is usable on 34,759 of them -- 99.97%
-- and its value means "flow is in the digitized direction", so VERTEX ORDER IS DOWNSTREAM. 3DHP's
`streamorder`, `hydrosequence`, `dnhydrosequence`, `levelpath` and `divergence` columns are present
and 100% NULL, so none of them is used here; `mainstemid` is populated and is what chains the reaches.

ALL 57 RIVERS HAVE A CHAINABLE CENTRELINE inside their own boundary, 6.9 km (rediversion canal) to
379.8 km (Ocmulgee), measured before this was written. There is no river this cannot run on.

WHAT IT WRITES

  chartpack/<slug>/centreline.geojson    one LineString, in downstream order, carrying per-station
                                         arrays: station_m, bearing_deg, radius_m, width_m -- plus
                                         the tributary confluences 3DHP knows about and the
                                         creek-mouth detector missed (104 on the Congaree against
                                         the pack's 4).

                                         SINCE 2026-09-18 THAT LINE IS PUT IN THE MIDDLE OF THE
                                         WATER rather than left where 3DHP drew it. See
                                         centre_on_water() for why it was not, what that cost on
                                         Ryan's own Congaree day, and the two rules that keep the
                                         line a line while it moves. `--no-centre` restores the
                                         old behaviour for a comparison.

  chartpack/<slug>/structure.geojson     each feature gains river_m, off_m, flow_deg, bend_r_m,
  chartpack/<slug>/water_features.geojson  bend_side. Nothing is removed and no feature is added, so
                                         nothing downstream goes stale.

TWO OF THOSE FIVE ARE ABOUT THE FEATURE AND THREE ARE ABOUT THE RIVER, and the difference is the
snap cap. `river_m` and `off_m` are a position -- nearest the channel here, that far off it -- and
they are true at any distance, so they are always stamped. `flow_deg`, `bend_r_m` and `bend_side`
describe the CHANNEL at that station, and a feature three channel widths off the centreline is, in
this script's own words below, off this river; stamping the channel's direction on it would be
saying something false about a thing nobody measured. So all three are gated on the cap together.
Until 2026-09-17 only `bend_side` was, and 5,288 of 22,939 features -- 23.1% -- carried a flow
direction measured somewhere they are not.

  <registry>/_river_centrelines.json     the build record.

THE TRIBUTARIES GO ON THE CENTRELINE, NOT INTO water_features.geojson. Adding creek_mouth features
to that layer would silently stale every run's `near_counts`, which build_trolling_runs.py computed
off it. A confluence is a property of the river at a station, so that is where it is stored.

--dry-run WRITES NOTHING AT ALL, including the report. bathy_graph.py's dry run overwrote
registry/_bathy_graphs.json from 109,488 bytes to 897 on 2026-09-15 and destroyed 196 rows of build
record, because "write no .bin" did not mean "write nothing". This one means it.

Every file this replaces is moved to <chartpack>/_to_delete/river_centrelines_<STAMP>/ first.

USAGE
    py F:\TrollMapPipeline\scripts\build_river_centrelines.py --registry F:\TrollMapPipeline\registry
"""
import argparse
import bisect
import collections
import json
import math
import os
import shutil
import sqlite3
import struct
import sys
import time

# ─────────────────────────────────────────────────────────────────────────────────────────────
# Conus Albers (EPSG:5070 / 6350), stdlib only.
#
# pyproj is not installed everywhere this has to run, and the 3DHP GeoPackage stores geometry in
# NAD83(2011) Conus Albers, so a lon/lat bbox query against its R-tree matches nothing -- silently,
# which is how an earlier attempt "proved" Lake Murray was not in 3DHP's waterbody layer.
# Snyder, Map Projections -- A Working Manual, pp. 101-102. GRS80, parallels 29.5/45.5, origin 23/-96.
# ─────────────────────────────────────────────────────────────────────────────────────────────
_A = 6378137.0
_E2 = 2 * (1 / 298.257222101) - (1 / 298.257222101) ** 2
_E = math.sqrt(_E2)
_LAT1, _LAT2, _LAT0, _LON0 = map(math.radians, (29.5, 45.5, 23.0, -96.0))


def _authalic_q(phi):
    s = math.sin(phi)
    return (1 - _E2) * (s / (1 - _E2 * s * s) - (1 / (2 * _E)) * math.log((1 - _E * s) / (1 + _E * s)))


def _m(phi):
    s = math.sin(phi)
    return math.cos(phi) / math.sqrt(1 - _E2 * s * s)


_Q1, _Q2, _Q0 = _authalic_q(_LAT1), _authalic_q(_LAT2), _authalic_q(_LAT0)
_M1, _M2 = _m(_LAT1), _m(_LAT2)
_N = (_M1 * _M1 - _M2 * _M2) / (_Q2 - _Q1)
_C = _M1 * _M1 + _N * _Q1
_RHO0 = _A * math.sqrt(_C - _N * _Q0) / _N


def to_albers(lon, lat):
    phi, lam = math.radians(lat), math.radians(lon)
    rho = _A * math.sqrt(_C - _N * _authalic_q(phi)) / _N
    theta = _N * (lam - _LON0)
    return rho * math.sin(theta), _RHO0 - rho * math.cos(theta)


def to_lonlat(x, y):
    dy = _RHO0 - y
    rho = math.hypot(x, dy)
    theta = math.atan2(x, dy) if _N > 0 else math.atan2(-x, -dy)
    q = (_C - (rho * _N / _A) ** 2) / _N
    lam = _LON0 + theta / _N
    # Snyder 3-16: iterate for the geodetic latitude that has this authalic area.
    phi = math.asin(max(-1.0, min(1.0, q / 2.0)))
    for _ in range(12):
        s = math.sin(phi)
        d = (1 - _E2 * s * s) ** 2 / (2 * math.cos(phi)) * (
            q / (1 - _E2) - s / (1 - _E2 * s * s)
            + (1 / (2 * _E)) * math.log((1 - _E * s) / (1 + _E * s)))
        phi += d
        if abs(d) < 1e-12:
            break
    return math.degrees(lam), math.degrees(phi)


# ─────────────────────────────────────────────────────────────────────────────────────────────
# GeoPackage geometry blobs.  'GP' + version + flags + srs_id + optional envelope, then plain WKB.
# ─────────────────────────────────────────────────────────────────────────────────────────────
def gpkg_lines(blob):
    if not blob or blob[:2] != b'GP':
        return []
    env = (blob[3] >> 1) & 7
    off = 8 + {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}.get(env, 0)
    try:
        return _wkb(blob, off)[0]
    except Exception:
        return []


def _wkb(b, off):
    e = '<' if b[off] == 1 else '>'
    off += 1
    typ, = struct.unpack_from(e + 'I', b, off)
    off += 4
    base = typ % 1000
    dim = 4 if typ >= 3000 else (3 if typ >= 1000 else 2)

    def pts(n, off):
        vals = struct.unpack_from(e + '%dd' % (n * dim), b, off)
        return [(vals[i * dim], vals[i * dim + 1]) for i in range(n)], off + 8 * n * dim

    if base == 2:
        n, = struct.unpack_from(e + 'I', b, off)
        p, off = pts(n, off + 4)
        return [p], off
    if base in (5, 6):
        n, = struct.unpack_from(e + 'I', b, off)
        off += 4
        out = []
        for _ in range(n):
            g, off = _wkb(b, off)
            out += g
        return out, off
    if base == 3:
        nr, = struct.unpack_from(e + 'I', b, off)
        off += 4
        out = []
        for _ in range(nr):
            n, = struct.unpack_from(e + 'I', b, off)
            p, off = pts(n, off + 4)
            out.append(p)
        return out, off
    raise ValueError('wkb type %d' % typ)


# ─────────────────────────────────────────────────────────────────────────────────────────────
# Scanline inside-test for one boundary. A naive point-in-polygon over a 19,782-vertex ring times
# out at 120 s on one river; this answers in constant time after an O(edges) build.
# ─────────────────────────────────────────────────────────────────────────────────────────────
class Mask:
    def __init__(self, rings, cell):
        self.cell = cell
        xs = [p[0] for r in rings for p in r]
        ys = [p[1] for r in rings for p in r]
        self.minx, self.maxx, self.miny, self.maxy = min(xs), max(xs), min(ys), max(ys)
        self.nrow = int((self.maxy - self.miny) / cell) + 1
        rows = [[] for _ in range(self.nrow)]
        for r in rings:
            j = len(r) - 1
            for i in range(len(r)):
                x1, y1 = r[j]
                x2, y2 = r[i]
                j = i
                if y1 == y2:
                    continue
                lo, hi = (y1, y2) if y1 < y2 else (y2, y1)
                r0 = max(0, int(math.ceil((lo - self.miny) / cell - 0.5)))
                r1 = min(self.nrow - 1, int(math.floor((hi - self.miny) / cell - 0.5)))
                for k in range(r0, r1 + 1):
                    yc = self.miny + (k + 0.5) * cell
                    if (y1 > yc) != (y2 > yc):
                        rows[k].append(x1 + (x2 - x1) * (yc - y1) / (y2 - y1))
        for k in range(self.nrow):
            rows[k].sort()
        self.rows = rows

    def inside(self, x, y):
        k = int((y - self.miny) / self.cell)
        if k < 0 or k >= self.nrow:
            return False
        return bisect.bisect_right(self.rows[k], x) % 2 == 1


# ─────────────────────────────────────────────────────────────────────────────────────────────
def rings_of(geom):
    t = geom.get('type')
    c = geom.get('coordinates') or []
    if t == 'Polygon':
        return list(c)
    if t == 'MultiPolygon':
        return [r for poly in c for r in poly]
    return []


def load_boundary_rings(path):
    with open(path, encoding='utf-8') as fh:
        d = json.load(fh)
    feats = d['features'] if d.get('type') == 'FeatureCollection' else [d]
    out = []
    for f in feats:
        for ring in rings_of(f.get('geometry') or f):
            out.append([to_albers(p[0], p[1]) for p in ring])
    return out


def first_point(geom):
    """Representative point of any geometry, in lon/lat."""
    c = geom.get('coordinates')
    while isinstance(c, list) and c and isinstance(c[0], list):
        c = c[len(c) // 2]
    return (c[0], c[1]) if isinstance(c, list) and len(c) >= 2 else None


# ─────────────────────────────────────────────────────────────────────────────────────────────
def chain_mainstem(segments, charted_m=None):
    """The chain through `segments` that carries the most CHARTED water, falling back to the
    longest. `segments` are already in flow order.

    ── THE MAINSTEM PICK WAS TAUGHT TO COUNT CHARTED METRES AND THIS WAS NOT ─────────────────────

    `8bdc635` fixed the pick one level up: choose the mainstem the CHART is on, not the longest one
    inside the boundary. It left this function scoring by length, and a mainstem does not arrive in
    one piece -- 3DHP breaks it wherever the reach ids change, so one `mainstemid` inside a boundary
    can yield several disconnected runs and this picks between them.

    MEASURED ON `south_yadkin_river`, 2026-09-17, which was the last river planning to nothing:

        the picked mainstem      93,197 m inside the boundary, 20,268 m of it charted
        its chains               2 heads
          chain A                71.3 km long,  0.0 km charted   <- what this function returned
          chain B                24.8 km long, 20.5 km charted   <- the water the pack is FOR

    So the right mainstem was chosen and then the wrong 71 km of it was kept, and the centreline
    stopped 1,141 m short of the pack's own chart. Ryan found it by disagreeing with the reason this
    file previously recorded -- "its chart overlaps 69% of the yadkin_river pack" -- which turned out
    to be a BOUNDING BOX. The two packs share 59 boundary lines and ZERO area: they abut at the
    confluence and tile the river, exactly as he said.

    `charted_m(a, b)` is the caller's metre-counter for one segment, or None where there is no chart
    to ask -- `--no-depth`, a pack with no depth areas, a river Garmin never sounded. Absent, and
    when no chain carries a charted metre, length is still the answer rather than an arbitrary pick
    among zeroes. Same rule and same fallback as the mainstem pick above, which is the point: the
    two decisions are the same question asked twice and they now answer it the same way.
    """
    key = lambda p: (round(p[0], 1), round(p[1], 1))
    starts = collections.defaultdict(list)
    for s in segments:
        starts[key(s[0])].append(s)
    ends = {key(s[-1]) for s in segments}
    heads = [s for s in segments if key(s[0]) not in ends] or segments[:1]
    chains = []
    for h in heads:
        chain, cur, seen = [], h, set()
        while cur is not None and id(cur) not in seen:
            seen.add(id(cur))
            chain.extend(cur if not chain else cur[1:])
            nxt = [x for x in starts.get(key(cur[-1]), []) if id(x) not in seen]
            cur = nxt[0] if nxt else None
        length = sum(math.dist(chain[i], chain[i + 1]) for i in range(len(chain) - 1))
        charted = 0.0
        if charted_m is not None:
            charted = sum(charted_m(chain[i], chain[i + 1]) for i in range(len(chain) - 1))
        chains.append((chain, length, charted))
    if not chains:
        return [], -1.0, 'length'
    best_charted = max(chains, key=lambda c: c[2])
    if best_charted[2] > 0:
        return best_charted[0], best_charted[1], 'charted'
    best_len = max(chains, key=lambda c: c[1])
    return best_len[0], best_len[1], 'length'


def resample(line, step):
    pts = [line[0]]
    acc = 0.0
    for i in range(len(line) - 1):
        a, b = line[i], line[i + 1]
        d = math.dist(a, b)
        if d == 0:
            continue
        t = 0.0
        while acc + d - t >= step:
            t += step - acc
            pts.append((a[0] + (b[0] - a[0]) * t / d, a[1] + (b[1] - a[1]) * t / d))
            acc = 0.0
        acc += d - t
    return pts


def curvature(pts, step, window_m):
    """Signed turn and radius at every station. Positive turn = to the left, looking downstream.

    THE ARC IS w*step, NOT 2*w*step, AND THE FIRST VERSION OF THIS REPORTED EVERY RADIUS AT TWICE
    ITS TRUE VALUE. The chord from station i-w to i has the heading of the TANGENT AT ITS MIDPOINT,
    i-w/2, and the chord from i to i+w has the tangent at i+w/2. So the two headings are separated
    by w*step of arc, not by the full 2*w*step window they span. On a 500 m test arc the old form
    returned 1000 m. Caught by test_river_centrelines.py before this ever ran on the drive; the
    outside/inside sign was never affected, only the magnitude.
    """
    n = len(pts)
    w = max(1, int(round(window_m / (2 * step))))
    turn = [None] * n
    rad = [None] * n
    hdg = lambda a, b: math.atan2(b[1] - a[1], b[0] - a[0])
    for i in range(w, n - w):
        dt = (hdg(pts[i], pts[i + w]) - hdg(pts[i - w], pts[i]) + math.pi) % (2 * math.pi) - math.pi
        turn[i] = dt
        rad[i] = (w * step) / abs(dt) if abs(dt) > 1e-9 else None
    return turn, rad


def bearings(pts):
    n = len(pts)
    out = []
    for i in range(n):
        a = pts[max(i - 1, 0)]
        b = pts[min(i + 1, n - 1)]
        # Compass bearing: 0 = north, clockwise. Albers x is east and y is north.
        out.append(math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) % 360.0)
    return out


def widths(pts, mask, max_m, probe):
    """Channel width at each station, by casting perpendicular rays until they leave the water."""
    n = len(pts)
    out = []
    for i in range(n):
        a = pts[max(i - 1, 0)]
        b = pts[min(i + 1, n - 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        h = math.hypot(dx, dy)
        if h == 0:
            out.append(None)
            continue
        px, py = -dy / h, dx / h          # unit normal, pointing left of downstream
        total = 0.0
        ok = True
        for sign in (1, -1):
            d = 0.0
            while d < max_m:
                d += probe
                if not mask.inside(pts[i][0] + px * sign * d, pts[i][1] + py * sign * d):
                    break
            else:
                ok = False
            total += d
        out.append(round(total, 1) if ok else None)
    return out


# ─────────────────────────────────────────────────────────────────────────────────────────────
# THE CENTRELINE WAS NEVER THE CENTRE OF THE WATER, AND NOTHING EVER MEASURED IT
#
# Ryan, 2026-09-18, having run a real Congaree plan from Bates Bridge and looked at the GPX:
# "looks like they don't stay in the river... you should see a few places where the track is over
# land". Then, when the measurement came back: *"How is the center line not the center of the
# water"*.
#
# Because nothing here ever asked. This file resamples 3DHP's FLOWLINE -- a hydrography network
# line whose job is topology, one line per stream, connected and draining downhill -- and calls the
# result a centreline. Everything after that is built SYMMETRIC ABOUT IT: widths() walks out
# perpendicular in both directions and returns the sum; cross_sections() lays the nine profile
# columns from -w/2 to +w/2 about the station. So `profile_fractions` 0.5 -- "mid-channel", the
# line the app's river drifts are drawn on -- means "wherever 3DHP put the line", and every
# measurement that could have checked it was defined relative to it.
#
# WHAT IT COSTS, MEASURED. On Ryan's own day, both reaches, against his pack's charted depth areas:
# 1,835 m of the 11,184 m he fished one way is outside the charted water -- 16.4%, and 3.7 km of a
# 22.4 km out-and-back. The excursions are not noise: the longest single runs are 301 m, 252 m,
# 224 m and 199 m, and every one is the line chording across the inside of a meander.
#
# IT IS NOT THE RESAMPLING AND IT IS NOT THE CHAINING. The raw 3DHP mainstem clipped to the same
# corridor is 21.5% off the charted water -- worse than the 15.6% this file manages over the same
# stretch, because chain_mainstem() already prefers the chain carrying charted metres. That
# flowline's own vertex spacing is 16 m at the median and 88 m at worst, so there is no long chord
# to inherit and resample() can only deviate from it by a sagitta of a metre or two. 3DHP and
# Garmin's survey disagree about where the river is, and the one a bait can be dragged through is
# Garmin's.
#
# ACROSS ALL 57 RIVERS, separating "the line left water the chart HAS within 150 m" from "nobody
# ever sounded this stretch" -- the second is not a defect: median 3.0% of a centreline is
# misplaced, 19 rivers at 5% or worse, 10 at 10% or worse, uwharrie_river worst at 30.2%. The
# alarming raw figures (chauga_river 96.3% "off charted water", johns_river 90.0%) are packs with
# almost no soundings, and their misplaced share is about 1%.
#
# ── AND THE NUMBER THAT FIXES IT IS ALREADY COMPUTED 2,537 TIMES A RIVER AND THROWN AWAY ────────
#
# widths() measures the left half and the right half SEPARATELY and returns `total`. The DIFFERENCE
# between those two halves is exactly how far off-centre the station is. That is the whole of the
# arithmetic below; what is new is using it to PLACE the station instead of to describe it.
#
# ── WHY A CENTRING PASS ALONE IS NOT ENOUGH, WHICH THE FIRST PROTOTYPE PROVED ───────────────────
#
# A station that is already OUTSIDE the water has its probe leave on the FIRST step in both
# directions, so (left - right) is zero and it sits exactly where it was. Centring alone put 6 of
# 20 off-water stations back in the water. Finding the water first and then centring put 20 of 20.
# So a station off the water is pulled ONTO it along its own normal, and then centred from there --
# two halves of one move, not two options.
#
# ── TWO RULES KEEP THE LINE A LINE ──────────────────────────────────────────────────────────────
#
# SIDEWAYS ONLY. A station moves along its own normal and never fore or aft. The prototype snapped
# to the NEAREST charted point in any direction, which on a cut meander pulls neighbouring stations
# onto opposite sides of the neck and doubles the line back on itself -- visible on two of the four
# worst bends. Restricting the move to the normal makes that impossible by construction: the
# along-track component of every step is unchanged.
#
# THE SIDE THE LAST ONE TOOK. Where a station off the water finds water on BOTH sides of its normal
# -- the two lobes of a meander it is chording across -- it takes the one nearest the previous
# station's offset. That is what walks the river in order instead of picking per station.
#
# And a station with no water on its normal inside the cap is LEFT WHERE IT IS. That is the
# unsounded case -- 17 of the 57 packs are mostly unsounded -- and the flowline is the honest answer
# there. The report counts them rather than hiding them.
# ─────────────────────────────────────────────────────────────────────────────────────────────


def station_normal(pts, i):
    """Unit normal at station `i`, pointing LEFT of downstream. The same one widths() casts along."""
    a = pts[max(i - 1, 0)]
    b = pts[min(i + 1, len(pts) - 1)]
    dx, dy = b[0] - a[0], b[1] - a[1]
    h = math.hypot(dx, dy)
    return None if h == 0 else (-dy / h, dx / h)


def _first_exit(inside, x, y, px, py, probe, reach):
    """From a point IN the water: metres to the first step outside, each way. (left, right)."""
    out = []
    for sign in (1, -1):
        d = 0.0
        while d < reach:
            d += probe
            if not inside(x + px * sign * d, y + py * sign * d):
                break
        out.append(d)
    return out[0], out[1]


def _first_entry(inside, x, y, px, py, probe, reach):
    """From a point NOT in the water: metres to the first step inside, each way, or None."""
    out = []
    for sign in (1, -1):
        d = 0.0
        hit = None
        while d < reach:
            d += probe
            if inside(x + px * sign * d, y + py * sign * d):
                hit = d
                break
        out.append(hit)
    return out[0], out[1]


def centre_pass(pts, inside, step, probe, reach):
    """One sweep. Returns (moved, stranded, folds, shifts) and a NEW list of stations.

    ── MEASURED ALL AT ONCE, THEN SMOOTHED, THEN APPLIED ───────────────────────────────────────
    #
    The first version of this moved each station as it went and took the next station's normal off
    the one it had just moved. That feeds back: a 10 m lateral step tilts the next station's idea of
    "forward" by 22 degrees, which tilts the next, and on a synthetic meander 300 m deep it turned
    41 stations into 337 folded back and forth across the river. Measuring every station against the
    SAME line and applying the result afterwards has no feedback in it at all.

    So there are three steps and they are deliberately separate:

      1. what each station would need, measured independently on the line as it stands;
      2. WHICH SIDE, for the stations that found water on both -- decided in order down the river,
         because that is the only thing here that is sequential;
      3. a cap at the local bend radius, because offsetting a curve inward by more than its own
         radius of curvature makes a cusp and not a curve;
      4. a slope limit, forward and back, so no station ends up more than one station spacing
         further across the channel than its neighbour;
      5. and a repair for whatever folds anyway, counted if any survives it.

    Steps 3 and 4 are what keep the line a line, and neither is a tuning constant. A lateral change
    of `step` over a length of `step` is a 45 degree bend; past that it stops being something a boat
    follows, and it turns a teleport into a wedge that opens at 45 degrees and reaches the same water
    over several stations, which is what walking down a river looks like. The radius cap is the
    geometry: the along-track component of a step goes to zero when the inward offset reaches the
    radius of curvature, so it is capped a station spacing short of it.
    """
    n = len(pts)
    norms = [station_normal(pts, i) for i in range(n)]

    # 1 ── what each station would need, all against the same line
    cands = []
    stranded = 0
    for i in range(n):
        nv = norms[i]
        if nv is None:
            cands.append(None)
            continue
        px, py = nv
        x, y = pts[i]
        if inside(x, y):
            dl, dr = _first_exit(inside, x, y, px, py, probe, reach)
            cands.append([(dl - dr) / 2.0])
            continue
        el, er = _first_entry(inside, x, y, px, py, probe, reach)
        opts = []
        if el is not None:
            dl, dr = _first_exit(inside, x + px * el, y + py * el, px, py, probe, reach)
            opts.append(el + (dl - dr) / 2.0)
        if er is not None:
            dl, dr = _first_exit(inside, x - px * er, y - py * er, px, py, probe, reach)
            opts.append(-er + (dl - dr) / 2.0)
        if not opts:
            # No water on this station's normal inside the cap. Unsounded, or a boundary and a
            # chart on different water. The flowline is the only answer there and it stays.
            stranded += 1
            cands.append(None)
            continue
        cands.append(opts)

    # 2 ── which side, walked down the river
    #
    # Where a station off the water found water on BOTH sides -- the two lobes of a meander it is
    # chording across -- the NEAREST one is the wrong rule: neighbouring stations pick opposite
    # lobes and the line folds. The side that agrees with the station before it is the right one,
    # and it is the only decision in here that has to be made in order.
    off = [0.0] * n
    prev = 0.0
    for i in range(n):
        if not cands[i]:
            off[i] = prev
            continue
        off[i] = min(cands[i], key=lambda c: abs(c - prev))
        prev = off[i]

    # 3 ── AND NO FURTHER INTO A BEND THAN THAT BEND'S OWN RADIUS
    #
    # This is the condition the slope limit below cannot see, and the one the Congaree's first real
    # run failed on 48 stations. Offsetting a curve inward by more than its radius of curvature does
    # not produce a curve -- it produces a cusp; the along-track component of the step goes to zero
    # at `o = R` and negative past it. So an offset pointing at the centre of the bend is capped at
    # the radius less one station spacing, which leaves the along-track component positive by the
    # same margin the slope limit works in.
    #
    # THE RADIUS IS THE LOCAL ONE, between this station and its two neighbours, and not the 400 m
    # curvature window: folding happens between adjacent segments and that is the scale to measure.
    # It needs no new parameter for the same reason.
    for i in range(1, n - 1):
        ax, ay = pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]
        bx, by = pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]
        la, lb = math.hypot(ax, ay), math.hypot(bx, by)
        if la == 0.0 or lb == 0.0:
            continue
        # Positive is a LEFT turn, and the normal points left of downstream, so an offset with the
        # same sign as the turn is an offset toward the inside of the bend.
        ang = math.atan2(ax * by - ay * bx, ax * bx + ay * by)
        if abs(ang) < 1e-9 or off[i] * ang <= 0:
            continue
        span = (la + lb) / 2.0
        lim = max(0.0, span / abs(ang) - span)
        if abs(off[i]) > lim:
            off[i] = lim if off[i] > 0 else -lim

    # 4 ── the slope limit, both ways, so the start is not privileged over the end
    for i in range(1, n):
        off[i] = max(off[i - 1] - step, min(off[i - 1] + step, off[i]))
    for i in range(n - 2, -1, -1):
        off[i] = max(off[i + 1] - step, min(off[i + 1] + step, off[i]))

    # 5 ── and the folds those two do not catch, smoothed out where they appear
    #
    # THE SLOPE LIMIT IS NOT QUITE ENOUGH ON A TIGHT BEND, and the Congaree says so: 48 of 2,659
    # stations. The limit keeps the OFFSETS within a station spacing of each other, which is exactly
    # right on a straight reach -- but two adjacent normals on a bend of radius R differ by step/R,
    # so an offset of `o` toward the inside of that bend eats `o * step / R` of the along-track step.
    # Once `o` approaches R the segment reverses. The Congaree's tenth-percentile radius is 281 m and
    # its largest shift is 238 m, so this is not a corner case there, it is the corners.
    #
    # Repaired rather than refused: a station whose neighbours have already moved cannot simply be
    # put back. Where a fold appears, the three offsets around it are replaced by their own mean --
    # the one operation that provably reduces the variation that caused it -- and the check is run
    # again. It stops when there is nothing left to fix or when a sweep stops helping, and whatever
    # survives is COUNTED so the build record says so instead of shipping a line nobody can follow.
    def build(offsets):
        made = []
        for i in range(n):
            nv = norms[i]
            # A MOVE SMALLER THAN ONE PROBE STEP IS NOT A MEASUREMENT. `(left - right) / 2` is
            # quantised to half a probe, so without this the line jitters for ever and never settles.
            if nv is None or cands[i] is None or abs(offsets[i]) < probe:
                made.append(pts[i])
            else:
                made.append((pts[i][0] + nv[0] * offsets[i], pts[i][1] + nv[1] * offsets[i]))
        return made

    def folding(made):
        bad = []
        for i in range(1, len(made) - 1):
            ax, ay = made[i][0] - made[i - 1][0], made[i][1] - made[i - 1][1]
            bx, by = made[i + 1][0] - made[i][0], made[i + 1][1] - made[i][1]
            if ax * bx + ay * by <= 0:
                bad.append(i)
        return bad

    out = build(off)
    bad = folding(out)
    while bad:
        for i in bad:
            lo = max(0, i - 1)
            hi = min(n - 1, i + 1)
            mean = sum(off[lo:hi + 1]) / float(hi - lo + 1)
            for k in range(lo, hi + 1):
                off[k] = mean
        out = build(off)
        again = folding(out)
        if len(again) >= len(bad):
            bad = again
            break
        bad = again
    folds = len(bad)

    moved = 0
    shifts = []
    for i in range(n):
        if out[i] is not pts[i] and (out[i][0] != pts[i][0] or out[i][1] != pts[i][1]):
            moved += 1
            shifts.append(math.hypot(out[i][0] - pts[i][0], out[i][1] - pts[i][1]))
    return moved, stranded, folds, shifts, out


def centre_on_water(pts, inside, step, probe, reach, passes):
    """Put the centreline in the middle of the water, and say what it took.

    THE SWEEPS STOP WHEN THEY STOP HELPING, not after a number somebody chose. Each sweep reports
    the total distance it moved the line; the first one that does not beat the one before it is
    discarded and the loop ends. On a synthetic meander that is 658 m, 271, 131, 57, 30, 25, 25 --
    the tail being pure probe-quantisation jitter, which is exactly where it should stop.

    THE RESAMPLE HAPPENS ONCE, AT THE END, and that is not a detail. `station_m` is `i * step`
    everywhere downstream, so the line has to come back to even spacing -- but resample() drops
    whatever is left over past the last whole step, and doing it every sweep shortened a 1,000 m test
    channel to 825 m over fifteen of them. Once is the same single truncation the flowline has always
    had.
    """
    rep = {'passes': 0, 'moved': [], 'stranded': 0, 'folds': 0, 'shift_m': {}, 'moved_m': []}
    every = []
    best = None
    for _ in range(max(1, int(passes))):
        moved, stranded, folds, shifts, out = centre_pass(pts, inside, step, probe, reach)
        total = round(sum(shifts), 1)
        if best is not None and total >= best:
            break
        best = total
        pts = out
        rep['passes'] += 1
        rep['moved'].append(moved)
        rep['moved_m'].append(total)
        rep['stranded'] = stranded
        rep['folds'] = folds
        every.extend(shifts)
        if moved == 0:
            break
    pts = resample(pts, step)
    if every:
        every.sort()
        rep['shift_m'] = {'p50': pct(every, .50), 'p90': pct(every, .90),
                          'max': round(every[-1], 1)}
    return pts, rep


def signed_offset(pts, i, x, y):
    """Metres left of downstream at station `i`. Positive is the left bank, looking downstream."""
    a = pts[max(i - 1, 0)]
    b = pts[min(i + 1, len(pts) - 1)]
    hx, hy = b[0] - a[0], b[1] - a[1]
    h = math.hypot(hx, hy) or 1.0
    return (-hy / h) * (x - pts[i][0]) + (hx / h) * (y - pts[i][1])


# ─────────────────────────────────────────────────────────────────────────────────────────────
# Charted depth, from depth_areas.geojson.
#
# Ryan, 2026-09-16: "if i am dragging baits then i still need to know what the shallowest depth is
# on the line so we can figure out baits... if it changes drastically then i would probably need
# bait changes."
#
# THE SHALLOWEST IN THE SECTION IS NOT THE SHALLOWEST ON THE LINE, and measuring it the obvious way
# says 1 ft at every station on the Congaree -- a cross-section runs bank to bank and the margin is
# always in the 0-1 ft band. What he asked for is the minimum along the PATH, which depends on which
# side he takes: on the Congaree the median depth is 3 ft a quarter of the way across, 5 ft
# mid-channel and 9 ft on the deepest line. So the profile is stored ACROSS the section and the
# minimum along a chosen line is the consumer's to take.
#
# TWO CONVENTIONS, ON PURPOSE, because the two numbers answer different questions. The profile
# carries the SHALLOW EDGE of the charted band -- the depth a bait has to clear. The area carries
# the band MIDPOINT, which is the better estimate of the volume the discharge is moving through.
# Bands are one foot wide, so the two differ by at most a foot.
# ─────────────────────────────────────────────────────────────────────────────────────────────
DEPTH_FRACTIONS = (0.0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1.0)


class DepthIndex:
    """Deepest charted band at a point, from the depth polygons of one pack."""

    def __init__(self, path, cell=200.0):
        self.cell = cell
        self.rings = []          # (pts, shallow_edge_ft, midpoint_ft)
        self.g = collections.defaultdict(list)
        self.polygons = 0
        if not os.path.exists(path):
            return
        with open(path, encoding='utf-8') as fh:
            fc = json.load(fh)
        for feat in fc.get('features') or []:
            pr = feat.get('properties') or {}
            lo, hi = pr.get('depth_min_ft'), pr.get('depth_max_ft')
            if lo is None and hi is None:
                continue
            lo = float(lo if lo is not None else hi)
            hi = float(hi if hi is not None else lo)
            self.polygons += 1
            for ring in rings_of(feat.get('geometry') or {}):
                pts = [to_albers(q[0], q[1]) for q in ring]
                if len(pts) < 3:
                    continue
                i = len(self.rings)
                xs = [q[0] for q in pts]
                ys = [q[1] for q in pts]
                # The ring's own bbox, kept beside it: four comparisons reject most candidates a
                # 200 m index cell hands over, before any ray cast. Without it the Congaree takes
                # 25 s and a 15,000-polygon pack takes minutes.
                self.rings.append((pts, lo, (lo + hi) / 2.0,
                                   min(xs), max(xs), min(ys), max(ys)))
                for gx in range(int(min(xs) // cell), int(max(xs) // cell) + 1):
                    for gy in range(int(min(ys) // cell), int(max(ys) // cell) + 1):
                        self.g[(gx, gy)].append(i)

    def at(self, x, y):
        """(shallow_edge_ft, midpoint_ft) of the DEEPEST band covering this point, or None."""
        best = None
        for i in self.g.get((int(x // self.cell), int(y // self.cell)), ()):
            pts, lo, mid, x0, x1, y0, y1 = self.rings[i]
            if x < x0 or x > x1 or y < y0 or y > y1:
                continue
            if best is not None and mid <= best[1]:
                continue
            c = False
            n = len(pts)
            j = n - 1
            for k in range(n):
                xi, yi = pts[k]
                xj, yj = pts[j]
                j = k
                if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                    c = not c
            if c:
                best = (lo, mid)
        return best


def cross_sections(pts, wid, depth, probe):
    """Per station: cross-section area, the deepest charted line, coverage, and the profile.

    ONE SWEEP, ONE ANSWER. The profile positions are read out of the same sweep that measures the
    area rather than re-queried afterwards -- two passes over the same section is two chances to
    disagree about the same water, which is the defect this project keeps finding.
    """
    n = len(pts)
    area = [None] * n
    deepest = [None] * n
    charted = [None] * n
    profile = [None] * n
    if not depth.rings:
        return area, deepest, charted, profile
    for i in range(n):
        w = wid[i]
        if not w:
            continue
        a = pts[max(i - 1, 0)]
        b = pts[min(i + 1, n - 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        h = math.hypot(dx, dy)
        if h == 0:
            continue
        px, py = -dy / h, dx / h
        half = w / 2.0
        samples = []                       # (offset from the left bank, shallow_edge, midpoint)
        k = -half
        while k <= half:
            samples.append((k + half, depth.at(pts[i][0] + px * k, pts[i][1] + py * k)))
            k += probe
        if not samples:
            continue
        hits = [(off, v) for off, v in samples if v is not None]
        charted[i] = round(len(hits) / len(samples), 3)
        if not hits:
            continue
        area[i] = round(sum(v[1] * 0.3048 * probe for _off, v in hits), 1)
        deepest[i] = max(v[0] for _off, v in hits)
        prof = []
        for fr in DEPTH_FRACTIONS:
            want = fr * w
            off, v = min(samples, key=lambda s: abs(s[0] - want))
            prof.append(v[0] if v else None)
        profile[i] = prof
    return area, deepest, charted, profile


class StationIndex:
    """Grid index over the resampled stations, so 22,940 features do not each scan 3,800 points."""

    def __init__(self, pts, cell=400.0):
        self.pts = pts
        self.cell = cell
        self.g = collections.defaultdict(list)
        for i, p in enumerate(pts):
            self.g[(int(p[0] // cell), int(p[1] // cell))].append(i)

    def nearest(self, x, y):
        gx, gy = int(x // self.cell), int(y // self.cell)
        cand, found_at = [], None
        for ring in range(0, 64):
            for a in range(gx - ring, gx + ring + 1):
                for b in range(gy - ring, gy + ring + 1):
                    if ring and max(abs(a - gx), abs(b - gy)) != ring:
                        continue
                    cand += self.g.get((a, b), ())
            if cand and found_at is None:
                found_at = ring
            if found_at is not None and ring >= found_at + 1:
                break
        if not cand:
            return None, None
        best = min(cand, key=lambda i: (self.pts[i][0] - x) ** 2 + (self.pts[i][1] - y) ** 2)
        return best, math.dist(self.pts[best], (x, y))


# ─────────────────────────────────────────────────────────────────────────────────────────────
STAMP_FIELDS = ('river_m', 'off_m', 'flow_deg', 'bend_r_m', 'bend_side')
FEATURE_FILES = ('structure.geojson', 'water_features.geojson')
RTREE = 'rtree_hydro_3dhp_all_flowline_shape'
TABLE = 'hydro_3dhp_all_flowline'


def rivers_from_index(registry, only):
    with open(os.path.join(registry, 'lake_index.json'), encoding='utf-8') as fh:
        idx = json.load(fh)
    rows = idx['lakes'] if isinstance(idx, dict) and 'lakes' in idx else idx
    if isinstance(rows, dict):
        rows = list(rows.values())
    riv = [r for r in rows if isinstance(r, dict) and str(r.get('feature_type')) == 'river']
    if only:
        want = {s.strip() for s in only.split(',') if s.strip()}
        missing = want - {r['slug'] for r in riv}
        if missing:
            sys.exit('--only names %d slug(s) that are not rivers in lake_index.json: %s'
                     % (len(missing), ', '.join(sorted(missing))))
        riv = [r for r in riv if r['slug'] in want]
    return sorted(riv, key=lambda r: r['slug'])


def backup(paths, chartpack, stamp, slug):
    dest = os.path.join(chartpack, '_to_delete', 'river_centrelines_%s' % stamp, slug)
    moved = []
    for p in paths:
        if os.path.exists(p):
            os.makedirs(dest, exist_ok=True)
            shutil.copy2(p, os.path.join(dest, os.path.basename(p)))
            moved.append(os.path.basename(p))
    return moved


def write_json(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(obj, fh)
    os.replace(tmp, path)


def pct(sorted_vals, p):
    if not sorted_vals:
        return None
    return round(sorted_vals[min(len(sorted_vals) - 1, int(p * (len(sorted_vals) - 1)))], 1)


def build_one(row, a, db, stamp):
    """Everything for one river. Returns (report_row, writes) where writes is path -> object."""
    slug = row['slug']
    t0 = time.time()
    rep = {'slug': slug, 'state': row.get('state'), 'display_name': row.get('display_name')}
    pack = os.path.join(a.chartpack, slug)
    bpath = os.path.join(a.registry, 'boundaries', '%s.geojson' % slug)
    if not os.path.isdir(pack):
        rep['skipped'] = 'no chartpack directory'
        return rep, {}
    if not os.path.exists(bpath):
        rep['skipped'] = 'no boundary in registry/boundaries'
        return rep, {}

    rings = load_boundary_rings(bpath)
    if not rings:
        rep['skipped'] = 'boundary carries no rings'
        return rep, {}
    mask = Mask(rings, a.mask_cell)

    rows = db.execute(
        'select mainstemid, flowdirection, shape from %s where fid in '
        '(select id from %s where maxx>=? and minx<=? and maxy>=? and miny<=?)' % (TABLE, RTREE),
        (mask.minx, mask.maxx, mask.miny, mask.maxy)).fetchall()

    inside_len = collections.Counter()
    by_main = collections.defaultdict(list)
    fdir = collections.Counter()
    for mid, fd, shape in rows:
        for line in gpkg_lines(shape):
            pin = [p for p in line if mask.inside(*p)]
            if len(pin) < 2:
                continue
            inside_len[mid] += sum(math.dist(pin[i], pin[i + 1]) for i in range(len(pin) - 1))
            by_main[mid].append(line)
            fdir[fd] += 1
    if not inside_len:
        rep['skipped'] = 'no 3DHP flowline inside the boundary'
        return rep, {}

    # ── WHICH MAINSTEM IS THIS RIVER: THE ONE THE CHART IS ON, NOT THE LONGEST ─────────────────
    #
    # A registry boundary can hold more than one river, and the longest one inside it is not always
    # the one Garmin surveyed. Measured 2026-09-17: on `pee_dee_river_2` the longest chain inside
    # the boundary is 111 km and NOT ONE of the pack's 104 charted features is within 1.8 km of it,
    # while the pack's own depth areas sit in the eastern third of the same boundary. Same on
    # `south_yadkin_river`, whose chart overlaps 69% of the `yadkin_river` pack's depth areas, and
    # on `nolichucky_river_2`. Three of 57 rivers were building a centreline through water their
    # own chartpack has no soundings for, which is a river day with nothing on it by construction.
    #
    # THE CENTRELINE EXISTS TO SERVE A PLANNER THAT NEEDS DEPTH, so the objective is charted metres,
    # not metres. The depth index moved above this pick for it; it was built a dozen lines below and
    # is per-pack either way, so nothing is computed twice.
    #
    # PER SEGMENT, ON ITS MIDPOINT. 3DHP segments are short and this is a SELECTION heuristic, not a
    # measurement that reaches a plan -- a segment half in charted water counts whole or not at all,
    # and that is fine for choosing between two rivers tens of kilometres apart.
    #
    # LENGTH IS STILL THE ANSWER WHERE THERE IS NO CHART TO ASK. `--no-depth`, a pack with no
    # depth_areas.geojson, and a river Garmin never sounded -- chauga_river has 4.7% of its stations
    # charted with every feature a few metres off the line -- all fall back to the old rule rather
    # than picking arbitrarily among zeroes. `mainstem_basis` on the report says which rule ran.
    if a.no_depth:
        depth = DepthIndex(os.devnull)
    else:
        depth = DepthIndex(os.path.join(pack, 'depth_areas.geojson'), a.depth_cell)

    charted_len = collections.Counter()
    if depth.polygons:
        for mid, lines in by_main.items():
            for line in lines:
                pin = [p for p in line if mask.inside(*p)]
                for k in range(len(pin) - 1):
                    if depth.at((pin[k][0] + pin[k + 1][0]) / 2.0,
                                (pin[k][1] + pin[k + 1][1]) / 2.0) is not None:
                        charted_len[mid] += math.dist(pin[k], pin[k + 1])

    if charted_len and max(charted_len.values()) > 0:
        main_id = charted_len.most_common(1)[0][0]
        rep['mainstem_basis'] = 'charted'
    else:
        main_id = inside_len.most_common(1)[0][0]
        rep['mainstem_basis'] = 'length'
    rep['mainstem_charted_m'] = round(charted_len.get(main_id, 0.0), 1)
    rep['mainstem_inside_m'] = round(inside_len.get(main_id, 0.0), 1)
    # SAY IT WHEN THE TWO RULES DISAGREE. A silent change of answer is how the old pick survived.
    longest_id = inside_len.most_common(1)[0][0]
    rep['mainstem_longest_id'] = longest_id
    rep['mainstem_changed'] = bool(main_id != longest_id)

    # THE SAME DEPTH INDEX THE PICK ABOVE USED, HANDED DOWN RATHER THAN REBUILT. A segment counts
    # its whole length when its midpoint is in charted water -- the same per-segment heuristic, for
    # the same reason: this chooses between runs tens of kilometres apart, it does not reach a plan.
    def _charted_m(a, b):
        mx, my = (a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0
        if not mask.inside(mx, my):
            return 0.0
        return math.dist(a, b) if depth.at(mx, my) is not None else 0.0

    chain, chain_m, chain_basis = chain_mainstem(by_main[main_id],
                                                _charted_m if depth.polygons else None)
    rep['chain_basis'] = chain_basis
    rep['chain_charted_m'] = round(
        sum(_charted_m(chain[i], chain[i + 1]) for i in range(len(chain) - 1)), 1)
    if chain_m < a.min_chain_m:
        rep['skipped'] = 'chain %.0f m is under --min-chain-m' % chain_m
        return rep, {}

    pts = resample(chain, a.step)

    # ── THE CAP IS MEASURED ON THE FLOWLINE, BEFORE ANYTHING MOVES ──────────────────────────────
    #
    # Three channel widths off the centreline is off this river. That rule used to be computed a
    # hundred lines down, off the FINAL widths, and it is now needed twice: once to bound how far
    # centre_on_water() may reach sideways looking for water, and once, unchanged, to gate the
    # channel direction stamped onto a feature. One measurement, two readers -- the river's width
    # is not changed by moving the line twenty metres, and two copies of one rule is how the two
    # start disagreeing.
    wid0 = widths(pts, mask, a.max_width_m, a.probe)
    w0 = sorted(w for w in wid0 if w is not None)
    cap = round(3.0 * w0[len(w0) // 2], 1) if w0 else None

    # ── AND NOW THE LINE IS PUT WHERE ITS NAME SAYS IT IS ───────────────────────────────────────
    #
    # See centre_on_water(). THE CHART DECIDES WHERE THE MIDDLE IS, and the boundary only where
    # there is no chart -- a pack with soundings is a pack whose depth areas are the water a bait
    # can be dragged through, and the registry boundary is an outline from somewhere else. Chosen
    # once per river rather than per station, so the line cannot alternate between two different
    # ideas of the middle halfway along itself.
    inside = ((lambda x, y: depth.at(x, y) is not None) if depth.polygons
              else (lambda x, y: mask.inside(x, y)))
    centring = {'basis': 'charted' if depth.polygons else 'boundary',
                'stations_before': len(pts),
                'off_water_before': sum(1 for q in pts if not inside(q[0], q[1]))}
    if not a.no_centre:
        pts, moved_rep = centre_on_water(pts, inside, a.step, a.probe,
                                         cap or a.max_width_m, a.centre_passes)
        centring.update(moved_rep)
    centring['stations_after'] = len(pts)
    centring['off_water_after'] = sum(1 for q in pts if not inside(q[0], q[1]))
    rep['centring'] = centring

    turn, rad = curvature(pts, a.step, a.window)
    brg = bearings(pts)
    # MEASURED AGAIN ON THE LINE THAT IS WRITTEN. `wid0` above priced the cap off the flowline;
    # every width, area and depth column below belongs to the centred line, because those are what
    # a plan reads. The span still comes from the BOUNDARY while the centring came from the CHART,
    # which is the one place those two ideas of the river still meet -- noted rather than changed,
    # because moving it would move every depth profile on all 57 rivers in the same commit.
    wid = widths(pts, mask, a.max_width_m, a.probe)

    xarea, xdeep, xchart, xprof = cross_sections(pts, wid, depth, a.probe)
    rep['depth_polygons'] = depth.polygons

    good_w = sorted(w for w in wid if w is not None)
    rep.update({
        'mainstem_id': main_id,
        'flowlines_in_bbox': len(rows),
        'flowdirection_usable': fdir.get(1, 0),
        'flowdirection_unusable': sum(v for k, v in fdir.items() if k != 1),
        'chain_km': round(chain_m / 1000.0, 2),
        'stations': len(pts),
        'step_m': a.step,
        'window_m': a.window,
        'width_m': {'n': len(good_w), 'p10': pct(good_w, .10), 'p50': pct(good_w, .50),
                    'p90': pct(good_w, .90)},
    })
    good_a = sorted(v for v in xarea if v is not None)
    good_d = sorted(v for v in xdeep if v is not None)
    rep['section'] = {
        'stations_with_depth': len(good_a),
        'area_m2': {'p10': pct(good_a, .10), 'p50': pct(good_a, .50), 'p90': pct(good_a, .90)},
        'deepest_line_ft': {'p10': pct(good_d, .10), 'p50': pct(good_d, .50),
                            'max': (good_d[-1] if good_d else None)},
    }

    good_r = sorted(r for r in rad if r is not None)
    rep['radius_m'] = {'n': len(good_r), 'p10': pct(good_r, .10), 'p25': pct(good_r, .25),
                       'p50': pct(good_r, .50), 'p75': pct(good_r, .75)}

    # THE SNAP CAP IS THE RIVER'S OWN WIDTH, not a number chosen here: three channel widths off the
    # centreline is off this river, and a water whose width never resolved gets no cap at all rather
    # than an invented one. Computed above, before the centring, and used by both.
    rep['snap_cap_m'] = cap

    idxr = StationIndex(pts)

    # ── tributary confluences: a non-mainstem reach whose DOWNSTREAM end meets the centreline ──
    tribs = {}
    for mid, lines in by_main.items():
        if mid == main_id:
            continue
        for line in lines:
            i, d = idxr.nearest(*line[-1])
            if i is None or d > a.trib_m:
                continue
            prev = tribs.get(mid)
            if prev is None or d < prev['off_m']:
                lon, lat = to_lonlat(*line[-1])
                # ONE ANSWER TO "WHICH SIDE", shared with the feature stamping below. Two
                # implementations of the same geometry is how a plan and a card end up disagreeing
                # about the same water.
                off = signed_offset(pts, i, line[-1][0], line[-1][1])
                tribs[mid] = {'river_m': round(i * a.step, 1), 'off_m': round(d, 1),
                              'side': 'left' if off > 0 else 'right',
                              'lonlat': [round(lon, 6), round(lat, 6)], 'mainstem_id': mid}
    trib_list = sorted(tribs.values(), key=lambda t: t['river_m'])
    rep['tributary_mouths'] = len(trib_list)

    # ── stamp the features that already exist ──────────────────────────────────────────────
    writes = {}
    stamped = collections.Counter()
    sides = collections.Counter()
    off_cap = collections.Counter()
    # THE ONE NUMBER THAT SEPARATES A TIGHT CAP FROM THE WRONG WATER. If the closest feature in the
    # whole pack is kilometres from the centreline, no cap would have saved it.
    nearest_feature_m = None
    for fn in FEATURE_FILES:
        p = os.path.join(pack, fn)
        if not os.path.exists(p):
            continue
        with open(p, encoding='utf-8') as fh:
            fc = json.load(fh)
        for feat in fc.get('features') or []:
            props = feat.setdefault('properties', {})
            for k in STAMP_FIELDS:
                props.pop(k, None)
            ll = first_point(feat.get('geometry') or {})
            if not ll:
                continue
            x, y = to_albers(ll[0], ll[1])
            i, d = idxr.nearest(x, y)
            if i is None:
                continue
            if nearest_feature_m is None or d < nearest_feature_m:
                nearest_feature_m = d
            off = signed_offset(pts, i, x, y)
            # WHERE THE THING IS RELATIVE TO THE RIVER. True at any distance, and the pair is the
            # whole answer: nearest the channel at `river_m`, and `off_m` away from it. A reader
            # that looks at one without the other is reading half a coordinate.
            props['river_m'] = round(i * a.step, 1)
            props['off_m'] = round(off, 1)
            # WHAT THE CHANNEL IS DOING AT THAT STATION -- WHICH IS ONLY ABOUT THIS FEATURE IF THE
            # FEATURE IS IN THE CHANNEL.
            #
            # `flow_deg` and `bend_r_m` describe the RIVER at station i. They were stamped at any
            # distance while `bend_side` alone respected the cap, so a feature this script's own
            # comment calls "off this river" -- three channel widths out -- still came away with a
            # flow direction and a bend radius measured somewhere it is not. Nothing read them yet,
            # which is the only reason it cost nothing; `deepest_within_m` is the standing lesson on
            # what a field that quietly says something false costs the day something does read it.
            #
            # Measured 2026-09-17 across all 57 rivers, 22,939 stamped features: 5,288 (23.1%) are
            # beyond their own pack's cap, and every one of them carried a `flow_deg`. On the
            # Congaree -- a river this works on -- |off_m| is 54 m at the median and 918 m at worst
            # against a 435 m cap. On south_yadkin_river, pee_dee_river_2 and nolichucky_river_2 it
            # is 100%, and the NEAREST feature in those three packs is 1.5 km, 1.8 km and 3.1 km
            # from the centreline. Those are not tight caps, they are packs whose chart and whose
            # boundary are on different water, and this gate is what makes them say so.
            on_river = cap is None or d <= cap
            props['flow_deg'] = round(brg[i], 1) if on_river else None
            props['bend_r_m'] = (round(rad[i], 1)
                                 if on_river and rad[i] is not None else None)
            side = None
            if on_river and rad[i] is not None and turn[i] is not None:
                side = 'outside' if (off > 0) != (turn[i] > 0) else 'inside'
            props['bend_side'] = side
            kind = props.get('kind') or 'unknown'
            stamped[kind] += 1
            if not on_river:
                off_cap[kind] += 1
            if side:
                sides['%s %s' % (kind, side)] += 1
        writes[p] = fc
    rep['stamped'] = dict(stamped)
    rep['bend_sides'] = dict(sides)
    # A CONDITION THIS SCRIPT CAN SEE MUST REACH THE REPORT, or the next person measures it again.
    # `off_cap` counts the features this pack put beyond its own three-widths rule -- a handful is
    # ordinary on a wide reach, and a pack where it approaches everything is a pack whose chart and
    # whose boundary are on different water. `off_cap_frac` is what a checker reads.
    n_stamped = sum(stamped.values())
    rep['off_cap'] = dict(off_cap)
    rep['off_cap_n'] = sum(off_cap.values())
    rep['off_cap_frac'] = (round(sum(off_cap.values()) / n_stamped, 4) if n_stamped else None)
    rep['nearest_feature_m'] = round(nearest_feature_m, 1) if nearest_feature_m is not None else None

    coords = [list(to_lonlat(*p)) for p in pts]
    writes[os.path.join(pack, 'centreline.geojson')] = {
        'type': 'FeatureCollection',
        '_note': ('Downstream-ordered centreline from the 3DHP flowline mainstem inside this '
                  "water's registry boundary. flowdirection=1 means vertex order is downstream. "
                  'bearing_deg is a compass bearing of flow; radius_m is unsigned curvature over a '
                  '%d m window and is null where the reach is straight; width_m is the channel '
                  'width from perpendicular rays and is null where a ray ran past --max-width-m. '
                  'area_m2 is the charted cross-section, summed from the MIDPOINT of each depth '
                  'band, and is what a discharge divides by to give a velocity. depth_profile_ft '
                  'carries the SHALLOW EDGE of the band at each of profile_fractions across the '
                  'section -- the depth a dragged bait has to clear -- and deepest_line_ft is that '
                  'same shallow edge on the deepest line found. charted_frac is the share of the '
                  'section that had any charted depth at all: where it is low the depth is UNKNOWN '
                  'and not shallow, and a station with none carries nulls rather than a number. '
                  'Arrays are parallel to the LineString coordinates. No threshold is applied here.'
                  % a.window),
        'features': [{
            'type': 'Feature',
            'geometry': {'type': 'LineString', 'coordinates': [[round(c[0], 6), round(c[1], 6)]
                                                               for c in coords]},
            'properties': {
                'slug': slug, 'mainstem_id': main_id, 'step_m': a.step, 'window_m': a.window,
                # THE LENGTH OF THE LINE IN THIS FILE, not of the 3DHP chain it came from. Those
                # were always a little apart -- resample() drops the tail remainder -- and the
                # centring makes them properly different, because following a meander instead of
                # chording it is longer. `chain_km` on the build record still reports the source.
                'length_m': round(sum(math.dist(pts[i], pts[i + 1])
                                      for i in range(len(pts) - 1)), 1),
                'stations': len(pts), 'snap_cap_m': cap,
                'built': stamp,
                'station_m': [round(i * a.step, 1) for i in range(len(pts))],
                'bearing_deg': [round(b, 1) for b in brg],
                'radius_m': [round(r, 1) if r is not None else None for r in rad],
                'width_m': wid,
                'area_m2': xarea,
                'deepest_line_ft': xdeep,
                'charted_frac': xchart,
                'profile_fractions': list(DEPTH_FRACTIONS),
                'depth_profile_ft': xprof,
                'tributaries': trib_list,
            },
        }],
    }
    rep['seconds'] = round(time.time() - t0, 1)
    return rep, writes


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True, help='the registry directory (holds lake_index.json and boundaries/)')
    ap.add_argument('--chartpack', help='the chartpack directory. Default: <registry>/../chartpack')
    ap.add_argument('--gpkg', help='the 3DHP GeoPackage. Default: <registry>/../3dhp_all_CONUS_20260112_GPKG/3dhp_all_CONUS_20260112_GPKG.gpkg')
    ap.add_argument('--report', help='where the build record goes. Default: <registry>/_river_centrelines.json')
    ap.add_argument('--only', help='comma-separated slugs, rivers only')
    ap.add_argument('--step', type=float, default=50.0, help='station spacing in metres (default 50)')
    ap.add_argument('--window', type=float, default=400.0,
                    help='curvature window in metres (default 400). The outside/inside split was '
                         'measured as insensitive to this between 400 and 1000.')
    ap.add_argument('--mask-cell', type=float, default=10.0, help='inside-test row height in metres (default 10)')
    ap.add_argument('--probe', type=float, default=5.0,
                    help='width ray step in metres, also the cross-section sample spacing (default 5)')
    ap.add_argument('--depth-cell', type=float, default=200.0,
                    help='depth-polygon index cell in metres (default 200)')
    ap.add_argument('--no-depth', action='store_true',
                    help='skip the cross-section entirely. Faster, and the centreline then carries '
                         'no area, no depth profile and no coverage.')
    ap.add_argument('--no-centre', action='store_true',
                    help='leave the line exactly where 3DHP drew it. This is what every centreline '
                         'built before 2026-09-18 is, and on Ryan\'s own Congaree reaches it puts '
                         '16.4%% of the water he fishes outside the charted river.')
    ap.add_argument('--centre-passes', type=int, default=6,
                    help='the most centring sweeps a river may take (default 6). A cap on '
                         'iteration, not a tuning knob: the sweeps stop on their own as soon as one '
                         'moves the line no further than the one before it, and the build record '
                         'reports how many each river actually used and how far each one moved.')
    ap.add_argument('--max-width-m', type=float, default=3000.0, help='give up on a width ray past this (default 3000)')
    ap.add_argument('--trib-m', type=float, default=120.0, help='a tributary mouth is this close to the centreline (default 120)')
    ap.add_argument('--min-chain-m', type=float, default=1000.0, help='skip a water whose longest chain is shorter (default 1000)')
    ap.add_argument('--dry-run', action='store_true', help='measure and print. WRITES NOTHING, including the report.')
    ap.add_argument('--quiet', action='store_true', help='one line per river, no per-river detail')
    a = ap.parse_args()

    a.registry = os.path.abspath(a.registry)
    root = os.path.dirname(a.registry)
    a.chartpack = os.path.abspath(a.chartpack or os.path.join(root, 'chartpack'))
    a.gpkg = os.path.abspath(a.gpkg or os.path.join(
        root, '3dhp_all_CONUS_20260112_GPKG', '3dhp_all_CONUS_20260112_GPKG.gpkg'))
    a.report = os.path.abspath(a.report or os.path.join(a.registry, '_river_centrelines.json'))
    for p, what in ((a.registry, '--registry'), (a.chartpack, '--chartpack')):
        if not os.path.isdir(p):
            sys.exit('%s is not a directory: %s' % (what, p))
    if not os.path.exists(a.gpkg):
        sys.exit('--gpkg not found: %s' % a.gpkg)

    riv = rivers_from_index(a.registry, a.only)
    stamp = time.strftime('%Y-%m-%d_%H%M%S')
    db = sqlite3.connect('file:%s?mode=ro' % a.gpkg.replace('?', '%3f'), uri=True)
    have = {r[0] for r in db.execute(
        "select name from sqlite_master where type in ('table','view') and name in (?,?)",
        (TABLE, RTREE))}
    if len(have) < 2:
        sys.exit('%s does not carry %s and %s' % (a.gpkg, TABLE, RTREE))

    print('%d river(s), step %g m, window %g m%s'
          % (len(riv), a.step, a.window, '   DRY RUN, nothing will be written' if a.dry_run else ''))
    t0 = time.time()
    report = {'_note': 'build record for build_river_centrelines.py. One row per river.',
              'built': stamp, 'step_m': a.step, 'window_m': a.window, 'rivers': {}}
    totals = collections.Counter()
    for n, row in enumerate(riv, 1):
        rep, writes = build_one(row, a, db, stamp)
        report['rivers'][row['slug']] = rep
        if rep.get('skipped'):
            print('  [%2d/%d] %-32s SKIPPED -- %s' % (n, len(riv), row['slug'], rep['skipped']))
            totals['skipped'] += 1
            continue
        if not a.dry_run:
            moved = backup([p for p in writes if os.path.exists(p)], a.chartpack, stamp, row['slug'])
            rep['replaced'] = moved
            for p, obj in writes.items():
                write_json(p, obj)
        st = rep['stamped']
        totals['rivers'] += 1
        totals['stamped'] += sum(st.values())
        totals['tribs'] += rep['tributary_mouths']
        for k, v in rep['bend_sides'].items():
            totals[k] += v
        if a.quiet:
            print('  [%2d/%d] %-32s %7.1f km  %5d stamped  %3d tributaries  %4.1fs'
                  % (n, len(riv), row['slug'], rep['chain_km'], sum(st.values()),
                     rep['tributary_mouths'], rep['seconds']))
        else:
            w, r = rep['width_m'], rep['radius_m']
            print('  [%2d/%d] %-32s %7.1f km  %5d stations  width p10/p50/p90 %s/%s/%s m  '
                  'radius p10/p50 %s/%s m'
                  % (n, len(riv), row['slug'], rep['chain_km'], rep['stations'],
                     w['p10'], w['p50'], w['p90'], r['p10'], r['p50']))
            sec = rep['section']
            print('           section %d/%d charted   area p10/p50/p90 %s/%s/%s m2   deepest line '
                  'p50/max %s/%s ft'
                  % (sec['stations_with_depth'], rep['stations'], sec['area_m2']['p10'],
                     sec['area_m2']['p50'], sec['area_m2']['p90'],
                     sec['deepest_line_ft']['p50'], sec['deepest_line_ft']['max']))
            print('           stamped %s   tributary mouths %d   snap cap %s m   %.1fs'
                  % (', '.join('%s %d' % (k, v) for k, v in sorted(st.items())),
                     rep['tributary_mouths'], rep['snap_cap_m'], rep['seconds']))
            # WHERE THE LINE WAS AND WHERE IT IS NOW. The two station counts are the whole claim
            # this stage makes, and a river that does not improve says so on its own line.
            c = rep.get('centring') or {}
            if c:
                sh = c.get('shift_m') or {}
                print('           centred on the %s   stations off the water %d/%d -> %d/%d   '
                      'shift p50/p90/max %s/%s/%s m'
                      % (c.get('basis'), c.get('off_water_before', 0), c.get('stations_before', 0),
                         c.get('off_water_after', 0), c.get('stations_after', 0),
                         sh.get('p50'), sh.get('p90'), sh.get('max')))
                print('           %d sweeps moving %s m   %d stranded with no water on their '
                      'normal   %d folds'
                      % (c.get('passes', 0),
                         '/'.join(str(x) for x in (c.get('moved_m') or ['-'])),
                         c.get('stranded', 0), c.get('folds', 0)))
                # SAID OUT LOUD, like the off-cap line below it. A fold is a line that runs back on
                # itself, which the slope limit is supposed to make impossible; a river that still
                # has most of its stations off the water after this has a chart and a boundary on
                # different water, and no amount of centring is the answer to that.
                if c.get('folds'):
                    print('           THE LINE FOLDS BACK ON ITSELF at %d station(s) -- the slope '
                          'limit in centre_pass() is supposed to make that impossible'
                          % c['folds'])
                before, after = c.get('off_water_before', 0), c.get('off_water_after', 0)
                if after and after >= before:
                    print('           CENTRING BOUGHT NOTHING HERE: %d of %d stations are still off '
                          'the %s water (%d before). %d had no water on their normal at all'
                          % (after, c.get('stations_after', 0), c.get('basis'), before,
                             c.get('stranded', 0)))
            # SAID OUT LOUD, EVERY RUN. A pack whose chart and whose boundary are on different water
            # looks exactly like a healthy one in every line above; this is the line it fails.
            if rep.get('off_cap_n'):
                print('           OFF THIS RIVER  %d of %d (%.0f%%) beyond the %s m cap; nearest '
                      'feature %s m -- no channel direction or bend radius stamped on those'
                      % (rep['off_cap_n'], sum(st.values()), 100.0 * (rep['off_cap_frac'] or 0),
                         rep['snap_cap_m'], rep['nearest_feature_m']))
    db.close()

    if not a.dry_run:
        if os.path.exists(a.report):
            backup([a.report], a.chartpack, stamp, '_registry')
        write_json(a.report, report)

    print('\n%d river(s) built, %d skipped, %.1f min'
          % (totals['rivers'], totals['skipped'], (time.time() - t0) / 60))
    print('   features stamped        %d' % totals['stamped'])
    print('   tributary mouths found  %d' % totals['tribs'])
    for kind in ('hole', 'ledge', 'point', 'cove', 'creek_mouth', 'hump'):
        o, i = totals['%s outside' % kind], totals['%s inside' % kind]
        if o or i:
            print('   %-12s outside %6d   inside %6d   (%.0f%% outside)'
                  % (kind, o, i, 100.0 * o / max(1, o + i)))
    # ── THE PACKS WHOSE CHART AND WHOSE CENTRELINE ARE ON DIFFERENT WATER ────────────────────────
    #
    # ONE TEST, AND IT IS THE PACK'S OWN NUMBERS: the nearest feature in the whole pack is further
    # from the centreline than three channel widths. Not one thing the chart knows about is on the
    # line this script just built, so no cap would have saved it and there is nothing here to plan.
    #
    # It names exactly three of 57 and nothing else is close. Measured 2026-09-17, nearest feature
    # against cap: nolichucky_river_2 6001.6 / 45, pee_dee_river_2 1798 / 150, south_yadkin_river
    # 1461 / 75 -- then a gap to broad_river_2 at 27.9 / 105 and uwharrie_river at 18.1 / 90, both
    # of which are simply charted wider than one channel thread.
    #
    # PRINTED IN --quiet TOO, on purpose. The per-river OFF THIS RIVER line above is in the verbose
    # branch, and a condition only a verbose run mentions is a condition nobody sees.
    dead = [(slug, r) for slug, r in sorted(report['rivers'].items())
            if isinstance(r, dict) and r.get('nearest_feature_m') is not None
            and r.get('snap_cap_m') and r['nearest_feature_m'] > r['snap_cap_m']]
    if dead:
        print('\n   %d RIVER(S) WHOSE CHART IS NOT ON THIS CENTRELINE -- nothing in the pack is'
              ' within three channel widths of the line, so there is no river day to plan here:'
              % len(dead))
        for slug, r in dead:
            sec = r.get('section') or {}
            print('     %-28s nearest feature %8.1f m vs a %s m cap; %s of %s stations charted'
                  % (slug, r['nearest_feature_m'], r['snap_cap_m'],
                     sec.get('stations_with_depth'), r.get('stations')))
        print('     The centreline is the longest 3DHP mainstem inside the registry BOUNDARY, and')
        print('     the boundary can hold more than one river. Compare the pack against its')
        print('     neighbours before researching or planning one of these.')

    if a.dry_run:
        print('\n   DRY RUN -- no chartpack file, no centreline and no report was written.')
    else:
        print('\n   report  %s' % a.report)
        print('   replaced files are in %s'
              % os.path.join(a.chartpack, '_to_delete', 'river_centrelines_%s' % stamp))


if __name__ == '__main__':
    main()
