#!/usr/bin/env python3
r"""build_river_lines.py -- every river's own outline, thinned to what a zoomed-out map can show,
so selecting a river shows the river.

    cd F:\TrollMapPipeline
    py .\TrollMap-Dev\Scripts\build_river_lines.py --root .

Reads registry\boundaries\<slug>.geojson for every lake_index.json row whose feature_type is
`river` and writes registry\river_lines.json. No network. upload_garmin_to_r2.py publishes it as
_registry/river_lines.json; js/data/river-lines.js reads it and js/modules/river-line-layer.js
draws it.

WHY. Ryan, 2026-09-24: *"the zoom doesn't work on all of them sometimes you have to actually pan
the map to find the river"*. Measured the same day over the 57 rivers:

    30 of 57 land at zoom 8-10 when picked, and a river's own linework -- contours, depth labels
    -- does not draw below zoom 11 (contour-data.js CONTOUR_MIN_ZOOM). At zoom 9 a screen pixel
    is about 250 m of ground and most of these rivers are 30-100 m wide. The frame held the river
    and nothing on screen said where in it the river was.

THE FRAME WAS NOT THE PROBLEM, AND THE FIRST CUT OF THIS FILE ASSUMED IT WAS. It thinned the
pack's CENTRELINE and meant to frame the map on that instead of the registry box, because
broad_river's box runs 63 km west and 52 km north of its centreline. Checked against the launches
before anything shipped: 22 of 57 rivers have a registry launch outside the centreline's box --
broad_river 18 of its 23, up to 58.6 km from the line (Gray's Bridge, Beech Springs Landing);
first_broad_river all 7. The centreline is ONE mainstem through the water; the outline is the
whole water, and the launches are on the whole water. Framing the centreline would have taken the
landings off the screen to centre a line. So the frame stays the registry box, and what this adds
is the thing that was missing: the water, drawn where it can be seen.

WHY NOT THE OUTLINE FILES THEMSELVES. registry\boundaries\ holds 67 MB of outline for these 57
rivers -- broad_river_2 alone is 1.7 MB -- because it is cut for chart work. Drawn below zoom 11
nearly all of that detail falls inside one pixel.

HOW THIN, AND WHERE THE NUMBER COMES FROM. The outline is drawn only below CONTOUR_MIN_ZOOM,
which this script READS out of js/modules/contour-data.js rather than restating. The largest zoom
it is ever drawn at is one below that, so the Douglas-Peucker tolerance is the ground size of one
screen pixel at that zoom, at the river's own latitude: 2 pi R cos(lat) / (256 * 2^z). A vertex
it removes moves the drawn line less than one pixel at the closest the line is ever seen.

OUTER RINGS ONLY. A hole is an island. Below zoom 11 the stroke is wider than most of them, and
leaving them out is the difference between drawing the river and drawing its islands.

Personal use only, not for distribution or resale; not for navigation.
"""
import argparse, io, json, math, os, re, sys, time

EARTH_R = 6378137.0          # WGS84 semi-major axis, the radius Web Mercator tiles are cut on
TILE_PX = 256                # Leaflet's tile size; map-init.js does not change it


def contour_min_zoom(repo):
    """CONTOUR_MIN_ZOOM as contour-data.js declares it. Read, never restated."""
    p = os.path.join(repo, 'js', 'modules', 'contour-data.js')
    src = io.open(p, encoding='utf-8').read()
    m = re.search(r'^\s*(?:export\s+)?const\s+CONTOUR_MIN_ZOOM\s*=\s*(\d+)\s*;', src, re.M)
    if not m:
        sys.exit('!! could not read CONTOUR_MIN_ZOOM out of %s -- the outline is drawn below it, '
                 'so the tolerance cannot be derived without it' % p)
    return int(m.group(1))


def pixel_m(lat, zoom):
    """Ground metres per screen pixel at this latitude and zoom (Web Mercator)."""
    return 2 * math.pi * EARTH_R * math.cos(math.radians(lat)) / (TILE_PX * 2 ** zoom)


