#!/usr/bin/env python3
"""
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

  chartpack/<slug>/structure.geojson     each feature gains river_m, off_m, flow_deg, bend_r_m,
  chartpack/<slug>/water_features.geojson  bend_side. Nothing is removed and no feature is added, so
                                         nothing downstream goes stale.

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
def chain_mainstem(segments):
    """Longest downstream-ordered chain through `segments`, which are already in flow order."""
    key = lambda p: (round(p[0], 1), round(p[1], 1))
    starts = collections.defaultdict(list)
    for s in segments:
        starts[key(s[0])].append(s)
    ends = {key(s[-1]) for s in segments}
    heads = [s for s in segments if key(s[0]) not in ends] or segments[:1]
    best = []
    best_len = -1.0
    for h in heads:
        chain, cur, seen = [], h, set()
        while cur is not None and id(cur) not in seen:
            seen.add(id(cur))
            chain.extend(cur if not chain else cur[1:])
            nxt = [x for x in starts.get(key(cur[-1]), []) if id(x) not in seen]
            cur = nxt[0] if nxt else None
        length = sum(math.dist(chain[i], chain[i + 1]) for i in range(len(chain) - 1))
        if length > best_len:
            best, best_len = chain, length
    return best, best_len


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


def signed_offset(pts, i, x, y):
    """Metres left of downstream at station `i`. Positive is the left bank, looking downstream."""
    a = pts[max(i - 1, 0)]
    b = pts[min(i + 1, len(pts) - 1)]
    hx, hy = b[0] - a[0], b[1] - a[1]
    h = math.hypot(hx, hy) or 1.0
    return (-hy / h) * (x - pts[i][0]) + (hx / h) * (y - pts[i][1])


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

    main_id = inside_len.most_common(1)[0][0]
    chain, chain_m = chain_mainstem(by_main[main_id])
    if chain_m < a.min_chain_m:
        rep['skipped'] = 'longest chain %.0f m is under --min-chain-m' % chain_m
        return rep, {}

    pts = resample(chain, a.step)
    turn, rad = curvature(pts, a.step, a.window)
    brg = bearings(pts)
    wid = widths(pts, mask, a.max_width_m, a.probe)

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
    good_r = sorted(r for r in rad if r is not None)
    rep['radius_m'] = {'n': len(good_r), 'p10': pct(good_r, .10), 'p25': pct(good_r, .25),
                       'p50': pct(good_r, .50), 'p75': pct(good_r, .75)}

    # THE SNAP CAP IS THE RIVER'S OWN WIDTH, not a number chosen here: three channel widths off the
    # centreline is off this river, and a water whose width never resolved gets no cap at all rather
    # than an invented one.
    cap = round(3.0 * good_w[len(good_w) // 2], 1) if good_w else None
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
            off = signed_offset(pts, i, x, y)
            props['river_m'] = round(i * a.step, 1)
            props['off_m'] = round(off, 1)
            props['flow_deg'] = round(brg[i], 1)
            props['bend_r_m'] = round(rad[i], 1) if rad[i] is not None else None
            side = None
            if rad[i] is not None and turn[i] is not None and (cap is None or d <= cap):
                side = 'outside' if (off > 0) != (turn[i] > 0) else 'inside'
            props['bend_side'] = side
            kind = props.get('kind') or 'unknown'
            stamped[kind] += 1
            if side:
                sides['%s %s' % (kind, side)] += 1
        writes[p] = fc
    rep['stamped'] = dict(stamped)
    rep['bend_sides'] = dict(sides)

    coords = [list(to_lonlat(*p)) for p in pts]
    writes[os.path.join(pack, 'centreline.geojson')] = {
        'type': 'FeatureCollection',
        '_note': ('Downstream-ordered centreline from the 3DHP flowline mainstem inside this '
                  "water's registry boundary. flowdirection=1 means vertex order is downstream. "
                  'bearing_deg is a compass bearing of flow; radius_m is unsigned curvature over a '
                  '%d m window and is null where the reach is straight; width_m is the channel '
                  'width from perpendicular rays and is null where a ray ran past --max-width-m. '
                  'Arrays are parallel to the LineString coordinates. No threshold is applied here.'
                  % a.window),
        'features': [{
            'type': 'Feature',
            'geometry': {'type': 'LineString', 'coordinates': [[round(c[0], 6), round(c[1], 6)]
                                                               for c in coords]},
            'properties': {
                'slug': slug, 'mainstem_id': main_id, 'step_m': a.step, 'window_m': a.window,
                'length_m': round(chain_m, 1), 'stations': len(pts), 'snap_cap_m': cap,
                'built': stamp,
                'station_m': [round(i * a.step, 1) for i in range(len(pts))],
                'bearing_deg': [round(b, 1) for b in brg],
                'radius_m': [round(r, 1) if r is not None else None for r in rad],
                'width_m': wid,
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
    ap.add_argument('--probe', type=float, default=5.0, help='width ray step in metres (default 5)')
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
            print('           stamped %s   tributary mouths %d   snap cap %s m   %.1fs'
                  % (', '.join('%s %d' % (k, v) for k, v in sorted(st.items())),
                     rep['tributary_mouths'], rep['snap_cap_m'], rep['seconds']))
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
    if a.dry_run:
        print('\n   DRY RUN -- no chartpack file, no centreline and no report was written.')
    else:
        print('\n   report  %s' % a.report)
        print('   replaced files are in %s'
              % os.path.join(a.chartpack, '_to_delete', 'river_centrelines_%s' % stamp))


if __name__ == '__main__':
    main()
