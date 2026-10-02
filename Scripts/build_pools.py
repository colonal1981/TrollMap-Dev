#!/usr/bin/env python3
"""
build_pools.py -- which water a ramp can reach on its own lake, for every lake.

Personal use only, not for distribution or resale; not for navigation.

Item 50 of APP_CHANGE_REQUESTS. Ryan, 2026-10-02, on Lake Monticello: "the subimpoundment
(recreation area) boat ramp isn't listed so there is no way to fish the subimpoundment area with
the app", and then "the app needs to be prevented from running plans from a ramp on a part of the
lake the ramp can't access... beyond that the ramp needs to be listed so that i can choose to launch
from the ramp and plan/fish the accessible area from that ramp".

A LAKE CAN HOLD WATER ITS OWN RAMPS CANNOT REACH. Monticello's 285-acre Recreational Lake sits
behind the SC-99 dike; Marion carries the Borrow Pit, Wyboo Swamp and the Santee refuge
impoundments. The registry calls each of them part of the one lake, so the planners offered their
lanes from the main lake's ramps, and the water graph (44 m cells on Monticello) joins the two
across the dike: 651 m from the Recreation Lake ramp to the 99 ramp. A pool that does not touch
the main one is told apart the way build_ramp_reach.py already tells it apart for `on_main_water`:
POLYGON ADJACENCY, which has no cell to be narrower than a dike (water_polygons.components()).

The polygons are the pack's own depth_areas.geojson -- the layer both planners read -- so the pools
here are the water the plan works on, not a second picture of it. The largest pool is the main
one. For every lake pack this writes chartpack/<slug>/pools.json:

  pools     every pool that is not the main one: its id, its acres and its outline. A point in
            none of them is on the main pool, so the main lake's outline is never shipped.
  landings  every landing in the pack's launches.json and the pool it launches onto. A landing
            build_ramp_reach.py put on the main water (on_main_water true, or null: not measured)
            is on pool 0 -- this never moves a ramp that is listed today off the main lake. One it
            put off the main water is on the nearest of these pools within 0.004 deg, the same
            reach as build_ramp_reach.py's _nearest_comp(); null when none is that near.

js/data/lake-pools.js reads it: a plan keeps to the pool its ramp is on. A lake with one pool gets
a file with no pools, so a stale file never outlives the water it described. Rivers get none: the
registry cuts a river at its dams (ONE_RIVER_IS_ONE_WATER_UNTIL_A_DAM_CUTS_IT), so a break in a
river's chart is a gap in the chart, not a dike.

    py Scripts/build_pools.py --lake monticello_reservoir --lake lake_marion
    py Scripts/build_pools.py --all --jobs 4 --report F:\\TrollMapPipeline\\_scratch\\pools\\report.json
    py Scripts/build_pools.py --all --check      # exit 1 if any lake's pools.json is missing or stale
"""

import argparse
import datetime as dt
import json
import math
import os
import sys
from concurrent.futures import ProcessPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

NOTE = ("Personal use only, not for distribution or resale; not for navigation. Built by "
        "Scripts/build_pools.py from this pack's depth_areas.geojson and launches.json: the pools of "
        "this lake that do not touch its main pool (a dike, a road embankment), and the pool each "
        "landing launches onto. A point in none of `pools` is on the main pool (id 0). Item 50.")

NEAR_DEG = 0.004      # build_ramp_reach.py _nearest_comp(): the bank plus slack, ~400 m


def load(path):
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def lake_slugs(registry, chartpack):
    idx = load(os.path.join(registry, 'lake_index.json'))
    return sorted(s for s, r in idx.items() if (r or {}).get('feature_type') == 'lake'
                  and os.path.isfile(os.path.join(chartpack, s, 'depth_areas.geojson')))


def _polys(features):
    from shapely.geometry import shape
    from shapely.validation import make_valid
    from shapely.ops import unary_union
    out = []
    for f in features:
        try:
            g = shape(f['geometry'])
        except Exception:
            continue
        if not g.is_valid:
            g = make_valid(g)
        if g.geom_type == 'GeometryCollection':
            g = unary_union([p for p in g.geoms if p.geom_type in ('Polygon', 'MultiPolygon')])
        if not g.is_empty and g.area > 0:
            out.append(g)
    return out


def _acres(area_deg2, lat):
    return area_deg2 * (111320.0 ** 2) * math.cos(math.radians(lat)) / 4046.86


def _rings(g):
    parts = [g] if g.geom_type == 'Polygon' else [p for p in getattr(g, 'geoms', []) if p.geom_type == 'Polygon']
    r6 = lambda cs: [[round(x, 6), round(y, 6)] for x, y in cs]
    return [[r6(p.exterior.coords)] + [r6(h.coords) for h in p.interiors] for p in parts]


