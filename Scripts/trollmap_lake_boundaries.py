#!/usr/bin/env python3
"""
trollmap_lake_boundaries.py - Extract lake boundaries from USGS 3DHP GeoPackage
using lake_catalog.py as the single source of truth for lake definitions.

Usage:
  py trollmap_lake_boundaries.py <gpkg_path>
  py trollmap_lake_boundaries.py <gpkg_path> --lake lake_wateree_fishing_creek
  py trollmap_lake_boundaries.py <gpkg_path> --overwrite
  py trollmap_lake_boundaries.py --list

Requires: geopandas, pyproj, lake_catalog.py in same directory
gpkg:     F:\\TrollMapPipeline\\3dhp_all_CONUS_20260112_GPKG\\3dhp_all_CONUS_20260112.gpkg
"""
import sys
import json
import argparse
import re
from pathlib import Path

try:
    from lake_catalog import LAKE_CATALOG
except ImportError:
    print("ERROR: lake_catalog.py not found in same directory")
    sys.exit(1)

OUT_DIR = Path(r"F:\TrollMapPipeline\lake_boundaries")
LAYER   = "hydro_3dhp_all_waterbody"

# ── Per-slug name filter overrides ───────────────────────────────────────────
# For chain lakes or slugs where the name doesn't cleanly derive a filter.
# Each entry is a list of strings — any match in gnisidlabel keeps the feature.
NAME_FILTER_OVERRIDES = {
    # ── Chain / multi-lake slugs ──────────────────────────────────────────────
    'lake_thurmond_russell':       ['thurmond', 'russell', 'clarks hill'],
    'lake_hickory_rhodhiss':       ['hickory', 'rhodhiss'],
    'lake_greenwood_secession':    ['greenwood', 'secession'],
    'lake_monticello_parr':        ['monticello', 'parr'],
    'yadkin_river_chain':          ['high rock', 'badin', 'tillery', 'blewett'],
    'lake_norman_mountain_island': ['norman', 'mountain island'],
    'lake_wateree_fishing_creek':  ['wateree', 'fishing creek'],
    'lake_juliette_high_falls':    ['juliette', 'high falls'],
    'watauga_boone_chain':         ['watauga', 'boone'],
    'catawba_narrows':             ['catawba'],   # no 'catawba narrows' in GNIS; will match river features — review output
    'north_saluda_reservoir':      ['north saluda', 'robinson'],
    'sc_ga_coastal':               [],   # skip — not a discrete waterbody

    # ── GNIS uses inverted name order (e.g. "Foo Lake" not "Lake Foo") ───────
    'lake_chatuge':                ['chatuge'],          # GNIS: "Chatuge Lake"
    'lake_chilhowee':              ['chilhowee'],        # GNIS: "Chilhowee Lake"
    'lake_nottely':                ['nottely'],          # GNIS: "Nottely Lake"
    'lake_santeetlah':             ['santeetlah'],       # GNIS: "Santeetlah Lake"
    'lake_seed':                   ['seed lake'],        # GNIS: "Seed Lake"
    'mayo_lake':                   ['mayo'],             # GNIS: "Mayo Reservoir"

    # ── GNIS uses full formal name ────────────────────────────────────────────
    'hb_robinson_lake':            ['robinson'],         # GNIS: "Lake Robinson"
    'lake_bowen':                  ['bowen'],            # GNIS: "Lake William C Bowen"
    'w_kerr_scott_reservoir':      ['kerr scott'],       # GNIS: "W Kerr Scott Reservoir" (no period)
    'kerr_lake':                   ['john h. kerr', 'kerr reservoir'],  # GNIS: "John H. Kerr Reservoir"
    'parksville_lake':             ['ocoee', 'parksville'],  # GNIS uses "Lake Ocoee" for this impoundment

    # ── Hartwell / Allatoona / Lanier / others where GNIS omits "Lake" ───────
    'lake_hartwell':               ['hartwell'],
    'lake_allatoona':              ['allatoona'],
    'lake_lanier':                 ['lanier', 'sidney lanier'],
    'lake_jackson_ga':             ['jackson lake'],     # narrowed — 'jackson' alone matched a pond
    'chickamauga_lake':            ['chickamauga'],
    'buckhorn_reservoir':          ['buckhorn'],
    'lake_blue_ridge':             ['blue ridge'],
    'lake_waccamaw':               ['waccamaw'],
    'lake_nottely':                ['nottely'],
    'randleman_lake':              ['randleman'],        # not in 3DHP (52 names searched, none match)
    'falls_lake':                  ['falls lake'],       # not in 3DHP; bbox also may be wrong (pulls B. Everett Jordan Lake)
    'lake_mackintosh':             ['mackintosh', 'burlington'],  # city reservoir; may use city name
    'lake_reidsville':             ['reidsville'],
    'lake_summit':                 ['summit'],
    'john_h_moss_lake':            ['moss', 'kings mountain'],    # GNIS: "Kings Mountain Reservoir"
    'lake_blalock':                ['blalock', 'pacolet'],        # may be "South Pacolet River Reservoir"
    'lake_robinson_greenville':    ['lyman'],                     # GNIS shows "Lyman Lake" in this bbox
    'tobesofkee_reservoir':        ['tobesofkee'],                # GNIS: "Lake Tobesofkee"
    'hiwassee_lake':               ['hiwassee', 'apalachia'],     # TVA uses "Apalachia Lake" in GNIS
    'lake_toxaway':                ['toxaway'],                   # geometry present, name may be null

    # ── Confirmed not in GNIS — bbox dumps accepted as best available ─────────
    # bear_creek_reservoir_ga: small GA ponds only, reservoir not in GNIS
    # john_d_long_lake: only "Cudds Pond"/"Adams Lake" in bbox — tiny SC pond
    # auman_lake: mapped as "Seven Lakes" community ponds, not Auman
    # catawba_narrows: no lake polygon — river channel between Wylie and Mountain Island
    # lake_adger: not in GNIS — only "Beech Lake"/"Beechwood Lake"
    # lookout_shoals_lake: not named in GNIS
    # lake_cheoah: GNIS maps this as part of Fontana Lake polygon
}

