#!/usr/bin/env python3
r"""build_ramp_reach.py - how far it is BY WATER from every landing to a river's own channel.

Personal use only, not for distribution or resale; not for navigation.

    py .\build_ramp_reach.py --registry "F:\TrollMapPipeline\registry" ^
                             --extract  "F:\TrollMapPipeline\extract" ^
                             --chartpack "F:\TrollMapPipeline\chartpack" --only congaree_river
    # ... reports, writes nothing. Then --go.

WHY THIS EXISTS

Ryan launches at Bates Bridge and also at Pack's Landing, which SCDNR files under Lake Marion.
Pack's reaches the Congaree along a canal that runs beside the railroad, and he fishes the canal
on the way: *"there is a canal that runs along the railroad tracks that leads directly into the
river. I fish the canal as well on my way to the river."*

Nothing in the pipeline could see that. The ramp binding is NAME-FIRST -- build_dnr_ramps_by_lake
matches the state feed's waterbody NAME to a slug and uses geometry only as a guard, and
access-index.js does the same at runtime -- so a landing the state files under "Lake Marion" can
never reach "Congaree River" however close it sits. The state, like Garmin, does not sort the
water the way we do.

STRAIGHT-LINE DISTANCE IS THE WRONG MEASURE AND SAYS SO OUT LOUD

    Pack's Landing   straight 2,367 m      by water 1,803 m
    Low Falls        straight   330 m      by water   254 m

The water route is SHORTER because it follows the canal instead of cutting across the swamp. A
rule built on straight-line distance would have put Pack's 564 m further away than it is, and I
proposed exactly that rule before Ryan said what the canal was.

WHAT IT MEASURES

The charted water is rasterised at 25 m and walked outward from the river's own centreline, 8-
connected, so what comes back is what a boat travels. Measured across the whole lower Santee
basin, 50 landings, the answer has a hole in it that nobody chose:

    25 m      Bates Bridge
    254 m     Low Falls
    1,270 m   Calhoun Subdivision
    1,803 m   Rimini / Pack's
    2,082 m   Santee State Park
    2,387 m   three unnamed
    3,073 m   one unnamed
    -- nothing between 3,073 and 6,044 --
    6,044 m   five more, and then Marion proper out to 35 km

THERE IS NO THRESHOLD IN HERE. Ryan: *"If you can have these ramps be both river and lake I do
not see the downside"*, and on the cut: annotate rather than filter. So this writes the distance
and every landing that has one, the app shows "Pack's Landing - 1.1 mi to the river", and the
choice is made in the boat. A number chosen here would be an arbitrary number, which is an AI
problem and not a fishing one.

ADDITIVE, NEVER SUBTRACTIVE. This does not move a landing off the water it is already filed
under and does not remove one. `lake_marion` keeps Pack's; the Congaree gains it.

WHAT IT CANNOT SEE, AND THE KNOWN CASE

It walks CHARTED water, so a real connection through water Garmin never sounded reads as no
path. The known instance is Cedar Creek Canoe Launch: the NPS and the paddling guides put the
Cedar Creek Canoe Trail at about 15 miles through the Congaree Wilderness to the river, taking
out at Hwy 601 -- which is Bates Bridge -- and this script says "no path" because the creek is
not sounded. It is already in the Congaree's OSM bucket and stays there; being additive is what
keeps that true. Reading USGS NHD flowlines as a second source for the CONNECTION question,
with the chart still answering the DEPTH question, is the fix and is not done here.

RIVERS SEED FROM THEIR LINE, LAKES FROM THEIR OWN WATER

A river has a channel to start the walk from -- `centreline.geojson`, which is what a boat
follows. A lake has no line, so it seeds from every cell of its OWN charted water: the depth
areas inside its boundary. Both then answer the same question, which is the one that matters --
can a boat get from this landing to this water, and how far is it.

Ryan asked for the second half by name: *"the part that is missing is that the river ramps do
not show as ramps the lakes can use"*. Bates Bridge is on the Congaree and 22.5 km of water from
Lake Marion; whether that is a Marion launch is his call in the boat, and the number is how he
makes it.
"""
import argparse
import json
import math
import os
import sys
from collections import deque