def pools_for(slug, chartpack):
    """The pools.json body for one lake pack, and a few numbers for the report."""
    from shapely.geometry import Point
    from shapely.ops import unary_union
    from shapely.strtree import STRtree
    from water_polygons import components
    P = os.path.join(chartpack, slug)
    polys = _polys(load(os.path.join(P, 'depth_areas.geojson')).get('features') or [])
    if not polys:
        return None, {'slug': slug, 'why': 'no charted polygons'}
    comps = components(polys)                       # largest total area first
    lat = polys[0].centroid.y
    # A pool's acres are its OUTLINE's, not the sum of its polygons': the bands overlap (Monticello's
    # main pool sums to 6,933 acres and unions to 6,368). The main pool is never unioned -- it is the
    # whole lake and nothing reads its size -- so only its polygon count is reported.
    pools, geoms = [], []
    for k, ix in enumerate(comps[1:], start=1):
        u = unary_union([polys[i] for i in ix])
        pools.append({'id': k, 'acres': round(_acres(u.area, lat), 1), 'rings': _rings(u)})
        geoms.append(u)
    landings = []
    lp = os.path.join(P, 'launches.json')
    if os.path.isfile(lp):
        tree = STRtree(geoms) if geoms else None
        for r in load(lp).get('landings') or []:
            la, lo = r.get('lat'), r.get('lon')
            if la is None or lo is None:
                continue
            pool = 0
            if r.get('on_main_water') is False:
                pool = None
                if tree is not None:
                    pt = Point(lo, la)
                    best = None
                    for i in tree.query(pt.buffer(NEAR_DEG)):
                        d = geoms[int(i)].distance(pt)
                        if best is None or d < best[0]:
                            best = (d, int(i))
                    if best is not None:
                        pool = pools[best[1]]['id']
            landings.append({'name': r.get('name'), 'lat': la, 'lon': lo, 'pool': pool})
    body = {'_note': NOTE, 'slug': slug, 'source': 'depth_areas.geojson',
            'pools': pools, 'landings': landings}
    # For the report: how many of the pack's lanes lie in each pool that is not the main one,
    # by the same majority-of-points rule the browser applies (js/data/lake-pools.js).
    lanes = {}
    rp = os.path.join(P, 'trolling_runs.geojson')
    if geoms and os.path.isfile(rp):
        tree = STRtree(geoms)
        for f in load(rp).get('features') or []:
            g = f.get('geometry') or {}
            cs = g.get('coordinates') or []
            if g.get('type') == 'MultiLineString':
                cs = [p for line in cs for p in line]
            if not cs:
                continue
            step = max(1, len(cs) // 20)
            tally = {}
            for x, y in [c[:2] for c in cs[::step]]:
                pt = Point(x, y)
                hit = 0
                for i in tree.query(pt):
                    if geoms[int(i)].contains(pt):
                        hit = pools[int(i)]['id']
                        break
                tally[hit] = tally.get(hit, 0) + 1
            k = max(tally, key=tally.get)
            if k:
                lanes[k] = lanes.get(k, 0) + 1
    stat = {'slug': slug, 'polygons': len(polys), 'main_polygons': len(comps[0]), 'pools': len(pools),
            'pool_acres': sorted((p['acres'] for p in pools), reverse=True)[:8],
            'lanes_off_main': {str(k): v for k, v in sorted(lanes.items())},
            'landings_off_main': [(l['name'], l['pool']) for l in landings if l['pool'] != 0]}
    return body, stat


def _one(job):
    slug, chartpack, check = job
    t = dt.datetime.now()
    try:
        body, stat = pools_for(slug, chartpack)
    except Exception as exc:                        # named, never swallowed
        return {'slug': slug, 'error': '%s: %s' % (type(exc).__name__, exc)}
    stat['seconds'] = round((dt.datetime.now() - t).total_seconds(), 1)
    if body is None:
        return stat
    out = os.path.join(chartpack, slug, 'pools.json')
    text = json.dumps(body, separators=(',', ':'))
    if check:
        try:
            with open(out, encoding='utf-8') as fh:
                same = fh.read() == text
        except OSError:
            same = False
        stat['stale'] = not same
    else:
        with open(out, 'w', encoding='utf-8') as fh:
            fh.write(text)
        stat['bytes'] = len(text)
    return stat


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    ap.add_argument('--chartpack', default=r'F:\TrollMapPipeline\chartpack')
    ap.add_argument('--registry', default=r'F:\TrollMapPipeline\registry')
    ap.add_argument('--lake', action='append', default=[])
    ap.add_argument('--all', action='store_true', help='every lake pack')
    ap.add_argument('--jobs', type=int, default=1,
                    help='lakes at once; memory is the limit (Murray is ~50,000 polygons)')
    ap.add_argument('--check', action='store_true', help='write nothing; exit 1 if any is stale')
    ap.add_argument('--report', help='write a JSON report here')
    a = ap.parse_args(argv)
    slugs = lake_slugs(a.registry, a.chartpack) if a.all else a.lake
    if not slugs:
        ap.error('name --lake or --all')
    jobs = [(s, a.chartpack, a.check) for s in slugs]
    stats = []
    if a.jobs > 1:
        with ProcessPoolExecutor(max_workers=a.jobs) as ex:
            for st in ex.map(_one, jobs):
                stats.append(st)
                print(json.dumps(st)[:400], flush=True)
    else:
        for j in jobs:
            st = _one(j)
            stats.append(st)
            print(json.dumps(st)[:400], flush=True)
    if a.report:
        with open(a.report, 'w', encoding='utf-8') as fh:
            json.dump({'built': dt.datetime.now().isoformat(timespec='seconds'), 'lakes': stats},
                      fh, indent=1)
    errors = [s for s in stats if s.get('error')]
    stale = [s['slug'] for s in stats if s.get('stale')]
    print('%d lakes, %d with a pool off the main one, %d errors%s' % (
        len(stats), sum(1 for s in stats if s.get('pools')), len(errors),
        (', %d stale: %s' % (len(stale), ', '.join(stale[:20]))) if a.check else ''))
    return 1 if (errors or stale) else 0


if __name__ == '__main__':
    sys.exit(main())