# Lakes to skip entirely (coastal catch-alls, non-lake entries, confirmed not in 3DHP GNIS)
SKIP_SLUGS = {
    'sc_ga_coastal',
    'saluda_river_arm',        # arm of Murray, not a separate waterbody in 3DHP
    # Confirmed absent from 3DHP GNIS after exhaustive name search:
    'bear_creek_reservoir_ga', # only unrelated small GA ponds in bbox
    'john_d_long_lake',        # only "Cudds Pond"/"Adams Lake" — tiny Union Co SC pond
    'auman_lake',              # mapped as Seven Lakes community ponds, not as Lake Auman
    'catawba_narrows',         # no lake polygon; river channel between Wylie and Mountain Island
    'lake_adger',              # not in GNIS; only "Beech Lake"/"Beechwood Lake" in bbox
    'lookout_shoals_lake',     # not named in GNIS; only "Noname" and unrelated ponds
    'lake_cheoah',             # GNIS maps this geometry under "Fontana Lake"
    # NC/TN reservoirs confirmed absent from 3DHP GNIS label column:
    'lake_summit',             # 134 unrelated ponds in bbox, no Summit match
    'randleman_lake',          # not in 3DHP; 52 names dumped, none match
    'buckhorn_reservoir',      # 609-feature dump, Wake Co reservoir not in GNIS
    'falls_lake',              # not in 3DHP; bbox also wrong (pulls B. Everett Jordan Lake)
    'lake_mackintosh',         # 412-feature dump, Burlington city reservoir not in GNIS
    'lake_reidsville',         # 1357-feature dump, city reservoir not in GNIS
    'lake_toxaway',            # 32 features, all GNIS labels null — unfilterable
    'chickamauga_lake',        # 5237-feature dump, TVA reservoir not in GNIS label column
}

# ── Layer CRS cache — detected once, reused for every lake ───────────────────
_LAYER_CRS = None

