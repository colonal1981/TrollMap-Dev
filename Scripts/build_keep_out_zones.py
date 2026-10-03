#!/usr/bin/env python3
"""build_keep_out_zones.py - the water behind a dam's buoys, and behind a line the chart names keep-out.

Personal use only, not for distribution or resale; not for navigation.

    py .\\build_keep_out_zones.py --packs "F:\\TrollMapPipeline\\chartpack" --dry-run
    py .\\build_keep_out_zones.py --packs "F:\\TrollMapPipeline\\chartpack" --only lake_moultrie

Writes `<slug>/keep_out.geojson`: one Polygon per zone (a LineString where a single buoy and the
shore are all there is). `fit_trolling_runs.KeepOut` cuts every lane where it enters one, the way
`ChartedShore` cuts at the Pinopolis wall. Run it after `refile_navaids.py` and before the fitter.

WHY

Ryan, 2026-10-03, after the continuous-troll drawing ran a lane along the Pinopolis buoys: *"It's
fine if the line is near the buoys I just don't want it inside of them"*, and then his rule: *"If a
buoy is within a certain distance of a dam it is to be treated it as something to avoid and not
enter the area between the buoy and the dam"*. On the measurement below he said *"Yes build that"*.

THE TWO WAYS A BUOY MARKS A ZONE

1. **Its name says keep out** -- `restricted_area` after `refile_navaids.py`: "No Boats", "No Boat
   Buoy", "Keep Out", "Entry Prohibited", "Swimming Area". Wherever it is. These are the chart's own
   words, and they need no distance: Wateree's dam line, Murray's spillway line and Monticello's
   are all named.
2. **It is at a dam** -- any charted buoy except a fish-attractor buoy (that one is a target) within
   `DAM_REACH_M` of an NID dam bound to this water (`registry/_dam_bindings.json`, refused
   bindings left out). This is Ryan's rule, for the lines the chart does not name: Pinopolis's six
   are three "No Wake" and three plain "Spar/Spindle" buoys.

DAM_REACH_M IS MEASURED, NOT CHOSEN. It is where the NAMED keep-out lines sit at the main dams on
the card (`_scratch/lanes_1003/dam_buoys_1003.py`, every charted buoy against the dams bound to its
water). At 12 of the 18 main dams that carry a named line, all of it lies within 500 m of the NID
point: Wateree 85-320 m, Saluda spillway 162-427, Cherokee 87-231, Falls Lake 68-439, Jordan
231-266, Jack Turner 149-205, Rocky Creek-Cedar Creek 243-269, Oxford 100-180, Wallace 144-226,
Sinclair 128-332, Tillery 398-499, Hicks Crossroad dike 378-497. The six that reach farther are
long dams whose NID point is mid-structure (Fairfield, Cowans Ford, Douglas, Tellico, Norris,
Catawba) -- and their lines are named, so rule 1 takes them at any distance; the reach only decides
unnamed buoys. At Pinopolis it takes the six buoys (78-237 m) and leaves Short Stay's no-wake buoys
(973 m and beyond) alone, which is the case it was asked for.

THE ZONE. The buoys that mark it are grouped: two belong together when they are within the same
reach of each other, and a dam belongs to the group its buoys are in. The zone is the convex hull
of the group's buoys, each buoy's nearest point on the charted shore (`garmin_shoreline.geojson`,
when that is within the reach), and the dam's NID point with its own nearest shore point -- cut to
the charted water (`depth_areas.geojson`). So it is the water between the buoys and the dam or the
bank they guard, and nothing out on the lake side of them: *"near is fine"*.

Not a navigation product. A buoy moved since the chart was surveyed is where the chart says.
"""
import argparse, collections, json, math, os, sys, time

try:
    from shapely.geometry import shape, mapping, Point, MultiPoint, LineString, Polygon, MultiPolygon
    from shapely.ops import unary_union, nearest_points
    from shapely.strtree import STRtree
    from shapely.validation import make_valid
except Exception:                                        # pragma: no cover
    sys.exit('build_keep_out_zones.py needs shapely (py -m pip install shapely)')

DAM_REACH_M = 500.0
# Every charted buoy class but the attractor's. `restricted_area` is also rule 1's class.
BUOY_TYPES = {'nav_buoy', 'slow_no_wake', 'danger_buoy', 'caution_buoy', 'restricted_area'}
NAMED_KEEP_OUT = {'restricted_area'}
M_PER_DEG_LAT = 110540.0


