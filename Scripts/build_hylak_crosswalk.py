#!/usr/bin/env python3
r"""build_hylak_crosswalk.py -- our slugs to HydroLAKES ids, by geometry and nothing else.

    py .\scripts\build_hylak_crosswalk.py --registry "F:\TrollMapPipeline\registry" ^
        --shp "F:\TrollMapPipeline\HydroLAKES_polys_v10_shp\HydroLAKES_polys_v10.shp"
    py .\scripts\build_hylak_crosswalk.py --registry "..." --shp "..." --go

WHY THIS EXISTS. The Lake Trophic State-US dataset (EDI package edi.1395.1, 55,662 lakes x 37
years, 1984-2020) is keyed by `Hylak_id` and carries no coordinate and no name. Its own metadata
says so: *"Preserved from HydroLAKES input data to enable future merge with HydroLAKES
attributes."* So the 243 MB of predictions on the drive join to nothing until this exists.

The crosswalk is the durable thing. HydroLAKES itself is 820 MB and is needed exactly once.

POLYGONS, NOT POUR POINTS, AND THE REASON IS A CHAIN.

HydroLAKES also ships an 79 MB pour-point layer, and a pour point is the lake's OUTLET -- for a
reservoir, the dam. On a chain that puts the upstream lake's point at the head of the downstream
one: Wylie, Fishing Creek, Great Falls and Wateree run down the Catawba; Monticello sits above
Parr on the Broad. A pour point can fall inside the NEXT lake's boundary and bind silently to the
wrong water, which is how Goat Rock Lake once reached rock_eagle_lake 200 km away.

THE TEST IS THAT THE OVERLAP IS THE MAJORITY OF BOTH SHAPES.

Not a tuned threshold -- a statement that the two polygons describe the same lake. A HydroLAKES
polygon covering most of ours but only a sliver of itself is a bigger water we sit inside (an arm
taken for the reservoir); ours covering most of theirs and little of ours is the reverse. Either
way it is not the same lake and it is refused rather than ranked. Where more than one candidate
passes, all of them are reported and none is chosen.

AND THE AREA IS CARRIED, NOT TRUSTED. HydroLAKES publishes `Lake_area` in square kilometres and
our index carries `area_acres` from the charted boundary. The geometry decides the binding; the
two areas are written side by side so a disagreement is visible to a person rather than averaged
away. They will not match exactly -- ours is the charted pool and theirs is a satellite-era
delineation -- and a large disagreement is a reason to look, not a reason to drop.

Personal use only, not for distribution or resale; not for navigation.
Contains data from HydroLAKES (Messager et al. 2016), CC-BY 4.0.
"""
from __future__ import annotations
import argparse
import json
import os
import sys

OUT_NAME = 'hylak_crosswalk.json'
MAJORITY = 0.5          # "most of both shapes" -- see the docstring; not a tuning knob.
                        # Compared with > and not >=: an exact half is not a majority, and a
                        # boundary that splits evenly between two HydroLAKES polygons is the
                        # ambiguous case, not the bound one. The test caught this.


def read_boundaries(reg):
    """{slug: shapely geometry} from registry/boundaries/<slug>.geojson."""
    from shapely.geometry import shape
    bdir = os.path.join(reg, 'boundaries')
    if not os.path.isdir(bdir):
        raise SystemExit('no boundaries folder at %s' % bdir)
    out = {}
    for fn in sorted(os.listdir(bdir)):
        if not fn.endswith('.geojson'):
            continue
        try:
            g = json.load(open(os.path.join(bdir, fn), encoding='utf-8'))
            gm = shape(g['features'][0]['geometry'] if g.get('type') == 'FeatureCollection'
                       else (g.get('geometry') or g))
        except Exception:
            continue
        if not gm.is_valid:
            gm = gm.buffer(0)
        if gm.is_empty:
            continue
        out[fn[:-len('.geojson')]] = gm
    if not out:
        raise SystemExit('no boundary polygons read')
    return out


