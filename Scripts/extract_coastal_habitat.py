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
# NOT IN oyster_marsh/ -- it arrived later and sits in its own folder beside it.
GA_OYSTER_FILE = Path(r'F:\TrollMapPipeline\georgia_oyster_reef_2015\georgia_oyster_reef_2015.gpkg')
SC_ESI_ZIP     = DATA_DIR / 'SCarolina_2015_GDB.zip'
NC_ESI_ZIP     = DATA_DIR / 'NCarolina_2016_GDB.zip'
GA_ESI_ZIP     = DATA_DIR / 'Georgia_2015_GDB.zip'

# WHICH STATE'S OYSTER FILE A ZONE IS ALLOWED TO SEE. ALL THREE HAVE ONE.
#
# This was written inline as `oyster_sc if state == 'SC' else oyster_nc if state in ('NC','GA')`,
# so every Georgia zone was clipped against NORTH CAROLINA's DMF reef guide. The two coasts are
# four hundred kilometres apart, so the clip returned nothing and the run printed
# "oyster_beds: none in bbox" -- which reads as a fact about Georgia and is a fact about a search
# of the wrong state. An answer from the wrong book is worse than no answer, because no answer
# gets looked into.
#
# A table rather than a chain, because the chain is what hid this: `state in ('NC','GA')` reads
# as deliberate and a row naming a file cannot.
#
# AND THE FIRST VERSION OF THIS TABLE SAID `'GA': None`, WHICH WAS ALSO WRONG.
#
# It carried a comment reading "Georgia publishes no statewide oyster layer", lifted from the
# header of js/modules/coastal-layers.js: "SC/NC only -- GA has no public oyster shapefile, so GA
# zones legitimately 404." That sentence was TRUE ON THE DAY IT WAS WRITTEN and stopped being true
# on 2026-09-03, when Ryan downloaded georgia_oyster_reef_2015.gpkg -- 66,935 mapped reef polygons
# across six coastal counties, with an acreage on every row. The notes from that day record the
# per-zone counts: Savannah 34,216, Ossabaw/St Catherines 23,950, Brunswick/St Simons 9,907,
# Sapelo/Altamaha 9,871.
#
# So a stale claim was read as evidence for itself and written down a second time, harder, as a
# table row -- which is the exact failure THE_DRIVE_HELD_MORE_THAN_THE_PIPELINE_KNEW records about
# this very line. Ryan caught it: "so how do we get oysterbeds for GA... i thought we had them".
# He was right, and the file had been on the drive the whole time. LOOK AT THE DRIVE, NOT AT A
# COMMENT ABOUT THE DRIVE.
OYSTER_SOURCE_BY_STATE = {
    'SC': 'sc',     # SCDNROyster2015Live.geojson         -- SCDNR 2015 live layer
    'NC': 'nc',     # DMF_ReefGuide_*.geojson             -- NCDMF reef guide
    'GA': 'ga',     # georgia_oyster_reef_2015.gpkg       -- 66,935 reef polygons, six counties
}

# ESI layer names — matched to actual GDB contents
# HABITATS = primary habitat polygons (marsh, SAV, beach, etc.)
# ESIL = ESI shoreline lines with habitat coding
# BENTHIC = NC benthic habitat (oyster/shell bottom)
# RESOURCE_POLY = managed resource areas
ESI_HABITAT_LAYERS = ['HABITATS', 'ESIL', 'BENTHIC', 'RESOURCE_POLY']

# NOT A HABITAT LAYER -- a TABLE, and the only place an ESI geodatabase says what any of its
# polygons are. Loaded beside the others and pulled out of the dict before the zone loop,
# because it has no geometry to clip to a bbox.
BIOFILE_LAYER = 'BIOFILE'

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


