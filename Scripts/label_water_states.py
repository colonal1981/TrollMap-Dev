#!/usr/bin/env python3
"""label_water_states.py - which states each water actually touches, from its own shape.

Personal use only, not for distribution or resale; not for navigation.

PowerShell:

    py .\\label_water_states.py `
       --registry "F:\\TrollMapPipeline\\registry" `
       --shp      "F:\\TrollMapPipeline\\PADUS4_1Geodatabase\\tl_2022_us_state.shp"

WHY THIS EXISTS

The registry files a water under ONE state, chosen from where its centroid falls, and writes that
into the display name. For a lake that is nearly always right and somebody has curated the ten
that are not -- Hartwell reads `SC/GA`, Wylie reads `NC/SC`. For a river it is nearly always
wrong: **zero of the 58 rivers we offer carry a two-state mark**, and rivers are the waters that
cross lines for a living.

Two things went wrong because of it, both found by Ryan reading cards:

  * South Carolina's striped bass rule printed on `Lumber River (Robeson Co, NC)` and read as
    foreign. It is not foreign. Better than half of the water we ship under that slug lies south
    of the state line, where SC's book is the law. He asked for two rule entries and a `NC/SC`
    label, then said: "i am sure that is not the only river".
  * `Savannah River (Aiken Co, GA)` -- Aiken County is in South Carolina. The row pairs a Georgia
    state code with a South Carolina county, on a river that IS the GA/SC line.

A LABEL CURATED BY HAND KEEPS MISSING THE NEXT ONE. A shape cannot. Every water already has its
boundary on disk and the Census state outlines are already on the drive -- the same file
make_region_mask.py reads -- so this asks the geometry instead of the name.

WHAT IT WRITES

`registry/water_states.json`: slug -> the states its boundary has vertices in, most vertices
first, with the share in each. build_regulations_table.py reads it in place of parsing states out
of a display name, so `states_of()` stops being a string test.

A water whose shape lands in no state polygon is reported, not guessed at: that means the boundary
is offshore, or missing, or wrong, and each of those wants a person rather than a default.
"""
import argparse, json, os, sys, importlib.util
from collections import Counter