def hydrolakes(shp_path, bbox):
    """Stream HydroLAKES polygons that touch our bounding box. Yields (attrs, geometry).

    The file is global and 1.4 million lakes; reading it whole is pointless when everything we
    carry sits in one corner of North America. shapefile records are read one at a time and the
    bounding box is tested before the geometry is built.
    """
    try:
        import shapefile                     # pyshp
    except ImportError:
        raise SystemExit('pyshp is required: py -m pip install pyshp')
    from shapely.geometry import shape

    # LATIN-1, BECAUSE THE NAME COLUMN IS NOT UTF-8 AND WE DO NOT NEED IT TO BE.
    # pyshp defaults to strict UTF-8 and HydroLAKES stops it dead on the first record carrying a
    # transliterated Cyrillic name -- `Pal\x92yeozero` -- before the reader ever reaches North
    # America. latin-1 maps every byte and never raises. The name is CARRIED, NOT TRUSTED: the
    # binding below is geometric, so a foreign lake's name rendering oddly costs nothing.
    sf = shapefile.Reader(shp_path, encoding='latin-1')
    want = ['Hylak_id', 'Lake_name', 'Lake_area']
    have = [f[0] for f in sf.fields[1:]]
    keep = [f for f in want if f in have]

    # ASK THE READER TO DO THE FILTERING. pyshp 3 takes a bounding box and a field list, so the
    # 1.4 million polygons outside our corner of the world are skipped without their geometry or
    # their twenty-odd attributes ever being built. Older pyshp does not, and the loop below
    # falls back to testing each record's own bbox -- same answer, slower.
    try:
        it = sf.iterShapeRecords(fields=keep, bbox=bbox)
        prefiltered = True
    except TypeError:
        it = sf.iterShapeRecords()
        keep, prefiltered = have, False

    w, s, e, n = bbox
    for sr in it:
        if not prefiltered:
            bb = getattr(sr.shape, 'bbox', None)
            if not bb or bb[2] < w or bb[0] > e or bb[3] < s or bb[1] > n:
                continue
        gm = shape(sr.shape.__geo_interface__)
        if not gm.is_valid:
            gm = gm.buffer(0)
        if gm.is_empty:
            continue
        yield dict(zip(keep, list(sr.record))), gm


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', default=os.environ.get('TROLLMAP_REGISTRY',
                                                         r'F:\TrollMapPipeline\registry'))
    ap.add_argument('--shp', required=True, help='HydroLAKES_polys_v10.shp')
    ap.add_argument('--go', action='store_true', help='write the crosswalk')
    a = ap.parse_args(argv)

    if not os.path.exists(a.shp):
        raise SystemExit('not found: %s' % a.shp)
    reg = a.registry
    idx_fp = os.path.join(reg, 'lake_index.json')
    IDX = {k: v for k, v in json.load(open(idx_fp, encoding='utf-8')).items()
           if isinstance(v, dict)} if os.path.exists(idx_fp) else {}

    ours = read_boundaries(reg)
    print('%d boundary polygon(s) read' % len(ours))

    xs = [g.bounds for g in ours.values()]
    bbox = (min(b[0] for b in xs), min(b[1] for b in xs),
            max(b[2] for b in xs), max(b[3] for b in xs))
    print('our corner of the world: W%.3f S%.3f E%.3f N%.3f' % bbox)

    from shapely.strtree import STRtree
    slugs = sorted(ours)
    geoms = [ours[s] for s in slugs]
    tree = STRtree(geoms)

    hits, seen = {}, 0
    for attrs, gm in hydrolakes(a.shp, bbox):
        seen += 1
        for i in tree.query(gm):
            idx = int(i)
            mine = geoms[idx]
            inter = gm.intersection(mine).area
            if inter <= 0:
                continue
            # THE MAJORITY OF BOTH SHAPES, OR IT IS NOT THE SAME LAKE.
            of_ours = inter / mine.area if mine.area else 0.0
            of_theirs = inter / gm.area if gm.area else 0.0
            if of_ours <= MAJORITY or of_theirs <= MAJORITY:
                continue
            hits.setdefault(slugs[idx], []).append(
                {'hylak_id': int(attrs.get('Hylak_id') or 0),
                 'hydrolakes_name': (attrs.get('Lake_name') or '').strip() or None,
                 'hydrolakes_area_km2': attrs.get('Lake_area'),
                 'overlap_of_ours': round(of_ours, 4),
                 'overlap_of_theirs': round(of_theirs, 4)})
    print('%d HydroLAKES polygon(s) inside that box' % seen)

    bound, ambiguous = {}, {}
    for slug, cands in sorted(hits.items()):
        if len(cands) > 1:
            ambiguous[slug] = cands
            continue
        c = dict(cands[0])
        row = IDX.get(slug) or {}
        c['slug'] = slug
        c['display_name'] = row.get('display_name')
        c['our_acres'] = row.get('area_acres')
        if c['our_acres'] and c['hydrolakes_area_km2']:
            c['area_ratio'] = round(float(c['hydrolakes_area_km2']) * 247.105
                                    / float(c['our_acres']), 3)
        bound[slug] = c

    unbound = sorted(set(ours) - set(hits))
    print()
    print('bound %d, ambiguous %d, no HydroLAKES polygon covering them %d'
          % (len(bound), len(ambiguous), len(unbound)))
    odd = sorted((v for v in bound.values() if v.get('area_ratio')
                  and not 0.5 <= v['area_ratio'] <= 2.0),
                 key=lambda v: -abs((v.get('area_ratio') or 1) - 1))
    if odd:
        print()
        print('THE GEOMETRY BOUND THESE AND THE TWO AREAS DISAGREE -- worth a look, not a drop:')
        for v in odd[:20]:
            print('   %-40s ours %8s ac  HydroLAKES %8.1f ac  ratio %.2f'
                  % ((v.get('display_name') or v['slug'])[:40], v.get('our_acres'),
                     float(v['hydrolakes_area_km2']) * 247.105, v['area_ratio']))
    if ambiguous:
        print()
        print('MORE THAN ONE HYDROLAKES POLYGON IS MOSTLY THIS WATER -- none chosen:')
        for slug, cands in list(ambiguous.items())[:20]:
            print('   %-40s %s' % (slug[:40], ', '.join(str(c['hylak_id']) for c in cands)))

    if not a.go:
        print()
        print('dry run. Re-run with --go to write %s' % os.path.join(reg, OUT_NAME))
        return 0

    doc = {'_note': 'Our slugs to HydroLAKES ids, bound by polygon overlap being the majority of '
                    'BOTH shapes. Built so that Hylak_id-keyed datasets -- the Lake Trophic '
                    'State-US predictions, EDI edi.1395.1 -- can reach a water. The areas are '
                    'carried side by side and NOT reconciled: ours is the charted pool, theirs a '
                    'satellite-era delineation, and a disagreement is a reason to look. '
                    'Personal use only, not for distribution or resale; not for navigation.',
           'source': 'HydroLAKES v1.0 polygons (Messager et al. 2016), CC-BY 4.0',
           'rule': 'intersection is more than %g of our polygon AND more than %g of theirs'
                   % (MAJORITY, MAJORITY),
           'generated': __import__('datetime').date.today().isoformat(),
           'bound_count': len(bound),
           'ambiguous': ambiguous,
           'unbound': unbound,
           'waters': bound}
    fp = os.path.join(reg, OUT_NAME)
    with open(fp, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write('\n')
    print('-> %s   (%d water(s))' % (fp, len(bound)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
