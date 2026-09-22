r"""Which landings sit on water they cannot leave?

    py .\landings_off_the_main_water.py --registry "F:\TrollMapPipeline\registry" ^
       --chartpack "F:\TrollMapPipeline\chartpack" --out "F:\TrollMapPipeline\registry\_landing_components.json"
    # --only lake_marion,monticello_reservoir   to check one water

WHY THIS EXISTS. Ryan, 2026-09-22: *"lake marions pack carries the bathymetry for the borrow pit but
they are separate lakes"*, and *"i was just curious about the ramps... making sure the app didn't
think you could plan for another lake from the other"*. It does think that. `registry/_ramp_reach.json`
files `Borrow Pit` under `lake_marion` at **water_m 0**, and Lake Monticello's sub-impoundment ramp is
offered as access to all 6,676 acres. Both are separated from their main pool by a dike with a road
on it.

    THE APP MUST NOT OFFER A LANDING AS ACCESS TO WATER A BOAT CANNOT REACH FROM IT.

And that is the whole requirement. **No new packs and no split boundaries** -- his call, and the right
one: the bathymetry is correct where it is, one pack per boundary, and the sub-impoundment and the
borrow pit are real water worth charting. What is wrong is only which landings are offered for which
water.

IT COUNTS POLYGON COMPONENTS, NOT GRID CELLS, AND THAT IS THE POINT. A flood over a raster cannot see
a barrier narrower than one cell: at 25 m -- what `build_ramp_reach.py` uses -- Lake Monticello came
back 100.0% connected, and at 6 m it came back 36.9%, two separate waters. The resolution WAS the
answer and nothing in the coarse output hinted at it. Two depth-area polygons either side of a dike do
not touch at any resolution, so adjacency answers the same question exactly and once.

    A FLOOD CANNOT SEE A BARRIER NARROWER THAN ITS OWN CELL.
    A BOUNDARY IS NOT A CONNECTIVITY CLAIM -- one polygon can hold two waters.

This only MEASURES. It writes a report and changes no producer, because how to spend the answer
depends on how big it is: a handful of landings is a different fix from a hundred.

Personal use only, not for distribution or resale; not for navigation.
"""
import argparse, json, math, os, sys

from shapely.geometry import shape, Point
from shapely.strtree import STRtree


def load_json(p):
    with open(p, encoding='utf-8') as fh:
        return json.load(fh)