# THE SHAPEFILE READER IS ALREADY WRITTEN, in make_region_mask.py, in the standard library --
# no geopandas, no fiona, neither of which is installed. Importing it rather than copying it
# keeps one reader of that file; a second copy is how the two drift.
def _mask_module(script_dir):
    p = os.path.join(script_dir, 'make_region_mask.py')
    if not os.path.exists(p):
        sys.exit('make_region_mask.py must sit beside this script -- it holds the shapefile reader')
    spec = importlib.util.spec_from_file_location('_mrm', p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def state_polygons(mrm, shp, want):
    """{state: [shapely polygon, ...]} for the states asked for."""
    from shapely.geometry import Polygon
    dbf = shp[:-4] + '.dbf'
    for p in (shp, dbf):
        if not os.path.exists(p):
            sys.exit('missing %s' % p)
    recs = mrm.read_dbf(dbf)
    key = 'STUSPS' if recs and 'STUSPS' in recs[0] else 'STATE'
    idx = {i: r[key] for i, r in enumerate(recs) if r.get(key) in want}
    missing = sorted(set(want) - set(idx.values()))
    if missing:
        sys.exit('%s not in %s' % (', '.join(missing), os.path.basename(dbf)))
    raw = mrm.read_shp_polygons(shp, set(idx))
    out = {}
    for i, st in idx.items():
        for flat in raw.get(i) or []:
            pts = [(flat[k], flat[k + 1]) for k in range(0, len(flat), 2)]
            if len(pts) >= 4:
                out.setdefault(st, []).append(Polygon(pts).buffer(0))
    return out


def water_points(path, step):
    """Boundary vertices, decimated. A ring's vertices are where the water is."""
    try:
        d = json.load(open(path, encoding='utf-8'))
    except Exception:
        return []
    pts = []

    def walk(c):
        if not c:
            return
        if isinstance(c[0], (int, float)):
            return
        if isinstance(c[0][0], (int, float)):
            pts.extend(c[::step])
            return
        for x in c:
            walk(x)
    for f in d.get('features') or []:
        g = f.get('geometry') or {}
        if g.get('coordinates'):
            walk(g['coordinates'])
    return pts


def water_shape(path):
    """The water's own outline as one shapely geometry, or None."""
    from shapely.geometry import shape
    from shapely.ops import unary_union
    try:
        d = json.load(open(path, encoding='utf-8'))
    except Exception:
        return None
    gs = []
    for f in d.get('features') or []:
        g = f.get('geometry')
        if g and g.get('coordinates'):
            try:
                s = shape(g)
                gs.append(s if s.is_valid else s.buffer(0))
            except Exception:
                continue
    return unary_union(gs) if gs else None


def write_state_parts(path, measured, idx, polys, bdir, reach_m):
    """`registry/water_state_parts.json`: for each water in more than one state, which state
    each piece of the ground within reach of it is in.

    WHAT IT IS FOR: WHICH STATE'S BOOK APPLIES AT THE LAUNCH. A water in two states is under two
    books, and the one that governs a morning is the one for the bank he puts in from. The app
    had one state per water -- the row's -- so a launch in Cherokee County, SC on the Broad was
    checked against North Carolina's statewide limits. The launch's coordinate is in the app;
    what it lacked was the line. This is the line, and only where a water crosses one.

    WHERE A LAUNCH CAN BE, NOT THE WHOLE STATE. Cut to each water's bounding box the file was
    1,466 KB for 27 waters, nearly all of it coastline and Blue Ridge state line nowhere near a
    water -- the French Broad's box alone held 10,449 vertices. A launch is a point beside the
    water, and `reach_m` is how far beside: the distance build_dnr_ramps_by_lake.py binds a ramp
    to a water by (its --tol-m), because "is this launch on this water" is the question both
    answer. The envelope is the water grown by twice that and then simplified by that, which by
    Douglas-Peucker's own bound still holds every point within `reach_m` of the water; its
    outline only decides where the file stops answering. THE STATE LINE INSIDE IT IS NOT
    SIMPLIFIED -- the Savannah IS the GA/SC line down its whole length, so any tolerance there
    is a distance the line may move toward a launch.

    Coordinates are written to six decimals, the precision RFC 7946 (GeoJSON, section 11.2)
    describes as about 10 cm, finer than either outline.

    COASTAL ZONES ARE LEFT OUT. A `coast_` zone carries its own state in coastal-zones.js and the
    coastal regulations route by that, not by the registry row.

    A launch outside every part is the app's to report, not this file's to guess; see
    regulationStateFor() in plan-preflight.js.
    """
    import math
    from shapely import affinity
    from shapely.geometry import mapping
    from shapely.ops import unary_union

    whole = {st: unary_union(ps) for st, ps in polys.items()}
    # Metres to degrees of latitude: the conversion build_dnr_ramps_by_lake.py's within() uses
    # for the same distance.
    deg = reach_m / 111320.0

    def rounded(g):
        def walk(c):
            if isinstance(c[0], (int, float)):
                return [round(c[0], 6), round(c[1], 6)]
            return [walk(x) for x in c]
        m = mapping(g)
        return {'type': m['type'], 'coordinates': walk(m['coordinates'])}

    waters, skipped = {}, []
    for slug, rec in sorted(measured.items()):
        sts = rec.get('states') or []
        if len(sts) < 2 or slug.startswith('coast_'):
            continue
        w = water_shape(os.path.join(bdir, slug + '.geojson'))
        if w is None or w.is_empty:
            skipped.append({'slug': slug, 'why': 'no boundary on disk to grow an envelope from'})
            continue
        # Grown in a frame where a degree of longitude is as long as a degree of latitude at the
        # water's middle, so the envelope is `reach_m` wide east-west as well as north-south. The
        # error is the change in cos(latitude) across the water: about 1% over a degree of
        # latitude at 35 N, 3 m of 250.
        y0, y1 = w.bounds[1], w.bounds[3]
        k = math.cos(math.radians((y0 + y1) / 2.0))
        local = affinity.scale(w, xfact=k, yfact=1.0, origin=(0, 0))
        env = local.buffer(2 * deg).simplify(deg, preserve_topology=True)
        env = affinity.scale(env, xfact=1.0 / k, yfact=1.0, origin=(0, 0))
        parts = {}
        for st in sts:
            g = whole.get(st)
            if g is None:
                continue
            cut = g.intersection(env)
            if not cut.is_empty and cut.geom_type in ('Polygon', 'MultiPolygon'):
                parts[st] = rounded(cut)
        if len(parts) >= 2:
            waters[slug] = {'states': sts, 'reach_m': reach_m, 'parts': parts}
        else:
            skipped.append({'slug': slug, 'why': 'fewer than two states within reach of the water'})
    doc = {'_note': 'Personal use only, not for distribution or resale; not for navigation. '
                    'Census state outlines, cut to the ground within reach of each water that '
                    'crosses a state line, so the app can say which state a launch is in. '
                    'Written by label_water_states.py; nothing hand edited.',
           'source': 'tl_2022_us_state.shp', 'waters': waters, 'skipped': skipped}
    json.dump(doc, open(path, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
    print('state lines: %d water(s) cross one, %d KB -> %s'
          % (len(waters), os.path.getsize(path) // 1024, path))
    for s in skipped:
        print('  -- %-28s %s' % (s['slug'], s['why']))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--shp', required=True, help='tl_2022_us_state.shp')
    ap.add_argument('--states', nargs='*',
                    default=['SC', 'NC', 'GA', 'TN', 'VA', 'AL', 'KY', 'MS', 'FL'],
                    help='the four we offer plus every state they border, so a water that '
                         'reaches out of the region is reported rather than silently clipped')
    ap.add_argument('--step', type=int, default=5, help='sample every Nth boundary vertex')
    ap.add_argument('--min-share', type=float, default=0.01,
                    help='a state must hold this share of the vertices to be named. Default 1%% '
                         '-- enough to keep a real crossing and drop a boundary that wobbles a '
                         'few metres over the line, which is a survey artefact and not a state.')
    ap.add_argument('--out', default=None)
    ap.add_argument('--launch-reach-m', type=float, default=250.0,
                    help='how far from a water a launch may be and still be that water\'s. The '
                         'same distance build_dnr_ramps_by_lake.py binds a ramp to a water by '
                         '(its --tol-m default); test/the-broad-is-in-two-states pins them '
                         'equal. Sets the envelope water_state_parts.json answers inside.')
    a = ap.parse_args()

    mrm = _mask_module(os.path.dirname(os.path.abspath(__file__)))
    from shapely.geometry import Point
    from shapely.prepared import prep
    from shapely.strtree import STRtree

    polys = state_polygons(mrm, a.shp, set(a.states))
    print('state outlines: %s' % ', '.join('%s(%d)' % (k, len(v)) for k, v in sorted(polys.items())))
    flat, owner = [], []
    for st, ps in polys.items():
        for p in ps:
            flat.append(p)
            owner.append(st)
    tree = STRtree(flat)
    ready = [prep(p) for p in flat]

    idx = json.load(open(os.path.join(a.registry, 'lake_index.json'), encoding='utf-8'))
    bdir = os.path.join(a.registry, 'boundaries')
    out, nowhere, changed = {}, [], []
    for n, (slug, row) in enumerate(sorted(idx.items()), 1):
        pts = water_points(os.path.join(bdir, slug + '.geojson'), a.step)
        if not pts:
            nowhere.append({'slug': slug, 'why': 'no boundary on disk'})
            continue
        tally = Counter()
        for lon, lat in pts:
            pt = Point(lon, lat)
            for j in tree.query(pt):
                if ready[j].contains(pt):
                    tally[owner[j]] += 1
                    break
        total = sum(tally.values())
        if not total:
            nowhere.append({'slug': slug, 'display_name': row.get('display_name'),
                            'why': 'no vertex falls inside any state outline -- the boundary is '
                                   'offshore, or wrong'})
            continue
        states = [{'state': s, 'share': round(c / total, 4)}
                  for s, c in tally.most_common() if c / total >= a.min_share]
        out[slug] = {'states': [s['state'] for s in states], 'detail': states,
                     'vertices_tested': total, 'feature_type': row.get('feature_type')}
        filed = (row.get('state') or '').upper()
        if filed and filed not in out[slug]['states']:
            changed.append({'slug': slug, 'display_name': row.get('display_name'),
                            'filed_as': filed, 'geometry_says': out[slug]['states'],
                            'why': 'the registry files this water in a state its own shape does '
                                   'not touch'})
        elif len(out[slug]['states']) > 1:
            changed.append({'slug': slug, 'display_name': row.get('display_name'),
                            'filed_as': filed, 'geometry_says': out[slug]['states'],
                            'why': 'this water is in more than one state'})
        if n % 50 == 0:
            print('  %d/%d' % (n, len(idx)), flush=True)

    doc = {'_note': 'Personal use only, not for distribution or resale; not for navigation. '
                    'Which states each water TOUCHES, measured from its own boundary against the '
                    'Census state outlines. Written by label_water_states.py; nothing hand '
                    'edited. `states` is ordered by how much of the water sits in each.',
           'source': os.path.basename(a.shp), 'sampled_every': a.step,
           'min_share': a.min_share, 'waters': out,
           'multi_state_or_misfiled': changed, 'no_state_found': nowhere}
    path = a.out or os.path.join(a.registry, 'water_states.json')
    json.dump(doc, open(path, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    parts_path = os.path.join(os.path.dirname(path), 'water_state_parts.json')
    write_state_parts(parts_path, out, idx, polys, bdir, a.launch_reach_m)
    multi = [c for c in changed if len(c['geometry_says']) > 1]
    wrong = [c for c in changed if c['filed_as'] not in c['geometry_says']]
    print('\n%d waters measured; %d touch more than one state, %d are filed in a state their '
          'shape does not touch, %d have no boundary or no hit'
          % (len(out), len(multi), len(wrong), len(nowhere)))
    for c in wrong:
        print('  !! %-30s filed %s, geometry says %s'
              % (c['slug'], c['filed_as'], '/'.join(c['geometry_says'])))
    print('-> %s' % path)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