CELL_DEG = 0.00025          # ~26 m of latitude; the canal at Rimini is wider than one cell
MARGIN_DEG = 0.05           # how far outside the line to look for landings, ~5.5 km


def load_json(path):
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def access_points(registry):
    """Every landing we know, from every bucket, deduped on position.

    Keyed to 5 dp, which is 1.1 m -- the same two records from two feeds collapse, two real
    ramps on one lot do not.
    """
    out = {}
    for fn in ('dnr_ramps_by_lake.json', 'osm_ramps_by_lake.json', 'natl_ramps_by_lake.json'):
        p = os.path.join(registry, fn)
        if not os.path.isfile(p):
            continue
        src = fn.split('_')[0]
        body = load_json(p)
        if not isinstance(body, dict):
            continue
        for slug, rs in body.items():
            if not isinstance(rs, list):
                continue
            for r in rs:
                try:
                    la = float(r.get('lat') if r.get('lat') is not None else r.get('latitude'))
                    lo = float(r.get('lon') if r.get('lon') is not None
                               else (r.get('lng') if r.get('lng') is not None else r.get('longitude')))
                except (TypeError, ValueError):
                    continue
                k = (round(la, 5), round(lo, 5))
                rec = out.setdefault(k, {'lat': la, 'lon': lo, 'name': '', 'filed': set(), 'src': set()})
                rec['filed'].add(slug)
                rec['src'].add(src)
                nm = r.get('name') or r.get('NAME') or r.get('label')
                if nm and not rec['name']:
                    rec['name'] = nm
    return out


def water_polys(extract, registry, slug, bbox):
    """Every zoom-0 depth-area polygon near this water, off the tiles it sits on.

    zoom 0 only: the coarser levels are redraws of the same water, not extra survey, and a
    generalised polygon closes the very gaps -- a canal mouth, a creek neck -- this walk is for.
    """
    from shapely.geometry import shape, box
    tmap_p = os.path.join(registry, 'tile_lake_map.json')
    tiles = []
    if os.path.isfile(tmap_p):
        tiles = (load_json(tmap_p).get('by_lake') or {}).get(slug) or []
    if not tiles:
        return [], 0
    import gzip
    win = box(*bbox)
    out, n = [], 0
    for t in tiles:
        cid = 'C' + t[1:] if t[:1] in 'Bb' else t
        for ext in ('.geojson.gz', '.geojson'):
            fp = os.path.join(extract, 'depth_areas', cid + ext)
            if not os.path.isfile(fp):
                continue
            raw = gzip.open(fp, 'rb').read() if ext.endswith('.gz') else open(fp, 'rb').read()
            for f in (json.loads(raw).get('features') or []):
                if (f.get('properties') or {}).get('zoom') != 0:
                    continue
                n += 1
                try:
                    g = shape(f['geometry'])
                except Exception:
                    continue
                if g.is_empty:
                    continue
                if not g.is_valid:
                    g = g.buffer(0)
                if g.is_empty or 'Polygon' not in g.geom_type:
                    continue
                if g.intersects(win):
                    out.append(g)
            break
    return out, n