class Frame:
    """A local metre frame around one pack."""
    def __init__(self, lat0):
        self.kx = 111320.0 * math.cos(math.radians(lat0))

    def xy(self, lon, lat):
        return (lon * self.kx, lat * M_PER_DEG_LAT)

    def ll(self, x, y):
        return (x / self.kx, y / M_PER_DEG_LAT)

    def geom_ll(self, g):
        from shapely.ops import transform
        return transform(lambda x, y, z=None: (x / self.kx, y / M_PER_DEG_LAT), g)

    def geom_xy(self, g):
        from shapely.ops import transform
        return transform(lambda x, y, z=None: (x * self.kx, y * M_PER_DEG_LAT), g)


def dams_by_slug(registry):
    path = os.path.join(registry, '_dam_bindings.json')
    out = collections.defaultdict(list)
    if not os.path.isfile(path):
        return out
    for b in json.load(open(path, 'r', encoding='utf-8')).get('bindings') or []:
        if 'REFUSED' in str(b.get('verdict')) or b.get('lat') is None:
            continue
        out[b['slug']].append(b)
    return out


def load(pack, name):
    p = os.path.join(pack, name)
    if not os.path.isfile(p):
        return []
    with open(p, 'r', encoding='utf-8') as fh:
        return json.load(fh).get('features') or []


def groups_of(buoys, dams, reach):
    """[(buoy indexes, dam indexes)]: buoys that mark a zone, linked when within `reach` of each
    other; a dam joins the group of every buoy within `reach` of it."""
    n = len(buoys)
    marks = set(i for i, b in enumerate(buoys) if b['type'] in NAMED_KEEP_OUT)
    near_dam = collections.defaultdict(set)
    for j, d in enumerate(dams):
        for i, b in enumerate(buoys):
            if math.dist(b['xy'], d['xy']) <= reach:
                near_dam[i].add(j)
                marks.add(i)
    marks = sorted(marks)
    parent = {i: i for i in marks}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for a_ in range(len(marks)):
        for b_ in range(a_ + 1, len(marks)):
            i, k = marks[a_], marks[b_]
            if math.dist(buoys[i]['xy'], buoys[k]['xy']) <= reach:
                parent[find(i)] = find(k)
    comp = collections.defaultdict(list)
    for i in marks:
        comp[find(i)].append(i)
    out = []
    for members in comp.values():
        ds = sorted(set(j for i in members for j in near_dam.get(i, ())))
        out.append((sorted(members), ds))
    return out