def components(polys):
    """Union-find over polygons that touch. Returns a list of index-lists, largest area first.

    `intersects` and not a distance: two adjacent depth BANDS share an edge and are one body of
    water, while two pools either side of a dike share nothing. Nesting is fine -- a deeper ring
    inside a shallower one is contained by it, which is the same water.
    """
    n = len(polys)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    tree = STRtree(polys)
    for i, g in enumerate(polys):
        for j in tree.query(g):
            if j > i and polys[j].intersects(g):
                union(i, j)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return sorted(groups.values(), key=lambda ix: -sum(polys[k].area for k in ix))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--chartpack', required=True)
    ap.add_argument('--out')
    ap.add_argument('--only', help='comma-separated slugs')
    ap.add_argument('--max-polys', type=int, default=40000,
                    help='skip a pack with more polygons than this and SAY SO rather than hang')
    a = ap.parse_args()

    idx = load_json(os.path.join(a.registry, 'lake_index.json'))
    reach_fp = os.path.join(a.registry, '_ramp_reach.json')
    reach = load_json(reach_fp).get('waters') or {} if os.path.isfile(reach_fp) else {}

    only = set((a.only or '').split(',')) - {''}
    slugs = sorted(only or idx)

    report, skipped = {}, []
    for n_done, slug in enumerate(slugs, 1):
        if slug not in idx:
            continue
        fp = os.path.join(a.chartpack, slug, 'depth_areas.geojson')
        if not os.path.isfile(fp):
            continue
        # landings: the reach file is the merged list and carries Ryan's own names
        lands = [l for l in ((reach.get(slug) or {}).get('landings') or [])
                 if l.get('lat') is not None]
        if not lands:
            for bucket, recs in ((idx[slug].get('ramps') or {}).items()):
                for r in (recs or []):
                    if r.get('lat') is not None:
                        lands.append({'name': r.get('name'), 'lat': r['lat'], 'lon': r['lon'],
                                      'src': [bucket]})
        if not lands:
            continue

        gj = load_json(fp)
        polys = []
        for f in (gj.get('features') or []):
            try:
                g = shape(f['geometry'])
            except Exception:
                continue
            if not g.is_empty and g.area > 0:
                polys.append(g)
        if not polys:
            continue
        if len(polys) > a.max_polys:
            skipped.append({'slug': slug, 'polygons': len(polys), 'why': 'over --max-polys'})
            print('  SKIP %-30s %d polygons > %d' % (slug, len(polys), a.max_polys), flush=True)
            continue

        comps = components(polys)
        k = math.cos(math.radians(polys[0].centroid.y)) or 1e-9
        acres = lambda ix: sum(polys[i].area for i in ix) * (111320.0 ** 2) * k / 4046.86
        comp_of = {}
        for ci, ix in enumerate(comps):
            for i in ix:
                comp_of[i] = ci
        tree = STRtree(polys)

        rows = []
        for l in lands:
            pt = Point(l['lon'], l['lat'])
            best = None
            for i in tree.query(pt.buffer(0.004)):       # ~400 m
                d = polys[i].distance(pt)
                if best is None or d < best[0]:
                    best = (d, i)
            if best is None:
                rows.append({'name': l.get('name'), 'lat': l['lat'], 'lon': l['lon'],
                             'component': None, 'water_m': None, 'src': l.get('src')})
                continue
            ci = comp_of[best[1]]
            # THE ACRES GO ON THE ROW, not looked up in a truncated list. The first cut of this
            # printed "?-acre pool" for three lakes because `component_acres` keeps only the
            # first eight and the landing was on the ninth or later -- a roll call with holes in
            # it is not a roll call.
            rows.append({'name': l.get('name'), 'lat': l['lat'], 'lon': l['lon'],
                         'component': ci,
                         'component_acres': round(acres(comps[ci]), 1),
                         'metres_to_that_water': round(best[0] * 111320.0 * k, 1),
                         'src': l.get('src')})
        off = [r for r in rows if r['component'] not in (0, None)]
        report[slug] = {
            'components': len(comps),
            'component_acres': [round(acres(ix), 1) for ix in comps[:8]],
            'landings': len(rows),
            'landings_off_the_main_component': len(off),
            'off': off,
        }
        if off or len(comps) > 1:
            print('  %-30s %3d component(s)  main %9.1f ac  %d of %d landing(s) OFF the main water'
                  % (slug, len(comps), acres(comps[0]), len(off), len(rows)), flush=True)
        if n_done % 25 == 0:
            print('  ... %d/%d slugs' % (n_done, len(slugs)), flush=True)

    tot_off = sum(v['landings_off_the_main_component'] for v in report.values())
    waters_with = [s for s, v in report.items() if v['landings_off_the_main_component']]
    print()
    print('%d water(s) measured' % len(report))
    print('%d landing(s) sit on water that is NOT their lake\'s main body, across %d water(s)'
          % (tot_off, len(waters_with)))
    if skipped:
        print('%d pack(s) skipped for size -- NAMED, NOT COUNTED:' % len(skipped))
        for s in skipped:
            print('   %-30s %d polygons' % (s['slug'], s['polygons']))
    if a.out:
        json.dump({'_note': 'landings on a water body disconnected from their lake\'s main one',
                   'waters': report, 'skipped': skipped},
                  open(a.out, 'w', encoding='utf-8'), indent=1, sort_keys=True)
        print('-> %s' % a.out)


if __name__ == '__main__':
    main()