def get_layer_crs(gpkg_path):
    """Read the layer CRS once and cache it. Returns a pyproj.CRS."""
    global _LAYER_CRS
    if _LAYER_CRS is not None:
        return _LAYER_CRS
    import geopandas as gpd
    # Read a single feature just to get the CRS — no bbox filter
    probe = gpd.read_file(gpkg_path, layer=LAYER, rows=1)
    _LAYER_CRS = probe.crs
    print(f"  [CRS] Layer CRS detected: {_LAYER_CRS.to_string()}")
    return _LAYER_CRS


def wgs84_bbox_to_layer_crs(bbox_wgs84, layer_crs):
    """
    Transform a (minx, miny, maxx, maxy) WGS84 bbox into the layer's native CRS.
    Returns transformed (minx, miny, maxx, maxy) tuple, or the original bbox
    if the layer is already EPSG:4326.
    """
    from pyproj import Transformer, CRS
    wgs84 = CRS("EPSG:4326")
    if layer_crs.equals(wgs84):
        return bbox_wgs84

    # Transform all four corners and take the envelope — handles rotated CRS
    transformer = Transformer.from_crs(wgs84, layer_crs, always_xy=True)
    minx, miny, maxx, maxy = bbox_wgs84
    corners = [
        transformer.transform(minx, miny),
        transformer.transform(maxx, miny),
        transformer.transform(minx, maxy),
        transformer.transform(maxx, maxy),
    ]
    xs = [c[0] for c in corners]
    ys = [c[1] for c in corners]
    return (min(xs), min(ys), max(xs), max(ys))


def name_filters_for(slug, catalog_entry):
    """Return list of name filter strings for a slug."""
    if slug in NAME_FILTER_OVERRIDES:
        return NAME_FILTER_OVERRIDES[slug]
    # Derive from catalog name — strip chain suffixes and extract key words
    name = catalog_entry.get('name', '')
    # Remove parenthetical and chain descriptions
    name = re.sub(r'\s*\(.*?\)', '', name)
    name = re.sub(r'\s*(chain|above|below|arm)\b.*', '', name, flags=re.IGNORECASE)
    # Split on & and / to handle multi-lake names
    parts = re.split(r'[&/]', name)
    filters = []
    for part in parts:
        word = part.strip().lower()
        if word:
            filters.append(word)
    return filters if filters else [slug.replace('_', ' ')]