def process_zone(slug, zone, oyster_sc, oyster_nc, oyster_ga, esi_sc, esi_nc, esi_ga,
                 dry_run=False, skip_upload=False, gz=True):
    state = zone.get('state', '')
    print(f"\n  {slug}: {zone['name']} ({state})")

    results = {}

    # ── Oyster beds ───────────────────────────────────────────────────────────
    # See OYSTER_SOURCE_BY_STATE: Georgia is None on purpose and is SAID rather than searched.
    which = OYSTER_SOURCE_BY_STATE.get(state)
    oyster_src = {'sc': oyster_sc, 'nc': oyster_nc, 'ga': oyster_ga}.get(which)
    if oyster_src is None and state in OYSTER_SOURCE_BY_STATE:
        # The state HAS a source and it did not load -- a missing file or a failed read. That is a
        # different sentence from "this state has no oyster layer", and saying the second one when
        # the first is true is how georgia_oyster_reef_2015.gpkg sat unread for twelve days.
        print(f"    oyster_beds: {state} has a source in OYSTER_SOURCE_BY_STATE and it did not "
              f"load -- check the path printed above. NOT the same as having no oyster data.")
    if oyster_src is not None:
        clipped = clip_to_zone(oyster_src, zone)
        if clipped is not None and len(clipped) >= MIN_FEATURES:
            # Drop tiny slivers below 10 sq meters before simplifying
            clipped = clipped[clipped.geometry.area > 0.000001]
            # Adaptive simplification — increase tolerance until under MAX_SIZE_KB.
            #
            # `clipped` IS REPLACED EVERY TIME, not only on the break. It used to be assigned only
            # inside the `if`, so a zone that never got under the cap wrote the most-simplified
            # geojson (`gj` from the last pass) and then PRINTED the feature count of the
            # unsimplified set beside it. Simplify drops empty geometries, so the two genuinely
            # differ -- the line reported a count for a file that was never written.
            for tolerance in (0.0001, 0.0003, 0.0005, 0.001, 0.002, 0.005):
                simplified = clipped.copy()
                simplified['geometry'] = simplified.geometry.simplify(tolerance, preserve_topology=True)
                simplified = simplified[~simplified.geometry.is_empty]
                gj = gdf_to_geojson(simplified)
                size_kb = len(gj.encode()) // 1024
                clipped = simplified
                if size_kb <= MAX_SIZE_KB:
                    break
                print(f"    oyster_beds: {size_kb} KB at tolerance {tolerance}, trying larger...")
            over = ' — STILL OVER THE CAP' if size_kb > MAX_SIZE_KB else ''
            print(f"    oyster_beds: {len(clipped):,} features ({size_kb} KB, tolerance={tolerance}){over}")
            results['oyster_beds.geojson'] = gj
        else:
            print(f"    oyster_beds: none in bbox")

    # ── ESI habitat layers ────────────────────────────────────────────────────
    esi = esi_sc if state == 'SC' else esi_nc if state == 'NC' else esi_ga if state == 'GA' else {}
    # BIOFILE is a table, not a habitat layer: it has no geometry, so it cannot be clipped to a
    # bbox and must come out before the loop. It is what BENTHIC joins to.
    biofile = None
    for k, v in list(esi.items()):
        if k.upper() == BIOFILE_LAYER:
            biofile = v.drop(columns=[c for c in ('geometry',) if c in v.columns]).to_dict('records')
    for layer_name, gdf in esi.items():
        if layer_name.upper() == BIOFILE_LAYER:
            continue
        clipped = clip_to_zone(gdf, zone)
        if clipped is None or len(clipped) < MIN_FEATURES:
            continue

        layer_upper = layer_name.upper()

        if layer_upper == 'HABITATS':
            # HABITATS in these ESI GDBs is rare species habitat, not marsh/SAV — skip
            print(f"    HABITATS: skipping (rare species layer, not marsh/SAV)")

        elif layer_upper == 'BENTHIC':
            # BENTHIC IS NOT OYSTER, AND IT NEVER WAS. See BENTHIC_SUBELEMENT_FILES above for the
            # measurement: Georgia's 1,208 polygons are hardbottom and North Carolina's 9,750 are
            # four parts submerged aquatic vegetation to one part rock reef. This branch used to
            # write all of it to oyster_beds.geojson, which the map labels "Oyster bed".
            #
            # A BENTHIC FEATURE CLASS CARRIES GEOMETRY AND A RARNUM AND NOTHING ELSE, so the
            # polygons are joined to BIOFILE here before they are written. Without that the file
            # has no attribute a reader could use, which is how nobody noticed for this long.
            if biofile is None:
                print("    BENTHIC: no BIOFILE in this geodatabase — the polygons cannot be "
                      "identified, so nothing is written rather than guessing at them.")
                continue
            clipped['geometry'] = clipped.geometry.simplify(0.0001, preserve_topology=True)
            clipped = clipped[~clipped.geometry.is_empty]
            key = rarnum_column(clipped.head(1).to_dict('records'))
            if not key:
                print("    BENTHIC: no RARNUM column — nothing to join on, nothing written.")
                continue
            # One BIOFILE lookup per RARNUM, not per polygon: GA has 1,208 polygons across 2 keys.
            by_key = {}
            for rec in rows_for_rarnums(biofile, {r.get(key) for r in
                                                  clipped[[key]].to_dict('records')}):
                kcol = rarnum_column([rec])
                k = str(rec.get(kcol)).strip()
                if k.endswith('.0'):
                    k = k[:-2]
                by_key[k] = rec

            buckets, unknown = {}, {}
            for _, row in clipped.iterrows():
                geom = row.geometry
                if geom is None or geom.is_empty:
                    continue
                k = str(row[key]).strip()
                if k.endswith('.0'):
                    k = k[:-2]
                rec = by_key.get(k)
                fname = benthic_class(rec)
                if not fname:
                    sub = (rec or {}).get('SUBELEMENT') or f'RARNUM {k}'
                    unknown[str(sub)] = unknown.get(str(sub), 0) + 1
                    continue
                props = {f: str(rec[f]).strip() for f in BENTHIC_KEEP_FIELDS
                         if rec.get(f) is not None and str(rec[f]).strip() not in ('', 'nan', 'None')}
                props['source_layer'] = 'ESI BENTHIC'
                buckets.setdefault(fname, []).append(
                    {'type': 'Feature', 'geometry': geom.__geo_interface__, 'properties': props})

            for fname, feats in sorted(buckets.items()):
                gj = json.dumps({'type': 'FeatureCollection', 'features': feats},
                                separators=(',', ':'))
                print(f"    {fname}: {len(feats):,} features (BENTHIC, "
                      f"{len({f['properties'].get('NAME') for f in feats})} named type(s))")
                if fname in results:
                    existing = json.loads(results[fname])
                    existing['features'].extend(feats)
                    results[fname] = json.dumps(existing, separators=(',', ':'))
                else:
                    results[fname] = gj
            # A SUBELEMENT NOBODY HAS LOOKED AT IS SAID OUT LOUD, not filed somewhere plausible.
            # That is the exact mistake this branch is being fixed for.
            for sub, n in sorted(unknown.items(), key=lambda kv: -kv[1]):
                print(f"    BENTHIC: {n:,} features of unrecognised subelement '{sub}' — "
                      f"NOT written. Add it to BENTHIC_SUBELEMENT_FILES once somebody has looked.")

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


