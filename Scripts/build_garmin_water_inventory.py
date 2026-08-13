#!/usr/bin/env python3
r"""build_garmin_water_inventory.py -- every water Garmin draws, with its real shoreline.

    py .\scripts\build_garmin_water_inventory.py
    py .\scripts\build_garmin_water_inventory.py --at -83.646,33.695 --radius-km 8   # one lake

Reads `extract/land_fill` and `extract/waterbody`, reassembles each water from the fragments
Garmin stores it in, and writes closed shorelines plus an inventory TSV.

WHY THIS IS THE RIGHT SOURCE, MEASURED

Ryan, 2026-08-12: *"the garmin packs have their own shoreline boundaries... they know who they
are, why are we using names in 3dhp to choose what lakes garmin has."* He was right, and it took
until the following night to act on it. Against lakes with independently published areas:

    Hard Labor Creek   land_fill  1,320 ac   published 1,370    closed ring, 4,003 pts
    Thousand Acre      land_fill  1,032 ac   published ~1,000   closed ring, 4,065 pts
    Lake Graham        waterbody    441 ac   3DHP 387 / DNR 459
    Murphy Village     neither     no closed ring at all       -> phantom

Within about 3% on every real one. The cell-raster method this replaces read Hard Labor Creek at
2,489 acres -- 82% high -- because a 0.002 deg cell is claimed if ANY vertex lands in it and
convoluted shoreline drags land in with it.

TWO LAYERS, BECAUSE GARMIN SPLITS WATER BY WHETHER IT NAMED IT

From `gmapmf_regions_v51.py`: `"1/10": "land_fill"  # subdivision box with the NAMED water body
as a hole`. That word does the work.

    land_fill 1/10   water Garmin LABELS. The subdivision box carries the shoreline as a hole,
                     encoded in a single ring that runs the box edge, cuts in on a seam, traces
                     the shore, and returns. Hard Labor Creek and Thousand Acre live here.
    waterbody 6/20   water Garmin does NOT label. Drawn as its own polygon on top of solid land.
                     Lake Graham lives here -- its land_fill box has no hole at all, which is
                     what sent this investigation sideways for an hour.

Both are needed. Neither alone is complete. Mode 11/19 is a documented duplicate of 6/20 and is
dropped; zooms 1-5 are generalised copies of zoom 0 and are dropped.

THE SEAM IS THE WHOLE PROBLEM

Garmin clips everything at subdivision boundaries, so one lake arrives as many fragments and the
cut edges are artifacts, not shore. Both layers get the same treatment: drop vertices lying on
the subdivision box, and what remains is real shoreline. `land_fill` gives its own box for free
(the polygon IS the box). `waterbody` does not -- its bbox is the water's -- so boxes are indexed
by `subdivision` from land_fill and looked up. On the sampled tile, 32 of 34 waterbody
subdivisions had a land_fill box; the rest are passed through untrimmed and counted.

Arcs are then chained end-to-end. **A ring that closes is a water body. A ring that does not is
not.** That is not a threshold anyone chose -- Hard Labor Creek and Thousand Acre close to 0 m,
Murphy Village leaves gaps of 1.7 to 3.2 km. It is the discriminator that four invented metrics
(solidity, elongation, cover, depth share) all failed to be.

`--tol` defaults to 120 m. Measured on Hard Labor Creek: 50 m leaves it in 8 pieces, 120-600 m
closes it, 900 m starts welding separate waters together. The window is wide and the default sits
at its bottom, where over-joining is least likely.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse, glob, gzip, json, math, os, sys, time
from collections import defaultdict

EARTH = 111320.0


def _unhyphen(argv, flags):
    """`--at -83.6,33.7` reads as a flag to argparse; lookup_3dhp.py documented this for --near."""
    out, i = [], 0
    while i < len(argv):
        if argv[i] in flags and i + 1 < len(argv) and argv[i + 1].startswith('-'):
            out.append('%s=%s' % (argv[i], argv[i + 1]))
            i += 2
            continue
        out.append(argv[i])
        i += 1
    return out


def _sibling(name):
    q = os.path.join(os.path.dirname(os.path.abspath(__file__)), name + '.py')
    spec = __import__('importlib.util', fromlist=['util']).spec_from_file_location(name, q)
    m = __import__('importlib.util', fromlist=['util']).module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _open(p):
    return gzip.open(p, 'rt', encoding='utf-8') if p.endswith('.gz') else open(p, encoding='utf-8')


def metres(a, b):
    return math.hypot((a[0] - b[0]) * EARTH * math.cos(math.radians(a[1])),
                      (a[1] - b[1]) * EARTH)


def acres(ring):
    """Shoelace on an equirectangular projection at the ring's own mean latitude."""
    if len(ring) < 3:
        return 0.0
    la = sum(p[1] for p in ring) / len(ring)
    k = math.cos(math.radians(la))
    s = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        s += (x1 * k * EARTH) * (y2 * EARTH) - (x2 * k * EARTH) * (y1 * EARTH)
    return abs(s) / 2.0 / 4046.86


