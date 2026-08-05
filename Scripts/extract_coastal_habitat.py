#!/usr/bin/env python3
"""
extract_coastal_habitat.py — Extract and clip coastal habitat data to TrollMap
coastal zone bboxes, then upload to R2.

Handles:
  1. SC oyster beds (SCDNROyster2015Live.geojson) → {zone}/oyster_beds.geojson
  2. NC reef/oyster guide (DMF_ReefGuide_*.geojson) → {zone}/oyster_beds.geojson
  3. SC ESI GDB (SCarolina_2015_GDB.zip) → marsh + SAV layers
  4. NC ESI GDB (NCarolina_2016_GDB.zip) → marsh + SAV layers

Output: {zone}/oyster_beds.geojson, {zone}/marsh.geojson, {zone}/sav.geojson

Usage:
    py extract_coastal_habitat.py --dry-run    # show what would be extracted
    py extract_coastal_habitat.py              # extract and upload all
    py extract_coastal_habitat.py --zone coast_charleston_sc
    py extract_coastal_habitat.py --skip-upload  # extract only, no R2 upload
"""

import json
import sys
import argparse
import subprocess
import zipfile
import tempfile
from pathlib import Path
from collections import defaultdict

# Sibling module. Every road into trollmap-chartpacks compresses the same way -- r2_gzip.py.
from r2_gzip import prepared

try:
    import geopandas as gpd
    from shapely.geometry import box
except ImportError:
    print("ERROR: pip install geopandas shapely --break-system-packages")
    sys.exit(1)

try:
    from coastal_catalog import COASTAL_CATALOG
except ImportError:
    print("ERROR: coastal_catalog.py not found in same directory")
    sys.exit(1)

# ── Config ────────────────────────────────────────────────────────────────────
DATA_DIR    = Path(r'F:\TrollMapPipeline\oyster_marsh')
OUTPUT_DIR  = Path(r'F:\TrollMapPipeline\habitat_output')
R2_BUCKET   = 'trollmap-chartpacks'
WRANGLER_JS = r'C:\Users\Ryan\AppData\Roaming\npm\node_modules\wrangler\bin\wrangler.js'

SC_OYSTER_FILE = DATA_DIR / 'SCDNROyster2015Live.geojson'
NC_REEF_FILE   = DATA_DIR / 'DMF_ReefGuide_434636977206671764.geojson'
SC_ESI_ZIP     = DATA_DIR / 'SCarolina_2015_GDB.zip'
NC_ESI_ZIP     = DATA_DIR / 'NCarolina_2016_GDB.zip'
GA_ESI_ZIP     = DATA_DIR / 'Georgia_2015_GDB.zip'

# ESI layer names — matched to actual GDB contents
# HABITATS = primary habitat polygons (marsh, SAV, beach, etc.)
# ESIL = ESI shoreline lines with habitat coding
# BENTHIC = NC benthic habitat (oyster/shell bottom)
# RESOURCE_POLY = managed resource areas
ESI_HABITAT_LAYERS = ['HABITATS', 'ESIL', 'BENTHIC', 'RESOURCE_POLY']

# Within HABITATS, ESI codes for marsh and SAV
# ESI codes: 10=salt marsh, 9=sheltered rocky shores, 8=sheltered scarps,
# 7=exposed tidal flats, 6=gravel beaches, 5=mixed sand/gravel,
# 4=coarse-grained sand, 3=fine-grained sand, 2=exposed rocky shores, 1=exposed solid man-made
# Marsh = ESI 10 (salt marsh), SAV typically tagged in HABITATS with BIO_TYPE or HABITAT field
MARSH_ESI_CODES = {'10', '10A', '10B', '10C', '10D'}
SAV_HABITAT_TYPES = {'SAV', 'SEAGRASS', 'SUBMERGED AQUATIC', 'OYSTER', 'SHELL'}

# Minimum features to bother uploading
MIN_FEATURES = 1
MAX_SIZE_KB = 10240  # 10MB — simplify harder if over this
UPLOAD_TIMEOUT = 300  # 5 minutes for large files


def zone_bbox_polygon(zone):
    s, n, w, e = zone['bbox']
    return box(w, s, e, n)