# ── looking before writing ──────────────────────────────────────────────────────────────────

def layer_value_summary(rows, top=15, max_values_per_col=60):
    """Columns and their commonest values for one layer, as printable lines.

    PURE ON PURPOSE -- it takes a list of plain dicts and returns a list of strings, so the thing
    that decides what a layer CONTAINS can be tested without a geodatabase, geopandas, or the
    1.2 GB oyster file. The GDB read around it is the thin untestable shell.

    WHY THIS EXISTS. The BENTHIC branch below writes an ENTIRE benthic layer to
    oyster_beds.geojson with no filter on what kind of bottom it is, and the map draws that file
    with the tooltip "Oyster bed -- redfish on moving water". That branch was written for North
    Carolina, whose BENTHIC is shell bottom, and never looked at again. Georgia has a BENTHIC
    layer too -- confirmed 2026-09-15 -- and nobody has looked at what is in it. Soft bottom
    drawn and labelled as an oyster rake is a claim the data does not make, and the plan now
    scores oyster off the South Atlantic habitat matrix, so it would be a wrong claim twice.

    A COLUMN WITH A VALUE PER ROW IS AN ID, NOT A CLASSIFICATION, and printing sixty thousand
    distinct values teaches nothing -- those columns are named and skipped.
    """
    lines = []
    if not rows:
        return ['    (no rows)']
    cols = []
    for r in rows:
        for k in r.keys():
            if k not in cols:
                cols.append(k)
    lines.append(f'    {len(rows):,} rows, {len(cols)} columns')
    for c in cols:
        counts = {}
        for r in rows:
            v = r.get(c)
            if v is None or v == '':
                continue
            key = str(v)
            counts[key] = counts.get(key, 0) + 1
        if not counts:
            lines.append(f'      {c}: (all empty)')
            continue
        if len(counts) > max_values_per_col:
            lines.append(f'      {c}: {len(counts):,} distinct values — looks like an id, skipped')
            continue
        ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:top]
        shown = ', '.join(f'{k}={n:,}' for k, n in ordered)
        more = '' if len(counts) <= top else f' … +{len(counts) - top} more'
        lines.append(f'      {c}: {shown}{more}')
    return lines