def inside(ring, px, py):
    """Ray cast. Used to PROVE a reported point is on the water, not to guess."""
    c = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > py) != (yj > py) and px < (xj - xi) * (py - yi) / ((yj - yi) or 1e-15) + xi:
            c = not c
        j = i
    return c


def rep_point(ring):
    """A point GUARANTEED inside the ring, or None.

    The mean of the vertices is not that point. On a long snaking shoreline it lands mid-meander
    on dry ground, which is how a list of farm fields got handed over as lakes -- the third time
    in one night that a centroid was reported as a place to look. So: try the mean, and if it
    fails, scan latitudes across the ring and take the midpoint of the WIDEST interior span,
    which is inside by construction.
    """
    cx = sum(p[0] for p in ring) / len(ring)
    cy = sum(p[1] for p in ring) / len(ring)
    if inside(ring, cx, cy):
        return cx, cy
    ys = [p[1] for p in ring]
    lo, hi = min(ys), max(ys)
    best = None
    for k in range(1, 20):
        y = lo + (hi - lo) * k / 20.0
        xs = []
        n = len(ring)
        j = n - 1
        for i in range(n):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if (yi > y) != (yj > y):
                xs.append(xi + (xj - xi) * (y - yi) / ((yj - yi) or 1e-15))
            j = i
        xs.sort()
        for i in range(0, len(xs) - 1, 2):
            w = xs[i + 1] - xs[i]
            if best is None or w > best[0]:
                best = (w, (xs[i] + xs[i + 1]) / 2.0, y)
    if best and inside(ring, best[1], best[2]):
        return best[1], best[2]
    return None


def rings_of(geom):
    t = geom.get('type')
    c = geom.get('coordinates') or []
    if t == 'Polygon':
        return [c[0]] if c else []
    if t == 'MultiPolygon':
        return [p[0] for p in c if p]
    return []


def arcs_from_ring(ring, box, frac):
    """Everything in `ring` that is NOT lying on the subdivision box: the real shoreline.

    The ring is closed, so a shore run can straddle the start. The first and last runs are
    merged when both ends are interior, otherwise every lake whose seam happens to fall at
    vertex 0 comes out as two arcs that then have to find each other again.
    """
    W, E, S, N = box
    tx = max((E - W) * frac, 1e-9)
    ty = max((N - S) * frac, 1e-9)
    runs, cur = [], []
    for x, y in ring:
        if abs(x - W) < tx or abs(x - E) < tx or abs(y - S) < ty or abs(y - N) < ty:
            if len(cur) > 2:
                runs.append(cur)
            cur = []
        else:
            cur.append((x, y))
    if len(cur) > 2:
        runs.append(cur)
    if len(runs) > 1 and ring and runs[0] and runs[-1]:
        first_is_start = tuple(ring[0]) == tuple(runs[0][0])
        last_is_end = tuple(ring[-1]) == tuple(runs[-1][-1])
        if first_is_start and last_is_end:
            runs[0] = runs[-1] + runs[0]
            runs.pop()
    return runs


