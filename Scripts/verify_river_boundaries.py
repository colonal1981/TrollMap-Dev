#!/usr/bin/env python3
r"""verify_river_boundaries.py - check what make_river_boundaries.py actually cut, before installing it.

Personal use only, not for distribution or resale; not for navigation.

    py .\verify_river_boundaries.py --dir "F:\TrollMapPipeline\lake_boundaries"

WHY THIS EXISTS

A fast run is not a correct run. The river cutter has now been wrong twice in ways that looked
fine from the console:

  1. Unbounded contiguity growth walked through confluences, so two DIFFERENT named rivers came
     out as one identical geometry. The console printed two happy rows.
  2. Before that, the whole thing was quadratic and never finished at all -- which at least
     announced itself.

Failure (1) is the dangerous shape, because the output is well-formed GeoJSON of the right
size in the right place. Nothing downstream would have complained; the app would just have
shown the Altamaha when asked for the Ocmulgee. So the boundaries get checked against each
other, not merely inspected one at a time.

WHAT IT CHECKS

  duplicates    two rivers whose geometry is the same water. The signature of a confluence
                merge that survived.
  overlap       two rivers sharing area. Some is legitimate -- a tributary's ramp box reaches
                into the main stem -- so this reports a ratio and lets you judge, rather than
                pretending there is a threshold that means "wrong".
  containment   one river wholly inside another. Almost never right.
  degenerate    empty geometry, zero area, or a boundary whose pieces sit far apart. A river
                grown by contiguity at --join-tol 50 m should come out as one connected run;
                parts separated by kilometres mean a seed latched onto unrelated water.

                NOT a fill-ratio test. The obvious check -- "area is a tiny fraction of the
                bounding box" -- flags every river there is. A 137 km river 200 m wide fills
                about 0.2% of its box; that is what a river IS. The first version of this
                script used that test and would have reported all 220 as broken.
  bounds        coordinates that are not plausibly in SC/NC/GA/TN. Catches a lon/lat swap or a
                projection that did not round-trip.

Exit code is 1 if anything in the first four categories fires.
"""
import argparse, glob, json, math, os, sys
from collections import defaultdict

# The corner of the world TrollMap covers, generously padded. A coordinate outside this did not
# come from a SC/NC/GA/TN waterbody, whatever the file is called.
REGION = (-90.0, 29.0, -74.0, 38.0)   # west, south, east, north