def rarnum_column(rows):
    """The column that joins this layer to BIOFILE, or None.

    AN ESI FEATURE CLASS CARRIES GEOMETRY AND A KEY, NOT ATTRIBUTES. Measured 2026-09-15 on both
    geodatabases: NC BENTHIC is 9,750 rows of three columns -- RARNUM, Shape_Length, Shape_Area --
    and GA BENTHIC is 1,208 rows of the same, spelled SHAPE_Length. Two of the three are geometry
    measurements. The ONLY attribute is RARNUM, and it is a foreign key into the BIOFILE table,
    which is where the species and habitat names live.

    So a reader that takes BENTHIC alone gets polygons whose single property is a number that
    means nothing outside the geodatabase -- which is exactly what this script has been writing to
    oyster_beds.geojson for every NC and GA zone. The map then labels them "Oyster bed" on our
    say-so rather than the data's.

    Case varies BETWEEN the geodatabases -- `Shape_Length` in North Carolina, `SHAPE_Length` in
    Georgia -- so nothing here may match a column name exactly.
    """
    for r in rows:
        for k in r.keys():
            if str(k).strip().upper() == 'RARNUM':
                return k
    return None


def rows_for_rarnums(bio_rows, wanted):
    """The BIOFILE rows a set of RARNUMs points at.

    Pure, so the join can be tested without a geodatabase. Compared as STRINGS: the key arrives as
    an int from one layer and can arrive as a float or a string from the other, and 236000023 !=
    236000023.0 is how a join silently returns nothing and reads as "no attributes exist".
    """
    want = {str(w).strip() for w in wanted if w is not None and str(w).strip() != ''}
    if not want:
        return []
    col = rarnum_column(bio_rows)
    if not col:
        return []
    out = []
    for r in bio_rows:
        v = r.get(col)
        if v is None:
            continue
        key = str(v).strip()
        if key.endswith('.0'):
            key = key[:-2]
        if key in want:
            out.append(r)
    return out


