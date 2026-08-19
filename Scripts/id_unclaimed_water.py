#!/usr/bin/env python3
r"""id_unclaimed_water.py -- ask 3DHP what each unclaimed Garmin water actually is.

    py .\scripts\id_unclaimed_water.py --in outputs\garmin_unclaimed.json `
        --out outputs\unclaimed_worklist.tsv --min-acres 100

READ-ONLY. Opens the GeoPackage immutable, writes one TSV, touches nothing else.

WHY

`sweep_unclaimed.py` says WHERE Garmin has bathymetry that no boundary claims. It cannot say
WHAT any of it is -- the output is cell clusters with a lat/lon and an acreage. Ryan, 2026-08-12:
*"we still have to figure out what these are... before you were able to line these up with a 3dhp
id and I was able to use the coordinates to match them to a 3dhp id to confirm what it is and
then get info."* That loop produced `unnamed_water_worklist.tsv` and it worked: 114 of 427 rows
got a name and exactly one came back unnameable. This is that loop, batched.

`lookup_3dhp.py --near LON,LAT` answers it for ONE point. `gnisid` is unindexed in the 60 GB
file so a name or id search is a full scan measured in minutes, but the RTree makes a bounding
box query instant. This opens the file once and runs that query per cluster.

TWO THINGS THAT LOOK LIKE POINTS AND ARE NOT

An RTree hit means "this polygon's BOUNDING BOX overlaps your search box". The bounding box of a
dendritic reservoir covers hundreds of square kilometres of dry land and every pond on it, so
bbox-overlap alone would hand a 200-acre farm pond the name of the reservoir 20 km away, and
picking the biggest hit makes that failure systematic. So the geometry is parsed and tested
against the real rings, not the box.

And the CLUSTER is not a point either. The first cut of this script probed 3DHP with the
cluster's centroid, and on the real file 0 of the top 8 clusters landed inside any polygon while
a 2,509-acre cluster got matched to a 0.5-acre pond 226 m away. The centroid of a lake-shaped
thing is routinely on land: measured against this very GeoPackage, LAKE MARION'S OWN REGISTRY
CENTROID sits 4,160 m from the edge of Lake Marion's polygon, and Kentucky Lake's is 860 m
outside its own. That is the same edge-versus-centroid mistake that has now cost four bugs in a
week, arriving from the input side.

So the cluster is probed as a FOOTPRINT, and each candidate polygon is scored by `cover`, the
share of the cluster's sample points that fall inside it. A pond scores 0.02 against a big
cluster and the reservoir that actually holds it scores 0.6, so the ranking cannot be won by a
pond again. The `probe` column says which footprint was available, and the difference matters:

  probe=cells  the `pts` array sweep_unclaimed.py writes -- a sample of the cluster's OWN CELLS.
               Every sample point is water, so cover is the share of the water that is inside.
  probe=bbox   fallback: a --grid x --grid lattice over the bounding box. The median cluster
               fills 54% of its box, so a PERFECT match tops out near 0.54 here and a genuine
               one reads 0.12. Ranking still works, the absolute number does not. Re-run
               sweep_unclaimed.py --report to get `pts`.

  hit=inside   cover >= 0.5. The cluster is substantially inside this polygon.
  hit=partial  cover > 0. Some of the cluster is in it -- an arm, an overlap, or a diluted box.
  hit=near     cover = 0, and dist_m is the distance to the nearest polygon EDGE. Read it.
  hit=(blank)  the RTree returned nothing within --radius of the cluster's box.

Ties on cover go to the SMALLEST polygon: a river-area polygon drawn through a reservoir and the
reservoir itself may both cover the cluster, and the smaller one is the more specific statement.

WHAT IT REPORTS, AND WHY BOTH TABLES

  WATERBODY  a polygon. A boundary can be cut from it, and `gnisidlabel` names it.
  FLOWLINE   a line. Nothing to clip against, so a cluster matching only flowlines is the
             UNNAMED-POLYGON BLIND SPOT: 3DHP named the river and never modelled the
             impoundment. Bates Old River is the worked case -- 11 flowlines, zero waterbody rows.

  waterbody-named    a polygon covers at least --min-cover of this water and 3DHP names it.
  waterbody-unnamed  a polygon covers at least --min-cover of it and has no name. Cut it, then
                     name it from Garmin 5/1 POIs or DNR.
  nothing-covers-it  no polygon covers enough of this water to identify it. NOT an
                     identification, and `id3dhp` is BLANK on these rows -- whatever polygon is
                     nearest belongs to some other water, and it is reported as `near_id3dhp`
                     where it cannot be mistaken for an answer.

                     Both halves of that were learned the hard way on the first real run. It
                     called 1,210 near-misses 'waterbody-unnamed', which read as 468,985 acres of
                     findable lake; and on a 2,489-acre cluster it printed the id of an eleven-
                     acre pond that had caught ONE of twenty-four sample cells. Ryan: *"3dhp
                     doesn't even know there is a lake there... which is weird because you gave
                     me a 3dhp id."*
  flowline-only      no polygon at all, only lines. This is Bates. It needs a Garmin-derived cut.
  nothing-in-3dhp    3DHP has never heard of this water.

`name` is only ever the name of the PICKED polygon. If the pick is unnamed, the biggest named
polygon in the box is reported separately in `alt` with its area, so a 2-acre pond posing as an
identification is visible as a 2-acre pond instead of quietly becoming the answer.

`reg_slug` is the registry row whose `gnis:` id matches, so "3DHP names it and the registry does
not have it" is a checked claim rather than an assumed one.

`--radius` defaults to 1200 m, not lookup_3dhp's 4000: that one answers "what is near this point"
for a human, this answers "what IS this cluster" for a list, and 4 km around a 200-acre pond
returns the whole neighbourhood.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse, collections, importlib.util, json, math, os, sqlite3, struct, sys

WB = 'hydro_3dhp_all_waterbody'
FL = 'hydro_3dhp_all_flowline'


def dd(lon: float, lat: float) -> str:
    """The National Map's `dd` box, which is NOT two plain signed numbers.

    It wants hemisphere letters and fixed-width degrees -- latitude on 2 digits, longitude on 3,
    zero padded, both to 6 decimals: `33.694880 deg N, 083.646250 deg W`.

    Ryan pasted an xy pair into this box and it came back `83.648071 S, 033.665655 E`: the widget
    read the LONGITUDE as a latitude and flipped both hemispheres, silently, into a plausible
    point in the Indian Ocean. That is the failure this column exists to prevent, so the
    hemisphere letters are computed from the sign and never carried over from anything.
    """
    return '%09.6f\u00b0%s, %010.6f\u00b0%s' % (abs(lat), 'N' if lat >= 0 else 'S',
                                                 abs(lon), 'E' if lon >= 0 else 'W')


def webmercator(lon: float, lat: float):
    """EPSG:3857 metres, which is what The National Map's basemap reads.

    Sanity checks, both exact: (-180, 0) -> (-20037508.34, 0), and lat 85.05113 -> y = x at 180.
    """
    R = 6378137.0
    lat = max(-85.05112878, min(85.05112878, lat))
    return (R * math.radians(lon),
            R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


# ------------------------------------------------------------------ geometry
# GeoPackage BLOB = 'GP' | version | flags | srs_id | optional envelope | WKB.
# Envelope length is encoded in flags bits 1-3, and skipping the wrong number of doubles lands
# mid-WKB and yields garbage coordinates that still parse, so it is read rather than assumed.
_ENV_DOUBLES = {0: 0, 1: 4, 2: 6, 3: 6, 4: 8}


def _wkb_start(blob: bytes) -> int:
    if len(blob) < 8 or blob[:2] != b'GP':
        return 0  # already bare WKB
    flags = blob[3]
    n = _ENV_DOUBLES.get((flags >> 1) & 0x07)
    if n is None:
        raise ValueError('bad envelope flag %d' % ((flags >> 1) & 0x07))
    return 8 + 8 * n


def _rings(blob: bytes):
    """Every ring in a (Multi)Polygon, as flat [x0,y0,x1,y1,...] lists. [] for lines/points."""
    if not blob:
        return []
    out = []

    def poly(buf, off, en, dims):
        nr, = struct.unpack_from(en + 'I', buf, off)
        off += 4
        for _ in range(nr):
            npt, = struct.unpack_from(en + 'I', buf, off)
            off += 4
            raw = struct.unpack_from(en + '%dd' % (npt * dims), buf, off)
            off += 8 * npt * dims
            out.append(list(raw) if dims == 2 else
                       [v for i, v in enumerate(raw) if i % dims < 2])
        return off

    def geom(buf, off):
        en = '<' if buf[off] == 1 else '>'
        off += 1
        t, = struct.unpack_from(en + 'I', buf, off)
        off += 4
        base, hi = t % 1000, t // 1000
        dims = 2 + (1 if hi in (1, 2) else 2 if hi == 3 else 0)
        if base == 3:
            return poly(buf, off, en, dims)
        if base == 6:
            n, = struct.unpack_from(en + 'I', buf, off)
            off += 4
            for _ in range(n):
                off = geom(buf, off)
            return off
        if base == 7:
            n, = struct.unpack_from(en + 'I', buf, off)
            off += 4
            for _ in range(n):
                off = geom(buf, off)
            return off
        return off  # points and lines carry no rings; nothing to walk past

    try:
        geom(blob, _wkb_start(blob))
    except (struct.error, ValueError, IndexError):
        return []
    return out


def _boxes(rings):
    """Per-ring bbox plus the overall one. Lake Marion is 355 rings and 59,795 points; without
    this every point test walks all of them."""
    bb = []
    for r in rings:
        xs = r[0::2]
        ys = r[1::2]
        bb.append((min(xs), max(xs), min(ys), max(ys)))
    if not bb:
        return [], None
    return bb, (min(b[0] for b in bb), max(b[1] for b in bb),
                min(b[2] for b in bb), max(b[3] for b in bb))


def _inside(rings, px, py, bb=None) -> bool:
    """Even-odd ray cast across ALL rings at once, which handles holes for free.

    The ray runs toward +x, so a ring entirely to the LEFT of the point can never be crossed and
    is skipped; so can a ring that does not span the point's y. Skipping on a plain bbox-contains
    test would be wrong -- a ring to the right of the point matters even though it does not
    contain it."""
    c = False
    for k, r in enumerate(rings):
        if bb is not None:
            mnx, mxx, mny, mxy = bb[k]
            if mxx < px or mny > py or mxy < py:
                continue
        n = len(r) // 2
        j = n - 1
        for i in range(n):
            xi, yi, xj, yj = r[2 * i], r[2 * i + 1], r[2 * j], r[2 * j + 1]
            if (yi > py) != (yj > py) and px < (xj - xi) * (py - yi) / (yj - yi) + xi:
                c = not c
            j = i
    return c


def _box_dist(b, px, py) -> float:
    mnx, mxx, mny, mxy = b
    dx = mnx - px if px < mnx else (px - mxx if px > mxx else 0.0)
    dy = mny - py if py < mny else (py - mxy if py > mxy else 0.0)
    return math.hypot(dx, dy)


def _edge_dist(rings, px, py, bb=None) -> float:
    """Metres to the nearest EDGE. Never to a centroid -- that mistake cost four bugs this week."""
    best = float('inf')
    order = range(len(rings))
    if bb is not None:
        order = sorted(order, key=lambda k: _box_dist(bb[k], px, py))
    for k in order:
        if bb is not None and _box_dist(bb[k], px, py) > best:
            continue
        r = rings[k]
        n = len(r) // 2
        for i in range(n - 1):
            x1, y1, x2, y2 = r[2 * i], r[2 * i + 1], r[2 * i + 2], r[2 * i + 3]
            dx, dy = x2 - x1, y2 - y1
            L = dx * dx + dy * dy
            if L <= 0:
                d = math.hypot(px - x1, py - y1)
            else:
                t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / L))
                d = math.hypot(px - x1 - t * dx, py - y1 - t * dy)
            if d < best:
                best = d
    return best


def _line_pts(blob: bytes):
    """Flat [x,y,...] for (Multi)LineString, for flowline distance only."""
    if not blob:
        return []
    out = []

    def geom(buf, off):
        en = '<' if buf[off] == 1 else '>'
        off += 1
        t, = struct.unpack_from(en + 'I', buf, off)
        off += 4
        base, hi = t % 1000, t // 1000
        dims = 2 + (1 if hi in (1, 2) else 2 if hi == 3 else 0)
        if base == 2:
            npt, = struct.unpack_from(en + 'I', buf, off)
            off += 4
            raw = struct.unpack_from(en + '%dd' % (npt * dims), buf, off)
            off += 8 * npt * dims
            out.append(list(raw) if dims == 2 else
                       [v for i, v in enumerate(raw) if i % dims < 2])
            return off
        if base in (5, 7):
            n, = struct.unpack_from(en + 'I', buf, off)
            off += 4
            for _ in range(n):
                off = geom(buf, off)
            return off
        return off

    try:
        geom(blob, _wkb_start(blob))
    except (struct.error, ValueError, IndexError):
        return []
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--in', dest='inp', default=os.path.join('outputs', 'garmin_unclaimed.json'))
    ap.add_argument('--out', default=os.path.join('outputs', 'unclaimed_worklist.tsv'))
    ap.add_argument('--gpkg', default=os.path.join('3dhp_all_CONUS_20260112_GPKG',
                                                   '3dhp_all_CONUS_20260112_GPKG.gpkg'))
    ap.add_argument('--index', default=os.path.join('registry', 'lake_index.json'),
                    help='registry, to mark which 3DHP ids are already carried')
    ap.add_argument('--radius', type=float, default=1200.0,
                    help='metres of slack around the cluster box when asking the RTree')
    ap.add_argument('--grid', type=int, default=7,
                    help='NxN sample lattice across the cluster bbox (1 = centroid only, which '
                         'is the test that failed)')
    ap.add_argument('--min-acres', type=float, default=100.0)
    ap.add_argument('--flow-m', type=float, default=300.0,
                    help='how close a cell must be to a 3DHP flowline to count as on-channel')
    ap.add_argument('--min-cover', type=float, default=0.25,
                    help='share of a cluster a polygon must cover before it counts as an '
                         'identification rather than a coincidental overlap (0.25)')
    ap.add_argument('--min-da', type=float, default=0.25,
                    help='skip clusters less than this share inside a real depth area')
    ap.add_argument('--allow-no-da', action='store_true',
                    help='run even when the input carries no depth-area share, accepting that '
                         'surveyed water cannot be told from stray contour lines')
    ap.add_argument('--include-attached', action='store_true',
                    help='also do the ones already touching a boundary (those are arms, and '
                         'attach_arms.py is the tool for them)')
    ap.add_argument('--include-narrow', action='store_true',
                    help='also do the one-cell-wide ones (those are river channels)')
    ap.add_argument('--limit', type=int, default=0, help='stop after N clusters (0 = all)')
    a = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    L3 = _load(os.path.join(here, 'lookup_3dhp.py'), 'l3')
    if not os.path.exists(a.gpkg):
        sys.exit('no GeoPackage at %s' % a.gpkg)

    rows = json.load(open(a.inp, encoding='utf-8'))

    # EVERY FILTER PRINTS WHAT IT ATE. A filter that silently removes all 13,460 rows and a
    # filter that removes none look identical from the outside, and this pipeline has now been
    # bitten four times in one day by a switch whose effect was invisible.
    # A WARNING HERE IS NOT ENOUGH; IT ALREADY SCROLLED PAST ONCE.
    has_da = any(r.get('da_share') for r in rows)
    if not has_da and not a.allow_no_da:
        print('STOP: %s carries no depth-area share, so --min-da %.2f would filter nothing.'
              % (a.inp, a.min_da))
        print()
        print('  Every row would read da_share 0.00 -- not because the water is contour-only but')
        print('  because the question was never asked, and the depth test is the only thing that')
        print('  tells water Garmin SOUNDED from cells a contour line passed through.')
        print()
        print('      py .\\scripts\\build_coverage_cache.py')
        print('      py .\\scripts\\sweep_unclaimed.py')
        print('      py .\\scripts\\sweep_unclaimed.py --min-acres 20 --report')
        print()
        print('  --allow-no-da runs anyway and accepts that the depth test is off.')
        sys.exit(2)
    if not has_da:
        print('!! --allow-no-da: the depth test is OFF, da_share is meaningless in this output')
    drop = collections.Counter()
    todo = []
    for r in rows:
        if r['acres'] < a.min_acres:
            drop['under %g acres' % a.min_acres] += 1
        elif r.get('narrow') and not a.include_narrow:
            drop['narrow (river channel)'] += 1
        elif r.get('touches_known') and not a.include_attached:
            drop['already touching a boundary'] += 1
        elif has_da and (r.get('da_share') or 0) < a.min_da:
            drop['under %.2f depth-area share' % a.min_da] += 1
        else:
            todo.append(r)
            continue
    todo.sort(key=lambda r: -r['acres'])
    print('%d clusters in %s' % (len(rows), os.path.basename(a.inp)))
    for k, v in drop.most_common():
        print('   -%-34s %6d' % (k, v))
    print('   =%-34s %6d' % ('to identify', len(todo)))
    if a.limit:
        todo = todo[:a.limit]
        print('   (--limit %d)' % a.limit)
    if not todo:
        sys.exit('nothing left to identify -- loosen the filters above')

    reg = {}
    if os.path.exists(a.index):
        idx = json.load(open(a.index, encoding='utf-8'))
        for slug, v in idx.items():
            g = str(v.get('gnis') or '')
            if g.startswith('gnis:'):
                reg[g[5:]] = slug
        print('registry: %d of %d rows carry a gnis id' % (len(reg), len(idx)))
    else:
        print('!! NO registry at %s -- reg_slug will be blank on every row, which is not the '
              'same as "absent from the registry"' % a.index)

    con = sqlite3.connect('file:%s?mode=ro&immutable=1' % a.gpkg.replace('\\', '/'), uri=True)
    cur = con.cursor()
    geom = {}
    try:
        cur.execute('SELECT table_name, column_name FROM gpkg_geometry_columns')
        geom = dict(cur.fetchall())
    except sqlite3.Error:
        pass
    wb_cols = ['fid'] + L3._pick(L3._cols(cur, WB))
    fl_cols = ['fid'] + L3._pick(L3._cols(cur, FL))

    def query(table, cols, bx):
        g = geom.get(table, 'shape')
        sql = ('SELECT %s, %s FROM %s WHERE fid IN (SELECT id FROM rtree_%s_%s '
               'WHERE maxx>=? AND minx<=? AND maxy>=? AND miny<=?)'
               % (', '.join(cols), g, table, table, g))
        cur.execute(sql, (bx[0], bx[1], bx[2], bx[3]))
        res = []
        for row in cur.fetchall():
            d = dict(zip(cols, row[:-1]))
            d['_blob'] = row[-1]
            res.append(d)
        return res

    # Parsed rings are cached by fid: a big reservoir is a candidate for every one of its own rim
    # clusters, and re-parsing 62,321 points each time is the whole runtime.
    cache: 'collections.OrderedDict' = collections.OrderedDict()

    def rings_for(w):
        fid = w['fid']
        got = cache.get(fid)
        if got is None:
            rr = _rings(w['_blob'])
            got = (rr,) + _boxes(rr)
            cache[fid] = got
            if len(cache) > 300:
                cache.popitem(last=False)
        else:
            cache.move_to_end(fid)
        w.pop('_blob', None)
        return got

    def samples(r):
        """The cluster's footprint, in descending order of honesty.

        `pts` is a sample of the cluster's OWN CELLS, so every sample point is water and `cover`
        means what it says. The bbox grid is the fallback and it is a weak one: the median
        cluster fills 54% of its box, so a perfect match scores ~0.54 and a good one scores 0.12.
        Which test ran is printed, because a 0.12 that means "half the water" and a 0.12 that
        means "a pond in the corner" must not look the same."""
        p = r.get('pts')
        if p:
            return [L3.albers(lon, lat) for lon, lat in p], True
        pts = [L3.albers(r['lon'], r['lat'])]
        b = r.get('bbox')
        if b and a.grid > 1:
            w, s, e, n = b
            for gy in range(a.grid):
                for gx in range(a.grid):
                    pts.append(L3.albers(w + (e - w) * (gx + 0.5) / a.grid,
                                         s + (n - s) * (gy + 0.5) / a.grid))
        return pts, False

    out = []
    weak = 0
    for i, r in enumerate(todo, 1):
        cx, cy = L3.albers(r['lon'], r['lat'])
        pts, on_water = samples(r)
        if not on_water:
            weak += 1
        # THE COORDINATE HANDED TO A HUMAN MUST BE ON THE WATER.
        #
        # Ryan pasted a printed xy into Google Maps and got woods: *"ummm that is no there lake
        # here"*. He was looking exactly where told. `lon`/`lat` are the cluster CENTROID, and a
        # cluster that fills 29% of its box has a centroid in the trees -- measured, 133 m from
        # the nearest charted cell on that row and 771 m on Hard Labor Creek. Same
        # edge-versus-centroid error as everywhere else in this pipeline, this time pointed at
        # the person doing the verifying, which is the most expensive place to put it.
        #
        # So every coordinate meant for a human -- xy, dd, basemap, the map link -- is the
        # cluster's own cell NEAREST its centroid, which is charted water by construction.
        # `lat`/`lon` stay the centroid, because that is what near_km and the sort are measured
        # from and changing them would move the goalposts under the rest of the file.
        wet_lon, wet_lat = r['lon'], r['lat']
        if r.get('pts'):
            wet_lon, wet_lat = min(
                r['pts'],
                key=lambda p: ((p[0] - r['lon']) * math.cos(math.radians(r['lat']))) ** 2
                + (p[1] - r['lat']) ** 2)
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        qbox = (min(xs) - a.radius, max(xs) + a.radius,
                min(ys) - a.radius, max(ys) + a.radius)

        wb = query(WB, wb_cols, qbox)
        for w in wb:
            rr, bb, ob = rings_for(w)
            w['_r'], w['_bb'], w['_ob'] = rr, bb, ob
            w['_cov'] = (sum(1 for px, py in pts if _inside(rr, px, py, bb)) / float(len(pts))
                         if rr else 0.0)
        pick, hit, dist, cover = None, '', '', ''
        covered = [w for w in wb if w['_cov'] > 0]
        if covered:
            # Ties on cover go to the SMALLEST polygon: a river-area polygon drawn through a
            # reservoir and the reservoir itself may both cover the cluster, and the smaller one
            # is the more specific statement 3DHP is making about it.
            covered.sort(key=lambda w: (-w['_cov'], w.get('areasqkm') or 0))
            pick = covered[0]
            cover = round(pick['_cov'], 3)
            hit = 'inside' if pick['_cov'] >= 0.5 else 'partial'
            dist = 0.0
        elif wb:
            # Nothing covers it. True edge distance is expensive on 60,000-point polygons, so
            # only the few nearest by bounding box get measured properly.
            for w in wb:
                w['_bd'] = _box_dist(w['_ob'], cx, cy) if w['_ob'] else float('inf')
            wb.sort(key=lambda w: w['_bd'])
            for w in wb[:6]:
                w['_d'] = _edge_dist(w['_r'], cx, cy, w['_bb']) if w['_r'] else float('inf')
            near = sorted(wb[:6], key=lambda w: w['_d'])
            pick, hit, cover = near[0], 'near', 0.0
            dist = round(near[0]['_d'], 1)

        # FLOWLINES ARE ALWAYS ASKED FOR, NOT ONLY WHEN NOTHING ELSE ANSWERED.
        #
        # This used to be `if not wb`, and since there is always some pond within the search box,
        # it never ran. So a 1,836-acre cluster at Murphy Village SC came back as an unnamed
        # waterbody when 3DHP knew exactly what it was: id 4ZF7B, featuretype 1, CHANNEL LINE,
        # 0.92 km, stream order 1, no gnisid, no waterbody. Ryan looked at it and said *"there is
        # no lake here"*, and there is not -- it is a creek, and Garmin charts creek channels
        # with depth areas the same way it charts a lake.
        #
        # `flow_frac` is the share of the cluster's own cells lying within --flow-m of a
        # flowline. A dendritic creek network scores near 1.0 because every cell IS the channel;
        # a lake scores low because its middle is nowhere near a line.
        fl = query(FL, fl_cols, qbox)
        flow_frac = ''
        if fl:
            near_n = 0
            segs = []
            for f in fl:
                lp = _line_pts(f.pop('_blob'))
                segs.append(lp)
                f['_d'] = _edge_dist(lp, cx, cy)
            for px, py in pts:
                if any(_edge_dist(lp, px, py) <= a.flow_m for lp in segs if lp):
                    near_n += 1
            flow_frac = round(near_n / float(len(pts)), 3)
            fl.sort(key=lambda f: f['_d'])
            if not wb:
                dist = round(fl[0]['_d'], 1)

        # KIND FOLLOWS COVER, NOT THE PICK.
        #
        # It used to follow the pick, and on the 2026-08-12 run that reported 1,416
        # 'waterbody-unnamed' rows totalling 468,985 acres when only 206 rows had ANY polygon
        # over any part of them. The other 1,210 were `near` -- nearest polygon a median 592 m
        # away, covering nothing -- presented in the same column as a real identification. A row
        # whose nearest 3DHP polygon does not touch it has not been identified, and the table
        # must not imply otherwise.
        # A SLIVER IS NOT AN IDENTIFICATION, AND MUST NOT CARRY AN ID.
        #
        # Ryan, 2026-08-12, on a 2,489-acre row: *"3dhp doesn't even know there is a lake there
        # ... which is weird because you gave me a 3dhp id."* It was weird. `cover` was 0.042 --
        # one of twenty-four sample cells landing in an unnamed 0.044 km2 polygon, eleven acres --
        # and the script printed that pond's id beside 2,489 acres of water as if it named it.
        # `hit in (inside, partial)` was the whole test, and `partial` had no floor, so a single
        # coincidental cell was enough to promote a row into the identification lists.
        name = ((pick or {}).get('gnisidlabel') or '').strip()
        if pick and hit in ('inside', 'partial') and (cover or 0) >= a.min_cover:
            kind = 'waterbody-named' if name else 'waterbody-unnamed'
        elif pick:
            kind = 'nothing-covers-it'      # a polygon is near, dist_m says how near
        elif fl:
            kind = 'flowline-only'
        else:
            kind = 'nothing-in-3dhp'

        # If the pick has no name, say what the nearest NAMED thing was and how big it is, rather
        # than letting a 2-acre pond inherit a 300-acre cluster.
        alt = ''
        if pick is not None and not name:
            named = [w for w in wb if (w.get('gnisidlabel') or '').strip()]
            if named:
                named.sort(key=lambda w: (-(w.get('_cov') or 0), -(w.get('areasqkm') or 0)))
                alt = '%s (cover %.2f, %.3f km2)' % (named[0]['gnisidlabel'].strip(),
                                                     named[0].get('_cov') or 0,
                                                     named[0].get('areasqkm') or 0)
        # An identification carries name, gnisid and reg_slug. Nothing else may, for the same
        # reason nothing else may carry an id: those fields describe some OTHER water, and a
        # reader scanning the column cannot tell that from the row.
        ident = kind in ('waterbody-named', 'waterbody-unnamed', 'flowline-only')
        gnisid = str((pick or {}).get('gnisid') or '') if ident else ''
        if not ident and pick is not None:
            alt = '%s%s (cover %.2f, %.3f km2)' % (
                pick.get('id3dhp') or '?',
                ' "%s"' % name if name else ' unnamed',
                pick.get('_cov') or 0, pick.get('areasqkm') or 0)
            name = ''
        out.append({
            'acres': r['acres'], 'lat': r['lat'], 'lon': r['lon'],
            'da_share': r.get('da_share', ''), 'fill': r.get('fill', ''),
            'near_slug': r.get('near_slug') or '', 'near_km': r.get('near_km', ''),
            'kind': kind, 'hit': hit, 'cover': cover, 'flow_frac': flow_frac,
            'probe': 'cells' if on_water else 'bbox',
            'dist_m': dist,
            # Only an identification carries an id. On a near-miss or a sliver the id belongs
            # to some other water, and printing it invites exactly the wrong conclusion.
            'id3dhp': ((pick or (fl[0] if fl else {}) or {}).get('id3dhp') or ''
                       if kind in ('waterbody-named', 'waterbody-unnamed', 'flowline-only')
                       else ''),
            'near_id3dhp': (pick or {}).get('id3dhp') or '',
            'name': name, 'gnisid': gnisid, 'alt': alt,
            'featuretype': (pick or {}).get('featuretype', '') if ident else '',
            'areasqkm': round((pick or {}).get('areasqkm') or 0, 3) if ident else '',
            'reg_slug': reg.get(gnisid, ''),
            'wb_hits': len(wb), 'fl_hits': len(fl),
            # apps.nationalmap.gov/viewer is where a 3DHP id gets confirmed by eye, and its
            # coordinate box takes several formats that disagree about which number comes first.
            # Guessing wrong costs a paste-and-retry every single row, so all three are here:
            #   xy       lon, lat, plain signed decimals. CONFIRMED WORKING 2026-08-12.
            #   dd       lat then lon, with hemisphere letters and padded degrees -- see dd().
            #   basemap  EPSG:3857 metres, the basemap's own spatial reference.
            'xy': '%.6f, %.6f' % (wet_lon, wet_lat),
            'dd': dd(wet_lon, wet_lat),
            'basemap': '%.2f, %.2f' % webmercator(wet_lon, wet_lat),
            'map': 'https://www.google.com/maps?q=%.5f,%.5f' % (wet_lat, wet_lon),
            # how far the centroid was from the water, so a big number is visible rather than
            # merely corrected
            'centroid_off_m': round(math.hypot(
                (wet_lon - r['lon']) * math.cos(math.radians(r['lat'])),
                wet_lat - r['lat']) * 111320),
        })
        if i % 25 == 0 or i == len(todo):
            print('  %d/%d' % (i, len(todo)), flush=True)
    con.close()

    cols = ['acres', 'kind', 'hit', 'cover', 'flow_frac', 'probe', 'dist_m', 'name', 'alt', 'id3dhp', 'gnisid',
            'reg_slug', 'near_id3dhp', 'featuretype', 'areasqkm', 'da_share', 'fill',
            'near_slug', 'near_km',
            'wb_hits', 'fl_hits', 'xy', 'dd', 'basemap', 'centroid_off_m',
            'lat', 'lon', 'map']
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    with open(a.out, 'w', encoding='utf-8') as fh:
        fh.write('\t'.join(cols) + '\n')
        for r in out:
            fh.write('\t'.join('' if r.get(c) is None else str(r.get(c, '')) for c in cols) + '\n')

    c = collections.Counter(r['kind'] for r in out)
    print('\n%-20s %6s  %10s   %s' % ('WHAT 3DHP SAYS', 'COUNT', 'ACRES', 'MEDIAN COVER'))
    for k in ('waterbody-named', 'waterbody-unnamed', 'nothing-covers-it', 'flowline-only',
              'nothing-in-3dhp'):
        mine = [r for r in out if r['kind'] == k]
        cv = sorted(float(r['cover'] or 0) for r in mine)
        print('%-20s %6d  %10s   %s'
              % (k, len(mine), format(sum(r['acres'] for r in mine), ','),
                 ('%.3f' % cv[len(cv) // 2]) if cv else '-'))
    print('\nThe first two are identifications. `nothing-covers-it` is NOT -- 3DHP has a polygon')
    print('somewhere nearby and none of it is over this water. Read dist_m before believing it.')
    ch = [r for r in out if (r['flow_frac'] or 0) >= 0.5]
    if ch:
        print('\n%d cluster(s), %s acres, sit >=50%% ON a 3DHP flowline. Garmin charts creek'
              % (len(ch), format(sum(r['acres'] for r in ch), ',')))
        print('channels with depth areas exactly as it charts a lake, so these are probably')
        print('creeks, not lakes nobody has -- but Bates Old River is flowline-only too and IS')
        print('real water, so read fill: a creek sprawls, an oxbow is compact.')
    h = collections.Counter(r['hit'] for r in out)
    print('\nfootprint vs 3DHP polygon:  inside(>=50%%) %d   partial %d   near(0%%) %d   '
          'no polygon at all %d' % (h['inside'], h['partial'], h['near'], h['']))
    if weak:
        print('!! %d of %d cluster(s) carry no `pts`, so cover was scored against the BOUNDING '
              'BOX, not the water.' % (weak, len(out)))
        print('   The median cluster fills 54% of its box, so a perfect match scores about 0.54 '
              'there and a real one scores 0.1. Re-run sweep_unclaimed.py --report to write '
              '`pts` and these numbers become readable.')
    print('-> %s' % a.out)

    new = [r for r in out if r['kind'] == 'waterbody-named' and not r['reg_slug']
           and r['hit'] in ('inside', 'partial')]
    if new:
        print('\nnamed by 3DHP, covering the cluster, and NOT carried by the registry:')
        for r in sorted(new, key=lambda r: -r['acres'])[:25]:
            print('   %8s ac  cover %-5s  %-26s %-8s  xy %s   %s'
                  % (format(r['acres'], ','), r['cover'], r['name'][:26], r['id3dhp'],
                     r['xy'], r['map']))
    unn = [r for r in out if r['kind'] == 'waterbody-unnamed' and r['hit'] in ('inside', 'partial')]
    if unn:
        print('\nreal polygon, NO name -- the unnamed-polygon blind spot, biggest first:')
        for r in sorted(unn, key=lambda r: -r['acres'])[:15]:
            print('   %8s ac  cover %-5s  %-8s  xy %s   %s'
                  % (format(r['acres'], ','), r['cover'], r['id3dhp'], r['xy'], r['map']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
