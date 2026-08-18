#!/usr/bin/env python3
r"""
audit_boundary_rings.py -- which registry boundaries are the wrong shape, and which way.

    py .\scripts\audit_boundary_rings.py
    py .\scripts\audit_boundary_rings.py --fix          # rewrite the nesting, .bak first
    py .\scripts\audit_boundary_rings.py --min-pct 5    # only disagreements over 5%

WHY THIS EXISTS

Two different faults produce a wrong boundary and NOTHING on the drive looked for either one.

    ISLANDS AS WATER      boundary_from_3dhp.py wrote every ring as its own outer ring, so a
                          hole became solid. Found 2026-08-17 on the Cooper River: 221 rings,
                          220 of them nested, 28,742 acres of "water" against 3DHP's 17,071.
                          The generator is fixed; every boundary it wrote BEFORE the fix still
                          carries the defect, and it is invisible on any water without islands
                          -- which is why it survived from Lake Robinson (08-11) until a tidal
                          river turned up.

    STOPS SHORT           the opposite. falls_lake traces 9,530 acres where NHD has 11,984;
                          prestwood_lake 193 against 454; rhodes_pond 91 against 274. Nobody
                          drew the whole water. These need re-tracing, not re-nesting.

Both are "this polygon is not that water", so they are one audit and not two.

HOW EACH IS DETECTED, AND WHY THE FIRST NEEDS NO REFERENCE DATA

A ring nested inside another ring of the SAME feature is a hole, whatever any external source
says. GeoJSON's own structure carries the answer: a Polygon's first ring is the outer boundary
and the rest are holes. So a file that writes N single-ring polygons where some contain others
is self-evidently wrong and can be repaired from itself. No NHD, no 3DHP, no network.

The second fault cannot be found that way -- a polygon that stops short is perfectly valid and
looks fine alone. That one is measured against registry/_nhd_bindings.json, which holds the NHD
acreage that match_waters_to_nhd.py measured per slug.

AREA IS SPHERICAL, NOT A FLAT DEGREE COUNT. A polygon 51 km tall spans enough latitude that a
single cos(lat) factor is off by percent, and percent is the thing being reported. The formula
below is the standard spherical-excess one and agrees with 3DHP on the Cooper to 0.2%.

--fix REWRITES NESTING ONLY. It never changes a coordinate, never adds or removes a ring, and
never touches a boundary that stops short -- re-tracing is a decision about what the water IS
and this tool does not have an opinion. Every file it rewrites gets a .bak beside it first.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys

R_EARTH = 6371008.8              # IUGG mean radius, metres
SQM_PER_ACRE = 4046.8564224


def find_repo_root(explicit=None):
    """The folder holding registry/. Tries an explicit path, then cwd, then this file's parents.
    A bare relative default resolves against cwd, so running from scripts/ instead of the repo
    root looks one folder too high -- the mistake build_water_chain.py's own test made."""
    if explicit:
        p = os.path.abspath(explicit)
        return os.path.dirname(os.path.dirname(p)) if p.endswith('.json') else p
    here = os.path.abspath(os.getcwd())
    mine = os.path.dirname(os.path.abspath(__file__))
    seen = set()
    cands = []
    for start in (here, mine):
        c = start
        while True:
            cands.append(c)
            nxt = os.path.dirname(c)
            if nxt == c:
                break
            c = nxt
    for c in cands:
        if c in seen:
            continue
        seen.add(c)
        if os.path.isdir(os.path.join(c, 'registry', 'boundaries')):
            return c
    return here


def ring_area_m2(ring):
    """Signed spherical area of a closed lon/lat ring, in square metres.

    Positive for counter-clockwise. The sign is what tells an outer ring from a hole in a
    well-formed file -- but this project's files are not reliably wound, so the caller uses
    CONTAINMENT to decide and only takes abs() of this.
    """
    if len(ring) < 4:
        return 0.0
    total = 0.0
    for i in range(len(ring) - 1):
        lon1, lat1 = ring[i][0], ring[i][1]
        lon2, lat2 = ring[i + 1][0], ring[i + 1][1]
        total += math.radians(lon2 - lon1) * (
            2 + math.sin(math.radians(lat1)) + math.sin(math.radians(lat2)))
    return total * R_EARTH * R_EARTH / 2.0


def bbox(ring):
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