def chain(arcs, tol, progress=None):
    """Join arcs end-to-end. Endpoints are hashed into a `tol`-sized grid, so this is linear in
    the number of arcs rather than quadratic -- 245,815 arcs would be 60 billion comparisons the
    naive way."""
    cell = tol / EARTH
    live = [list(a) for a in arcs]
    used = [False] * len(live)
    ends = defaultdict(list)

    def key(p):
        return (int(p[0] / cell), int(p[1] / cell))

    for i, a in enumerate(live):
        ends[key(a[0])].append((i, 0))
        ends[key(a[-1])].append((i, 1))

    def find(p, skip):
        k = key(p)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j, w in ends.get((k[0] + dx, k[1] + dy), ()):
                    if used[j] or j == skip:
                        continue
                    q = live[j][0] if w == 0 else live[j][-1]
                    if metres(p, q) <= tol:
                        return j, w
        return None, None

    out = []
    for i in range(len(live)):
        if used[i]:
            continue
        used[i] = True
        cur = live[i]
        for _ in range(2):                       # extend the tail, then the head
            while True:
                j, w = find(cur[-1], i)
                if j is None:
                    break
                used[j] = True
                cur = cur + (live[j] if w == 0 else live[j][::-1])
            cur.reverse()
        out.append(cur)
        if progress and len(out) % 20000 == 0:
            progress(len(out))
    return out


def _tile_bbox_cache(extract, layer):
    """Per-tile bbox on disk, so `--at` does not parse 467 tiles to reach 4.

    `near()` filtered rings but nothing filtered FILES: every run read every tile in the
    layer whatever the radius, which is 22 s of pure waste on land_fill before the first
    line of output and the reason a one-lake run looked like a hang. The cache is keyed by
    size:mtime, so a re-extracted tile invalidates its own entry and no one has to remember
    to clear it. A tile with no cached bounds is READ, never skipped -- a stale cache must
    cost time, not water.
    """
    # NOT inside extract/<layer>/ -- that folder is globbed as the tile list, so a cache
    # file living there would be read back as a tile.
    fp = os.path.join(extract, '_tile_bbox_%s.json' % layer)
    try:
        cache = json.load(open(fp, encoding='utf-8'))
    except Exception:
        cache = {}
    return fp, cache


def _bbox_key(p):
    st = os.stat(p)
    return '%d:%d' % (st.st_size, int(st.st_mtime))


def _bbox_of_doc(d):
    xs, ys = [], []
    for ft in (d.get('features') or []):
        for ring in rings_of(ft.get('geometry') or {}):
            for c in ring:
                xs.append(c[0]); ys.append(c[1])
    return [min(xs), max(xs), min(ys), max(ys)] if xs else None