def extract_lake(gpkg_path, slug, overwrite=False, dump_names=False):
    import geopandas as gpd

    if slug in SKIP_SLUGS:
        print(f"  {slug}: SKIPPED (not a discrete 3DHP waterbody)")
        return True

    catalog = LAKE_CATALOG.get(slug)
    if not catalog:
        print(f"  {slug}: NOT IN CATALOG -- skipping")
        return False

    out_path = OUT_DIR / f"{slug}_3dhp.geojson"
    if out_path.exists() and not overwrite:
        print(f"  {slug}: already exists -- skipping (--overwrite to replace)")
        return True

    # Catalog bbox is (south, north, west, east) in WGS84 degrees
    s, n, w, e = catalog['bbox']
    # geopandas bbox=(minx, miny, maxx, maxy) = (west, south, east, north)
    bbox_wgs84 = (w, s, e, n)

    filters = name_filters_for(slug, catalog)
    print(f"  {slug}: {catalog['name']}")
    print(f"    bbox WGS84: S{s} N{n} W{w} E{e}")
    print(f"    name filters: {filters}")

    try:
        # Detect layer CRS and transform bbox into it before querying.
        # gpd.read_file(bbox=...) passes the tuple directly to GDAL/OGR, which
        # interprets it in the layer's native CRS — not necessarily WGS84.
        # Passing WGS84 degrees to a projected layer gives coordinates in the
        # range of -83..+36, which are near-zero in meters and miss everything.
        layer_crs = get_layer_crs(gpkg_path)
        bbox_native = wgs84_bbox_to_layer_crs(bbox_wgs84, layer_crs)
        print(f"    bbox native ({layer_crs.to_epsg() or 'proj'}): {tuple(round(v, 1) for v in bbox_native)}")

        gdf = gpd.read_file(gpkg_path, layer=LAYER, bbox=bbox_native)
        print(f"    Features in bbox: {len(gdf)}")

        if len(gdf) == 0:
            print(f"    WARNING: No features found -- bbox may need adjustment")
            return False

        # Reproject to WGS84 for output
        gdf_wgs = gdf.to_crs("EPSG:4326") if gdf.crs.to_epsg() != 4326 else gdf

        # Filter by name
        if filters:
            label_col = 'gnisidlabel' if 'gnisidlabel' in gdf_wgs.columns else \
                        'name' if 'name' in gdf_wgs.columns else None
            if label_col:
                pattern = '|'.join(re.escape(f) for f in filters)
                matches = gdf_wgs[gdf_wgs[label_col].str.contains(pattern, case=False, na=False)]
                print(f"    Name matches: {len(matches)}")
                if len(matches) == 0:
                    avail = gdf_wgs[label_col].dropna().unique()[:10].tolist()
                    print(f"    Available names: {avail}")
                    if dump_names:
                        all_names = sorted(gdf_wgs[label_col].dropna().unique().tolist())
                        print(f"    ALL names in bbox ({len(all_names)} unique):")
                        for n in all_names:
                            print(f"      {n}")
                    print(f"    Saving all bbox features as fallback...")
                    matches = gdf_wgs  # fallback — save everything in bbox
            else:
                print(f"    No name column found — saving all bbox features")
                matches = gdf_wgs
        else:
            matches = gdf_wgs

        OUT_DIR.mkdir(parents=True, exist_ok=True)
        matches.to_crs("EPSG:4326").to_file(str(out_path), driver='GeoJSON')
        size_kb = out_path.stat().st_size // 1024
        print(f"    Saved: {out_path.name} ({size_kb} KB, {len(matches)} features)")
        return True

    except Exception as e:
        print(f"    ERROR: {e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    ap = argparse.ArgumentParser(description='Extract lake boundaries from 3DHP GeoPackage')
    ap.add_argument('gpkg_path', nargs='?', default=None,
                    help='Path to 3DHP .gpkg file')
    ap.add_argument('--lake', choices=[s for s in LAKE_CATALOG if s not in SKIP_SLUGS],
                    help='Extract a single lake by slug')
    ap.add_argument('--list', action='store_true',
                    help='List all lakes and their extraction status')
    ap.add_argument('--overwrite', action='store_true',
                    help='Re-extract even if output file already exists')
    ap.add_argument('--dump-names', action='store_true',
                    help='On name-match failure, print ALL unique names in bbox (use with --lake)')
    args = ap.parse_args()

    if args.list:
        print(f"{'[STATUS]':10} {'SLUG':40} NAME")
        print('-' * 90)
        for slug, data in LAKE_CATALOG.items():
            if slug in SKIP_SLUGS:
                status = 'SKIP'
            else:
                out = OUT_DIR / f"{slug}_3dhp.geojson"
                status = 'OK' if out.exists() else '--'
            print(f"  [{status:4}]  {slug:40} {data['name']}")
        return

    if not args.gpkg_path:
        ap.print_help()
        print(f"\nDefault gpkg: F:\\TrollMapPipeline\\3dhp_all_CONUS_20260112_GPKG\\3dhp_all_CONUS_20260112.gpkg")
        sys.exit(1)

    gpkg = args.gpkg_path
    if not Path(gpkg).exists():
        print(f"ERROR: File not found: {gpkg}")
        sys.exit(1)

    lakes_to_run = [args.lake] if args.lake else [s for s in LAKE_CATALOG if s not in SKIP_SLUGS]

    print(f"3DHP: {gpkg}")
    print(f"Output: {OUT_DIR}")
    print(f"Extracting {len(lakes_to_run)} lake(s)...\n")

    ok = 0
    for slug in lakes_to_run:
        if extract_lake(gpkg, slug, overwrite=args.overwrite, dump_names=args.dump_names):
            ok += 1
        print()

    print(f"Done: {ok}/{len(lakes_to_run)} extracted")
    print(f"Output directory: {OUT_DIR}")


if __name__ == '__main__':
    main()