def load(dir_path):
    out = []
    for fp in sorted(glob.glob(os.path.join(dir_path, '*_river.geojson'))):
        try:
            gj = json.load(open(fp, encoding='utf-8'))
        except Exception as exc:
            print('  !! %s: unreadable (%s)' % (os.path.basename(fp), exc))
            continue
        feats = gj.get('features') or []
        if not feats:
            out.append({'file': fp, 'name': os.path.basename(fp), 'props': {}, 'geom': None})
            continue
        f = feats[0]
        out.append({'file': fp,
                    'name': (f.get('properties') or {}).get('name') or os.path.basename(fp),
                    'props': f.get('properties') or {},
                    'raw': f.get('geometry')})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dir', required=True, help='folder holding *_river.geojson')
    ap.add_argument('--overlap-report', type=float, default=0.02,
                    help='report a pair sharing at least this fraction of the smaller river')
    ap.add_argument('--max-gap-km', type=float, default=5.0,
                    help='flag a boundary whose pieces are further apart than this')
    a = ap.parse_args()

    try:
        from shapely.geometry import shape, LineString
        from shapely.ops import nearest_points
        from shapely.strtree import STRtree
    except ImportError as exc:
        sys.exit('needs shapely: %s' % exc)

    rivers = load(a.dir)
    if not rivers:
        sys.exit('no *_river.geojson in %s' % a.dir)
    print('%d river boundaries in %s\n' % (len(rivers), a.dir))

    problems = defaultdict(list)

    # ── build geometries, catching the degenerate shapes on the way through ──
    good = []
    for r in rivers:
        if not r.get('raw'):
            problems['degenerate'].append('%s: no geometry' % r['name']); continue
        try:
            g = shape(r['raw'])
        except Exception as exc:
            problems['degenerate'].append('%s: bad geometry (%s)' % (r['name'], exc)); continue
        if g.is_empty or g.area <= 0:
            problems['degenerate'].append('%s: empty geometry' % r['name']); continue

        w, s, e, n = g.bounds
        if not (REGION[0] <= w and e <= REGION[2] and REGION[1] <= s and n <= REGION[3]):
            problems['bounds'].append('%s: bounds %.3f,%.3f .. %.3f,%.3f are outside SC/NC/GA/TN'
                                      % (r['name'], w, s, e, n))

        # Connectivity test: how far apart are this boundary's own pieces?
        #
        # unary_union leaves separate parts wherever polygons did not actually touch. A river
        # grown at --join-tol 50 m should therefore be one part, or a few that are metres
        # apart. Parts kilometres apart used to mean a ramp seeded something unrelated -- a
        # farm pond beside the launch, a different creek across the road.
        #
        # It no longer means only that. Since the cutter started assigning each polygon to the
        # name with the most landings on it, one continuous channel can carry two names in
        # sequence and each gets the stretch it owns: the Little Pee Dee comes out as two
        # pieces with 6.5 km between them, and what sits in that 6.5 km is the Lumber River,
        # which has seven landings on it against the Little Pee Dee's none. Two pieces of one
        # channel with a neighbour's reach between them is the system working, not failing.
        #
        # So the gap is measured the same way and then ASKED ABOUT: does another boundary in
        # this folder lie in it? If it does, the split is explained and gets reported for
        # reading, not counted as a failure. If nothing is there, the gap is empty land and the
        # old diagnosis stands.
        # SLIVERS ARE NOT PIECES. 3DHP leaves hairline scraps -- a lock chamber, a canal stub,
        # a sub-metre offcut of a bank -- and unary_union keeps each as its own part. The
        # Savannah came back "4 pieces, furthest 15.1 km away", which reads as a river torn in
        # half; it is one 0.01473 deg2 river and three parts of area 0.00000. Measuring the gap
        # to those made the one river Ryan actually fishes look broken while the real geometry
        # was whole. A piece too small to launch a kayak into is not a second river.
        all_parts = list(getattr(g, 'geoms', [g]))
        parts = [p for p in all_parts if p.area >= 0.01 * g.area] or all_parts[:1]
        slivers = len(all_parts) - len(parts)
        r['slivers'] = slivers
        gap_km = 0.0
        if len(parts) > 1:
            mid_lat = (s + n) / 2.0
            # Degrees -> km, longitude shrunk by latitude. Good enough to separate "touching"
            # from "in the next county", which is the only distinction being made.
            def km_between(p, q):
                d = p.distance(q)                       # degrees, min distance between parts
                return d * 111.32 * math.cos(math.radians(mid_lat)) if d else 0.0
            # Each part's distance to its NEAREST neighbour. The largest of those is the gap
            # that would have to be bridged to make the whole thing connected.
            widest = None
            for idx, p in enumerate(parts):
                for k, q in enumerate(parts):
                    if k == idx:
                        continue
                    km = km_between(p, q)
                    if km > gap_km:
                        gap_km, widest = km, (p, q)
            if gap_km > a.max_gap_km and widest is not None:
                r['gap_pair'] = widest

        r['geom'] = g
        r['parts'] = len(parts)
        r['gap_km'] = gap_km
        good.append(r)

    # ── pairwise, via an index so this stays fast with hundreds of rivers ──
    geoms = [r['geom'] for r in good]
    tree = STRtree(geoms)

    # ── is a multi-part boundary split by a neighbour, or by nothing at all? ──
    for i, r in enumerate(good):
        pair = r.pop('gap_pair', None)
        if not pair:
            continue
        try:
            bridge = LineString(nearest_points(pair[0], pair[1]))
        except Exception:
            bridge = None
        filler = None
        if bridge is not None:
            for j in tree.query(bridge):
                j = int(j)
                if j != i and good[j]['geom'].intersects(bridge):
                    filler = good[j]['name']
                    break
        if filler:
            problems['split_by_neighbour'].append(
                '%-28s %d pieces, %.1f km apart -- %s owns the water in between'
                % (r['name'][:28], r['parts'], r['gap_km'], filler))
        else:
            problems['degenerate'].append(
                '%s: %d pieces, furthest sits %.1f km from any other and nothing else is in '
                'the gap' % (r['name'], r['parts'], r['gap_km']))

    seen_pairs = set()
    for i, r in enumerate(good):
        for j in tree.query(r['geom']):
            j = int(j)
            if j == i:
                continue
            key = (min(i, j), max(i, j))
            if key in seen_pairs:
                continue
            seen_pairs.add(key)

            o = good[j]
            try:
                inter = r['geom'].intersection(o['geom'])
            except Exception:
                continue
            if inter.is_empty or inter.area <= 0:
                continue

            smaller = min(r['geom'].area, o['geom'].area)
            frac = inter.area / max(smaller, 1e-12)

            # Same water under two names -- the confluence-merge signature.
            if frac > 0.98:
                problems['duplicates'].append(
                    '%s and %s are the same water (%.1f%% identical)' % (r['name'], o['name'], frac * 100))
            elif frac > 0.90:
                problems['containment'].append(
                    '%s is almost entirely inside %s (%.1f%%)'
                    % ((r['name'], o['name'], frac * 100) if r['geom'].area < o['geom'].area
                       else (o['name'], r['name'], frac * 100)))
            elif frac >= a.overlap_report:
                problems['overlap'].append(
                    '%-28s / %-28s share %5.1f%% of the smaller'
                    % (r['name'][:28], o['name'][:28], frac * 100))

    # ── report ──
    order = [('duplicates',  'SAME WATER UNDER TWO NAMES -- a confluence merge survived'),
             ('containment', 'ONE RIVER INSIDE ANOTHER'),
             ('degenerate',  'DEGENERATE GEOMETRY'),
             ('bounds',      'COORDINATES OUTSIDE THE REGION'),
             ('split_by_neighbour',
              'split by a neighbour (one channel, two names -- read it, do not fix it)'),
             ('overlap',     'shared area (some is legitimate -- a tributary reaching the main stem)')]
    hard = 0
    for key, title in order:
        rows = problems.get(key) or []
        if not rows:
            continue
        if key not in ('overlap', 'split_by_neighbour'):
            hard += len(rows)
        print('%s  (%d)' % (title, len(rows)))
        for line in rows[:40]:
            print('    ' + line)
        if len(rows) > 40:
            print('    ... and %d more' % (len(rows) - 40))
        print()

    areas = sorted(((r['geom'].area, r['name'], r['props'].get('polygons_3dhp'),
                     r['parts'], r['gap_km'], r.get('slivers', 0)) for r in good), reverse=True)
    print('%-34s %10s %9s %6s %9s %8s'
          % ('largest 10 by area', 'deg2', 'polygons', 'parts', 'max gap', 'slivers'))
    for ar, nm, np_, pc, gk, sv in areas[:10]:
        print('    %-34s %8.4f %8s %6d %7.1f km %6d' % (nm[:34], ar, np_, pc, gk, sv))
    tot_sliver = sum(t[5] for t in areas)
    if tot_sliver:
        print('    (%d sub-1%% fragments across %d boundaries ignored when measuring gaps)'
              % (tot_sliver, sum(1 for t in areas if t[5])))
    print()

    if not hard:
        print('OK -- no duplicate, contained, degenerate or out-of-region boundaries.')
    else:
        print('%d problem(s) that should be resolved before installing.' % hard)
    return 1 if hard else 0


if __name__ == '__main__':
    sys.exit(main())