def clip_to_zone(gdf, zone):
    """Clip a GeoDataFrame to a zone bbox. Returns clipped GDF or None."""
    if gdf is None or gdf.empty:
        return None
    bbox_poly = zone_bbox_polygon(zone)
    try:
        # Ensure CRS is WGS84
        if gdf.crs is None:
            gdf = gdf.set_crs('EPSG:4326')
        elif gdf.crs.to_epsg() != 4326:
            gdf = gdf.to_crs('EPSG:4326')
        clipped = gdf[gdf.geometry.intersects(bbox_poly)].copy()
        if clipped.empty:
            return None
        return clipped
    except Exception as e:
        print(f"    ⚠️  Clip error: {e}")
        return None


def gdf_to_geojson(gdf):
    """Convert GeoDataFrame to GeoJSON string, keeping only geometry + minimal props."""
    features = []
    for _, row in gdf.iterrows():
        geom = row.geometry
        if geom is None or geom.is_empty:
            continue
        # Keep only string/numeric props, drop nulls
        props = {}
        for col in gdf.columns:
            if col == 'geometry':
                continue
            val = row[col]
            if val is not None and str(val) not in ('nan', 'None', ''):
                props[col] = str(val) if not isinstance(val, (int, float, bool)) else val
        features.append({
            'type': 'Feature',
            'geometry': geom.__geo_interface__,
            'properties': props,
        })
    return json.dumps({'type': 'FeatureCollection', 'features': features}, separators=(',', ':'))


def upload_to_r2(slug, layer_name, geojson_str, dry_run=False, gz=True):
    """Push one habitat layer.

    GZIPPED SINCE 2026-08-05. This was the FIFTH road into trollmap-chartpacks and the last one
    found -- upload_garmin_to_r2.py, upload_to_r2_coastal.py, upload_boundaries_to_r2.py and
    fetch_osm_structures.py were all converted before anyone noticed this one existed. It was
    holding 208 MB raw across 37 objects (marsh_edges 114.7 MB / 21, oyster_beds 93.3 MB / 16),
    and the audit could not see it because those two filenames are in neither uploader's layer
    vocabulary, so no rule had an opinion about them.

    Ryan, 2026-08-05: "they can be encrypted the worker is what fetches them" -- and that is the
    whole argument. Every read path is covered: r2Body() for anything the browser pulls through
    the chartpack route, r2Text() for anything the Worker parses itself.
    """
    r2_key = f"{slug}/{layer_name}"
    size_kb = len(geojson_str.encode()) // 1024
    tmp = Path(f'_habitat_tmp_{slug}_{layer_name}')
    tmp.write_text(geojson_str, encoding='utf-8')
    print(f"    uploading {r2_key} ({size_kb} KB) ...", end=' ', flush=True)

    if dry_run:
        tmp.unlink()
        print("DRY RUN")
        return True

    try:
        with prepared(tmp, gz) as (src, extra):
            cmd = [
                'node', WRANGLER_JS, 'r2', 'object', 'put', f'{R2_BUCKET}/{r2_key}',
                '--file', str(src),
                '--content-type', 'application/json',
                '--remote', *extra,
            ]
            result = subprocess.run(cmd, capture_output=True, timeout=UPLOAD_TIMEOUT)
        out = (result.stdout + result.stderr).decode('utf-8', errors='replace')
        tmp.unlink()
        if result.returncode == 0 or 'success' in out.lower():
            print("✅")
            return True
        print(f"❌  (exit {result.returncode})")
        print(f"      {out.strip()[:200]}")
        return False
    except subprocess.TimeoutExpired:
        tmp.unlink(missing_ok=True)
        print("❌  timeout")
        return False
    except FileNotFoundError:
        tmp.unlink(missing_ok=True)
        print("❌  node/wrangler not found")
        sys.exit(1)


def list_gdb_layers(gdb_path):
    """List all layers in a GDB."""
    try:
        import pyogrio
        layers = pyogrio.list_layers(str(gdb_path))
        # list_layers returns array of [name, geometry_type] pairs
        return [l[0] for l in layers]
    except Exception as e:
        print(f"  ⚠️  Could not list layers: {e}")
        return []


