#!/usr/bin/env python3
"""refile_channel_markers.py - a numbered mark on the water is a channel marker, not a highway sign.

Personal use only, not for distribution or resale; not for navigation.

    py .\\refile_channel_markers.py --packs "F:\\TrollMapPipeline\\chartpack" --dry-run
    py .\\refile_channel_markers.py --packs "F:\\TrollMapPipeline\\chartpack" --only lake_moultrie

Rewrites `<slug>/pois.geojson` in place, moving the original to
`<packs>/../_to_delete/pre_channel_markers/<slug>/` first (never over an earlier copy).

WHY

Ryan, 2026-10-03, on Lake Moultrie: *"these are not land POI at all... they are channel markers they
alternate red and green and mark the channel and the app only shows them if i turn on garmin land
POI"*. His example was "2" at 33.24911, -79.99603, filed as a Highway marker.

`rgn4_pois.poi_type()` files every label that is a bare number as `road_shield`, and `road_shield`
is one of its OFF_WATER classes, so all of them were hidden with the land POIs. Its comment says
the rule was written for mode 5/1, where 97, 521 and 601 are US and SC routes; the code applies it
to every mode. Across the chart packs that is 1,834 numbered marks. Moultrie's 25 run from "2" at
Pinopolis Dam up the lake to "32", and every one of them sits inside the pack's own charted water.

THE TEST IS THE CHART'S OWN WATER. A numbered mark inside the pack's depth areas or waterbody is on
the water and is refiled; one outside them is left as it was, because the same label on land really
is a road. Nothing here is a distance or a threshold. The extractor is not changed: it runs per
tile, without the water, and the pack is the first place both are in one folder.

RED OR GREEN COMES FROM THE NUMBER. 33 CFR 62.43(a), the U.S. Aids to Navigation System: "red aids
bearing even numbers and green aids bearing odd numbers". Ryan's own account of Moultrie's is that
they alternate. The side is written as `side`, and the source of it as `side_from`, so a mark whose
colour was never read off the chart says so.
"""
import argparse, json, os, sys, time

try:
    from shapely.geometry import shape, Point
    from shapely.strtree import STRtree
    from shapely.validation import make_valid
except Exception:                                        # pragma: no cover
    sys.exit('refile_channel_markers.py needs shapely')

SIDE_RULE = '33 CFR 62.43(a): red aids bear even numbers, green aids odd numbers'


def number_of(name):
    """The integer a label is, or None. Garmin writes these with quotes: '"23"'."""
    s = (name or '').strip().strip('"').strip()
    return int(s) if s.isdigit() else None


def water_of(pack):
    """The pack's charted water: depth areas and waterbody polygons, as one STRtree."""
    polys = []
    for name in ('depth_areas.geojson', 'waterbody.geojson'):
        p = os.path.join(pack, name)
        if not os.path.isfile(p):
            continue
        with open(p, 'r', encoding='utf-8') as fh:
            for f in json.load(fh).get('features') or []:
                try:
                    g = shape(f['geometry'])
                    if not g.is_valid:
                        g = make_valid(g)
                    if not g.is_empty:
                        polys.append(g)
                except Exception:
                    continue
    return polys, (STRtree(polys) if polys else None)


def refile(features, polys, tree):
    """Refile in place. Returns (refiled, left_on_land)."""
    moved = kept = 0
    for f in features:
        pr = f.get('properties') or {}
        if pr.get('poi_type') != 'road_shield':
            continue
        n = number_of(pr.get('name'))
        g = f.get('geometry') or {}
        if n is None or g.get('type') != 'Point' or tree is None:
            kept += 1
            continue
        pt = Point(g['coordinates'][:2])
        if not any(polys[i].covers(pt) for i in tree.query(pt)):
            kept += 1
            continue
        pr['poi_type'] = 'channel_marker'
        pr['on_water'] = True
        pr['marker_number'] = n
        pr['side'] = 'red' if n % 2 == 0 else 'green'
        pr['side_from'] = SIDE_RULE
        pr['refiled_from'] = 'road_shield'
        moved += 1
    return moved, kept


def backup(packs, slug, path):
    bak = os.path.join(os.path.dirname(os.path.abspath(packs)), '_to_delete', 'pre_channel_markers', slug)
    os.makedirs(bak, exist_ok=True)
    dest = os.path.join(bak, 'pois.geojson')
    n = 2
    while os.path.exists(dest):
        dest = os.path.join(bak, 'pois.geojson.%d' % n)
        n += 1
    os.replace(path, dest)
    return dest


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--packs', required=True)
    ap.add_argument('--only', default=None)
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    slugs = [a.only] if a.only else sorted(d for d in os.listdir(a.packs)
                                           if os.path.isfile(os.path.join(a.packs, d, 'pois.geojson')))
    t0 = time.time()
    changed, tot_m, tot_k = [], 0, 0
    for slug in slugs:
        pack = os.path.join(a.packs, slug)
        path = os.path.join(pack, 'pois.geojson')
        if not os.path.isfile(path):
            continue
        with open(path, 'r', encoding='utf-8') as fh:
            gj = json.load(fh)
        feats = gj.get('features') or []
        if not any((f.get('properties') or {}).get('poi_type') == 'road_shield' for f in feats):
            continue
        polys, tree = water_of(pack)
        moved, kept = refile(feats, polys, tree)
        tot_m += moved; tot_k += kept
        if moved:
            changed.append(slug)
            print('  %-40s %4d refiled as channel markers, %4d left on land' % (slug, moved, kept))
            if not a.dry_run:
                backup(a.packs, slug, path)
                tmp = path + '.tmp'
                with open(tmp, 'w', encoding='utf-8') as fh:
                    fh.write(json.dumps(gj, ensure_ascii=False))
                os.replace(tmp, path)
    print('%d packs changed, %d marks refiled, %d left as road signs, %.0fs%s'
          % (len(changed), tot_m, tot_k, time.time() - t0, ' (dry run, nothing written)' if a.dry_run else ''))
    if changed and not a.dry_run:
        print('changed: ' + ','.join(changed))


if __name__ == '__main__':
    main()
