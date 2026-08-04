#!/usr/bin/env python3
r"""make_coastal_boundaries.py - give the 21 coastal zones a boundary so they can be built.

Personal use only, not for distribution or resale; not for navigation.

    py .\make_coastal_boundaries.py `
       --catalog "F:\TrollMapPipeline\TrollMap-Dev-main\Scripts\coastal_catalog.py" `
       --out     "F:\TrollMapPipeline\lake_boundaries"
    # then install them into the registry:
    py .\install_registry_boundary.py --registry ... --boundaries ... --labels ... `
       --lake coast_santee_delta_sc=SC

WHY THIS EXISTS

`coastal-zones.js` defines 21 coastal zones and eleven modules render them, so they are
selectable in TrollMap today. `key_map.json` has ZERO coastal slugs. Nothing has ever been
built for them, because `build_all_chartpacks.py` only builds rows in `registry/lakes.json`
and the zones are not in it.

Meanwhile the Garmin data for those exact waters is already decoded and sitting on disk --
23 of the 31 tiles that cover the coast, holding 48,696 docks, 83,134 POIs, 181,196 shoreline
features, 331 MB of contours and 607 MB of depth areas. It is a registry gap, not a data gap,
and the only thing missing is a polygon to clip against.

WHY A RECTANGLE IS THE RIGHT BOUNDARY HERE, AND ONLY HERE

For a lake, a bbox would be wrong: Lake Marion's box is two-thirds dry land and its contours
have to be separated from Lake Moultrie's next door. A coastal ZONE is not a lake. It is a
region, and the honest answer to "which water belongs to Winyah Bay / Georgetown" is "the
water in that region".

Clipping to a rectangle is also harmless in a way it would not be on land, because every
layer being clipped is water-only to begin with -- Garmin draws no contours, depth areas or
docks across a marsh island. The rectangle does not invent features, it just declines to
carve the estuary into arbitrary pieces.

The one real consequence: `charted` (filled depth-area cells / core cells) becomes
meaningless for a zone, because the denominator counts dry land inside the box. Do not read
it as coverage for these rows. Under the 2026-08-03 ship rule that does not matter -- any
contours ship.

OVERLAP

Zone boxes are allowed to overlap, and some do. A dock in the overlap lands in both packs.
That is better than dropping it, and the zones are presented as regions to choose between,
not as a partition. Overlaps are reported so they are a known quantity rather than a surprise.
"""
import argparse, importlib.util, json, os, sys


def load_catalog(path):
    spec = importlib.util.spec_from_file_location('coastal_catalog', path)
    if not spec or not spec.loader:
        sys.exit('cannot import %s' % path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for name in ('COASTAL_CATALOG', 'COASTAL_ZONES', 'CATALOG'):
        cat = getattr(mod, name, None)
        if isinstance(cat, dict) and cat:
            return cat
    sys.exit('no COASTAL_CATALOG / COASTAL_ZONES dict in %s' % path)


def ring(s, n, w, e):
    """Closed CCW ring for the bbox. GeoJSON wants lon,lat."""
    return [[w, s], [e, s], [e, n], [w, n], [w, s]]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--catalog', required=True, help='Scripts/coastal_catalog.py')
    ap.add_argument('--out', required=True, help='lake_boundaries folder')
    ap.add_argument('--only', help='comma list of zone slugs, for a single-zone test')
    ap.add_argument('--go', action='store_true', help='write. Default is a dry run.')
    a = ap.parse_args()

    cat = load_catalog(a.catalog)
    want = {x.strip() for x in a.only.split(',')} if a.only else None
    rows = []

    for slug, z in cat.items():
        if want and slug not in want:
            continue
        s, n, w, e = z['bbox']
        if not (s < n and w < e):
            print('  %-32s BAD BBOX %r -- skipping' % (slug, z['bbox']))
            continue
        # A degree of latitude is ~111 km; longitude shrinks with the cosine. Report km so
        # the size of what is being claimed is legible.
        import math
        kh = (n - s) * 111.32
        kw = (e - w) * 111.32 * math.cos(math.radians((n + s) / 2))
        rows.append((slug, z, (s, n, w, e), kw * kh))
        print('  %-32s %6.1f x %5.1f km  %8.0f km2  %s'
              % (slug, kw, kh, kw * kh, z.get('name', '')[:34]))

    if not rows:
        sys.exit('\nno zones matched')

    # overlap report -- a known quantity beats a surprise
    print('\noverlapping zone pairs (a feature there lands in both packs):')
    hits = 0
    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            s1, n1, w1, e1 = rows[i][2]
            s2, n2, w2, e2 = rows[j][2]
            if not (e1 < w2 or w1 > e2 or n1 < s2 or s1 > n2):
                hits += 1
                print('  %s  <->  %s' % (rows[i][0], rows[j][0]))
    if not hits:
        print('  none')

    if not a.go:
        print('\nDRY RUN -- nothing written. Add --go.')
        return

    os.makedirs(a.out, exist_ok=True)
    for slug, z, (s, n, w, e), _ in rows:
        gj = {
            'type': 'FeatureCollection',
            'features': [{
                'type': 'Feature',
                'properties': {
                    'slug': slug,
                    'name': z.get('name', slug),
                    'kind': 'coastal_zone',
                    # Recorded so nobody later mistakes this for a surveyed shoreline.
                    'source': 'coastal_catalog.py bbox -- a REGION, not a waterbody outline',
                },
                'geometry': {'type': 'Polygon', 'coordinates': [ring(s, n, w, e)]},
            }],
        }
        fp = os.path.join(a.out, slug + '_zone.geojson')
        json.dump(gj, open(fp, 'w', encoding='utf-8'))
        print('  -> %s' % fp)

    print('\nnext: install them into the registry, then build.')
    print('  py .\\install_registry_boundary.py --registry ... --boundaries ... --labels ... \\')
    print('     ' + ' '.join('--lake %s=%s' % (slug, z.get('state', '??'))
                             for slug, z, _, _ in rows[:3]) + (' ...' if len(rows) > 3 else ''))


if __name__ == '__main__':
    main()