def extract_gdb_from_zip(zip_path):
    """Extract GDB from zip to temp dir, return path to .gdb folder."""
    tmp_dir = Path(tempfile.mkdtemp())
    print(f"  Extracting {zip_path.name} ...")
    with zipfile.ZipFile(zip_path, 'r') as z:
        z.extractall(tmp_dir)
    # Find .gdb folder
    gdbs = list(tmp_dir.rglob('*.gdb'))
    if not gdbs:
        print(f"  ⚠️  No .gdb found in {zip_path.name}")
        return None, tmp_dir
    return gdbs[0], tmp_dir


def load_esi_layers(gdb_path, target_layers):
    """Load ESI layers from GDB. Returns dict of layer_name→GDF."""
    available = list_gdb_layers(gdb_path)
    loaded = {}
    for layer in available:
        if layer.upper() in [t.upper() for t in target_layers]:
            try:
                gdf = gpd.read_file(str(gdb_path), layer=layer, engine="pyogrio")
                if not gdf.empty:
                    print(f"  Loaded layer '{layer}': {len(gdf):,} features, cols: {list(gdf.columns[:8])}")
                    loaded[layer] = gdf
            except Exception as e:
                print(f"  ⚠️  Could not load layer '{layer}': {e}")
    return loaded


def process_zone(slug, zone, oyster_sc, oyster_nc, esi_sc, esi_nc, esi_ga,
                 dry_run=False, skip_upload=False, gz=True):
    state = zone.get('state', '')
    print(f"\n  {slug}: {zone['name']} ({state})")

    results = {}

    # ── Oyster beds ───────────────────────────────────────────────────────────
    oyster_src = oyster_sc if state == 'SC' else oyster_nc if state in ('NC', 'GA') else None
    if oyster_src is not None:
        clipped = clip_to_zone(oyster_src, zone)
        if clipped is not None and len(clipped) >= MIN_FEATURES:
            # Drop tiny slivers below 10 sq meters before simplifying
            clipped = clipped[clipped.geometry.area > 0.000001]
            # Adaptive simplification — increase tolerance until under MAX_SIZE_KB
            for tolerance in (0.0001, 0.0003, 0.0005, 0.001, 0.002, 0.005):
                simplified = clipped.copy()
                simplified['geometry'] = simplified.geometry.simplify(tolerance, preserve_topology=True)
                simplified = simplified[~simplified.geometry.is_empty]
                gj = gdf_to_geojson(simplified)
                size_kb = len(gj.encode()) // 1024
                if size_kb <= MAX_SIZE_KB:
                    clipped = simplified
                    break
                print(f"    oyster_beds: {size_kb} KB at tolerance {tolerance}, trying larger...")
            print(f"    oyster_beds: {len(clipped):,} features ({size_kb} KB, tolerance={tolerance})")
            results['oyster_beds.geojson'] = gj
        else:
            print(f"    oyster_beds: none in bbox")

    # ── ESI habitat layers ────────────────────────────────────────────────────
    esi = esi_sc if state == 'SC' else esi_nc if state == 'NC' else esi_ga if state == 'GA' else {}
    for layer_name, gdf in esi.items():
        clipped = clip_to_zone(gdf, zone)
        if clipped is None or len(clipped) < MIN_FEATURES:
            continue

        layer_upper = layer_name.upper()

        if layer_upper == 'HABITATS':
            # HABITATS in these ESI GDBs is rare species habitat, not marsh/SAV — skip
            print(f"    HABITATS: skipping (rare species layer, not marsh/SAV)")

        elif layer_upper == 'BENTHIC':
            # NC benthic — simplify before saving
            clipped['geometry'] = clipped.geometry.simplify(0.0001, preserve_topology=True)
            clipped = clipped[~clipped.geometry.is_empty]
            gj = gdf_to_geojson(clipped)
            print(f"    oyster_beds (BENTHIC): {len(clipped):,} features")
            if 'oyster_beds.geojson' in results:
                existing = json.loads(results['oyster_beds.geojson'])
                existing['features'].extend(json.loads(gj)['features'])
                results['oyster_beds.geojson'] = json.dumps(existing, separators=(',', ':'))
            else:
                results['oyster_beds.geojson'] = gj

        elif layer_upper == 'ESIL':
            # Filter to marsh shoreline only: ESI code 10 variants = salt marsh
            # Also grab ESI 9 (sheltered tidal flats) which borders marsh
            marsh_codes = {'10', '10A', '10B', '10C', '10D', '9', '9A', '9B', '9C'}
            esi_col = next((c for c in clipped.columns if c.upper() == 'ESI'), None)
            if esi_col:
                marsh = clipped[clipped[esi_col].astype(str).isin(marsh_codes)].copy()
                if len(marsh) >= MIN_FEATURES:
                    # Adaptive simplification on lines
                    for tolerance in (0.0001, 0.0003, 0.0005, 0.001, 0.002):
                        simplified = marsh.copy()
                        simplified['geometry'] = simplified.geometry.simplify(tolerance, preserve_topology=True)
                        simplified = simplified[~simplified.geometry.is_empty]
                        gj = gdf_to_geojson(simplified)
                        size_kb = len(gj.encode()) // 1024
                        if size_kb <= MAX_SIZE_KB:
                            marsh = simplified
                            break
                        print(f"    marsh_edges: {size_kb} KB at tolerance {tolerance}, trying larger...")
                    print(f"    marsh_edges: {len(marsh):,} features ({size_kb} KB, tolerance={tolerance})")
                    results['marsh_edges.geojson'] = gj
                else:
                    print(f"    marsh_edges: none matching ESI codes in bbox")
            else:
                print(f"    ESIL: no ESI column found")

        elif layer_upper == 'RESOURCE_POLY':
            # Keep only fishing-relevant resource types
            type_col = next((c for c in clipped.columns if c.upper() == 'TYPE'), None)
            if type_col:
                relevant = clipped[clipped[type_col].astype(str).str.upper().str.contains(
                    'SHELL|OYSTER|CLAM|FISH|AQUA|HARVEST', na=False)]
                if len(relevant) >= MIN_FEATURES:
                    gj = gdf_to_geojson(relevant)
                    print(f"    resource_areas: {len(relevant):,} features")
                    results['resource_areas.geojson'] = gj
                else:
                    print(f"    resource_areas: no fishing-relevant types in bbox")
            else:
                gj = gdf_to_geojson(clipped)
                print(f"    resource_areas: {len(clipped):,} features")
                results['resource_areas.geojson'] = gj

    if not results:
        print(f"    No habitat data found for this zone")
        return 0

    if skip_upload:
        # Write to output dir instead
        zone_dir = OUTPUT_DIR / slug
        zone_dir.mkdir(parents=True, exist_ok=True)
        for fname, gj in results.items():
            out_path = zone_dir / fname
            out_path.write_text(gj, encoding='utf-8')
            kb = len(gj.encode()) // 1024
            print(f"    Saved {fname} ({kb} KB) → {out_path}")
        return len(results)

    ok = 0
    for fname, gj in results.items():
        if upload_to_r2(slug, fname, gj, dry_run=dry_run, gz=gz):
            ok += 1
    return ok


