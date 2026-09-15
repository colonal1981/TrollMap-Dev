#!/usr/bin/env python3
"""measure_gwrap.py — what G-WRAPData2021 holds for the zones the app actually offers.

G-WRAPVectorData2021 is 566 MB of Georgia coastal GIS that has sat on the drive unopened.
Listing its layers on 2026-09-15 turned up things no other source on the drive has, and two of
them look like direct answers to gaps this project has written down:

    InshoreReefCenters / InshoreReefStructures   GA DNR's ARTIFICIAL INSHORE REEFS. Built to be
        fished, inshore by name, and the exact hard structure the South Atlantic habitat matrix
        rates 3.5 for sheepshead against 1.0 for the fine bottom that is everywhere. South
        Carolina's equivalent was already chased and recorded as a dead end -- ArtReef2021.csv,
        14 of 846 inside a real zone boundary, all one site. Georgia's is a different dataset
        with "inshore" in its name.

    ArmoredShoreline                             A second source for the armoured front the ENC
        seabed layer now supplies. Worth counting against it rather than assuming either way.

    SurfaceSalinityPoints / SurfaceSalinityLines  Salinity, which the coast has no gauge for.

    OysterReefs / OysterReefsHighWater           A second Georgia oyster source beside the gpkg.
        Counting it is how we find out whether it adds anything or repeats what we have.

MEASURE BEFORE WRITING A READER. That rule is why ArtReef2021 was refused and why the seagrass
compilation was, and it is the only thing this script does: count features per zone and print
what the attributes say. It writes nothing and uploads nothing.

    py .\\measure_gwrap.py
    py .\\measure_gwrap.py --layers InshoreReefStructures,OysterReefs

Personal use only, not for distribution or resale; not for navigation.
"""
import argparse
import sys
from pathlib import Path

try:
    import geopandas as gpd
    from shapely.geometry import box
except ImportError:
    print('ERROR: pip install geopandas shapely --break-system-packages')
    sys.exit(1)

try:
    from coastal_catalog import COASTAL_CATALOG
except ImportError:
    print('ERROR: coastal_catalog.py not found in same directory')
    sys.exit(1)

GDB = Path(r'F:\TrollMapPipeline\G-WRAPVectorData2021\G-WRAPData2021.gdb')

# The layers worth counting, and why each is here. Everything else in the geodatabase is land
# cover, county lines, sea-level-rise projections or impaired-water reporting -- none of which
# says anything about where a fish is.
LAYERS = [
    'InshoreReefStructures',
    'InshoreReefCenters',
    'OysterReefs',
    'OysterReefsHighWater',
    'ArmoredShoreline',
    'Causeways',
    'Tidegates_51',
    'SurfaceSalinityPoints',
    'ShellfishGrowingAreas',
    'RecreationalHarvestAreasShellfish',
    'CoastalWaterAccessPoints',
]


def zone_boxes():
    out = {}
    for slug, z in COASTAL_CATALOG.items():
        s, n, w, e = z['bbox']
        out[slug] = (box(w, s, e, n), z.get('state', ''))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--gdb', default=str(GDB))
    ap.add_argument('--layers', default=None, help='comma list; default is the fishing-relevant set')
    ap.add_argument('--attrs', type=int, default=6, help='how many attribute values to show')
    a = ap.parse_args()

    gdb = Path(a.gdb)
    if not gdb.exists():
        print(f'ERROR: not found: {gdb}')
        sys.exit(1)
    want = [s.strip() for s in a.layers.split(',')] if a.layers else LAYERS

    boxes = zone_boxes()
    print(f'{len(boxes)} zones in the catalog; {sum(1 for _, st in boxes.values() if st == "GA")} '
          f'of them Georgia\n')

    for name in want:
        try:
            gdf = gpd.read_file(str(gdb), layer=name, engine='pyogrio')
        except Exception as e:
            print(f'{name}: could not read -- {e}')
            continue
        if gdf.empty:
            print(f'{name}: empty')
            continue
        try:
            gdf = gdf.set_crs('EPSG:4326') if gdf.crs is None else gdf.to_crs('EPSG:4326')
        except Exception as e:
            print(f'{name}: could not reproject -- {e}')
            continue

        hits = {}
        for slug, (poly, _st) in boxes.items():
            try:
                n = int(gdf.geometry.intersects(poly).sum())
            except Exception:
                n = 0
            if n:
                hits[slug] = n
        total = sum(hits.values())
        print(f'{name}: {len(gdf):,} features, {total:,} inside a zone')
        if not total:
            # NAMED AND EMPTY IS A RESULT. ArtReef2021 was refused on exactly this line and it
            # saved a reader nobody would have used.
            print('   -> nothing in any zone the app offers. Not worth a reader.')
            continue
        for slug, n in sorted(hits.items(), key=lambda kv: -kv[1]):
            print(f'     {slug:34} {n:>6,}')
        cols = [c for c in gdf.columns if c != gdf.geometry.name][:a.attrs]
        for c in cols:
            try:
                vc = gdf[c].astype(str).value_counts()
            except Exception:
                continue
            if 1 < len(vc) <= 25:
                print(f'   {c}: ' + ', '.join(f'{k}={v:,}' for k, v in list(vc.items())[:8]))
        print()


if __name__ == '__main__':
    main()
