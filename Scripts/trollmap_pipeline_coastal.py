#!/usr/bin/env python3
"""
trollmap_pipeline_coastal.py — TrollMap Coastal Zone Extraction Pipeline

Extracts depth contours + supplemental layers for SC/GA coastal zones from
the murray_marion_moultrie i-Boating PBF cache (which covers the coast).

Output structure matches upload_to_r2.py expectations:
  I-Boating Contours and supplemental data/       (renamed by Ryan from split_output3)
    {zone_key}.geojson                      ← contours (uploaded as {zone_key}/contours.geojson)
    supplemental/
      {zone_key}/
        depth_areas.geojson
        fishing_lines.geojson
        fishing_points.geojson
        pois.geojson
        shoreline.geojson

Usage:
    python trollmap_pipeline_coastal.py
    python trollmap_pipeline_coastal.py --zone coast_charleston_sc
    python trollmap_pipeline_coastal.py --zooms 14 15 16
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
    from coastal_catalog import COASTAL_CATALOG
except ImportError:
    print("ERROR: coastal_catalog.py not found in same directory")
    sys.exit(1)

# ── Config ────────────────────────────────────────────────────────────────────
#
# OUTPUT_DIR SAID split_output3 UNTIL 2026-08-20 AND THAT DIRECTORY WAS NEVER DELETED.
# Ryan renamed it: "i renamed split_output3 to its current name which is I-Boating Contours
# and supplemental data". On 2026-08-19 I read the missing name as a missing directory and
# wrote "gone for weeks" into three checkers as a retirement reason. Missing is not renamed,
# the same way missing is not stale.
#
# WHAT THIS SCRIPT IS, because I got it wrong on 2026-08-20 and Ryan caught it.
#
# I called it "the third rival coastal path" and asked whether it should be retired. It is not
# a path to R2 at all -- there is no wrangler call, no upload, no subprocess in this file. It
# READS iboating_pbf_cache and WRITES geojson to disk. Ryan: "i dont think you meant this
# script... that script is the one to create the files... i think you meant the coastal r2
# upload script". He is right. The ungated-second-road indictment belongs to
# upload_to_r2_coastal.py, which was retired 2026-08-19. This one was never a candidate.
#
# It is the opposite of retirable: it is the REGENERATOR. r2_vs_local.py's PROTECTED set used
# to say fishing_lines and fishing_points "live in R2 and nowhere else... there is no pipeline
# replacement for them". This script and its lakes counterpart, trollmap_pipeline.py, are the
# replacement, and iboating_pbf_cache is the source. That is the whole reason those layers now
# pass the test Ryan set for osm-structures on 08-13: the script and the source on the drive.
#
# THE ACTUAL GAP IS THE OTHER END, and it is not this file's problem to fix. Nothing uploads
# these four layers any more. upload_garmin_to_r2.py's LAYERS does not contain shoreline,
# depth_soundings, fishing_lines or fishing_points -- checked 2026-08-20 -- so a regenerated
# tree has no route to R2 today. The 131 objects already in the bucket got there through the
# retired uploader. If those layers ever need re-pushing, that is a decision about an UPLOADER.
#
# READ THIS BEFORE RUNNING, which is a separate matter and still true. That tree stopped being
# scratch output the moment SOURCE_MAP named it: it is the local home of 131 R2 objects --
# 81 shoreline, 20 depth_soundings, 15 fishing_lines, 15 fishing_points -- whose R2 copies are
# judged recoverable BECAUSE these files exist. So this script is a writer sitting on top of a
# backup. A run that produces anything different from what is there -- a changed cache, a
# changed threshold, one zone instead of all -- overwrites the copy the prune already counted.
# Copy the tree aside first.
# RENAMED 2026-08-20. Ryan: "we probably need to rename that folder... that is the
# i-boating pbf cache". It sat beside osm_pbf/ wearing the generic name, which is how a
# 0.57 GB tile cache of i-Boating vector tiles reads as scratch. 71,400 .pbf tiles in
# {region}/{z}/{x}/{y}.pbf across seven regions; PBF_FOLDERS below names four of them.
#
# This rename was done the other way round from split_output3: the readers were repointed
# first, then the directory moved, and both are recorded here so a future grep that comes
# up empty on 'pbf_cache' finds the reason instead of concluding the data is gone.
PBF_CACHE   = Path(r'F:\TrollMapPipeline\iboating_pbf_cache')
OUTPUT_DIR  = Path(r'F:\TrollMapPipeline\I-Boating Contours and supplemental data')
DEFAULT_ZOOMS = None  # scan all available zooms
MIN_CONTOUR_FEATURES = 5  # lower threshold for coastal — zones may be sparse

# PBF folders covering coastal zones
PBF_FOLDERS = [
    {'folder': PBF_CACHE / 'murray_marion_moultrie',             'label': 'Murray / Marion / Moultrie / SC+GA Coast'},
    {'folder': PBF_CACHE / 'NC_coastal_southern',                'label': 'NC Coastal Southern (Myrtle Beach to Wilmington)'},
    {'folder': PBF_CACHE / 'NC__eastern_lakes_coastal_northern', 'label': 'NC Eastern / Coastal Northern'},
    {'folder': PBF_CACHE / 'Georgia_coastal',                    'label': 'Georgia Coastal'},
]

METERS_TO_FEET = 3.28084

POI_TYPE_MAP = {
    'wateraccess':        'boat_ramp',
    'fishattractor':      'fish_attractor',
    'gnis':               'place_name',
    'boatramp':           'boat_ramp',
    'danger_buoy':        'danger_buoy',
    'caution_buoy':       'caution_buoy',
    'slow_no_wake_buoy':  'slow_no_wake',
    'boats_keep_out_buoy':'restricted_area',
    'BCNLAT':             'nav_beacon',
    'LIGHTS':             'nav_light',
    'BOYSPP':             'nav_buoy',
    'BOYLAT':             'nav_buoy',
    'DISMAR':             'mile_marker',
}

# ── Tile math ─────────────────────────────────────────────────────────────────
def make_transformer(x, y, z):
    n = 2.0 ** z
    def t(px, py):
        lon = (x + px / 4096.0) / n * 360.0 - 180.0
        lat_rad = math.atan(math.sinh(math.pi * (1.0 - 2.0 * (y + py / 4096.0) / n)))
        lat = math.degrees(lat_rad)
        return round(lon, 7), round(lat, 7)
    return t

def tile_bbox(z, x, y):
    n = 2.0 ** z
    west  = x / n * 360.0 - 180.0
    east  = (x + 1) / n * 360.0 - 180.0
    south = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * (y + 1) / n))))
    north = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * y / n))))
    return south, north, west, east

# ── Zone assignment ───────────────────────────────────────────────────────────
def match_point_to_zone(lon, lat):
    candidates = []
    for key, data in COASTAL_CATALOG.items():
        s, n, w, e = data['bbox']
        if s <= lat <= n and w <= lon <= e:
            clat, clon = data['center']
            dist = math.sqrt((lat - clat)**2 + (lon - clon)**2)
            candidates.append((data.get('priority', 8), -dist, key))
    if not candidates:
        return None
    candidates.sort(reverse=True)
    return candidates[0][2]

def feature_centroid(coords):
    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    return sum(xs) / len(xs), sum(ys) / len(ys)

def feature_rep_point(geom):
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

# ── Cove propagation ──────────────────────────────────────────────────────────
def assign_contours_with_propagation(features, max_cove_dist=0.015):
    print("\n  Locking contours to coastal zone bounding boxes...")
    zone_buckets = defaultdict(list)
    unmatched = []
    core_coords = []
    core_zones = []
    unboxed = []
    unboxed_coords = []

    for f in tqdm(features, desc="Core lock"):
        coords = f.get('geometry', {}).get('coordinates', [])
        if len(coords) < 2:
            unmatched.append(f)
            continue
        cx, cy = feature_centroid(coords)
        zone = match_point_to_zone(cx, cy)
        if zone:
            zone_buckets[zone].append(f)
            core_coords.append((cy, cx))
            core_zones.append(zone)
        else:
            unboxed.append(f)
            unboxed_coords.append((cy, cx))

    print(f"  Core locked: {sum(len(v) for v in zone_buckets.values()):,} | Unboxed: {len(unboxed):,}")

    if unboxed and core_coords:
        print(f"  Propagating {len(unboxed):,} edge contours...")
        if cKDTree is not None:
            tree = cKDTree(core_coords)
            dists, idxs = tree.query(unboxed_coords, k=1)
            propagated = 0
            for i, f in enumerate(unboxed):
                if dists[i] <= max_cove_dist:
                    zone_buckets[core_zones[idxs[i]]].append(f)
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
                    zone_buckets[core_zones[min_idx]].append(f)
                    propagated += 1
                else:
                    unmatched.append(f)
            print(f"  Propagated: {propagated:,} | Truly unmatched: {len(unmatched):,}")
        else:
            unmatched.extend(unboxed)

    return zone_buckets, unmatched

# ── POI normalizer ────────────────────────────────────────────────────────────
def normalize_poi(raw_props, lon, lat, zone_key, zone_name, z):
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
        'zone_key': zone_key, 'zone_name': zone_name,
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
# ── Best zoom pre-scan ────────────────────────────────────────────────────────
def find_best_zoom_per_zone(pbf_folders, zone_filter=None):
    from collections import Counter
    print("\n🔍 Pre-scanning zoom levels for contour density...")
    if zone_filter:
        zones = {zone_filter: COASTAL_CATALOG[zone_filter]} if zone_filter in COASTAL_CATALOG else {}
    else:
        zones = COASTAL_CATALOG
    zoom_counts = {k: Counter() for k in zones}
    for job in pbf_folders:
        folder = Path(job['folder'])
        if not folder.exists(): continue
        for p in folder.rglob('*.pbf'):
            m = re.search(r'[/\\](\d+)[/\\](\d+)[/\\](\d+)\.pbf$', str(p))
            if not m: continue
            z, x, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
            ts, tn, tw, te = tile_bbox(z, x, y)
            matching = [k for k, zc in zones.items()
                       if tw < zc['bbox'][3] and te > zc['bbox'][2]
                       and ts < zc['bbox'][1] and tn > zc['bbox'][0]]
            if not matching: continue
            try:
                with open(p, 'rb') as f:
                    tile = mapbox_vector_tile.decode(f.read())
            except Exception: continue
            n = len(tile.get('layer_depcnt', {}).get('features', []))
            if n == 0: continue
            for k in matching:
                zoom_counts[k][z] += n
    best_zoom = {}
    for k, counts in zoom_counts.items():
        if counts:
            best = counts.most_common(1)[0][0]
            best_zoom[k] = best
            print(f"  {k}: best zoom={best} ({counts[best]:,} features)")
        else:
            best_zoom[k] = None
    return best_zoom


def extract_all(pbf_folders, zooms, zone_filter=None, best_zoom_map=None, contours_only=False):
    contour_features = []
    depth_areas    = defaultdict(list)
    fishing_lines  = defaultdict(list)
    fishing_points = defaultdict(list)
    pois           = defaultdict(list)
    shorelines     = defaultdict(list)

    seen_contours = set()
    seen_areas    = set()
    seen_fl       = set()
    seen_fp       = set()
    seen_poi      = set()
    seen_shore    = set()

    filter_bbox = None
    if zone_filter:
        zc = COASTAL_CATALOG.get(zone_filter)
        if zc:
            filter_bbox = zc['bbox']
        else:
            print(f"WARNING: zone_filter '{zone_filter}' not in COASTAL_CATALOG")

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
            if zooms is not None and z not in zooms: continue
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

            # Tile-level zoom filter: skip tile if z is not the best zoom
            # for any zone whose bbox overlaps this tile
            if best_zoom_map:
                ts, tn, tw, te = tile_bbox(z, x, y)
                tile_wanted = False
                for zone_key, zc in COASTAL_CATALOG.items():
                    if zone_filter and zone_key != zone_filter:
                        continue
                    fs, fn, fw, fe = zc['bbox']
                    if tw < fe and te > fw and ts < fn and tn > fs:
                        best = best_zoom_map.get(zone_key)
                        if best is None or best == z:
                            tile_wanted = True
                            break
                if not tile_wanted:
                    continue

            try:
                t = make_transformer(x, y, z)
                with open(pbf, 'rb') as f:
                    tile = mapbox_vector_tile.decode(
                        f.read(),
                        default_options={'transformer': t, 'y_coord_down': True}
                    )
            except Exception:
                continue

            # ── Contours ─────────────────────────────────────────────────────
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
                    mid = coords[len(coords) // 2]
                    sig = (round(mid[0], 4), round(mid[1], 4), dft)
                    if sig in seen_contours: continue
                    seen_contours.add(sig)
                    contour_features.append({
                        'type': 'Feature',
                        'geometry': {'type': 'LineString', 'coordinates': coords},
                        'properties': {'depth_ft': dft, 'depth_m': round(float(dm), 3)}
                    })

            # ── Supplemental layers (skipped if contours_only) ────────────────
            if contours_only:
                continue
            for feat in tile.get('layer_areas', {}).get('features', []):
                props = feat.get('properties', {})
                if props.get('type') != 'DEPARE': continue
                geom = feat.get('geometry')
                if not geom or geom['type'] not in ('Polygon', 'MultiPolygon'): continue
                lon, lat = feature_rep_point(geom)
                if lon is None: continue
                zone_key = match_point_to_zone(lon, lat)
                if not zone_key: continue
                sig = (round(lon, 4), round(lat, 4), props.get('real0', 0), props.get('real1', 0))
                if sig in seen_areas: continue
                seen_areas.add(sig)
                depth_areas[zone_key].append({
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
                zone_key = match_point_to_zone(lon, lat)
                if not zone_key: continue
                sig = (round(lon, 5), round(lat, 5))
                if sig in seen_fl: continue
                seen_fl.add(sig)
                fishing_lines[zone_key].append({
                    'type': 'Feature', 'geometry': geom,
                    'properties': {'feature_type': 'fishing_line', 'zone_key': zone_key,
                                   'zone_name': COASTAL_CATALOG[zone_key]['name'], 'source_zoom': z},
                })

            # ── Fishing points ────────────────────────────────────────────────
            for feat in tile.get('layer_fishing_point', {}).get('features', []):
                geom = feat.get('geometry')
                if not geom or geom['type'] != 'Point': continue
                coords = geom.get('coordinates', [])
                pt = coords[0] if isinstance(coords[0], list) else coords
                lon, lat = round(float(pt[0]), 7), round(float(pt[1]), 7)
                zone_key = match_point_to_zone(lon, lat)
                if not zone_key: continue
                sig = (round(lon, 5), round(lat, 5))
                if sig in seen_fp: continue
                seen_fp.add(sig)
                fishing_points[zone_key].append({
                    'type': 'Feature', 'geometry': geom,
                    'properties': {'feature_type': 'fishing_point', 'zone_key': zone_key,
                                   'zone_name': COASTAL_CATALOG[zone_key]['name'], 'source_zoom': z},
                })

            # ── POIs ──────────────────────────────────────────────────────────
            for feat in tile.get('layer_points', {}).get('features', []):
                geom = feat.get('geometry')
                if not geom or geom['type'] != 'Point': continue
                coords = geom.get('coordinates', [])
                if not coords: continue
                lon, lat = round(float(coords[0]), 7), round(float(coords[1]), 7)
                props = feat.get('properties', {})
                raw_type = props.get('type', '')
                # Coastal: include nav aids and buoys in addition to standard POI types
                if raw_type not in ('wateraccess', 'fishattractor', 'gnis',
                                    'boatramp', 'BCNLAT', 'LIGHTS', 'BOYSPP',
                                    'BOYLAT', 'danger_buoy', 'caution_buoy',
                                    'slow_no_wake_buoy', 'DISMAR'): continue
                zone_key = match_point_to_zone(lon, lat)
                if not zone_key: continue
                name = (props.get('frmtd', '') or '').strip()
                sig = (round(lon, 5), round(lat, 5), raw_type, name)
                if sig in seen_poi: continue
                seen_poi.add(sig)
                pois[zone_key].append({
                    'type': 'Feature', 'geometry': geom,
                    'properties': normalize_poi(props, lon, lat, zone_key,
                                                COASTAL_CATALOG[zone_key]['name'], z),
                })

            # ── Shoreline + coastal structures (layer_lines) ──────────────────
            for feat in tile.get('layer_lines', {}).get('features', []):
                props = feat.get('properties', {})
                raw_type = props.get('type', '')
                if raw_type not in ('COALNE', 'COALNE_area', 'pier',
                                    'OBSTRN', 'DRGARE', 'NONEARTHERN_SHORE'): continue
                geom = feat.get('geometry')
                if not geom: continue
                lon, lat = feature_rep_point(geom)
                if lon is None: continue
                zone_key = match_point_to_zone(lon, lat)
                if not zone_key: continue
                sig = (round(lon, 4), round(lat, 4), raw_type)
                if sig in seen_shore: continue
                seen_shore.add(sig)
                is_shoreline = raw_type in ('COALNE', 'COALNE_area', 'NONEARTHERN_SHORE')
                shorelines[zone_key].append({
                    'type': 'Feature', 'geometry': geom,
                    'properties': {
                        'feature_type': 'shoreline' if is_shoreline else raw_type.lower(),
                        'raw_type': raw_type,
                        'zone_key': zone_key,
                        'zone_name': COASTAL_CATALOG[zone_key]['name'],
                        'source_zoom': z,
                    },
                })

            # ── Depth soundings (layer_soundg) ────────────────────────────────
            for feat in tile.get('layer_soundg', {}).get('features', []):
                geom = feat.get('geometry')
                if not geom or geom['type'] != 'Point': continue
                coords = geom.get('coordinates', [])
                if not coords: continue
                lon, lat = round(float(coords[0]), 7), round(float(coords[1]), 7)
                props = feat.get('properties', {})
                dm = props.get('real0')
                if dm is None: continue
                dft = round(float(dm) * METERS_TO_FEET, 1)
                if dft <= 0: continue
                zone_key = match_point_to_zone(lon, lat)
                if not zone_key: continue
                sig = (round(lon, 5), round(lat, 5))
                if sig in seen_fp: continue
                seen_fp.add(sig)
                fishing_points[zone_key].append({
                    'type': 'Feature', 'geometry': geom,
                    'properties': {
                        'feature_type': 'depth_sounding',
                        'depth_ft': dft,
                        'depth_m': round(float(dm), 3),
                        'zone_key': zone_key,
                        'zone_name': COASTAL_CATALOG[zone_key]['name'],
                        'source_zoom': z,
                    },
                })

    return contour_features, depth_areas, fishing_lines, fishing_points, pois, shorelines
def write_geojson(path, features):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'type': 'FeatureCollection', 'features': features}, f, separators=(',', ':'))
    kb = path.stat().st_size / 1024.0
    return f"{kb/1024:.1f}MB" if kb > 1024 else f"{kb:.0f}KB"

def main():
    parser = argparse.ArgumentParser(description="TrollMap Coastal Pipeline")
    parser.add_argument('--output', default=str(OUTPUT_DIR))
    parser.add_argument('--zone', default=None, help='Single zone key to extract')
    parser.add_argument('--zooms', type=int, nargs='+', default=DEFAULT_ZOOMS,
                        help='Zoom levels to scan (default: all)')
    parser.add_argument('--contours-only', action='store_true',
                        help='Extract contours only, skip supplemental layers')
    parser.add_argument('--max-cove-dist', type=float, default=0.015)
    parser.add_argument('--min-features', type=int, default=MIN_CONTOUR_FEATURES)
    args = parser.parse_args()

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)
    supp_dir = out_dir / 'supplemental'
    supp_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 70)
    print("TrollMap Coastal Pipeline — Contours + Supplemental")
    print(f"Output:  {out_dir}")
    print(f"Zooms:   {args.zooms}")
    if args.zone:
        print(f"Filter:  {args.zone}")
    print("=" * 70)

    best_zoom_map = find_best_zoom_per_zone(PBF_FOLDERS, args.zone)

    (contour_features, depth_areas, fishing_lines,
     fishing_points, pois, shorelines) = extract_all(PBF_FOLDERS, args.zooms, args.zone,
                                                      best_zoom_map, contours_only=args.contours_only)

    print(f"\n✅ {len(contour_features):,} contours extracted (fingerprint dedup applied inline)")

    # Assign to zones
    print("\nAssigning contours to coastal zones...")
    contour_buckets, unmatched = assign_contours_with_propagation(contour_features, args.max_cove_dist)

    # Write contours
    print("\n=== Writing contours ===")
    contour_inventory = []
    for zone_key, feats in sorted(contour_buckets.items()):
        if args.zone and zone_key != args.zone:
            continue
        if len(feats) < args.min_features:
            continue
        path = out_dir / f"{zone_key}.geojson"
        size = write_geojson(path, feats)
        depths = sorted(set(round(f['properties'].get('depth_ft', 0)) for f in feats))
        dstr = f"{min(depths)}-{max(depths)}ft" if depths else "?"
        zone_name = COASTAL_CATALOG.get(zone_key, {}).get('name', zone_key)
        print(f"  ✅ {zone_key:<40} {len(feats):>7,} feats  {size:>8}  {dstr}")
        contour_inventory.append({'zone_key': zone_key, 'features': len(feats), 'size': size, 'depths': dstr})

    if unmatched:
        path = out_dir / '_unmatched_coastal.geojson'
        write_geojson(path, unmatched)
        print(f"\n  ⚠️  {len(unmatched):,} unmatched contours → _unmatched_coastal.geojson")

    # Write supplemental
    if args.contours_only:
        print("\n⏭  Skipping supplemental layers (--contours-only)")
    else:
        print("\n=== Writing supplemental layers ===")
        all_zones = sorted(set(
            list(depth_areas) + list(fishing_lines) + list(fishing_points) +
            list(pois) + list(shorelines)
        ))
        supp_inventory = []

        for zone_key in all_zones:
            if args.zone and zone_key != args.zone:
                continue
            zone_name = COASTAL_CATALOG.get(zone_key, {}).get('name', zone_key)
            da = depth_areas.get(zone_key, [])
            fl = fishing_lines.get(zone_key, [])
            fp = fishing_points.get(zone_key, [])
            po = pois.get(zone_key, [])
            sh = shorelines.get(zone_key, [])
            total = len(da) + len(fl) + len(fp) + len(po) + len(sh)
            if total == 0:
                continue

            zone_supp_dir = supp_dir / zone_key
            print(f"\n  ✅ {zone_key} ({zone_name})")

            if da:
                s = write_geojson(zone_supp_dir / 'depth_areas.geojson', da)
                print(f"    depth_areas    {len(da):>6,}  {s}")
            if fl:
                s = write_geojson(zone_supp_dir / 'fishing_lines.geojson', fl)
                print(f"    fishing_lines  {len(fl):>6,}  {s}")
            if fp:
                soundings = [f for f in fp if f['properties'].get('feature_type') == 'depth_sounding']
                pts = [f for f in fp if f['properties'].get('feature_type') != 'depth_sounding']
                if pts:
                    s = write_geojson(zone_supp_dir / 'fishing_points.geojson', pts)
                    print(f"    fishing_points {len(pts):>6,}  {s}")
                if soundings:
                    s = write_geojson(zone_supp_dir / 'depth_soundings.geojson', soundings)
                    print(f"    depth_soundings {len(soundings):>5,}  {s}")
            if po:
                s = write_geojson(zone_supp_dir / 'pois.geojson', po)
                print(f"    pois           {len(po):>6,}  {s}")
            if sh:
                s = write_geojson(zone_supp_dir / 'shoreline.geojson', sh)
                print(f"    shoreline      {len(sh):>6,}  {s}")

            supp_inventory.append({
                'zone_key': zone_key, 'zone_name': zone_name,
                'depth_areas': len(da), 'fishing_lines': len(fl),
                'fishing_points': len(fp), 'pois': len(po), 'shoreline': len(sh),
            })

        with open(out_dir / '_contour_inventory_coastal.json', 'w') as f:
            json.dump(contour_inventory, f, indent=2)
        with open(supp_dir / '_supplemental_inventory_coastal.json', 'w') as f:
            json.dump(supp_inventory, f, indent=2)

        print(f"\n{'='*70}")
        print(f"Done. {len(contour_inventory)} zones with contours, {len(supp_inventory)} zones with supplemental.")
        print(f"Output: {out_dir}")
        print(f"{'='*70}")

if __name__ == '__main__':
    main()