def main():
    ap = argparse.ArgumentParser(description='Extract coastal habitat data for TrollMap')
    ap.add_argument('--zone',        help='Process single zone by slug')
    ap.add_argument('--zones',       nargs='+', help='Process multiple zones by slug')
    ap.add_argument('--dry-run',     action='store_true')
    ap.add_argument('--no-gzip',     action='store_true',
                    help='upload raw -- only if the Worker predates r2Body()')
    ap.add_argument('--skip-upload', action='store_true', help='Save locally instead of uploading')
    ap.add_argument('--list-layers', action='store_true', help='List ESI GDB layers and exit')
    args = ap.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # ── List layers mode ──────────────────────────────────────────────────────
    if args.list_layers:
        for label, zip_path in [('SC ESI', SC_ESI_ZIP), ('NC ESI', NC_ESI_ZIP), ('GA ESI', GA_ESI_ZIP)]:
            if not zip_path.exists():
                print(f"{label}: not found at {zip_path}")
                continue
            print(f"\n{label} layers:")
            gdb_path, tmp_dir = extract_gdb_from_zip(zip_path)
            if gdb_path:
                layers = list_gdb_layers(gdb_path)
                for l in layers:
                    print(f"  {l}")
            import shutil; shutil.rmtree(tmp_dir, ignore_errors=True)
        return

    # ── Load source data ──────────────────────────────────────────────────────
    print("Loading source data...")

    # SC oyster
    oyster_sc = None
    if SC_OYSTER_FILE.exists():
        print(f"  Loading SC oyster ({SC_OYSTER_FILE.stat().st_size // 1024 // 1024} MB)...")
        oyster_sc = gpd.read_file(str(SC_OYSTER_FILE), engine="pyogrio")
        print(f"  SC oyster: {len(oyster_sc):,} features")
    else:
        print(f"  ⚠️  SC oyster not found: {SC_OYSTER_FILE}")

    # NC reef/oyster
    oyster_nc = None
    if NC_REEF_FILE.exists():
        print(f"  Loading NC reef guide...")
        oyster_nc = gpd.read_file(str(NC_REEF_FILE), engine="pyogrio")
        print(f"  NC reef/oyster: {len(oyster_nc):,} features")
    else:
        print(f"  ⚠️  NC reef file not found: {NC_REEF_FILE}")

    # SC ESI
    esi_sc = {}
    if SC_ESI_ZIP.exists():
        gdb_path, tmp_sc = extract_gdb_from_zip(SC_ESI_ZIP)
        if gdb_path:
            esi_sc = load_esi_layers(gdb_path, ESI_HABITAT_LAYERS)
    else:
        print(f"  ⚠️  SC ESI not found: {SC_ESI_ZIP}")
        tmp_sc = None

    # NC ESI
    esi_nc = {}
    if NC_ESI_ZIP.exists():
        gdb_path, tmp_nc = extract_gdb_from_zip(NC_ESI_ZIP)
        if gdb_path:
            esi_nc = load_esi_layers(gdb_path, ESI_HABITAT_LAYERS)
    else:
        print(f"  ⚠️  NC ESI not found: {NC_ESI_ZIP}")
        tmp_nc = None

    # GA ESI
    esi_ga = {}
    if GA_ESI_ZIP.exists():
        gdb_path, tmp_ga = extract_gdb_from_zip(GA_ESI_ZIP)
        if gdb_path:
            esi_ga = load_esi_layers(gdb_path, ESI_HABITAT_LAYERS)
    else:
        print(f"  ⚠️  GA ESI not found: {GA_ESI_ZIP}")
        tmp_ga = None

    # ── Process zones ─────────────────────────────────────────────────────────
    if args.zone:
        if args.zone not in COASTAL_CATALOG:
            print(f"❌ Unknown zone: {args.zone}")
            sys.exit(1)
        zones = [(args.zone, COASTAL_CATALOG[args.zone])]
    elif args.zones:
        zones = []
        for s in args.zones:
            if s not in COASTAL_CATALOG:
                print(f"❌ Unknown zone: {s}")
                sys.exit(1)
            zones.append((s, COASTAL_CATALOG[s]))
    else:
        zones = list(COASTAL_CATALOG.items())

    print(f"\n{'='*60}")
    print(f"Processing {len(zones)} zones...")
    if args.dry_run:
        print("Mode: DRY RUN")
    elif args.skip_upload:
        print(f"Mode: LOCAL SAVE → {OUTPUT_DIR}")

    total = 0
    for slug, zone in zones:
        n = process_zone(slug, zone, oyster_sc, oyster_nc, esi_sc, esi_nc, esi_ga,
                         dry_run=args.dry_run, skip_upload=args.skip_upload,
                         gz=not args.no_gzip)
        total += n

    # Cleanup temp dirs
    import shutil
    if tmp_sc: shutil.rmtree(tmp_sc, ignore_errors=True)
    if tmp_nc: shutil.rmtree(tmp_nc, ignore_errors=True)
    if tmp_ga: shutil.rmtree(tmp_ga, ignore_errors=True)

    print(f"\n{'='*60}")
    print(f"Done. {total} files processed.")


if __name__ == '__main__':
    main()
