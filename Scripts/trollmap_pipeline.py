#!/usr/bin/env python3
"""
trollmap_pipeline.py — Unified TrollMap Extraction Pipeline

Single pass over all 4 PBF cache folders extracts BOTH:
  - Depth contours (layer_depcnt) → {lake_key}/contours.geojson
  - Supplemental layers:
      depth_areas     (layer_areas DEPARE polygons)
      fishing_lines   (layer_fishing_line)
      fishing_points  (layer_fishing_point)
      pois            (layer_points: ramps, attractors, place names)
      shoreline       (layer_lines COALNE)

Output structure matches R2 upload expectations:
  split_output3/
    {lake_key}.geojson                     ← contours (uploaded as {lake_key}/contours.geojson)
    supplemental/
      {lake_key}/
        depth_areas.geojson
        fishing_lines.geojson
        fishing_points.geojson
        pois.geojson
        shoreline.geojson
    supplemental/_all/
        pois.geojson                       ← all POIs combined

Usage:
    python trollmap_pipeline.py
    python trollmap_pipeline.py --lake lake_wateree_fishing_creek
    python trollmap_pipeline.py --zooms 14 15 16
    python trollmap_pipeline.py --output F:\\TrollMapPipeline\\split_output3
"""

import argparse
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

try:
    from tqdm import tqdm
except ImportError:
    def tqdm(it, **kw):
        total = kw.get('total') or (len(it) if hasattr(it, '__len__') else None)
        desc = kw.get('desc', '')
        for i, x in enumerate(it):
            if total and i % 10000 == 0:
                print(f"  {desc}: {i:,}/{total:,} ({100*i//total}%)", end='\r')
            yield x
        print()

try:
    import numpy as np
except ImportError:
    np = None

try:
    from scipy.spatial import cKDTree
except ImportError:
    cKDTree = None

try:
    import mapbox_vector_tile
except ImportError:
    print("ERROR: pip install mapbox-vector-tile")
    sys.exit(1)

try:
    from lake_catalog import LAKE_CATALOG
except ImportError:
    print("ERROR: lake_catalog.py not found in same directory")
    sys.exit(1)

# ── Config ────────────────────────────────────────────────────────────────────
PBF_CACHE   = Path(r'F:\TrollMapPipeline\pbf_cache')
OUTPUT_DIR  = Path(r'F:\TrollMapPipeline\split_output3')
DEFAULT_ZOOMS = [14, 15, 16, 17]
MIN_CONTOUR_FEATURES = 10

PBF_FOLDERS = [
    {'folder': PBF_CACHE / 'monticello_parr_wateree',  'label': 'Monticello / Parr / Wateree'},
    {'folder': PBF_CACHE / 'murray_marion_moultrie',   'label': 'Murray / Marion / Moultrie'},
    {'folder': PBF_CACHE / 'Georgia',                  'label': 'Georgia'},
    {'folder': PBF_CACHE / 'Knoxville_western NC_TN',  'label': 'Knoxville / W. NC / TN'},
]

METERS_TO_FEET = 3.28084

POI_TYPE_MAP = {
    'wateraccess':   'boat_ramp',
    'fishattractor': 'fish_attractor',
    'gnis':          'place_name',
}

# ── Tile math ─────────────────────────────────────────────────────────────────
def make_transformer(x, y, z):
    """Exact Spherical Mercator tile → (lon, lat)."""
    n = 2.0 ** z
    def t(px, py):
        lon = (x + px / 4096.0) / n * 360.0 - 180.0
        lat_rad = math.atan(math.sinh(math.pi * (1.0 - 2.0 * (y + py / 4096.0) / n)))
        lat = math.degrees(lat_rad)
        return round(lon, 7), round(lat, 7)
    return t

def tile_bbox(z, x, y):
    """Return (south, north, west, east) for a tile."""
    n = 2.0 ** z
    west  = x / n * 360.0 - 180.0
    east  = (x + 1) / n * 360.0 - 180.0
    south = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * (y + 1) / n))))
    north = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * y / n))))
    return south, north, west, east