def walk(polys, line_pts, bbox, cell=CELL_DEG):
    """Rasterise the water, seed every cell the channel runs through, flood outward.

    Returns (dist, nx, ny, w0, s0, step_m). `dist` is in CELLS; multiply by step_m.

    Rasterising the whole bounding box would be tens of millions of point-in-polygon tests on a
    long river, nearly all of them over dry ground. Each polygon paints only its own box, which
    is the same work the water occupies and no more.
    """
    from shapely.geometry import Point
    from shapely.prepared import prep
    w0, s0, e0, n0 = bbox
    nx = int((e0 - w0) / cell) + 1
    ny = int((n0 - s0) / cell) + 1
    wet = bytearray(nx * ny)
    for g in polys:
        gx0, gy0, gx1, gy1 = g.bounds
        i0 = max(0, int((gx0 - w0) / cell)); i1 = min(nx - 1, int((gx1 - w0) / cell) + 1)
        j0 = max(0, int((gy0 - s0) / cell)); j1 = min(ny - 1, int((gy1 - s0) / cell) + 1)
        if i1 < i0 or j1 < j0:
            continue
        P = prep(g)
        for j in range(j0, j1 + 1):
            y = s0 + (j + 0.5) * cell
            row = j * nx
            for i in range(i0, i1 + 1):
                if wet[row + i]:
                    continue
                if P.covers(Point(w0 + (i + 0.5) * cell, y)):
                    wet[row + i] = 1
    dist = [-1] * (nx * ny)
    q = deque()
    for x, y in line_pts:
        i = int((x - w0) / cell); j = int((y - s0) / cell)
        if 0 <= i < nx and 0 <= j < ny and wet[j * nx + i] and dist[j * nx + i] < 0:
            dist[j * nx + i] = 0
            q.append((i, j))
    NB = ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))
    while q:
        i, j = q.popleft()
        d = dist[j * nx + i] + 1
        for di, dj in NB:
            a, b = i + di, j + dj
            if 0 <= a < nx and 0 <= b < ny and wet[b * nx + a] and dist[b * nx + a] < 0:
                dist[b * nx + a] = d
                q.append((a, b))
    lat = (s0 + n0) / 2.0
    step = ((110540 * cell) + (111320 * math.cos(math.radians(lat)) * cell)) / 2.0
    return dist, nx, ny, w0, s0, step, sum(wet)


def boundary_rings(registry, slug):
    """Every ring of a water's registry boundary, whatever shape the file is written in."""
    p = os.path.join(registry, 'boundaries', slug + '.geojson')
    if not os.path.isfile(p):
        return []
    gj = load_json(p)
    feats = gj.get('features') if isinstance(gj, dict) and gj.get('features') else [gj]
    out = []
    for f in feats:
        g = (f or {}).get('geometry') or f
        if not g:
            continue
        if g.get('type') == 'Polygon':
            out.append(g['coordinates'])
        elif g.get('type') == 'MultiPolygon':
            out.extend(g['coordinates'])
    return out