def point_in_ring(pt, ring):
    """Ray casting. Pure Python on purpose -- this tool must run with nothing installed, and
    the rings it walks are already in memory."""
    x, y = pt
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y):
            xint = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < xint:
                inside = not inside
        j = i
    return inside


def rep_point(ring):
    """A point that is actually inside the ring, not its centroid -- a sinuous river's centroid
    lands on dry ground, which is how the Cooper's 3DHP centre ended up in a forest. Scans a
    horizontal line at the ring's mid-latitude and takes the midpoint of the first crossing
    pair, which is inside by construction."""
    w, s, e, n = bbox(ring)
    y = (s + n) / 2.0
    xs = []
    m = len(ring)
    j = m - 1
    for i in range(m):
        yi, yj = ring[i][1], ring[j][1]
        if (yi > y) != (yj > y):
            xi, xj = ring[i][0], ring[j][0]
            xs.append((xj - xi) * (y - yi) / (yj - yi) + xi)
        j = i
    xs.sort()
    if len(xs) >= 2:
        return ((xs[0] + xs[1]) / 2.0, y)
    return ((w + e) / 2.0, y)


def read_polygons(doc):
    """Every polygon in a FeatureCollection or bare geometry, as [[ring, ring, ...], ...]."""
    feats = doc['features'] if doc.get('type') == 'FeatureCollection' else [doc]
    out = []
    for f in feats:
        g = f.get('geometry') if 'geometry' in f else f
        if not g:
            continue
        t, c = g.get('type'), g.get('coordinates')
        if t == 'Polygon':
            out.append(c)
        elif t == 'MultiPolygon':
            out.extend(c)
        elif t == 'GeometryCollection':
            for sub in g.get('geometries') or []:
                out.extend(read_polygons({'type': 'Feature', 'geometry': sub}))
    return [[r for r in p if len(r) >= 4] for p in out if p]


def renest(polys):
    """Rebuild ring hierarchy from containment. Returns (new_polys, moved).

    ONLY rings that are alone in their own polygon can move. A polygon that already declares its
    holes is left exactly as it is -- this repairs a flattening, it does not re-derive a file
    that was written correctly.
    """
    singles = [i for i, p in enumerate(polys) if len(p) == 1]
    if len(singles) < 2:
        return polys, 0
    idx = sorted(singles, key=lambda i: -abs(ring_area_m2(polys[i][0])))
    boxes = {i: bbox(polys[i][0]) for i in idx}
    pts = {i: rep_point(polys[i][0]) for i in idx}
    parent = {}
    for pos, i in enumerate(idx):
        for j in idx[:pos]:                      # only something LARGER can contain it
            if j in parent:                      # a hole inside a hole is an island; leave it
                continue
            bw, bs, be, bn = boxes[j]
            px, py = pts[i]
            if bw <= px <= be and bs <= py <= bn and point_in_ring(pts[i], polys[j][0]):
                parent[i] = j
                break
    if not parent:
        return polys, 0
    out = []
    for i, p in enumerate(polys):
        if i in parent:
            continue
        rings = list(p)
        if len(p) == 1:
            rings += [polys[k][0] for k, v in parent.items() if v == i]
        out.append(rings)
    return out, len(parent)