# What a BENTHIC subelement is, and the file it belongs in. Measured on both geodatabases
# 2026-09-15 by resolving every RARNUM through BIOFILE:
#
#   GA BENTHIC  1,208 polygons, 2 RARNUMs, SUBELEMENT `hardbottom` for BOTH.
#               NAME "Hardbottom community", CONC dense and sparse. No oyster. No shell.
#   NC BENTHIC  9,750 polygons, 5 RARNUMs. Four are SUBELEMENT `sav` -- "Loose watermilfoil"
#               (Myriophyllum laxum) and "Submerged aquatic vegetation" -- and the fifth is
#               `hardbottom`, "Rock reef". No oyster. No shell.
#
# NEITHER BENTHIC LAYER CONTAINS ANY OYSTER, and this script has been writing both of them to
# oyster_beds.geojson. coastal-layers.js draws that file with the tooltip "Oyster bed -- redfish
# on moving water", so every NC and GA zone would have shown milfoil beds and rock reef as oyster
# rakes. Charleston escaped it only because South Carolina has no BENTHIC layer at all and its
# oyster comes from SCDNR's own file.
#
# THE DATA IS GOOD AND THE FILENAME WAS WRONG, which is a much better problem. The South Atlantic
# habitat matrix the plan now reads scores six structure classes, and two of them are exactly
# these: `grass_flat` is SAV, and hard bottom is what a sheepshead wants (`hard` 3.5 against
# `fine` 1.0) and where a red drum spawns. Filed under its own name each one answers a question;
# filed as oyster both of them answer it wrongly.
BENTHIC_SUBELEMENT_FILES = {
    'hardbottom': 'hard_bottom.geojson',
    'sav': 'sav.geojson',
}

# The BIOFILE columns worth carrying onto each polygon. The rest are breeding calendars and empty
# rank fields -- see the --inspect output. Without these the feature has no attribute at all,
# which is the state this whole branch was in.
BENTHIC_KEEP_FIELDS = ('SUBELEMENT', 'NAME', 'GEN_SPEC', 'CONC', 'MAPPING_QUALIFIER')


def benthic_class(record):
    """The output file one BIOFILE record belongs in, or None.

    Pure so the routing can be tested without a geodatabase. `None` means a subelement nobody has
    looked at yet, and the caller SAYS so rather than filing it somewhere plausible -- which is
    the mistake that produced oyster_beds.geojson full of milfoil.
    """
    if not record:
        return None
    sub = None
    for k, v in record.items():
        if str(k).strip().upper() == 'SUBELEMENT':
            sub = str(v or '').strip().lower()
            break
    return BENTHIC_SUBELEMENT_FILES.get(sub)


def inspect_layer(label, zip_path, layer_name, max_rows=200000):
    """Print what one layer of one ESI geodatabase actually holds. Reads nothing else."""
    if not zip_path.exists():
        print(f"{label}: not found at {zip_path}")
        return
    gdb_path, tmp_dir = extract_gdb_from_zip(zip_path)
    try:
        if not gdb_path:
            return
        have = [l for l in list_gdb_layers(gdb_path) if l.upper() == layer_name.upper()]
        if not have:
            print(f"\n{label}: no {layer_name} layer")
            return
        gdf = gpd.read_file(str(gdb_path), layer=have[0], engine="pyogrio")
        print(f"\n{label} — {have[0]}:")
        if gdf.empty:
            print('    (empty)')
            return
        geom = gdf.geometry.name if hasattr(gdf, 'geometry') else None
        flat = gdf.drop(columns=[geom]) if geom and geom in gdf.columns else gdf
        rows = flat.head(max_rows).to_dict('records')
        if len(gdf) > max_rows:
            print(f'    (summarising the first {max_rows:,} of {len(gdf):,} rows)')
        for line in layer_value_summary(rows):
            print(line)

        # AND WHAT THE KEY POINTS AT, because the key on its own is not an answer. See
        # rarnum_column(): an ESI feature class holds geometry and a RARNUM, and every word about
        # what the polygon IS lives in BIOFILE.
        key_col = rarnum_column(rows)
        if key_col:
            bio = [l for l in list_gdb_layers(gdb_path) if l.upper() == 'BIOFILE']
            if not bio:
                print(f'    {key_col} is a key into BIOFILE and this geodatabase has no BIOFILE '
                      f'layer -- the polygons cannot be identified from it at all.')
            else:
                wanted = {r.get(key_col) for r in rows}
                bdf = gpd.read_file(str(gdb_path), layer=bio[0], engine="pyogrio")
                bgeom = getattr(getattr(bdf, 'geometry', None), 'name', None)
                bflat = bdf.drop(columns=[bgeom]) if bgeom and bgeom in bdf.columns else bdf
                hits = rows_for_rarnums(bflat.to_dict('records'), wanted)
                print(f'\n    {key_col} resolved through BIOFILE ({len(bdf):,} rows) '
                      f'-> {len(hits):,} matching records for the {len(wanted)} key(s) above:')
                for line in layer_value_summary(hits):
                    print(line)
    finally:
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)