def build(pack, slug, dams_all, reach=DAM_REACH_M):
    pois = load(pack, 'pois.geojson')
    raw = [f for f in pois if (f.get('properties') or {}).get('poi_type') in BUOY_TYPES
           and (f.get('geometry') or {}).get('type') == 'Point']
    dams = dams_all.get(slug, [])
    if not raw:
        return [], {'buoys': 0, 'dams': len(dams)}
    lat0 = sum(f['geometry']['coordinates'][1] for f in raw) / len(raw)
    F = Frame(lat0)
    buoys = [{'xy': F.xy(*f['geometry']['coordinates'][:2]), 'type': f['properties']['poi_type'],
              'name': f['properties'].get('class') or f['properties'].get('name') or ''} for f in raw]
    dxy = [{'xy': F.xy(d['lon'], d['lat']), 'dam': (d.get('dam') or '').strip(), 'nid_id': d.get('nid_id')}
           for d in dams]
    groups = groups_of(buoys, dxy, reach)
    if not groups:
        return [], {'buoys': len(buoys), 'dams': len(dams)}

    shore_lines = []
    for f in load(pack, 'garmin_shoreline.geojson'):
        g = f.get('geometry') or {}
        parts = ([g.get('coordinates')] if g.get('type') == 'LineString'
                 else g.get('coordinates') if g.get('type') == 'MultiLineString' else [])
        for c in parts or ():
            if c and len(c) >= 2:
                shore_lines.append(LineString([F.xy(*p[:2]) for p in c]))
    stree = STRtree(shore_lines) if shore_lines else None
    water = [make_valid(F.geom_xy(shape(f['geometry']))) for f in load(pack, 'depth_areas.geojson')
             if (f.get('geometry') or {}).get('type') in ('Polygon', 'MultiPolygon')]
    wtree = STRtree(water) if water else None

    def foot(xy):
        if stree is None:
            return None
        p = Point(xy)
        k = stree.nearest(p)
        q = nearest_points(p, shore_lines[k])[1]
        return (q.x, q.y) if p.distance(q) <= reach else None

    feats = []
    for members, ds in groups:
        pts = []
        for i in members:
            pts.append(buoys[i]['xy'])
            f_ = foot(buoys[i]['xy'])
            if f_: pts.append(f_)
        for j in ds:
            pts.append(dxy[j]['xy'])
            f_ = foot(dxy[j]['xy'])
            if f_: pts.append(f_)
        hull = MultiPoint(pts).convex_hull
        if hull.geom_type == 'Point':
            continue                                    # a lone buoy, nothing to keep out of
        if hull.geom_type == 'Polygon' and wtree is not None:
            near = [water[k] for k in wtree.query(hull)]
            zone = hull.intersection(unary_union(near)) if near else hull
            zone = make_valid(zone)
            polys = [g for g in getattr(zone, 'geoms', [zone]) if g.geom_type == 'Polygon' and g.area > 1.0]
            if not polys:
                continue
            geom = polys[0] if len(polys) == 1 else MultiPolygon(polys)
        else:
            geom = hull                                 # a buoy and the shore: a line not to cross
        names = collections.Counter(buoys[i]['name'] for i in members)
        props = {
            'kind': 'dam' if ds else 'keep_out',
            'dam': '; '.join(dxy[j]['dam'] for j in ds) or None,
            'nid_id': '; '.join(str(dxy[j]['nid_id']) for j in ds) or None,
            'buoys': len(members),
            'named_keep_out': sum(1 for i in members if buoys[i]['type'] in NAMED_KEEP_OUT),
            'names': dict(names.most_common()),
            'reach_m': reach,
            'area_m2': round(geom.area) if geom.geom_type != 'LineString' else 0,
            'source': 'build_keep_out_zones.py: buoys from pois.geojson, dams from NID via _dam_bindings.json',
        }
        feats.append({'type': 'Feature', 'properties': props, 'geometry': mapping(F.geom_ll(geom))})
    return feats, {'buoys': len(buoys), 'dams': len(dams), 'zones': len(feats),
                   'dam_zones': sum(1 for f in feats if f['properties']['kind'] == 'dam')}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--packs', required=True)
    ap.add_argument('--registry', default=None, help='default: <packs>/../registry')
    ap.add_argument('--only', default=None, help='one slug, or several joined by commas')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args(argv)
    registry = a.registry or os.path.join(os.path.dirname(os.path.abspath(a.packs)), 'registry')
    dams_all = dams_by_slug(registry)
    slugs = (a.only.split(',') if a.only else
             sorted(d for d in os.listdir(a.packs) if os.path.isfile(os.path.join(a.packs, d, 'pois.geojson'))))
    t0 = time.time()
    with_zones, n_zones = [], 0
    for slug in slugs:
        pack = os.path.join(a.packs, slug)
        if not os.path.isdir(pack):
            continue
        feats, st = build(pack, slug, dams_all)
        path = os.path.join(pack, 'keep_out.geojson')
        if feats:
            with_zones.append(slug)
            n_zones += len(feats)
            print('  %-40s %d zone(s): %s' % (slug, len(feats), '; '.join(
                '%s %s, %d buoys, %.1f ha' % (f['properties']['kind'], (f['properties']['dam'] or '')[:26],
                                              f['properties']['buoys'], f['properties']['area_m2'] / 1e4)
                for f in feats[:4])))
        if a.dry_run or (not feats and not os.path.isfile(path)):
            continue
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as fh:
            json.dump({'type': 'FeatureCollection', 'features': feats}, fh, ensure_ascii=False)
        os.replace(tmp, path)
    print('%d packs with a zone, %d zones, reach %.0f m, %.0fs%s' % (
        len(with_zones), n_zones, DAM_REACH_M, time.time() - t0, ' (dry run, nothing written)' if a.dry_run else ''))
    if with_zones:
        print('with zones: ' + ','.join(with_zones))
    return 0


if __name__ == '__main__':
    sys.exit(main())
