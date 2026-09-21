#!/usr/bin/env python3
"""build_annex.py - Garmin-sounded water that touches one of our waters and belongs to nobody.

Personal use only, not for distribution or resale; not for navigation.

    py -u Scripts\\build_annex.py ^
       --extract  F:\\TrollMapPipeline\\extract ^
       --registry F:\\TrollMapPipeline\\registry ^
       --map      F:\\TrollMapPipeline\\registry\\tile_lake_map.json ^
       --out      F:\\TrollMapPipeline\\registry\\annex

WHAT THIS IS FOR, 2026-09-21

The canal from Pack's Landing to the Congaree. Ryan: *"there are still great big humongous holes
in the canal running from packs landing to the river."* Garmin has it -- a narrow white ribbon on
his chartplotter with 1, 2 and 10 ft contours down it -- and our extract has it. Four separate
fixes to the ownership rules that night did nothing for it, because it was never an ownership
question:

    Garmin bands in the window around it        297.1 ac
    boundaries overlapping that window          2   (congaree_river, lake_marion)
    sounded water NO boundary claims             27.8 ac  (9%)
        12.95 ac  33.65524 -80.52628   0 m from the nearest boundary
         9.23 ac  33.64877 -80.52741   0 m from the nearest boundary

**THE CANAL IS INSIDE NO WATER'S 3DHP POLYGON AT ALL.** 00_START_HERE's governing fact is that a
feature can only be assigned by clipping it against a polygon, so water no polygon covers is
water no pack can carry. It is not a bug in a rule. It is a hole between two agencies: Garmin
surveyed it, 3DHP never drew it.

THE RULE, AND IT HAS NO THRESHOLD IN IT

*Water Garmin sounded, touching a water we have, claimed by no other water, belongs to that
water.* Every orphan piece around the canal sits at **0 m** from a boundary -- it does not drift
near one, it runs right up against it and stops being anybody's the moment it leaves the outline.
Touching is the whole test. Nothing is tuned.

A piece touching TWO waters is annexed to BOTH, which is the canal's own case: it joins Pack's
Landing on Lake Marion to the Congaree River and it is the route between them. Ryan already
priced duplication, on ramps: *"If you can have these ramps be both river and lake I do not see
the downside."*

WHY NOT sweep_unclaimed.py

That answers a different question -- "is there a whole water here that the registry never heard
of", Lake Robinson at 803 acres with no name in 3DHP -- and its floor is 40 acres precisely so a
strip like this does not drown the report. This one attaches fragments to waters that already
exist, and a 9-acre fragment is the point rather than the noise.

WHAT IT WRITES

`<out>/<slug>.geojson`, one FeatureCollection of orphan polygons per water, and `_annex.json`
with the totals. build_all_chartpacks.load_boundary() unions them into the water's outline, so
everything downstream -- the mask, the trim, the core test, the unsurveyed clip -- follows with
no further change.
"""
import argparse, json, gzip, os, sys, time
from collections import defaultdict

NOTE = "Personal use only, not for distribution or resale; not for navigation."


def rd(p):
    op = gzip.open if p.endswith('.gz') else open
    with op(p, 'rt', encoding='utf-8') as fh:
        return json.load(fh).get('features') or []


def tile_file(extract, layer, tid):
    base = os.path.join(extract, layer, tid)
    for suf in ('.geojson.gz', '.geojson'):
        if os.path.exists(base + suf):
            return base + suf
    return None