# ── Lake assignment ───────────────────────────────────────────────────────────
def match_point_to_lake(lon, lat):
    candidates = []
    for key, data in LAKE_CATALOG.items():
        s, n, w, e = data['bbox']
        if s <= lat <= n and w <= lon <= e:
            clat, clon = data['center']
            dist = math.sqrt((lat - clat)**2 + (lon - clon)**2)
            candidates.append((data.get('priority', 10), -dist, key))
    if not candidates:
        return None
    candidates.sort(reverse=True)
    return candidates[0][2]

def feature_centroid(coords):
    """Mean centroid of a LineString coordinate list."""
    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    return sum(xs) / len(xs), sum(ys) / len(ys)

def feature_rep_point(geom):
    """Representative (lon, lat) for any geometry."""
    gtype = geom.get('type', '')
    coords = geom.get('coordinates', [])
    if gtype == 'Point':
        return round(float(coords[0]), 7), round(float(coords[1]), 7)
    elif gtype in ('LineString', 'MultiPoint'):
        pts = coords
        mid = pts[len(pts) // 2]
        return round(float(mid[0]), 7), round(float(mid[1]), 7)
    elif gtype in ('Polygon', 'MultiLineString'):
        ring = coords[0] if coords else []
        if not ring: return None, None
        xs = [c[0] for c in ring]
        ys = [c[1] for c in ring]
        return round(sum(xs)/len(xs), 7), round(sum(ys)/len(ys), 7)
    elif gtype == 'MultiPolygon':
        ring = coords[0][0] if coords and coords[0] else []
        if not ring: return None, None
        xs = [c[0] for c in ring]
        ys = [c[1] for c in ring]
        return round(sum(xs)/len(xs), 7), round(sum(ys)/len(ys), 7)
    return None, None

# ── Cove propagation for contours ─────────────────────────────────────────────
def assign_contours_with_propagation(features, max_cove_dist=0.015):
    """Core-lock + nearest-neighbour cove propagation (same as original pipeline)."""
    print("\n  Locking contours to lake bounding boxes...")
    lake_buckets = defaultdict(list)
    unmatched = []
    core_coords = []
    core_lakes = []
    unboxed = []
    unboxed_coords = []

    for f in tqdm(features, desc="Core lock"):
        coords = f.get('geometry', {}).get('coordinates', [])
        if len(coords) < 2:
            unmatched.append(f)
            continue
        cx, cy = feature_centroid(coords)
        lake = match_point_to_lake(cx, cy)
        if lake:
            lake_buckets[lake].append(f)
            core_coords.append((cy, cx))
            core_lakes.append(lake)
        else:
            unboxed.append(f)
            unboxed_coords.append((cy, cx))

    print(f"  Core locked: {sum(len(v) for v in lake_buckets.values()):,} | Unboxed: {len(unboxed):,}")

    if unboxed and core_coords:
        print(f"  Propagating {len(unboxed):,} cove contours...")
        if cKDTree is not None:
            tree = cKDTree(core_coords)
            dists, idxs = tree.query(unboxed_coords, k=1)
            propagated = 0
            for i, f in enumerate(unboxed):
                if dists[i] <= max_cove_dist:
                    lake_buckets[core_lakes[idxs[i]]].append(f)
                    propagated += 1
                else:
                    unmatched.append(f)
            print(f"  Propagated: {propagated:,} | Truly unmatched: {len(unmatched):,}")
        elif np is not None:
            core_arr = np.array(core_coords, dtype=np.float32)
            r_sq = max_cove_dist ** 2
            propagated = 0
            for i, f in enumerate(tqdm(unboxed, desc="NumPy propagation")):
                pt = unboxed_coords[i]
                dists_sq = (core_arr[:, 0] - pt[0])**2 + (core_arr[:, 1] - pt[1])**2
                min_idx = int(np.argmin(dists_sq))
                if dists_sq[min_idx] <= r_sq:
                    lake_buckets[core_lakes[min_idx]].append(f)
                    propagated += 1
                else:
                    unmatched.append(f)
            print(f"  Propagated: {propagated:,} | Truly unmatched: {len(unmatched):,}")
        else:
            unmatched.extend(unboxed)

    return lake_buckets, unmatched

# ── POI normalizer ────────────────────────────────────────────────────────────
def normalize_poi(raw_props, lon, lat, lake_key, lake_name, z):
    raw_type = raw_props.get('type', '')
    poi_type = POI_TYPE_MAP.get(raw_type, raw_type)
    name = (raw_props.get('frmtd', '') or raw_props.get('ltxt1', '') or '').strip()
    icon = raw_props.get('imak', '')
    ramp_subtype = None
    if poi_type == 'boat_ramp':
        ramp_subtype = 'trailer_ramp' if 'trailer' in icon else 'generic_ramp' if 'generic' in icon else 'water_access'
    return {
        'poi_type': poi_type, 'raw_type': raw_type, 'name': name,
        'icon': icon, 'ramp_subtype': ramp_subtype,
        'lake_key': lake_key, 'lake_name': lake_name,
        'lon': lon, 'lat': lat, 'source_zoom': z,
    }

def depare_props(raw_props):
    r0 = raw_props.get('real0')
    r1 = raw_props.get('real1')
    return {
        'depth_min_ft': round(float(r0) * METERS_TO_FEET, 1) if r0 is not None else None,
        'depth_max_ft': round(float(r1) * METERS_TO_FEET, 1) if r1 is not None else None,
        'depth_min_m':  round(float(r0), 3) if r0 is not None else None,
        'depth_max_m':  round(float(r1), 3) if r1 is not None else None,
        'color_code':   raw_props.get('color', ''),
        'feature_type': 'DEPARE',
    }

# ── Main extraction ───────────────────────────────────────────────────────────
def extract_all(pbf_folders, zooms, lake_filter=None):
    """
    Single pass over all PBF folders extracting contours + supplemental.
    Returns:
      contour_features  — flat list (assigned later)
      depth_areas       — defaultdict(list) keyed by lake_key
      fishing_lines     — defaultdict(list)
      fishing_points    — defaultdict(list)
      pois              — defaultdict(list)
      shorelines        — defaultdict(list)
    """
    contour_features = []

    depth_areas    = defaultdict(list)
    fishing_lines  = defaultdict(list)
    fishing_points = defaultdict(list)
    pois           = defaultdict(list)
    shorelines     = defaultdict(list)

    # Dedup signatures
    seen_contours = set()
    seen_areas    = set()
    seen_fl       = set()
    seen_fp       = set()
    seen_poi      = set()
    seen_shore    = set()

    # Lake filter bbox for tile pre-filtering
    filter_bbox = None
    if lake_filter:
        lc = LAKE_CATALOG.get(lake_filter)
        if lc:
            filter_bbox = lc['bbox']  # (south, north, west, east)
        else:
            print(f"WARNING: lake_filter '{lake_filter}' not in LAKE_CATALOG")

    for job in pbf_folders:
        folder = Path(job['folder'])
        label  = job['label']

        if not folder.exists():
            print(f"  ⚠️  Not found: {folder}")
            continue

        all_pbf = list(folder.rglob('*.pbf'))
        target = []
        for p in all_pbf:
            m = re.search(r'[/\\](\d+)[/\\](\d+)[/\\](\d+)\.pbf$', str(p))
            if not m: continue
            z = int(m.group(1))
            if z not in zooms: continue
            if filter_bbox:
                tz, tx, ty = z, int(m.group(2)), int(m.group(3))
                ts, tn, tw, te = tile_bbox(tz, tx, ty)
                fs, fn, fw, fe = filter_bbox
                if tw >= fe or te <= fw or ts >= fn or tn <= fs:
                    continue
            target.append(p)

        print(f"\n📁 {label} — {len(target):,} tiles")

        for pbf in tqdm(target, desc=label):
            m = re.search(r'[/\\](\d+)[/\\](\d+)[/\\](\d+)\.pbf$', str(pbf))
            if not m: continue
            z, x, y = int(m.group(1)), int(m.group(2)), int(m.group(3))

            try:
                t = make_transformer(x, y, z)
                with open(pbf, 'rb') as f:
                    tile = mapbox_vector_tile.decode(
                        f.read(),
                        default_options={'transformer': t, 'y_coord_down': True}
                    )
            except Exception:
                continue

            # ── Contours (layer_depcnt) ───────────────────────────────────────
            for feat in tile.get('layer_depcnt', {}).get('features', []):
                dm = feat['properties'].get('real0')
                if dm is None: continue
                dft = round(float(dm) * METERS_TO_FEET, 1)
                if dft <= 0: continue
                geom = feat['geometry']
                if geom['type'] not in ('LineString', 'MultiLineString'): continue
                lines = [geom['coordinates']] if geom['type'] == 'LineString' else geom['coordinates']
                for line in lines:
                    if len(line) < 2: continue
                    coords = [[round(float(c[0]), 7), round(float(c[1]), 7)] for c in line]
                    if len(coords) < 2: continue
                    # Dedup: sample 5 points
                    n_pts = len(coords)
                    sample = [coords[0], coords[n_pts//4], coords[n_pts//2], coords[3*n_pts//4], coords[-1]]
                    sig = tuple(round(p[i], 4) for p in sample for i in range(2)) + (dft,)
                    if sig in seen_contours: continue
                    seen_contours.add(sig)
                    contour_features.append({
                        'type': 'Feature',
                        'geometry': {'type': 'LineString', 'coordinates': coords},
                        'properties': {'depth_ft': dft, 'depth_m': round(float(dm), 3)}
                    })

            # ── Depth areas (layer_areas DEPARE) ─────────────────────────────
            for feat in tile.get('layer_areas', {}).get('features', []):
                props = feat.get('properties', {})
                if props.get('type') != 'DEPARE': continue
                geom = feat.get('geometry')
                if not geom or geom['type'] not in ('Polygon', 'MultiPolygon'): continue
                lon, lat = feature_rep_point(geom)
                if lon is None: continue
                lake_key = match_point_to_lake(lon, lat)
                if not lake_key: continue
                sig = (round(lon, 4), round(lat, 4), props.get('real0', 0), props.get('real1', 0))
                if sig in seen_areas: continue
                seen_areas.add(sig)
                depth_areas[lake_key].append({
                    'type': 'Feature', 'geometry': geom,
                    'properties': depare_props(props),
                })

            # ── Fishing lines ─────────────────────────────────────────────────
            for feat in tile.get('layer_fishing_line', {}).get('features', []):
                geom = feat.get('geometry')
                if not geom or geom['type'] not in ('LineString', 'MultiLineString'): continue
                coords = geom.get('coordinates', [])
                line = coords[0] if geom['type'] == 'MultiLineString' and coords else coords
                if not line: continue
                mid = line[len(line) // 2]
                lon, lat = round(float(mid[0]), 7), round(float(mid[1]), 7)
                lake_key = match_point_to_lake(lon, lat)
                if not lake_key: continue
                sig = (round(lon, 5), round(lat, 5))
                if sig in seen_fl: continue
                seen_fl.add(sig)
                fishing_lines[lake_key].append({
                    'type': 'Feature', 'geometry': geom,
                    'properties': {'feature_type': 'fishing_line', 'lake_key': lake_key,
                                   'lake_name': LAKE_CATALOG[lake_key]['name'], 'source_zoom': z},
                })

            # ── Fishing points ────────────────────────────────────────────────
            for feat in tile.get('layer_fishing_point', {}).get('features', []):
                geom = feat.get('geometry')
                if not geom or geom['type'] != 'Point': continue
                coords = geom.get('coordinates', [])
                pt = coords[0] if isinstance(coords[0], list) else coords
                lon, lat = round(float(pt[0]), 7), round(float(pt[1]), 7)
                lake_key = match_point_to_lake(lon, lat)
                if not lake_key: continue
                sig = (round(lon, 5), round(lat, 5))
                if sig in seen_fp: continue
                seen_fp.add(sig)
                fishing_points[lake_key].append({
                    'type': 'Feature', 'geometry': geom,
                    'properties': {'feature_type': 'fishing_point', 'lake_key': lake_key,
                                   'lake_name': LAKE_CATALOG[lake_key]['name'], 'source_zoom': z},
                })

            # ── POIs (layer_points) ───────────────────────────────────────────
            for feat in tile.get('layer_points', {}).get('features', []):
                geom = feat.get('geometry')
                if not geom or geom['type'] != 'Point': continue
                coords = geom.get('coordinates', [])
                if not coords: continue
                lon, lat = round(float(coords[0]), 7), round(float(coords[1]), 7)
                props = feat.get('properties', {})
                raw_type = props.get('type', '')
                if raw_type not in ('wateraccess', 'fishattractor', 'gnis'): continue
                lake_key = match_point_to_lake(lon, lat)
                if not lake_key: continue
                name = (props.get('frmtd', '') or '').strip()
                sig = (round(lon, 5), round(lat, 5), raw_type, name)
                if sig in seen_poi: continue
                seen_poi.add(sig)
                pois[lake_key].append({
                    'type': 'Feature', 'geometry': geom,
                    'properties': normalize_poi(props, lon, lat, lake_key,
                                                LAKE_CATALOG[lake_key]['name'], z),
                })

            # ── Shoreline (layer_lines COALNE) ────────────────────────────────
            for feat in tile.get('layer_lines', {}).get('features', []):
                props = feat.get('properties', {})
                if props.get('type') not in ('COALNE', 'COALNE_area'): continue
                geom = feat.get('geometry')
                if not geom: continue
                lon, lat = feature_rep_point(geom)
                if lon is None: continue
                lake_key = match_point_to_lake(lon, lat)
                if not lake_key: continue
                sig = (round(lon, 4), round(lat, 4))
                if sig in seen_shore: continue
                seen_shore.add(sig)
                shorelines[lake_key].append({
                    'type': 'Feature', 'geometry': geom,
                    'properties': {'feature_type': 'shoreline', 'raw_type': props.get('type', ''),
                                   'lake_key': lake_key, 'lake_name': LAKE_CATALOG[lake_key]['name'],
                                   'source_zoom': z},
                })

    return contour_features, depth_areas, fishing_lines, fishing_points, pois, shorelines

# ── Write outputs ─────────────────────────────────────────────────────────────
def write_geojson(path, features):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'type': 'FeatureCollection', 'features': features}, f, separators=(',', ':'))
    kb = path.stat().st_size / 1024.0
    return f"{kb/1024:.1f}MB" if kb > 1024 else f"{kb:.0f}KB"

def main():
    parser = argparse.ArgumentParser(description="TrollMap Unified Pipeline")
    parser.add_argument('--output', default=str(OUTPUT_DIR))
    parser.add_argument('--lake', default=None, help='Single lake key to extract')
    parser.add_argument('--zooms', type=int, nargs='+', default=DEFAULT_ZOOMS)
    parser.add_argument('--max-cove-dist', type=float, default=0.015)
    parser.add_argument('--min-features', type=int, default=MIN_CONTOUR_FEATURES)
    args = parser.parse_args()

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)
    supp_dir = out_dir / 'supplemental'
    supp_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 70)
    print("TrollMap Unified Pipeline — Contours + Supplemental")
    print(f"Output:  {out_dir}")
    print(f"Zooms:   {args.zooms}")
    if args.lake:
        print(f"Filter:  {args.lake}")
    print("=" * 70)

    # ── Step 1: Extract everything ────────────────────────────────────────────
    folders = [job for job in PBF_FOLDERS]
    (contour_features, depth_areas, fishing_lines,
     fishing_points, pois, shorelines) = extract_all(folders, args.zooms, args.lake)

    print(f"\n✅ Extracted {len(contour_features):,} contour features")

    # ── Step 2: Dedup contours (high-detail first) ────────────────────────────
    print("\nDeduplicating contours...")
    contour_features.sort(key=lambda f: -len(f.get('geometry', {}).get('coordinates', [])))
    seen = set()
    deduped = []
    for f in tqdm(contour_features, desc="Dedup"):
        c = f['geometry']['coordinates']
        d = f['properties']['depth_ft']
        n = len(c)
        sample = [c[0], c[n//4], c[n//2], c[3*n//4], c[-1]]
        sig = tuple(round(p[i], 4) for p in sample for i in range(2)) + (d,)
        if sig not in seen:
            seen.add(sig)
            deduped.append(f)
    print(f"  {len(contour_features):,} → {len(deduped):,} after dedup")

    # ── Step 3: Assign contours to lakes ─────────────────────────────────────
    print("\nAssigning contours to lakes...")
    contour_buckets, unmatched = assign_contours_with_propagation(deduped, args.max_cove_dist)

    # ── Step 4: Write contours ────────────────────────────────────────────────
    print("\n=== Writing contours ===")
    contour_inventory = []
    for lake_key, feats in sorted(contour_buckets.items()):
        if args.lake and lake_key != args.lake:
            continue
        if len(feats) < args.min_features:
            continue
        path = out_dir / f"{lake_key}.geojson"
        size = write_geojson(path, feats)
        depths = sorted(set(round(f['properties'].get('depth_ft', 0)) for f in feats))
        dstr = f"{min(depths)}-{max(depths)}ft" if depths else "?"
        lake_name = LAKE_CATALOG.get(lake_key, {}).get('name', lake_key)
        print(f"  ✅ {lake_key:<35} {len(feats):>7,} feats  {size:>8}  {dstr}")
        contour_inventory.append({'lake_key': lake_key, 'features': len(feats), 'size': size, 'depths': dstr})

    if unmatched:
        path = out_dir / '_unmatched.geojson'
        write_geojson(path, unmatched)
        print(f"\n  ⚠️  {len(unmatched):,} unmatched contours → _unmatched.geojson")

    # ── Step 5: Write supplemental ────────────────────────────────────────────
    print("\n=== Writing supplemental layers ===")
    all_lakes = sorted(set(
        list(depth_areas) + list(fishing_lines) + list(fishing_points) +
        list(pois) + list(shorelines)
    ))
    all_pois_combined = []
    supp_inventory = []

    for lake_key in all_lakes:
        if args.lake and lake_key != args.lake:
            continue
        lake_name = LAKE_CATALOG.get(lake_key, {}).get('name', lake_key)
        da = depth_areas.get(lake_key, [])
        fl = fishing_lines.get(lake_key, [])
        fp = fishing_points.get(lake_key, [])
        po = pois.get(lake_key, [])
        sh = shorelines.get(lake_key, [])
        total = len(da) + len(fl) + len(fp) + len(po) + len(sh)
        if total == 0:
            continue

        lake_supp_dir = supp_dir / lake_key
        print(f"\n  ✅ {lake_key} ({lake_name})")

        if da:
            s = write_geojson(lake_supp_dir / 'depth_areas.geojson', da)
            print(f"    depth_areas    {len(da):>6,}  {s}")
        if fl:
            s = write_geojson(lake_supp_dir / 'fishing_lines.geojson', fl)
            print(f"    fishing_lines  {len(fl):>6,}  {s}")
        if fp:
            s = write_geojson(lake_supp_dir / 'fishing_points.geojson', fp)
            print(f"    fishing_points {len(fp):>6,}  {s}")
        if po:
            s = write_geojson(lake_supp_dir / 'pois.geojson', po)
            print(f"    pois           {len(po):>6,}  {s}")
            all_pois_combined.extend(po)
        if sh:
            s = write_geojson(lake_supp_dir / 'shoreline.geojson', sh)
            print(f"    shoreline      {len(sh):>6,}  {s}")

        supp_inventory.append({
            'lake_key': lake_key, 'lake_name': lake_name,
            'depth_areas': len(da), 'fishing_lines': len(fl),
            'fishing_points': len(fp), 'pois': len(po), 'shoreline': len(sh),
        })

    # Combined POI file
    if all_pois_combined:
        all_dir = supp_dir / '_all'
        s = write_geojson(all_dir / 'pois.geojson', all_pois_combined)
        print(f"\n  🗺️  _all/pois.geojson: {len(all_pois_combined):,} total POIs  {s}")

    # Inventories
    with open(out_dir / '_contour_inventory.json', 'w') as f:
        json.dump(contour_inventory, f, indent=2)
    with open(supp_dir / '_supplemental_inventory.json', 'w') as f:
        json.dump(supp_inventory, f, indent=2)

    print(f"\n{'='*70}")
    print(f"Done. {len(contour_inventory)} lakes with contours, {len(supp_inventory)} lakes with supplemental.")
    print(f"Output: {out_dir}")
    print(f"{'='*70}")

if __name__ == '__main__':
    main()