def zones_to_process(args):
    """The (slug, zone) pairs this run will actually touch.

    Pulled out of main() so the SOURCE LOADING can ask it before it reads 340 MB off the drive --
    see the note at its call site. Returns the same list main() always built; the only change is
    that it is built first.
    """
    if getattr(args, 'zone', None):
        if args.zone not in COASTAL_CATALOG:
            print(f"❌ Unknown zone: {args.zone}")
            sys.exit(1)
        return [(args.zone, COASTAL_CATALOG[args.zone])]
    if getattr(args, 'zones', None):
        out = []
        for slug in args.zones:
            if slug not in COASTAL_CATALOG:
                print(f"❌ Unknown zone: {slug}")
                sys.exit(1)
            out.append((slug, COASTAL_CATALOG[slug]))
        return out
    return list(COASTAL_CATALOG.items())


def main():
    ap = argparse.ArgumentParser(description='Extract coastal habitat data for TrollMap')
    ap.add_argument('--zone',        help='Process single zone by slug')
    ap.add_argument('--zones',       nargs='+', help='Process multiple zones by slug')
    ap.add_argument('--dry-run',     action='store_true')
    ap.add_argument('--no-gzip',     action='store_true',
                    help='upload raw -- only if the Worker predates r2Body()')
    ap.add_argument('--skip-upload', action='store_true', help='Save locally instead of uploading')
    ap.add_argument('--list-layers', action='store_true', help='List ESI GDB layers and exit')
    ap.add_argument('--inspect', metavar='LAYER',
                    help='Print one ESI layer\'s columns and commonest values, then exit. '
                         'Use before trusting a layer -- see layer_value_summary().')
    args = ap.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # ── Inspect one layer ─────────────────────────────────────────────────────
    if args.inspect:
        for label, zip_path in [('SC ESI', SC_ESI_ZIP), ('NC ESI', NC_ESI_ZIP), ('GA ESI', GA_ESI_ZIP)]:
            inspect_layer(label, zip_path, args.inspect)
        return

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

    # ── Which zones, BEFORE anything is loaded ────────────────────────────────
    #
    # Ryan, 2026-09-15: "why am i extracting NC coastal information when there are no NC coastal
    # zones in the app anymore?" He was right. The app offers thirteen coastal zones and every one
    # of them is SC or GA -- coastal_catalog.py carries exactly those thirteen -- so no North
    # Carolina zone has been PROCESSED for some time. But this function loaded all five sources
    # unconditionally before it looked at the zone list, so every run still unzipped and read
    # NCarolina_2016_GDB.zip: 340 MB off the drive, a GDB extract and four layer reads, for zones
    # that do not exist.
    #
    # A SOURCE IS LOADED WHEN A ZONE IN THIS RUN NEEDS IT. Nothing else changes -- the NC rows
    # stay in OYSTER_SOURCE_BY_STATE and in the ESI table, because they are correct and a zone
    # list that regains North Carolina must keep working. What is dropped is reading a file for
    # a state nobody asked about, which is the same rule the rest of this pipeline keeps.
    zones = zones_to_process(args)
    states = {z.get('state', '') for _, z in zones}
    print(f"States in this run: {', '.join(sorted(s for s in states if s)) or '(none)'}")

    # ── Load source data ──────────────────────────────────────────────────────
    print("Loading source data...")

    # SC oyster
    oyster_sc = None
    if 'SC' not in states:
        print("  SC oyster: no South Carolina zone in this run — not loaded")
    elif SC_OYSTER_FILE.exists():
        print(f"  Loading SC oyster ({SC_OYSTER_FILE.stat().st_size // 1024 // 1024} MB)...")
        oyster_sc = gpd.read_file(str(SC_OYSTER_FILE), engine="pyogrio")
        print(f"  SC oyster: {len(oyster_sc):,} features")
    else:
        print(f"  ⚠️  SC oyster not found: {SC_OYSTER_FILE}")

    # NC reef/oyster
    oyster_nc = None
    if 'NC' not in states:
        print("  NC reef guide: no North Carolina zone in this run — not loaded")
    elif NC_REEF_FILE.exists():
        print(f"  Loading NC reef guide...")
        oyster_nc = gpd.read_file(str(NC_REEF_FILE), engine="pyogrio")
        print(f"  NC reef/oyster: {len(oyster_nc):,} features")
    else:
        print(f"  ⚠️  NC reef file not found: {NC_REEF_FILE}")

    # GA oyster — a GeoPackage rather than a geojson, and in its own folder.
    oyster_ga = None
    if 'GA' not in states:
        print("  GA oyster: no Georgia zone in this run — not loaded")
    elif GA_OYSTER_FILE.exists():
        print(f"  Loading GA oyster ({GA_OYSTER_FILE.stat().st_size // 1024 // 1024} MB)...")
        oyster_ga = gpd.read_file(str(GA_OYSTER_FILE), engine="pyogrio")
        print(f"  GA oyster: {len(oyster_ga):,} reef polygons")
    else:
        print(f"  ⚠️  GA oyster not found: {GA_OYSTER_FILE}")

    # SC ESI
    esi_sc = {}
    tmp_sc = None
    if 'SC' not in states:
        print("  SC ESI: no SC zone in this run — the geodatabase is not unzipped")
    elif SC_ESI_ZIP.exists():
        gdb_path, tmp_sc = extract_gdb_from_zip(SC_ESI_ZIP)
        if gdb_path:
            esi_sc = load_esi_layers(gdb_path, ESI_HABITAT_LAYERS + [BIOFILE_LAYER])
    else:
        print(f"  ⚠️  SC ESI not found: {SC_ESI_ZIP}")
        tmp_sc = None

    # NC ESI
    esi_nc = {}
    tmp_nc = None
    if 'NC' not in states:
        print("  NC ESI: no NC zone in this run — the geodatabase is not unzipped")
    elif NC_ESI_ZIP.exists():
        gdb_path, tmp_nc = extract_gdb_from_zip(NC_ESI_ZIP)
        if gdb_path:
            esi_nc = load_esi_layers(gdb_path, ESI_HABITAT_LAYERS + [BIOFILE_LAYER])
    else:
        print(f"  ⚠️  NC ESI not found: {NC_ESI_ZIP}")
        tmp_nc = None

    # GA ESI
    esi_ga = {}
    tmp_ga = None
    if 'GA' not in states:
        print("  GA ESI: no GA zone in this run — the geodatabase is not unzipped")
    elif GA_ESI_ZIP.exists():
        gdb_path, tmp_ga = extract_gdb_from_zip(GA_ESI_ZIP)
        if gdb_path:
            esi_ga = load_esi_layers(gdb_path, ESI_HABITAT_LAYERS + [BIOFILE_LAYER])
    else:
        print(f"  ⚠️  GA ESI not found: {GA_ESI_ZIP}")
        tmp_ga = None

    # ── Process zones ─────────────────────────────────────────────────────────
    # `zones` was resolved above, before a byte was read. See zones_to_process().
    print(f"\n{'='*60}")
    print(f"Processing {len(zones)} zones...")
    if args.dry_run:
        print("Mode: DRY RUN")
    elif args.skip_upload:
        print(f"Mode: LOCAL SAVE → {OUTPUT_DIR}")

    total = 0
    for slug, zone in zones:
        n = process_zone(slug, zone, oyster_sc, oyster_nc, oyster_ga, esi_sc, esi_nc, esi_ga,
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