def reach_for(slug, args, points):
    cl_p = os.path.join(args.chartpack, slug, 'centreline.geojson')
    pts, st, kind = [], [], None
    if os.path.isfile(cl_p):
        feat = (load_json(cl_p).get('features') or [None])[0]
        if feat:
            pts = feat['geometry']['coordinates']
            st = (feat.get('properties') or {}).get('station_m') or []
            kind = 'centreline'
    if not pts:
        # A LAKE HAS NO LINE. Its own boundary is what says where it is, and the seed is the
        # charted water inside it -- so the walk starts from the whole lake rather than from a
        # channel down the middle of it, and a landing's distance is to the nearest water it
        # can actually reach.
        rings = boundary_rings(args.registry, slug)
        if not rings:
            return None, 'no centreline and no boundary'
        # boundary_rings() returns one RING LIST per polygon -- [outer, hole, hole...] -- so the
        # flatten is two deep, not one. It was one, and min() got handed a ring.
        pts = [tuple(q) for poly in rings for ring in poly for q in ring]
        kind = 'boundary'
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    bbox = (min(xs) - MARGIN_DEG, min(ys) - MARGIN_DEG, max(xs) + MARGIN_DEG, max(ys) + MARGIN_DEG)
    polys, nread = water_polys(args.extract, args.registry, slug, bbox)
    if not polys:
        return None, 'no charted water on its tiles'
    if kind == 'boundary':
        # Seeding on the RING alone would start the walk at the shoreline and make the middle of
        # the lake the far end of it. Seed every water cell inside the boundary instead: on a
        # lake, "how far to the water" is how far to the nearest part of it.
        from shapely.geometry import Polygon as _P
        from shapely.ops import unary_union as _uu
        try:
            box_polys = [_P(r[0], r[1:]) for r in boundary_rings(args.registry, slug)
                         if r and len(r[0]) >= 4]
            box_polys = [g if g.is_valid else g.buffer(0) for g in box_polys]
            own = _uu([g for g in box_polys if not g.is_empty])
            seeds = []
            for g in polys:
                if g.intersects(own):
                    c = g.intersection(own)
                    for part in (c.geoms if hasattr(c, 'geoms') else [c]):
                        if getattr(part, 'exterior', None) is not None:
                            seeds.extend(list(part.exterior.coords))
            if seeds:
                pts = seeds
        except Exception:
            pass                 # fall back to the ring, which is still an answer
    dist, nx, ny, w0, s0, step, nwet = walk(polys, pts, bbox)
    got = []
    for (la, lo), rec in points.items():
        if not (bbox[0] <= lo <= bbox[2] and bbox[1] <= la <= bbox[3]):
            continue
        i = int((lo - w0) / CELL_DEG); j = int((la - s0) / CELL_DEG)
        best = None
        # A landing sits ON THE BANK, never in the water -- make_river_boundaries measured
        # 25 m, 10 m, 28 m on the Ocmulgee. Look outward a few cells for the water it serves,
        # and stop at the first ring that has any, so the nearest water wins.
        for r in range(0, 7):
            for a in range(i - r, i + r + 1):
                for b in range(j - r, j + r + 1):
                    if 0 <= a < nx and 0 <= b < ny and dist[b * nx + a] >= 0:
                        d = dist[b * nx + a]
                        if best is None or d < best:
                            best = d
            if best is not None:
                break
        if best is None:
            continue
        cos = math.cos(math.radians(la))
        straight = min(math.hypot((x - lo) * 111320 * cos, (y - la) * 110540) for x, y in pts)
        k = min(range(len(pts)),
                key=lambda t: (pts[t][0] - lo) ** 2 + (pts[t][1] - la) ** 2)
        got.append({'name': rec['name'] or None, 'lat': rec['lat'], 'lon': rec['lon'],
                    'water_m': int(round(best * step)), 'straight_m': int(round(straight)),
                    # Where on the river it comes in. A lake has no stations, and saying 0
                    # would read as the top of something.
                    'station_m': (st[k] if (kind == 'centreline' and k < len(st)) else None),
                    'filed': sorted(rec['filed']), 'src': sorted(rec['src'])})
    got.sort(key=lambda r: r['water_m'])
    return {'slug': slug, 'cell_m': round(step, 1), 'water_cells': nwet, 'seed': kind,
            'polygons': len(polys), 'features_read': nread, 'landings': got}, None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--extract', required=True)
    ap.add_argument('--chartpack', required=True)
    ap.add_argument('--only', help='one slug, or a comma list. Default: every pack with a '
                                   'centreline (rivers). Name a lake explicitly and it seeds '
                                   'from its own charted water instead.')
    ap.add_argument('--out', help='default registry/_ramp_reach.json')
    ap.add_argument('--go', action='store_true', help='write; without it nothing is touched')
    a = ap.parse_args()

    try:
        import shapely  # noqa: F401
    except ImportError:
        print('shapely is required: the walk needs real polygon geometry, and a bbox '
              'approximation would put every landing on every river')
        return 2

    points = access_points(a.registry)
    print('access points on file: %d' % len(points))
    if a.only:
        slugs = [s.strip() for s in a.only.split(',') if s.strip()]
    else:
        import glob
        slugs = sorted(os.path.basename(os.path.dirname(p)) for p in
                       glob.glob(os.path.join(a.chartpack, '*', 'centreline.geojson')))
    print('waters to measure: %d' % len(slugs))

    out, skipped = {}, {}
    for slug in slugs:
        res, why = reach_for(slug, a, points)
        if res is None:
            skipped[slug] = why
            print('   %-30s -- %s' % (slug, why))
            continue
        out[slug] = res
        gained = [r for r in res['landings'] if slug not in r['filed']]
        print('   %-30s %-10s %6d water cells, %3d landings reachable, %3d filed elsewhere'
              % (slug, res['seed'], res['water_cells'], len(res['landings']), len(gained)))
        for r in gained[:6]:
            print('        %7d m by water (%6d straight)  %-32s filed %s'
                  % (r['water_m'], r['straight_m'], (r['name'] or '(unnamed)')[:32], r['filed']))

    dest = a.out or os.path.join(a.registry, '_ramp_reach.json')
    # MERGE, NEVER REPLACE. A run is almost always `--only` a handful of waters -- 57 rivers at
    # two or three minutes each is hours, so it gets done in batches -- and writing the whole
    # file from one batch would delete every water the batch did not measure. build_all_chartpacks
    # learned this the same way and says so out loud: "merging into existing report".
    waters, skips, carried = dict(out), dict(skipped), 0
    if os.path.isfile(dest):
        try:
            prev = load_json(dest)
            for slug, rec in (prev.get('waters') or {}).items():
                if slug not in waters:
                    waters[slug] = rec
                    carried += 1
            for slug, why in (prev.get('skipped') or {}).items():
                if slug not in waters and slug not in skips:
                    skips[slug] = why
        except Exception as e:
            print('!! %s is unreadable (%s) -- refusing to overwrite it with this run alone'
                  % (dest, e))
            return 2
    if carried:
        print('\nmerging into the existing index: %d water(s) carried forward untouched' % carried)
    doc = {'_note': 'build_ramp_reach.py -- water distance from a landing to a water. ADDITIVE: '
                    'nothing here removes a landing from the water it is filed under.',
           'cell_m': round(CELL_DEG * 110540, 1), 'waters': waters, 'skipped': skips}
    # TWO WRITES, BECAUSE TWO READERS. The registry index is the build-time record, the same
    # shape every other _*.json in there has. `chartpack/<slug>/launches.json` is what the APP
    # reads: it already fetches per-water files out of the pack by name -- centreline.geojson,
    # boundary.geojson -- so a landing list rides the delivery that exists rather than needing
    # a new one. upload_garmin_to_r2 ships it under `launches`, opt-in like the rest of that
    # group. Both are written from the same measurement in the same run; they cannot drift.
    packs = []
    for slug, res in out.items():
        d = os.path.join(a.chartpack, slug)
        if os.path.isdir(d):
            packs.append((os.path.join(d, 'launches.json'),
                          {'slug': slug, 'cell_m': res['cell_m'], 'note': doc['_note'],
                           'landings': res['landings']}))
    if not a.go:
        print('\nDRY RUN -- nothing written. Add --go to write %s' % dest)
        print('   and %d pack file(s), e.g. %s' % (len(packs), packs[0][0] if packs else '-'))
        return 0
    with open(dest, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh)
    print('\nwrote %s' % dest)
    for fp, body in packs:
        with open(fp, 'w', encoding='utf-8') as fh:
            json.dump(body, fh)
    print('wrote %d pack launches.json' % len(packs))
    if packs:
        print('\nSHIP IT -- the app reads this out of the pack, so it has to reach R2:\n')
        print('  py .\\scripts\\upload_garmin_to_r2.py `')
        print('     --root     F:\\TrollMapPipeline\\chartpack `')
        print('     --registry F:\\TrollMapPipeline\\registry `')
        print('     --layers launches --lake %s --jobs 6'
              % ','.join(sorted(out)[:4] + (['...'] if len(out) > 4 else [])))
    return 0


if __name__ == '__main__':
    sys.exit(main())
