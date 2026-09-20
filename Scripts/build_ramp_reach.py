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
BLOCK_CELLS = 2_000_000     # cells per vectorised point-in-polygon call; caps peak memory


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
                rec = out.setdefault(k, {'lat': la, 'lon': lo, 'name': '', 'access': '',
                                         'filed': set(), 'src': set()})
                rec['filed'].add(slug)
                rec['src'].add(src)
                nm = r.get('name') or r.get('NAME') or r.get('label')
                if nm and not rec['name']:
                    rec['name'] = nm
                # WHO IS ALLOWED TO LAUNCH THERE, WHERE THE FEED SAYS.
                #
                # OSM tags `access` and osm_ramps_by_lake.json has kept it all along; it stopped
                # at the registry and never reached the app, so the ramp list was offering
                # `access=private` slipways with nothing to tell them apart. OSM's
                # `leisure=slipway` covers a private dock ramp behind a house exactly as much as
                # a public landing, which is why Lake Murray has eight of them at 0 m of water.
                # Measured across the packs before this: 18 rows not freely public (15 private,
                # 2 customers, 1 `no` -- named "Abandon Boat Launch"), 31 positively public,
                # and 520 with no tag at all. So this answers for a minority and says nothing
                # for the rest, which is the truth and is why it is carried rather than assumed.
                ac = r.get('access')
                if ac and not rec['access']:
                    rec['access'] = str(ac)

    # A NAME GOOGLE KNEW AND NO FEED DID.
    #
    # name_launches_from_places.py asks Google Nearby Search what is at a landing nobody named
    # and writes the answers here. It is read LAST and only fills a blank: a name from SCDNR or
    # OSM is a name somebody chose for that landing, and Google's label for the car park it sits
    # in does not get to overwrite it. Only `accepted` records count -- the file also holds
    # unaccepted SUGGESTIONS, which are for a human to read and are not names.
    p = os.path.join(registry, '_place_names.json')
    if os.path.isfile(p):
        named = 0
        for key, r in (load_json(p).get('places') or {}).items():
            if not r.get('accepted') or not r.get('name'):
                continue
            try:
                la, lo = (float(v) for v in key.split(','))
            except ValueError:
                continue
            rec = out.get((round(la, 5), round(lo, 5)))
            if rec is not None and not rec['name']:
                rec['name'] = str(r['name'])
                rec['src'].add('places')
                named += 1
        if named:
            print('names from Google Places: %d' % named)

    # AND RYAN'S OWN CORRECTIONS, WHICH BEAT EVERY FEED.
    #
    # He fishes these waters and SCDNR does not. Read last and it OVERWRITES rather than filling
    # a blank, because the cases that need it are exactly the ones where a feed is confidently
    # wrong: *"Dam Boat dock is buckhill landing which is on the lake not the river"*.
    #
    # Naming two records the same thing is also how a duplicate is retired -- collapse() in
    # js/data/launch-reach.js folds two rows sharing a name within 250 m into one, so *"1 ramp at
    # hwy 378 on the wateree"* is answered by giving both records the one name rather than by a
    # rule about those two coordinates.
    p = os.path.join(registry, '_launch_name_overrides.json')
    if os.path.isfile(p):
        fixed = 0
        for key, r in (load_json(p).get('names') or {}).items():
            nm = (r or {}).get('name')
            if not nm:
                continue
            try:
                la, lo = (float(v) for v in key.split(','))
            except ValueError:
                continue
            rec = out.get((round(la, 5), round(lo, 5)))
            if rec is None:
                print('!! override at %s matches no landing -- check the position' % key)
                continue
            rec['name'] = str(nm)
            rec['src'].add('ryan')
            fixed += 1
        if fixed:
            print("Ryan's own corrections applied: %d" % fixed)
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
    import numpy as np
    from shapely import intersects_xy
    w0, s0, e0, n0 = bbox
    nx = int((e0 - w0) / cell) + 1
    ny = int((n0 - s0) / cell) + 1
    wet = np.zeros(nx * ny, dtype=bool)
    for g in polys:
        gx0, gy0, gx1, gy1 = g.bounds
        i0 = max(0, int((gx0 - w0) / cell)); i1 = min(nx - 1, int((gx1 - w0) / cell) + 1)
        j0 = max(0, int((gy0 - s0) / cell)); j1 = min(ny - 1, int((gy1 - s0) / cell) + 1)
        if i1 < i0 or j1 < j0:
            continue
        # ONE PREDICATE CALL PER BLOCK, NOT PER CELL. This was `prep(g).covers(Point(x, y))`
        # once per cell, and the Python call overhead -- not the geometry -- was the whole cost:
        # a river's polygons cover millions of cells between them. `intersects_xy` runs the SAME
        # test in C over an array, and for a point `g.intersects(p)` and `g.covers(p)` are the
        # same question, so the answer is identical and not merely close. Blocked by rows so a
        # lake-sized polygon cannot materialise its whole bbox at once.
        ii = np.arange(i0, i1 + 1)
        xs = w0 + (ii + 0.5) * cell
        rows = max(1, int(BLOCK_CELLS // xs.size))
        for jb in range(j0, j1 + 1, rows):
            je = min(j1, jb + rows - 1)
            jj = np.arange(jb, je + 1)
            ys = s0 + (jj + 0.5) * cell
            hit = intersects_xy(g, np.tile(xs, jj.size), np.repeat(ys, xs.size))
            if not hit.any():
                continue
            wet[(np.repeat(jj, xs.size) * nx + np.tile(ii, jj.size))[hit]] = True
    nwet = int(wet.sum())
    # The flood below reads one cell at a time, where bytes beats a numpy array on scalar
    # indexing. Same bits, cheaper reads.
    wet = wet.tobytes()
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
    return dist, nx, ny, w0, s0, step, nwet


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
    import numpy as np
    PX = np.fromiter((p[0] for p in pts), dtype=float, count=len(pts))
    PY = np.fromiter((p[1] for p in pts), dtype=float, count=len(pts))
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
        # ONE SCAN, NOT TWO, AND IN METRES. This was a `min()` over every seed point for the
        # distance and a second `min()` over the same points for the station, and the second
        # ranked by SQUARED DEGREES -- which stretches longitude by 1/cos(lat) and can hand back
        # a different point than the one the distance came from. Same scan, same metric, so the
        # station reported is the station that distance was measured to.
        cos = math.cos(math.radians(la))
        dm = np.hypot((PX - lo) * (111320 * cos), (PY - la) * 110540)
        k = int(dm.argmin())
        straight = float(dm[k])
        got.append({'name': rec['name'] or None, 'lat': rec['lat'], 'lon': rec['lon'],
                    'access': rec.get('access') or None,
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
    ap.add_argument('--all', action='store_true',
                    help='every water the APP OFFERS -- registry/lake_index.json -- that has a '
                         'pack, seeding rivers from their centreline and lakes from their own '
                         'charted water. The same gate upload_garmin_to_r2.py ships by, because '
                         'measuring water the app never shows is work nobody reads.')
    ap.add_argument('--out', help='default registry/_ramp_reach.json')
    ap.add_argument('--go', action='store_true', help='write; without it nothing is touched')
    ap.add_argument('--jobs', type=int, default=0,
                    help='waters measured at once. Default: one per core, capped at the number '
                         'of waters. 1 runs in this process, which is what to use when a run '
                         'misbehaves and you want the traceback where you can see it.')
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
    elif a.all:
        # THE SAME GATE THE UPLOADER SHIPS BY. lake_index.json is the file the app reads, so a
        # slug that is not in it is a pack nobody can select. A pack directory must exist too:
        # reach_for() needs the pack's centreline or the water's boundary, and a slug with
        # neither is reported as skipped rather than silently dropped.
        idx = load_json(os.path.join(a.registry, 'lake_index.json'))
        slugs = sorted(s for s in idx
                       if os.path.isdir(os.path.join(a.chartpack, s))
                       and (os.path.isfile(os.path.join(a.chartpack, s, 'centreline.geojson'))
                            or os.path.isfile(os.path.join(a.registry, 'boundaries', s + '.geojson'))))
        print('the app offers %d waters; %d of them have a pack and something to seed from'
              % (len(idx), len(slugs)))
    else:
        import glob
        slugs = sorted(os.path.basename(os.path.dirname(p)) for p in
                       glob.glob(os.path.join(a.chartpack, '*', 'centreline.geojson')))
    print('waters to measure: %d' % len(slugs))

    # EVERY WATER IS ITS OWN QUESTION. reach_for() reads the registry and the extract and
    # returns an answer; it shares nothing with the next water and writes nothing. So the only
    # reason this ran one at a time was that it was written that way. The merge below is still
    # one writer in one process, which is the part that has to stay serial.
    jobs = a.jobs if a.jobs > 0 else min(len(slugs), os.cpu_count() or 1)
    jobs = max(1, min(jobs, len(slugs)))
    print('measuring %d at a time' % jobs)

    done_n = [0]

    def report(slug, res, why):
        done_n[0] += 1
        # THE COUNT IS THE POINT. A 355-water run reported in the order ASKED FOR printed
        # nothing at all for the first thirteen minutes, because the first slug alphabetically
        # was submitted near-last under biggest-first and every other finished answer sat behind
        # its future. Fourteen workers were pegged the whole time and there was no way to see
        # it. Printed as they finish now, with the count, so a long run says where it is.
        head = '%3d/%d' % (done_n[0], len(slugs))
        if res is None:
            print('   %s %-30s -- %s' % (head, slug, why))
            return
        gained = [r for r in res['landings'] if slug not in r['filed']]
        print('   %s %-30s %-10s %6d water cells, %3d landings reachable, %3d filed elsewhere'
              % (head, slug, res['seed'], res['water_cells'], len(res['landings']), len(gained)))
        for r in gained[:6]:
            print('        %7d m by water (%6d straight)  %-32s filed %s'
                  % (r['water_m'], r['straight_m'], (r['name'] or '(unnamed)')[:32], r['filed']))

    out, skipped = {}, {}
    if jobs == 1:
        pairs = ((slug, reach_for(slug, a, points)) for slug in slugs)
    else:
        from concurrent.futures import ProcessPoolExecutor
        ex = ProcessPoolExecutor(max_workers=jobs)
        # Biggest first: the tail of a pool is one straggler, and on this data the straggler is
        # always a big water. Submitted in size order, the big ones start while there are still
        # small ones left to fill the gaps behind them.
        def _size(s):
            p = os.path.join(a.chartpack, s, 'centreline.geojson')
            b = os.path.join(a.registry, 'boundaries', s + '.geojson')
            return os.path.getsize(p) if os.path.isfile(p) else (
                os.path.getsize(b) if os.path.isfile(b) else 0)
        order = sorted(slugs, key=_size, reverse=True)
        futs = {ex.submit(reach_for, slug, a, points): slug for slug in order}
        # Reported AS THEY FINISH. The record is sorted by slug where it is written, so the file
        # two runs produce is the same whatever order the pool happened to return in.
        from concurrent.futures import as_completed
        pairs = ((futs[f], f.result()) for f in as_completed(futs))
    try:
        for slug, (res, why) in pairs:
            report(slug, res, why)
            if res is None:
                skipped[slug] = why
            else:
                out[slug] = res
    finally:
        if jobs != 1:
            ex.shutdown()

    dest = a.out or os.path.join(a.registry, '_ramp_reach.json')
    # MERGE, NEVER REPLACE. A run is often `--only` a handful of waters -- the lakes one hour,
    # the rivers the next -- and writing the whole file from one batch would delete every water
    # the batch did not measure. (This comment used to say 57 rivers "is hours". It was written
    # before the raster was vectorised and before the pool, it was the number Ryan was quoted,
    # and it was wrong: measure the run, do not trust this line.) build_all_chartpacks
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
    # SORTED, BECAUSE THE POOL FINISHES IN WHATEVER ORDER IT FINISHES. The console prints as
    # answers land, which is what makes a long run readable; the file has to be the same file
    # every time or a diff between two runs is mostly noise about ordering.
    doc = {'_note': 'build_ramp_reach.py -- water distance from a landing to a water. ADDITIVE: '
                    'nothing here removes a landing from the water it is filed under.',
           'cell_m': round(CELL_DEG * 110540, 1),
           'waters': {k: waters[k] for k in sorted(waters)},
           'skipped': {k: skips[k] for k in sorted(skips)}}
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