def main():
    from shapely.geometry import shape, mapping, box
    from shapely.ops import unary_union
    from shapely.strtree import STRtree

    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--extract', required=True)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--map', required=True, help='tile_lake_map.json')
    ap.add_argument('--out', required=True)
    ap.add_argument('--index', default=None,
                    help='lake_index.json -- only these waters may annex. Defaults beside '
                         '--registry, and it is the same gate the builder and uploader use.')
    ap.add_argument('--only-tiles', help='comma list, for a probe')
    a = ap.parse_args()

    def fix(g):
        # buffer(0), not make_valid: make_valid returns a GeometryCollection for a
        # self-intersecting ring and a Polygon/MultiPolygon filter throws those away in silence.
        return g if g.is_valid else (g.buffer(0) or g)

    def ac(g):
        return g.area * (111320.0 ** 2 * 0.8315) / 4046.856

    ipath = a.index or os.path.join(a.registry, 'lake_index.json')
    if not os.path.exists(ipath):
        sys.exit('no lake_index.json at %s -- annexing water for packs nobody serves is work '
                 'nobody asked for. Run consolidate_lake_index.py first.' % ipath)
    served = set(json.load(open(ipath, encoding='utf-8')))
    tm = json.load(open(a.map, encoding='utf-8'))
    by_tile = tm['by_tile']
    tiles = sorted(by_tile)
    if a.only_tiles:
        want = {t.upper().lstrip('BC') for t in a.only_tiles.split(',') if t.strip()}
        tiles = [t for t in tiles if t[1:] in want]
    print('%d tile(s), %d served water(s)' % (len(tiles), len(served)))

    # EVERY boundary, not just the served ones. A piece sitting inside an unserved water is that
    # water's and must not be annexed to its neighbour just because we do not ship it -- that is
    # how a lake's bathymetry ends up drawn inside the river beside it.
    bdir = os.path.join(a.registry, 'boundaries')
    bounds = {}
    for fn in sorted(os.listdir(bdir)):
        if not fn.endswith('.geojson') or fn.startswith('_'):
            continue
        slug = fn[:-len('.geojson')]
        try:
            gs = [fix(shape(f['geometry'])) for f in rd(os.path.join(bdir, fn))
                  if f.get('geometry')]
            gs = [g for g in gs if not g.is_empty]
            if gs:
                bounds[slug] = unary_union(gs)
        except Exception:
            continue
    print('%d boundary polygon(s) loaded' % len(bounds))

    annex = defaultdict(list)
    stats = {'tiles': 0, 'orphan_pieces': 0, 'orphan_acres': 0.0, 'annexed_acres': 0.0,
             'unattached_acres': 0.0, 'unattached_pieces': 0}
    t0 = time.time()
    for ti, tid in enumerate(tiles, 1):
        base = tid[1:]
        fp = tile_file(a.extract, 'depth_areas', 'C' + base)
        if not fp:
            continue
        feats = [f for f in rd(fp) if (f.get('properties') or {}).get('zoom') == 0]
        if not feats:
            continue
        stats['tiles'] += 1
        polys = []
        for f in feats:
            try:
                g = fix(shape(f['geometry']))
            except Exception:
                continue
            if not g.is_empty:
                polys.append(g)
        if not polys:
            continue
        tb = box(*unary_union([g.envelope for g in polys]).bounds)
        near = {s: g for s, g in bounds.items() if g.envelope.intersects(tb)}
        if not near:
            continue
        # A GRID, BECAUSE BOTH OBVIOUS SHAPES BLOW UP. Differencing each band against one
        # union of every nearby boundary took 92 s for ONE tile -- 2.3 hours for the card --
        # and an R-tree per band is worse, because these bands are river-chain polygons that
        # span miles and match hundreds of boundaries each.
        #
        # So cut the tile into 0.02 deg cells, about 2 km, and do the subtraction cell by cell
        # with only the geometry that reaches into that cell. Every operation is then bounded
        # by what fits in 2 km of water rather than by the size of the card, and the answer is
        # identical -- a difference distributes over a partition of the plane.
        bt = STRtree(polys)
        nslugs = list(near.keys())
        ngeoms = [near[s] for s in nslugs]
        nt = STRtree(ngeoms)
        minx, miny, maxx, maxy = unary_union([g.envelope for g in polys]).bounds
        STEP = 0.02
        orphan = []
        ny = int((maxy - miny) / STEP) + 1
        nx = int((maxx - minx) / STEP) + 1
        for iy in range(ny):
            for ix in range(nx):
                cell = box(minx + ix * STEP, miny + iy * STEP,
                           minx + (ix + 1) * STEP, miny + (iy + 1) * STEP)
                bi = bt.query(cell)
                if len(bi) == 0:
                    continue
                try:
                    S = unary_union([polys[i] for i in bi]).intersection(cell)
                except Exception:
                    continue
                if S.is_empty:
                    continue
                ci = nt.query(cell)
                if len(ci):
                    try:
                        C = unary_union([ngeoms[i] for i in ci]).intersection(cell)
                        S = fix(S.difference(C))
                    except Exception:
                        continue
                if not S.is_empty:
                    orphan.append(S)
        if not orphan:
            continue
        O = fix(unary_union(orphan))
        pieces = [q for q in getattr(O, 'geoms', [O])
                  if q.geom_type == 'Polygon' and not q.is_empty]
        for q in pieces:
            stats['orphan_pieces'] += 1
            stats['orphan_acres'] += ac(q)
            # TOUCHING, and only touching. A piece that merely lies NEAR a water is a water of
            # its own and belongs to sweep_unclaimed.py, not here.
            # THE TREE AGAIN, AND THIS WAS THE ACTUAL COST. Asking every one of ~3,000 nearby
            # boundaries for its distance to every one of ~3,700 orphan pieces is eleven
            # million distance calls, and it was the whole of the 124 s this tile took. Query
            # the piece's own envelope and test the handful that reach it.
            ti_ = nt.query(q)
            takers = [nslugs[i] for i in ti_
                      if nslugs[i] in served and q.distance(ngeoms[i]) <= 1e-9]
            if not takers:
                stats['unattached_pieces'] += 1
                stats['unattached_acres'] += ac(q)
                continue
            for s in takers:
                annex[s].append(q)
                stats['annexed_acres'] += ac(q)
        # EVERY TILE, not every ten. A tile is up to 100 s here and a five-tile run printed
        # nothing at all until it finished, which is the same "is it working or hung" question
        # a buffered log asks. A line per tile costs nothing.
        if True:
            print('   tile %d/%d  %.0fs  %d orphan piece(s), %.1f ac, %d water(s) annexing'
                  % (ti, len(tiles), time.time() - t0, stats['orphan_pieces'],
                     stats['orphan_acres'], len(annex)))

    os.makedirs(a.out, exist_ok=True)
    report = {}
    for s, qs in sorted(annex.items()):
        u = fix(unary_union(qs))
        parts = [q for q in getattr(u, 'geoms', [u])
                 if q.geom_type == 'Polygon' and not q.is_empty]
        fc = {'type': 'FeatureCollection',
              'properties': {'slug': s, 'source': 'build_annex.py', 'note': NOTE},
              'features': [{'type': 'Feature',
                            'properties': {'acres': round(ac(q), 3), 'annexed': True},
                            'geometry': mapping(q)} for q in parts]}
        json.dump(fc, open(os.path.join(a.out, s + '.geojson'), 'w', encoding='utf-8'),
                  ensure_ascii=False)
        report[s] = {'pieces': len(parts), 'acres': round(sum(ac(q) for q in parts), 2)}
    json.dump({'note': NOTE, 'stats': {k: (round(v, 2) if isinstance(v, float) else v)
                                       for k, v in stats.items()}, 'by_water': report},
              open(os.path.join(a.out, '_annex.json'), 'w', encoding='utf-8'), indent=1)

    print('\n%d water(s) annexed %.1f ac of sounded water no boundary claimed'
          % (len(report), stats['annexed_acres']))
    # NOT SILENCE. A piece that touches nothing we serve is water we still cannot draw, and the
    # number is the honest measure of what 3DHP and Garmin disagree about.
    print('   %.1f ac in %d piece(s) touched no served water and stays unattached'
          % (stats['unattached_acres'], stats['unattached_pieces']))
    for s, r in sorted(report.items(), key=lambda kv: -kv[1]['acres'])[:15]:
        print('   %-34s %8.1f ac  %4d piece(s)' % (s, r['acres'], r['pieces']))
    print('-> %s' % a.out)


if __name__ == '__main__':
    main()