def main() -> int:
    sys.argv[1:] = _unhyphen(sys.argv[1:], ('--at',))
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--extract', default='extract')
    ap.add_argument('--out', default=os.path.join('outputs', 'garmin_water_inventory.tsv'))
    ap.add_argument('--geojson-dir', default='')
    ap.add_argument('--tol', type=float, default=120.0, help='seam-joining tolerance, metres')
    ap.add_argument('--box-frac', type=float, default=0.002,
                    help='how close to the subdivision box counts as ON it')
    ap.add_argument('--min-acres', type=float, default=20.0)
    ap.add_argument('--zoom', type=int, default=0)
    ap.add_argument('--at', default='', help='LON,LAT -- only this neighbourhood')
    ap.add_argument('--radius-km', type=float, default=10.0)
    ap.add_argument('--index', default=os.path.join('registry', 'lake_index.json'))
    ap.add_argument('--region-mask', default=os.path.join('registry', 'region_mask.json'))
    ap.add_argument('--no-region', action='store_true')
    ap.add_argument('--max-boxiness', type=float, default=0.9,
                    help='a ring filling this share of its own bounding box is a rectangle, not '
                         'a shoreline. No point-count threshold: 30 let a 34-point one through.')
    ap.add_argument('--coverage', default=os.path.join('extract', '_garmin_coverage.json'),
                    help='depth-area cells. A water with no soundings under it is not shippable '
                         'and is very often not water.')
    ap.add_argument('--min-da-share', type=float, default=0.5,
                    help='share of a ring\'s AREA that must be covered by its own depth-area '
                         'cells. Measured: Hard Labor Creek 0.97, Pamlico Sound 1.01, and a '
                         'ring the stitcher wrapped around dry ground near High Point 0.04. '
                         'Counting '
                         'cells instead of area (the first version required >=1) caught none of '
                         'it, because a loop enclosing two lakes contains both lakes cells.')
    ap.add_argument('--boundaries', default=os.path.join('registry', 'boundaries'),
                    help='registry GEOMETRY. A bounds test calls every arm of a lake a new lake.')
    ap.add_argument('--arm-km', type=float, default=1.0,
                    help='a water this close to an existing registry boundary is an ARM of it, '
                         'not a discovery. Measured on cases Ryan checked by eye: the Reelfoot '
                         'basin 0.03 km, a Mississippi reach 0.01, a Center Hill arm 0.01 -- '
                         'against Hard Labor Creek at 5.77 and Thousand Acre at 14.38, both '
                         'confirmed new. Nothing sits in between.')
    a = ap.parse_args()

    focus = None
    if a.at:
        lo, la = [float(v) for v in a.at.replace(' ', '').split(',')]
        focus = (lo, la, a.radius_km / 111.32)

    def near(W, E, S, N):
        if not focus:
            return True
        lo, la, r = focus
        return not (E < lo - r or W > lo + r or N < la - r or S > la + r)

    t0 = time.time()
    boxes = {}                                   # (tile, subdivision) -> box
    arcs = []
    stats = defaultdict(int)

    lf = sorted(glob.glob(os.path.join(a.extract, 'land_fill', '*')))
    if not lf:
        sys.exit('no land_fill in %s -- extract it first:\n'
                 '  py .\\scripts\\trollmap_extract_all.py <Tiles> --out %s '
                 '--layers land_fill --jobs 8 --gzip' % (a.extract, a.extract))
    lf_fp, lf_cache = _tile_bbox_cache(a.extract, 'land_fill')
    lf_dirty = False
    for p in lf:
        name = os.path.basename(p)
        key = _bbox_key(p)
        ent = lf_cache.get(name)
        if focus and ent and ent.get('k') == key:
            if ent.get('b') is None or not near(*ent['b']):
                stats['land_fill tiles skipped by --at'] += 1
                continue
        try:
            d = json.load(_open(p))
        except Exception:
            stats['unreadable land_fill tiles'] += 1
            continue
        if not ent or ent.get('k') != key:
            lf_cache[name] = {'k': key, 'b': _bbox_of_doc(d)}
            lf_dirty = True
            stats['land_fill tiles read to build the bbox cache'] += 1
        tile = os.path.basename(p).split('.')[0]
        for ft in (d.get('features') or []):
            pr = ft.get('properties') or {}
            if pr.get('zoom') != a.zoom:
                continue
            for ring in rings_of(ft['geometry']):
                xs = [c[0] for c in ring]
                ys = [c[1] for c in ring]
                box = (min(xs), max(xs), min(ys), max(ys))
                boxes[(tile, pr.get('subdivision'))] = box
                stats['land_fill boxes'] += 1
                if not near(*box):
                    continue
                got = arcs_from_ring(ring, box, a.box_frac)
                stats['land_fill arcs'] += len(got)
                arcs.extend(got)
    if lf_dirty:
        try:
            json.dump(lf_cache, open(lf_fp, 'w', encoding='utf-8'))
        except Exception as e:
            print('!! could not write %s (%s) -- every --at run will re-scan every tile'
                  % (lf_fp, str(e)[:60]))
    print('land_fill: %s box(es), %s arc(s), %.0fs'
          % (format(stats['land_fill boxes'], ','), format(stats['land_fill arcs'], ','),
             time.time() - t0))
    if stats['land_fill tiles skipped by --at']:
        print('   --at: %s of %s land_fill tiles skipped as outside the radius'
              % (format(stats['land_fill tiles skipped by --at'], ','), format(len(lf), ',')))

    wb = sorted(glob.glob(os.path.join(a.extract, 'waterbody', '*')))
    if not wb:
        print('!! no waterbody layer -- water Garmin does not NAME will be missing entirely '
              '(that is where Lake Graham lives)')
    wb_fp, wb_cache = _tile_bbox_cache(a.extract, 'waterbody')
    wb_dirty = False
    for p in wb:
        name = os.path.basename(p)
        key = _bbox_key(p)
        ent = wb_cache.get(name)
        if focus and ent and ent.get('k') == key:
            if ent.get('b') is None or not near(*ent['b']):
                stats['waterbody tiles skipped by --at'] += 1
                continue
        try:
            d = json.load(_open(p))
        except Exception:
            stats['unreadable waterbody tiles'] += 1
            continue
        if not ent or ent.get('k') != key:
            wb_cache[name] = {'k': key, 'b': _bbox_of_doc(d)}
            wb_dirty = True
        tile = os.path.basename(p).split('.')[0]
        for ft in (d.get('features') or []):
            pr = ft.get('properties') or {}
            # 11/19 is explicitly duplicate_of_mode 6/20; counting both doubles every area.
            if pr.get('mode') != '6/20' or pr.get('zoom') != a.zoom:
                continue
            box = boxes.get((tile, pr.get('subdivision')))
            for ring in rings_of(ft['geometry']):
                xs = [c[0] for c in ring]
                ys = [c[1] for c in ring]
                if not near(min(xs), max(xs), min(ys), max(ys)):
                    continue
                if box is None:
                    # No land_fill box for this subdivision. Pass it through whole rather than
                    # trim against the wrong rectangle -- a closed ring costs nothing here.
                    stats['waterbody rings with no box'] += 1
                    arcs.append(list(ring))
                    continue
                got = arcs_from_ring(ring, box, a.box_frac)
                if not got:
                    # entirely interior to its subdivision: already a complete shoreline
                    arcs.append(list(ring))
                    stats['waterbody whole rings'] += 1
                else:
                    arcs.extend(got)
                    stats['waterbody arcs'] += len(got)
    if wb_dirty:
        try:
            json.dump(wb_cache, open(wb_fp, 'w', encoding='utf-8'))
        except Exception as e:
            print('!! could not write %s (%s) -- every --at run will re-scan every tile'
                  % (wb_fp, str(e)[:60]))
    if stats['waterbody tiles skipped by --at']:
        print('   --at: %s of %s waterbody tiles skipped as outside the radius'
              % (format(stats['waterbody tiles skipped by --at'], ','), format(len(wb), ',')))
    print('waterbody: %s arc(s) + %s whole ring(s)%s'
          % (format(stats['waterbody arcs'], ','), format(stats['waterbody whole rings'], ','),
             (', %s with no subdivision box' % format(stats['waterbody rings with no box'], ','))
             if stats['waterbody rings with no box'] else ''))

    if not arcs:
        sys.exit('no arcs -- nothing to stitch')
    print('chaining %s arc(s) at %.0f m ...' % (format(len(arcs), ','), a.tol), flush=True)
    rings = chain(arcs, a.tol, progress=lambda n: print('   %s ...' % format(n, ','), flush=True))

    region = None
    if not a.no_region:
        region = _sibling('in_region').Region.load(a.region_mask, required=False)
        if region is None:
            print('!! NO region mask at %s -- nothing is filtered by state. '
                  'Build it: py .\\scripts\\make_region_mask.py' % a.region_mask)
        else:
            print(region.describe())

    out = []
    for r in rings:
        if len(r) < 4:
            continue
        gap = metres(r[0], r[-1])
        ac = acres(r)
        if ac < a.min_acres:
            continue
        xs = [p[0] for p in r]
        ys = [p[1] for p in r]
        # A SUBDIVISION BOX IS NOT A LAKE.
        #
        # The first full run put 965 of these in the output, 4,441,370 acres of them, in tidy
        # rows 0.043945 deg apart -- the subdivision spacing. They come from waterbody rings that
        # had no land_fill box to trim against, so they were passed through whole, and offshore
        # a whole ring IS the rectangle. A shoreline does not fill its own bounding box.
        bw = (max(xs) - min(xs)) * EARTH * math.cos(math.radians(sum(ys) / len(ys)))
        bh = (max(ys) - min(ys)) * EARTH
        if bw * bh > 0 and (ac * 4046.86) / (bw * bh) > a.max_boxiness:
            stats['not a shoreline: fills its own bounding box'] += 1
            continue
        # THE POINT REPORTED MUST BE ON THE WATER. Proven, not assumed.
        rp = rep_point(r)
        if rp is None:
            stats['no provable interior point'] += 1
            continue
        # Region by the INTERIOR point, not by any vertex. `any_inside` is right for a border
        # lake and wrong for the open Atlantic -- an offshore ring that clips the coast satisfies
        # it, which is how 33.188430,-79.135920 reached the list. The interior point settles both.
        if region is not None and not region.inside(rp[0], rp[1]):
            stats['dropped as outside the region'] += 1
            continue
        out.append({'acres': round(ac), 'closed': gap <= a.tol, 'gap_m': round(gap),
                    'pts': len(r), 'lon': round(rp[0], 6), 'lat': round(rp[1], 6),
                    'w': round(min(xs), 6), 's': round(min(ys), 6),
                    'e': round(max(xs), 6), 'n': round(max(ys), 6), '_ring': r})
    out.sort(key=lambda r: -r['acres'])

    # ---- DOES GARMIN ACTUALLY SOUND IT -------------------------------------------------------
    # Ryan's ship rule is "if it has bathymetry ship it", and its contrapositive is the strongest
    # filter available: a ring over farmland has no depth areas inside it. This is the check that
    # would have caught every bad row handed over tonight.
    da = []
    CELL = 0.002
    if os.path.exists(a.coverage):
        cov = json.load(open(a.coverage, encoding='utf-8'))
        da = cov.get('da_cells') or []
        if not da:
            print('!! %s has no da_cells -- the soundings test is OFF. Rebuild it: '
                  'py .\\scripts\\build_coverage_cache.py' % a.coverage)
    else:
        print('!! no coverage at %s -- the soundings test is OFF' % a.coverage)
    dagrid = defaultdict(list)
    for cx, cy in da:
        dagrid[(cx >> 5, cy >> 5)].append((cx * CELL, cy * CELL))

    def cell_acres(lat):
        return (CELL * EARTH * math.cos(math.radians(lat))) * (CELL * EARTH) / 4046.86

    def da_inside(ring, W, E, S, N):
        n = 0
        for gx in range(int(W / CELL) >> 5, (int(E / CELL) >> 5) + 1):
            for gy in range(int(S / CELL) >> 5, (int(N / CELL) >> 5) + 1):
                for x, y in dagrid.get((gx, gy), ()):
                    if W <= x <= E and S <= y <= N and inside(ring, x, y):
                        n += 1
                        if n >= 999:
                            return n
        return n

    # ---- IS IT ALREADY OURS, BY GEOMETRY -----------------------------------------------------
    # A bounds test calls every arm of Alligator River a new lake -- it produced a dozen such
    # rows. The registry boundary itself is the only honest test.
    reg = {}
    if os.path.exists(a.index) and os.path.isdir(a.boundaries):
        _idx = json.load(open(a.index, encoding='utf-8'))
        # lake_index.json is keyed by slug; lakes.json wraps the same slugs one level down.
        # Iterating lakes.json directly yields ['generated_from', 'bbox_wsen', ...], which
        # matches no boundary file and silently produced "0 ARMS" -- an all-clear that had
        # tested nothing.
        if isinstance(_idx, dict) and 'lakes' in _idx:
            _idx = _idx['lakes']
        slugs = set(_idx)
        for f in glob.glob(os.path.join(a.boundaries, '*.geojson')):
            slug = os.path.basename(f)[:-8]
            if slug not in slugs:
                continue                      # orphan boundary: the folder is not the app
            try:
                g = json.load(open(f, encoding='utf-8'))
            except Exception:
                continue
            feats = g.get('features') if g.get('type') == 'FeatureCollection' else [g]
            rr = []
            for ft in (feats or []):
                rr += rings_of((ft or {}).get('geometry') or {})
            if rr:
                xs2 = [p[0] for q in rr for p in q]
                ys2 = [p[1] for q in rr for p in q]
                reg[slug] = (rr, min(xs2), max(xs2), min(ys2), max(ys2))
        print('registry: %d boundary geometries loaded' % len(reg))
        if not reg:
            sys.exit('STOP: --index %s matched none of the %d boundaries in %s.\n'
                     '      Every row would read "not near anything known" without a single\n'
                     '      comparison being made. Point --index at registry/lake_index.json.'
                     % (a.index, len(glob.glob(os.path.join(a.boundaries, '*.geojson'))),
                        a.boundaries))
    else:
        print('!! no registry index or boundaries -- in_registry will be blank on every row, '
              'which is NOT the same as "missing"')

    # Vertex index for the ARM test. `owner()` answers inside-or-outside and nothing else, so a
    # basin of Reelfoot that its own boundary happens to exclude reads as a discovery. It is not.
    # BUCKET SIZE MUST MATCH THE QUESTION. At 0.1 deg (11 km) a single bucket near a coastal
    # boundary held over a hundred thousand vertices, and the search touched nine of them per
    # sample point, 200 points per ring, thousands of rings -- billions of comparisons, and the
    # run wedged after "registry: 854 boundary geometries loaded" with no output for 20 minutes.
    # The question is "is anything within --arm-km", so the bucket is --arm-km.
    RB = max(a.arm_km, 0.2) / 111.32
    rgrid = defaultdict(list)
    for slug, (rr, W, E, S, N) in reg.items():
        for q in rr:
            for x, y in q:
                rgrid[(int(x / RB), int(y / RB))].append((x, y, slug))

    def arm_of(ring):
        """Distance from the SHORELINE to the nearest registry boundary, not from the interior.

        Measured from the interior point first, and it was wrong for the same reason everything
        else has been wrong this week: a water whose shore touches a known lake can still have
        its middle kilometres away. Reelfoot's basin only passed by luck."""
        best = (1e9, '')
        step = max(1, len(ring) // 200)
        for lo, la in ring[::step]:
            k = math.cos(math.radians(la))
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for x, y, s2 in rgrid.get((int(lo / RB) + dx, int(la / RB) + dy), ()):
                        d = math.hypot((x - lo) * k, y - la) * 111.32
                        if d < best[0]:
                            best = (d, s2)
                            if d <= a.arm_km:
                                return best      # an arm is an arm; the exact metre is not needed
        return best

    def owner(r):
        lo, la = r['lon'], r['lat']
        for slug, (rr, W, E, S, N) in reg.items():
            if not (W <= lo <= E and S <= la <= N):
                continue
            for q in rr:
                if inside(q, lo, la):
                    return slug
        return ''

    cols = ['acres', 'closed', 'gap_m', 'pts', 'da_cells', 'da_share', 'in_registry',
            'arm_of', 'arm_km', 'pt_on_water', 'xy', 'lat', 'lon', 'map']
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    with open(a.out, 'w', encoding='utf-8') as fh:
        fh.write('\t'.join(cols) + '\n')
        keep = []
        for r in out:
            r['da_cells'] = da_inside(r['_ring'], r['w'], r['e'], r['s'], r['n']) if da else -1
            r['da_share'] = (round(r['da_cells'] * cell_acres(r['lat']) / max(1.0, r['acres']), 2)
                             if da else '')
            if da and r['closed'] and r['da_share'] < a.min_da_share:
                stats['closed but not %.0f%% sounded inside' % (a.min_da_share * 100)] += 1
                continue
            # the reported point, re-tested against the ring it claims to be in
            r['pt_on_water'] = inside(r['_ring'], r['lon'], r['lat'])
            if not r['pt_on_water']:
                stats['reported point not inside its own ring'] += 1
                continue
            r['in_registry'] = owner(r)
            d, s2 = arm_of(r['_ring']) if reg else (9999.0, '')
            r['arm_km'] = round(d, 2) if d < 9999 else ''
            r['arm_of'] = s2 if (d <= a.arm_km and not r['in_registry']) else ''
            keep.append(r)
        out = keep
        for r in out:
            r['xy'] = '%.6f, %.6f' % (r['lon'], r['lat'])
            r['map'] = 'https://www.google.com/maps?q=%.5f,%.5f' % (r['lat'], r['lon'])
            fh.write('\t'.join(str(r[c]) for c in cols) + '\n')

    if a.geojson_dir:
        os.makedirs(a.geojson_dir, exist_ok=True)
        n = 0
        for r in out:
            if not r['closed']:
                continue
            ring = r['_ring'] + [r['_ring'][0]]
            json.dump({'type': 'Feature',
                       'properties': {'acres': r['acres'], 'source': 'garmin',
                                      'note': 'Personal use only. NOT FOR NAVIGATION.'},
                       'geometry': {'type': 'Polygon', 'coordinates': [ring]}},
                      open(os.path.join(a.geojson_dir, 'garmin_%.5f_%.5f.geojson'
                                        % (r['lat'], r['lon'])), 'w'))
            n += 1
        print('%d closed shoreline(s) -> %s' % (n, a.geojson_dir))

    print()
    print('REJECTED BY SELF-CHECK -- these never reach the file:')
    any_rej = False
    for k in ('not a shoreline: fills its own bounding box', 'no provable interior point',
              'dropped as outside the region',
              'closed but not %.0f%% sounded inside' % (a.min_da_share * 100),
              'reported point not inside its own ring'):
        if stats[k]:
            any_rej = True
            print('  %-44s %s' % (k, format(stats[k], ',')))
    if not any_rej:
        print('  (none)')
    closed = [r for r in out if r['closed']]
    openr = [r for r in out if not r['closed']]
    arms = [r for r in closed if not r['in_registry'] and r['arm_of']]
    miss = [r for r in closed if not r['in_registry'] and not r['arm_of']]
    print()
    print('%s water(s) over %.0f acres' % (format(len(out), ','), a.min_acres))
    print('  %6s CLOSED    -- a shoreline that joins up is a water body'
          % format(len(closed), ','))
    print('  %6s open      -- gaps remain; fragments, or coverage with no water under it'
          % format(len(openr), ','))
    print('  %6s ARMS -- within %.1f km of a water you already have; widen that boundary, '
          'do not cut a new one' % (format(len(arms), ','), a.arm_km))
    print('  %6s NOT NEAR ANYTHING KNOWN  <-- the only rows that are candidate new water'
          % format(len(miss), ','))
    print('-> %s' % a.out)
    if miss:
        print()
        print('biggest waters that are closed, sounded, in-region, and near nothing known:')
        for r in miss[:25]:
            print('   %8s ac  %6d pts  sounded %3.0f%%  xy %s   %s'
                  % (format(r['acres'], ','), r['pts'],
                     100 * (r['da_share'] if r['da_share'] != '' else 0), r['xy'], r['map']))
    print('\n%.0fs total' % (time.time() - t0))
    return 0


if __name__ == '__main__':
    sys.exit(main())