def acres_of(polys):
    """Outer rings positive, every ring after the first in a polygon subtracted."""
    total = 0.0
    for p in polys:
        total += abs(ring_area_m2(p[0]))
        for hole in p[1:]:
            total -= abs(ring_area_m2(hole))
    return total / SQM_PER_ACRE


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', default=None, help='registry dir; default found from cwd')
    ap.add_argument('--boundaries', default=None, help='default <registry>/boundaries')
    ap.add_argument('--fix', action='store_true',
                    help='rewrite files whose rings are flattened (.bak first). Never re-traces.')
    ap.add_argument('--min-pct', type=float, default=2.0,
                    help='report an NHD disagreement only above this percent (default 2)')
    ap.add_argument('--only', nargs='*', help='slugs, for checking one water')
    a = ap.parse_args()

    root = find_repo_root(a.registry)
    reg = a.registry if (a.registry and os.path.isdir(a.registry)) \
        else os.path.join(root, 'registry')
    bdir = a.boundaries or os.path.join(reg, 'boundaries')
    if not os.path.isdir(bdir):
        print('no boundaries dir at %s' % bdir)
        return 2

    idx, nhd = {}, {}
    p = os.path.join(reg, 'lake_index.json')
    if os.path.exists(p):
        idx = json.loads(open(p, encoding='utf-8').read())
    p = os.path.join(reg, '_nhd_bindings.json')
    if os.path.exists(p):
        nhd = (json.loads(open(p, encoding='utf-8').read()) or {}).get('bindings') or {}
    print('boundaries %s' % bdir)
    print('index %d water(s); NHD bindings %d\n' % (len(idx), len(nhd)))

    names = sorted(f for f in os.listdir(bdir) if f.endswith('.geojson'))
    if a.only:
        want = set(a.only)
        names = [f for f in names if f[:-8] in want]

    flat, short, over, unread, fixed = [], [], [], [], 0
    for fn in names:
        slug = fn[:-8]
        fp = os.path.join(bdir, fn)
        try:
            doc = json.loads(open(fp, encoding='utf-8').read())
            polys = read_polygons(doc)
        except Exception as exc:
            unread.append((slug, '%s: %s' % (type(exc).__name__, exc)))
            continue
        if not polys:
            unread.append((slug, 'no usable ring'))
            continue

        as_written = acres_of(polys)
        renested, moved = renest(polys)
        corrected = acres_of(renested)
        if moved:
            flat.append((slug, len(polys), moved, as_written, corrected))
            if a.fix:
                shutil.copy2(fp, fp + '.bak')
                geom = ({'type': 'Polygon', 'coordinates': renested[0]} if len(renested) == 1
                        else {'type': 'MultiPolygon', 'coordinates': renested})
                feats = doc['features'] if doc.get('type') == 'FeatureCollection' else [doc]
                props = (feats[0].get('properties') or {}) if feats else {}
                open(fp, 'w', encoding='utf-8').write(json.dumps(
                    {'type': 'FeatureCollection',
                     'features': [{'type': 'Feature', 'properties': props, 'geometry': geom}]}))
                fixed += 1

        b = nhd.get(slug) or {}
        ref = b.get('nhd_acres')
        if ref:
            pct = 100.0 * (corrected - ref) / ref
            if abs(pct) >= a.min_pct:
                (short if pct < 0 else over).append((slug, corrected, ref, pct,
                                                     b.get('nhd_layer')))

    print('== rings flattened -- islands written as water (%d)' % len(flat))
    if flat:
        print('   %-28s %6s %6s %12s %12s %8s' % ('slug', 'parts', 'holes', 'as-written',
                                                  'corrected', 'change'))
        for slug, n, moved, aw, cor in sorted(flat, key=lambda r: -(r[3] - r[4])):
            print('   %-28s %6d %6d %12.1f %12.1f %7.1f%%'
                  % (slug, n, moved, aw, cor, 100.0 * (cor - aw) / max(aw, 1e-9)))
        print('\n   These are repairable FROM THE FILE -- a ring inside a ring is a hole.')
        print('   Re-run with --fix to rewrite the nesting (.bak kept). No coordinate moves.')
    else:
        print('   none -- every multi-part boundary declares its own holes')

    for label, rows, note in (
            ('boundary STOPS SHORT of the NHD polygon', short,
             'the trace is smaller than the water. Re-tracing is a decision, not a repair.'),
            ('boundary is LARGER than the NHD polygon', over,
             'either the trace overreaches, or NHD splits what the registry keeps whole.')):
        print('\n== %s, over %.0f%% (%d)' % (label, a.min_pct, len(rows)))
        if rows:
            print('   %-28s %12s %12s %8s  %s' % ('slug', 'boundary', 'NHD', 'diff', 'layer'))
            for slug, cor, ref, pct, layer in sorted(rows, key=lambda r: abs(r[3]),
                                                     reverse=True)[:40]:
                print('   %-28s %12.1f %12.1f %7.1f%%  %s' % (slug, cor, ref, pct, layer))
            if len(rows) > 40:
                print('   ... and %d more' % (len(rows) - 40))
            print('   %s' % note)

    if unread:
        print('\n== unreadable (%d)' % len(unread))
        for slug, why in unread[:20]:
            print('   %-28s %s' % (slug, why))

    print('\n%d boundary file(s) read; %d flattened; %d short; %d large'
          % (len(names) - len(unread), len(flat), len(short), len(over)))
    if a.fix:
        print('%d rewritten, each with a .bak beside it' % fixed)
        if fixed:
            print('re-run without --fix to confirm the flattened count is now zero,')
            print('then rebuild any affected chartpack -- the pack was cut against the old shape.')
    elif flat:
        print('nothing was written. Add --fix to repair the nesting.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
