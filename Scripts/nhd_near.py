#!/usr/bin/env python3
r"""nhd_near.py -- what does NHD have HERE, as polygons you can look at.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\nhd_near.py --near=-80.63639,33.78583 --radius 4000 `
       --gdb F:\TrollMapPipeline\NHD\0305\NHDPLUS_H_0305_HU4_GDB.gdb `
       --out F:\TrollMapPipeline\outputs\nhd_bates.geojson

The sibling of lookup_3dhp.py --near, for the case 3DHP cannot answer.

WHY IT EXISTS

Bates Old River, 2026-08-22. 3DHP carries it ONLY as a named flowline -- id3dhp 5Z2I1, gnisid
1220360, featuretype 1, 0.267 km of line and no polygon at all. The registry is built from 3DHP
waterbody POLYGONS, so a water like that can never get a row through the normal path, and
missing_waterbodies.py will never surface it either: that tool looks for polygons with no
boundary, and here there is no polygon. A different blind spot from the unnamed-polygon one --
call it named water that 3DHP draws as a line.

NHD does carry area geometry where 3DHP has only a line: a lake is NHDWaterbody, and a large
river's open water is NHDArea FType 460 StreamRiver. match_waters_to_nhd.py already reads both
for exactly that reason -- reading only NHDWaterbody bound 329 of 348.

--near TAKES LON,LAT AND MUST BE WRITTEN WITH AN EQUALS SIGN. `--near -80.6,33.7` looks like a
flag to argparse because it starts with a minus, and the error it gives points nowhere near the
cause. Same trap lookup_3dhp.py documents.

The GDB is 1.4 GB for one HU4, which is why this runs on Windows against the local NHD tree
rather than anywhere else.
"""
import argparse, json, math, os, sys

LAYERS = ('NHDWaterbody', 'NHDArea')
FTYPE = {390: 'LakePond', 436: 'Reservoir', 460: 'StreamRiver', 493: 'Estuary',
         466: 'SwampMarsh', 445: 'SeaOcean', 361: 'Playa'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--near', required=True, help='LON,LAT in WGS84. WRITE IT AS --near=-80.6,33.7')
    ap.add_argument('--radius', type=float, default=4000.0, help='metres (default 4000)')
    ap.add_argument('--gdb', required=True, help='one NHDPLUS_H_xxxx_HU4_GDB.gdb')
    ap.add_argument('--layers', default=','.join(LAYERS))
    ap.add_argument('--out', required=True, help='GeoJSON to write')
    a = ap.parse_args()

    try:
        import pyogrio
        from pyogrio.raw import read as rawread
        from shapely import from_wkb
        from shapely.geometry import mapping
    except ImportError:
        print('needs pyogrio and shapely -- the same two match_waters_to_nhd.py uses.')
        return 2

    lon, lat = [float(x) for x in a.near.split(',')]
    dlat = a.radius / 110540.0
    dlon = a.radius / (111320.0 * max(0.2, math.cos(math.radians(lat))))
    bbox = (lon - dlon, lat - dlat, lon + dlon, lat + dlat)
    print('point %.6f,%.6f  radius %.0f m  bbox %.5f,%.5f,%.5f,%.5f'
          % (lon, lat, a.radius, *bbox))

    feats = []
    for layer in [l.strip() for l in a.layers.split(',') if l.strip()]:
        try:
            info = pyogrio.read_info(a.gdb, layer=layer)
        except Exception as exc:
            print('  %-16s unreadable: %s' % (layer, exc)); continue
        have = {str(f).lower(): str(f) for f in (info.get('fields') if info.get('fields') is not None else [])}
        want = [have[k] for k in ('permanent_identifier', 'gnis_name', 'ftype', 'fcode',
                                  'areasqkm', 'gnis_id') if k in have]
        meta, _fids, geom, field_data = rawread(a.gdb, layer=layer, columns=want,
                                                bbox=bbox, read_geometry=True)
        # FIELD DATA IS ORDERED TO MATCH meta['fields'], NOT THE COLUMNS THAT WERE REQUESTED,
        # and it comes back as a LIST of arrays rather than a dict. match_waters_to_nhd.py's
        # read_polys() says so in a comment; this script did not copy the pattern and died with
        # "'list' object has no attribute 'items'" the first time Ryan ran it. 2026-08-22.
        got = [str(f) for f in (meta.get('fields') if meta.get('fields') is not None else [])]
        cols = {}
        for name, values in zip(got, field_data or []):
            cols[name.lower()] = values
        n = 0
        for i, wkb in enumerate(geom):
            if wkb is None:
                continue
            g = from_wkb(bytes(wkb))
            if g.is_empty:
                continue
            props = {'nhd_layer': layer}
            for k, vals in cols.items():
                v = vals[i]
                props[k] = v.item() if hasattr(v, 'item') else (
                    None if v is None else (str(v).strip() or None))
            ft = props.get('ftype')
            props['ftype_label'] = FTYPE.get(int(ft)) if ft not in (None, '') else None
            feats.append({'type': 'Feature', 'properties': props, 'geometry': mapping(g)})
            n += 1
        print('  %-16s %d polygon(s) in the box' % (layer, n))

    os.makedirs(os.path.dirname(os.path.abspath(a.out)) or '.', exist_ok=True)
    with open(a.out, 'w', encoding='utf-8') as fh:
        json.dump({'type': 'FeatureCollection', 'query': {'lon': lon, 'lat': lat,
                                                          'radius_m': a.radius},
                   'features': feats}, fh)
    print('wrote %s  (%d features)' % (a.out, len(feats)))
    for f in feats:
        p = f['properties']
        print('   %-14s %-22s %-12s %s km2'
              % (p.get('nhd_layer'), str(p.get('gnis_name'))[:22],
                 p.get('ftype_label') or p.get('ftype'), p.get('areasqkm')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