def simplify(pts, tol_m, lat0):
    """Douglas-Peucker on [lon, lat] points, measured in metres on a plane at lat0.

    Iterative, because an outline ring runs to tens of thousands of vertices and Python's
    recursion limit is not a property of rivers. Endpoints are always kept, so a closed ring
    stays closed."""
    if len(pts) < 3:
        return list(pts)
    kx = math.radians(1) * EARTH_R * math.cos(math.radians(lat0))
    ky = math.radians(1) * EARTH_R
    xy = [(p[0] * kx, p[1] * ky) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = xy[a], xy[b]
        dx, dy = bx - ax, by - ay
        seg = dx * dx + dy * dy
        far, at = -1.0, None
        for i in range(a + 1, b):
            px, py = xy[i]
            if seg == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > far:
                far, at = d, i
        if at is not None and far > tol_m:
            keep[at] = True
            stack.append((a, at))
            stack.append((at, b))
    return [p for p, k in zip(pts, keep) if k]


def outer_rings(fc):
    """The outer ring of every polygon in a boundary file, as lists of [lon, lat]."""
    feats = (fc or {}).get('features') if (fc or {}).get('type') == 'FeatureCollection' else [fc]
    out = []
    for f in feats or []:
        g = (f or {}).get('geometry') or f or {}
        t, c = g.get('type'), g.get('coordinates') or []
        if t == 'Polygon' and c:
            out.append([x[:2] for x in c[0]])
        elif t == 'MultiPolygon':
            out.extend([[x[:2] for x in poly[0]] for poly in c if poly])
    return [r for r in out if len(r) >= 2]


# 5 decimal places moves a point at most half of 1e-5 degree -- 0.56 m of latitude -- and the run
# prints that against the smallest tolerance rather than assuming it is small.
DECIMALS = 5


def build(idx, boundaries_dir, floor):
    """{slug: record} for every river row with an outline, and the rows that had none."""
    zoom = floor - 1
    waters, no_outline = {}, []
    for slug in sorted(s for s, r in idx.items() if (r or {}).get('feature_type') == 'river'):
        p = os.path.join(boundaries_dir, slug + '.geojson')
        rings = outer_rings(json.load(io.open(p, encoding='utf-8'))) if os.path.isfile(p) else []
        if not rings:
            no_outline.append(slug)
            continue
        allp = [q for r in rings for q in r]
        w, e = min(q[0] for q in allp), max(q[0] for q in allp)
        s, n = min(q[1] for q in allp), max(q[1] for q in allp)
        lat0 = (s + n) / 2
        tol = pixel_m(lat0, zoom)
        thin = [simplify(r, tol, lat0) for r in rings]
        rnd = lambda v: round(v, DECIMALS)
        waters[slug] = {
            'wsen': [rnd(w), rnd(s), rnd(e), rnd(n)],
            'tolerance_m': round(tol, 1),
            'points_in': len(allp),
            'points_out': sum(len(t) for t in thin),
            'lines': [[[rnd(q[0]), rnd(q[1])] for q in t] for t in thin],
        }
    return waters, no_outline


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default='.', help='the folder holding registry\\')
    ap.add_argument('--repo', default='TrollMap-Dev', help='the app tree, relative to --root')
    ap.add_argument('--out', default=os.path.join('registry', 'river_lines.json'))
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    R = lambda *p: os.path.join(a.root, *p)

    idx = json.load(io.open(R('registry', 'lake_index.json'), encoding='utf-8'))
    floor = contour_min_zoom(R(a.repo))
    waters, no_outline = build(idx, R('registry', 'boundaries'), floor)
    tot_in = sum(v['points_in'] for v in waters.values())
    tot_out = sum(v['points_out'] for v in waters.values())

    worst_round_m = 0.5 * 10 ** -DECIMALS * math.radians(1) * EARTH_R
    doc = {
        '_note': 'Personal use only, not for distribution or resale; not for navigation. Each '
                 'river\'s registry outline, outer rings only, thinned for the MAP to draw below '
                 'the zoom its own linework starts at. Not a chart and not a route. Built by '
                 'Scripts/build_river_lines.py from registry/boundaries/<slug>.geojson.',
        'built': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'drawn_below_zoom': floor,
        'tolerance_rule': 'one screen pixel of ground at zoom %d (CONTOUR_MIN_ZOOM %d - 1, read from '
                          'js/modules/contour-data.js), at each river\'s mean latitude'
                          % (floor - 1, floor),
        'rounding_m_max': round(worst_round_m, 2),
        'waters': waters,
    }
    body = json.dumps(doc, separators=(',', ':'), ensure_ascii=False)
    print('zoom:     drawn below %d, so thinned to one pixel at zoom %d' % (floor, floor - 1))
    print('rivers:   %d in lake_index.json -> %d outlines'
          % (len(waters) + len(no_outline), len(waters)))
    if no_outline:
        print('          %d with no outline file, skipped: %s'
              % (len(no_outline), ', '.join(no_outline)))
    print('points:   %s in, %s out (%.2f%%)' % (f'{tot_in:,}', f'{tot_out:,}',
                                                100.0 * tot_out / max(tot_in, 1)))
    tols = sorted(v['tolerance_m'] for v in waters.values())
    if tols:
        print('tolerance: %.0f-%.0f m; rounding moves a point at most %.2f m (%.1f%% of the smallest)'
              % (tols[0], tols[-1], worst_round_m, 100 * worst_round_m / tols[0]))
    print('size:     %.0f KB' % (len(body.encode('utf-8')) / 1024))
    if a.dry_run:
        print('dry run -- nothing written')
        return 0
    out = R(a.out)
    tmp = out + '.tmp'
    with io.open(tmp, 'w', encoding='utf-8') as f:
        f.write(body)
    os.replace(tmp, out)
    print('wrote %s' % out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
