#!/usr/bin/env python3
r"""trim_at_salt_line.py - cut a freshwater boundary where SC Code 50-5-80 says it ends.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\trim_at_salt_line.py --boundaries F:\TrollMapPipeline\lake_boundaries_3dhp `
       --slug waccamaw_river --slug sampit_river
    # reads back what it would change, changes nothing. Then:
    py .\scripts\trim_at_salt_line.py ... --go

WHY THIS EXISTS

A boundary cut from 3DHP by id is the whole polygon 3DHP holds, and near the coast that polygon
does not stop where the fishing law does. waccamaw_river came off `boundary_from_3dhp.py --id
OH5UM` at 6,334 acres with 231 of them seaward of the dividing line; sampit_river came off OHFIM
at 989 acres with 266 seaward -- 27% of it. Installing those would have put saltwater in the
river list, which is the exact thing the coastal work is trying to end.

    Ryan, 2026-08-16: "coastal water shouldn't have any freshwater in it at all period"

and the converse has to hold too or the seam is just wrong in the other direction.

THE STATUTE, NOT A GEOMETRIC GUESS

The rule is `classify_salt_fresh.classify`, imported rather than restated: NAME FIRST. If the
water's name is one of the thirteen exceptions in 50-5-80 -- Savannah, Edisto, New, Ashley,
Cooper, ICW, Wright, Wallace, Rantowles, Long Branch, Shem, Wando, Ashepoo -- that exception IS
the boundary and US-17 is ignored. The Cooper's line sits at Old Back River, nineteen kilometres
inland of the highway, so cutting the Cooper at US-17 would delete genuinely salt water.

Six of those creeks and the ICW are salt along their ENTIRE length. A water named one of them has
no freshwater part at all, so this refuses to write a boundary for it and says why: it wants to be
a coastal pointer, not a river. `mosquito_creek` is the live case -- 294 acres, every cell of it
seaward, shipped as a freshwater river today because the salt/fresh gate classifies RAMPS and that
creek has none. Nothing to classify came back as nothing salt.

SPLIT, NOT A GRID

A grid can say how much of a polygon is salt; it cannot hand back a ring. shapely.ops.split cuts
the polygon, and each resulting piece is then classified at its own representative point by
classify() -- so the keep/drop decision is the statute's, applied to real geometry, and the piece
count is reported rather than assumed. A line that does not cross the polygon yields one piece,
which is not a silent no-op here: it is printed as "the line does not cross this water".

AREA TRAVELS WITH THE POLYGON

`area_acres` in the properties is rewritten from the trimmed ring. It came off the untrimmed one,
and a stale number that looks like a measurement is worse than no number at all.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

SQM_PER_ACRE = 4046.8564224
# IUGG MEAN RADIUS, THE SAME ONE EVERY OTHER SCRIPT USES. This was the equatorial 6378137.0,
# which is 0.22% high on area -- enough that the acreage written into the properties here
# disagreed with the acreage install_registry_boundary.py computed from the very same ring
# (6,103.8 against 6,090.2 on waccamaw_river). Two earth radii in one pipeline is two numbers
# for one polygon, and the installer's own docstring is about exactly that.
EARTH_R_M = 6371008.8


def sphere_acres(geom):
    def ring(coords):
        pts = list(coords)
        if len(pts) < 4:
            return 0.0
        t = 0.0
        for k in range(len(pts) - 1):
            x1, y1 = math.radians(pts[k][0]), math.radians(pts[k][1])
            x2, y2 = math.radians(pts[k + 1][0]), math.radians(pts[k + 1][1])
            t += (x2 - x1) * (2 + math.sin(y1) + math.sin(y2))
        return abs(t * EARTH_R_M * EARTH_R_M / 2.0)
    total = 0.0
    for part in (list(geom.geoms) if hasattr(geom, 'geoms') else [geom]):
        if not hasattr(part, 'exterior'):
            continue
        total += ring(part.exterior.coords)
        for h in part.interiors:
            total -= ring(h.coords)
    return total / SQM_PER_ACRE


def cutters(line_path):
    """{normalised name: shapely line}, plus '' for US Highway 17.

    Keyed the same way classify_salt_fresh keys its index, so the name that selects the
    classifier also selects the knife. Two rules that have to agree cannot be typed twice.
    """
    from shapely.geometry import shape, MultiLineString
    from shapely.ops import linemerge, unary_union
    import classify_salt_fresh as CSF
    gj = json.load(open(line_path, encoding='utf-8'))
    by = {}
    for f in gj.get('features') or []:
        nm = (f.get('properties') or {}).get('NAME') or ''
        g = shape(f['geometry'])
        parts = list(g.geoms) if g.geom_type == 'MultiLineString' else [g]
        key = '' if nm == 'US Highway 17' else CSF._norm(nm)
        by.setdefault(key, []).extend(parts)
    out = {}
    for k, parts in by.items():
        m = linemerge(MultiLineString(parts)) if len(parts) > 1 else parts[0]
        out[k] = unary_union([m])
    return out


def trim(geom, name, knives, index):
    """(kept, dropped, note). kept is None when there is nothing to keep."""
    from shapely.ops import split, unary_union
    import classify_salt_fresh as CSF
    from classify_salt_fresh import classify

    key = CSF._norm(name) if name else ''
    if key in CSF.NAME_OVERRIDE and CSF.NAME_OVERRIDE[key] == 'salt':
        return None, geom, ('%s is saltwater along its entire length by 50-5-80 -- it wants to be '
                            'a coastal pointer, not a river' % name)
    knife = knives.get(key) or knives.get('')
    used = name if key in knives and key else 'US Highway 17'
    try:
        pieces = list(split(geom, knife).geoms)
    except Exception as exc:
        return geom, None, 'split failed (%s: %s) -- left alone' % (type(exc).__name__, exc)
    if len(pieces) == 1:
        # ONE PIECE IS NOT "DOES NOT APPLY". It means the water lies wholly on ONE side, and
        # which side is the entire answer. mosquito_creek is 294 acres sitting 15.7 km seaward
        # of US-17: the highway never crosses it, and reading that as "left alone" is how a
        # saltwater creek stays in the river list. Classify the piece and say which.
        c = geom.representative_point()
        if classify(c.x, c.y, index, waterbody=name)[0] == 'salt':
            return None, geom, ('wholly seaward of the %s line -- every acre of it is salt'
                                % used)
        return geom, None, ('wholly landward of the %s line -- nothing to trim' % used)
    keep, drop = [], []
    for p in pieces:
        c = p.representative_point()
        verdict = classify(c.x, c.y, index, waterbody=name)[0]
        (keep if verdict == 'fresh' else drop).append(p)
    if not keep:
        return None, unary_union(drop), 'every piece is seaward of the %s line' % used
    return (unary_union(keep), unary_union(drop) if drop else None,
            'cut at %s into %d piece(s), kept %d' % (used, len(pieces), len(keep)))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--boundaries', required=True, help='folder holding <slug>.geojson')
    ap.add_argument('--slug', action='append', default=[], required=True)
    ap.add_argument('--line', default=None,
                    help='Saltwater_Freshwater_Dividing_Line.geojson; '
                         'default <boundaries>/../Saltwater_Freshwater_Dividing_Line.geojson')
    ap.add_argument('--out', default=None, help='where trimmed files go; default in place')
    ap.add_argument('--go', action='store_true', help='actually write. Default is a dry run.')
    a = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, here)
    try:
        from shapely.geometry import shape, mapping
        from shapely.ops import unary_union
        import classify_salt_fresh as CSF
        from classify_salt_fresh import load_dividers, build_index
    except ImportError as exc:
        print('needs shapely and classify_salt_fresh.py beside this file: %s' % exc)
        return 2
    # classify() reads a module global that only main() ever set, so an importer got
    # 'NoneType' object is not subscriptable on the first call. Set it here too.
    CSF.SEAWARD = (math.cos(math.radians(-45.0)), math.sin(math.radians(-45.0)))

    line = a.line or os.path.join(os.path.dirname(os.path.abspath(a.boundaries)),
                                  'Saltwater_Freshwater_Dividing_Line.geojson')
    if not os.path.exists(line):
        print('no dividing line at %s -- pass --line' % line)
        return 2
    index = build_index(load_dividers(line))
    knives = cutters(line)
    print('%d divider feature(s): US-17 plus %d named exception(s)'
          % (len(knives), len(knives) - 1))

    out_dir = a.out or a.boundaries
    rc = 0
    for slug in a.slug:
        fp = os.path.join(a.boundaries, slug + '.geojson')
        if not os.path.exists(fp):
            print('%-20s no file at %s' % (slug, fp)); rc = 1; continue
        gj = json.load(open(fp, encoding='utf-8'))
        feats = gj['features'] if gj.get('type') == 'FeatureCollection' else [gj]
        props = dict(feats[0].get('properties') or {})
        name = props.get('name') or slug.replace('_', ' ').title()
        geom = unary_union([shape(f['geometry']).buffer(0) for f in feats])
        before = sphere_acres(geom)

        kept, dropped, note = trim(geom, name, knives, index)
        d_ac = sphere_acres(dropped) if dropped is not None else 0.0
        if kept is None:
            print('%-20s %8.0f ac  ->  NOTHING KEPT   %s' % (slug, before, note))
            rc = 1
            continue
        after = sphere_acres(kept)
        print('%-20s %8.0f ac  ->  %8.0f ac   dropped %8.2f ac   %s'
              % (slug, before, after, d_ac, note))
        # SPLITTING A 26,000-VERTEX RIVER WITH A 4,000-VERTEX HIGHWAY LEAVES CRUMBS. cooper_river
        # comes apart into five pieces of which three are sub-acre slivers along the cut, and
        # rewriting a boundary to shed those is a change with nothing behind it. Under an acre is
        # not a tuning constant here -- it is smaller than any water anyone would put a kayak on.
        if d_ac < 1.0:
            if d_ac > 0:
                print('                     %.2f ac of sliver at the cut, under an acre -- '
                      'left alone' % d_ac)
            continue

        props['area_acres'] = round(after, 1)
        props['source'] = '%s, trimmed at the SC 50-5-80 line by trim_at_salt_line.py' % (
            props.get('source') or 'unknown')
        doc = {'type': 'FeatureCollection',
               'features': [{'type': 'Feature', 'properties': props,
                             'geometry': mapping(kept)}]}
        dest = os.path.join(out_dir, slug + '.geojson')
        if not a.go:
            print('                     would write %s' % dest)
            continue
        os.makedirs(out_dir, exist_ok=True)
        json.dump(doc, open(dest, 'w', encoding='utf-8'), separators=(',', ':'))
        print('                     wrote %s' % dest)
    if not a.go:
        print('\nDRY RUN. Add --go to write.')
    return rc


if __name__ == '__main__':
    sys.exit(main())
