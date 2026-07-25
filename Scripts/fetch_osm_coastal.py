#!/usr/bin/env python3
"""
fetch_osm_coastal.py — Extracts fishing-relevant OSM structures for TrollMap
coastal/tidal zones using osmconvert64 to clip PBF to zone bbox, then pyosmium
to extract features.

Coastal-specific tags included beyond freshwater:
  - Jetties, breakwaters, groynes
  - Beacons, buoys, nav aids (seamark)
  - Reefs, oyster beds
  - Marinas, fishing spots
  - Boat ramps, docks, piers (same as freshwater)
  - Bridges still included

Usage:
    py fetch_osm_coastal.py
    py fetch_osm_coastal.py --zone coast_charleston_sc
    py fetch_osm_coastal.py --dry-run
    py fetch_osm_coastal.py --list

Requires:
    - osmconvert64.exe in scripts directory
    - pyosmium: pip install osmium --break-system-packages
    - coastal_catalog.py in same directory
    - SC and GA OSM PBF files in F:\\TrollMapPipeline\\osm_pbf\\
"""

import sys
import json
import time
import argparse
import subprocess
import tempfile
from pathlib import Path
from collections import Counter

try:
    import osmium
except ImportError:
    print("pip install osmium --break-system-packages")
    sys.exit(1)

try:
    from coastal_catalog import COASTAL_CATALOG
except ImportError:
    print("ERROR: coastal_catalog.py not found in same directory")
    sys.exit(1)

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPTS_DIR = Path(__file__).parent
PBF_DIR     = Path(r'F:\TrollMapPipeline\osm_pbf')
OSMCONVERT  = SCRIPTS_DIR / 'osmconvert64.exe'
R2_BUCKET   = 'trollmap-chartpacks'
WRANGLER_JS = r'C:\Users\Ryan\AppData\Roaming\npm\node_modules\wrangler\bin\wrangler.js'
TMP_DIR     = Path(r'F:\TrollMapPipeline\osm_tmp')

# SC, GA, and NC PBFs cover the full coastal range
PBF_FILES = [
    PBF_DIR / 'south-carolina-260717.osm.pbf',
    PBF_DIR / 'georgia-260717.osm.pbf',
    PBF_DIR / 'north-carolina-260717.osm.pbf',
]
# ─────────────────────────────────────────────────────────────────────────────


def classify_coastal(tags):
    ww = tags.get('waterway', '')
    mm = tags.get('man_made', '')
    br = tags.get('bridge', '')
    rw = tags.get('railway', '')
    hw = tags.get('highway', '')
    pl = tags.get('place', '')
    nt = tags.get('natural', '')
    sm = tags.get('seamark:type', '')
    le = tags.get('leisure', '')

    if ww in ('dam', 'weir') or mm == 'dam':                   return 'DAM'
    if ww == 'boat_slipway' or le == 'slipway':                return 'BOAT_RAMP'
    if ww in ('dock', 'boatyard') or le == 'marina' \
            or mm == 'marina':                                  return 'MARINA'
    if ww == 'tidal_channel':                                   return 'TIDAL_CHANNEL'
    if mm in ('pier', 'dock'):                                  return 'PIER'
    if mm == 'jetty':                                           return 'JETTY'
    if mm == 'breakwater':                                      return 'BREAKWATER'
    if mm == 'groyne':                                          return 'GROYNE'
    if mm == 'beacon' or sm in ('beacon_cardinal', 'beacon_lateral',
                                 'beacon_safe_water', 'beacon_isolated_danger',
                                 'beacon_special_purpose'):     return 'NAV_BEACON'
    if mm == 'buoy' or sm in ('buoy_cardinal', 'buoy_lateral',
                               'buoy_safe_water', 'buoy_isolated_danger',
                               'buoy_special_purpose'):         return 'NAV_BUOY'
    if sm in ('light', 'light_minor', 'light_vessel'):         return 'NAV_LIGHT'
    if sm == 'mooring':                                         return 'MOORING'
    if sm in ('wreck', 'obstruction'):                         return 'HAZARD'
    if sm == 'landmark':                                        return 'LANDMARK'
    if sm in ('harbour', 'small_craft_facility', 'anchorage'): return 'MARINA'
    if sm in ('navigation_line', 'recommended_track'):         return 'NAV_LINE'
    if nt in ('reef', 'shoal') or sm == 'rock':               return 'REEF_SHOAL'
    if nt in ('rock',) or tags.get('submerged') == 'yes' \
            or tags.get('hazard') == 'navigation':             return 'HAZARD'
    if tags.get('fish_attractor') == 'yes' \
            or le == 'fishing':                                 return 'FISH_ATTRACTOR'
    if nt in ('island', 'coastline', 'beach', 'mud'):         return 'SHORELINE'
    if pl in ('island', 'islet'):                              return 'ISLAND'
    if br == 'yes':
        if rw:                                                  return 'RAIL_BRIDGE'
        if hw in ('footway', 'path', 'pedestrian'):            return 'FOOT_BRIDGE'
        if hw:                                                  return 'ROAD_BRIDGE'
        return 'BRIDGE'
    return 'OTHER'


def tags_wanted_coastal(tags):
    checks = [
        ('waterway',     {'dam', 'weir', 'boat_slipway', 'dock', 'tidal_channel', 'boatyard'}),
        ('man_made',     {'pier', 'dock', 'jetty', 'groyne', 'breakwater',
                          'buoy', 'beacon', 'marina', 'artificial_reef'}),
        ('leisure',      {'marina', 'fishing', 'slipway'}),
        ('place',        {'island'}),
        ('natural',      {'reef', 'shoal', 'rock', 'island', 'coastline', 'beach', 'mud'}),
        ('fish_attractor', {'yes'}),
        ('submerged',    {'yes'}),
        ('hazard',       {'navigation'}),
    ]
    for key, vals in checks:
        if tags.get(key) in vals:
            return True
    # Any seamark:type tag
    if tags.get('seamark:type'):
        return True
    # Bridges with highway/railway
    if tags.get('bridge') == 'yes' and (tags.get('highway') or tags.get('railway')):
        return True
    return False


def make_feature(tags, osm_type, osm_id, lon, lat):
    t = dict(tags)
    structure_type = classify_coastal(t)
    if structure_type == 'OTHER':
        return None
    props = {
        'structure_type': structure_type,
        'source':         'osm',
        'query_method':   'pbf_clip_coastal',
        'osm_id':         osm_id,
        'osm_type':       osm_type,
    }
    name = t.get('name') or t.get('alt_name') or t.get('ref')
    if name:
        props['name'] = name
    for tag in ('waterway', 'man_made', 'bridge', 'railway', 'highway',
                'place', 'natural', 'leisure', 'operator',
                'seamark:type', 'submerged', 'hazard', 'depth'):
        if tag in t:
            props[tag] = t[tag]
    return {
        'type': 'Feature',
        'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
        'properties': props,
    }


class CoastalStructureHandler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.features = []

    def node(self, n):
        if not tags_wanted_coastal(n.tags):
            return
        try:
            lat = float(n.location.lat)
            lon = float(n.location.lon)
        except Exception:
            return
        feat = make_feature(n.tags, 'node', n.id, lon, lat)
        if feat:
            self.features.append(feat)

    def way(self, w):
        if not tags_wanted_coastal(w.tags):
            return
        try:
            lats = [float(nd.lat) for nd in w.nodes if nd.location.valid()]
            lons = [float(nd.lon) for nd in w.nodes if nd.location.valid()]
        except Exception:
            return
        if not lats:
            return
        feat = make_feature(w.tags, 'way', w.id,
                            sum(lons)/len(lons), sum(lats)/len(lats))
        if feat:
            self.features.append(feat)


def clip_pbf(pbf_path, s, n, w, e, out_path):
    bbox_str = f"{w},{s},{e},{n}"
    cmd = [
        str(OSMCONVERT),
        str(pbf_path),
        '--complete-ways',
        f'-b={bbox_str}',
        f'-o={out_path}',
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=60)
        if result.returncode == 0 and Path(out_path).exists() and Path(out_path).stat().st_size > 0:
            return True
        err = result.stderr.decode('utf-8', errors='replace').strip()
        if err:
            print(f"\n      osmconvert error: {err[:100]}")
        return False
    except subprocess.TimeoutExpired:
        print(f"\n      osmconvert timeout")
        return False
    except FileNotFoundError:
        print(f"\n      osmconvert64.exe not found at {OSMCONVERT}")
        sys.exit(1)


def fetch_structures(slug, zone):
    s, n, w, e = zone['bbox']
    print(f"    bbox: S{s:.4f} N{n:.4f} W{w:.4f} E{e:.4f}")
    print(f"    tide station: {zone.get('tide_station', 'n/a')}")

    TMP_DIR.mkdir(exist_ok=True)
    all_features = []
    seen = set()

    for pbf in PBF_FILES:
        if not pbf.exists():
            print(f"      ⚠️  PBF not found: {pbf.name}")
            continue

        clipped = TMP_DIR / f"{slug}_{pbf.stem}.osm.pbf"
        ok = clip_pbf(pbf, s, n, w, e, clipped)
        if not ok:
            continue

        size_kb = clipped.stat().st_size // 1024
        print(f"      {pbf.stem}: clipped to {size_kb} KB", end=' ', flush=True)

        if size_kb < 1:
            print("(empty)")
            clipped.unlink(missing_ok=True)
            continue

        handler = CoastalStructureHandler()
        handler.apply_file(str(clipped), locations=True)
        clipped.unlink(missing_ok=True)

        new = 0
        for feat in handler.features:
            fid = f"{feat['properties']['osm_type']}/{feat['properties']['osm_id']}"
            if fid in seen:
                continue
            seen.add(fid)
            all_features.append(feat)
            new += 1
        print(f"→ {new} features")

    return all_features


def upload_to_r2(slug, geojson_str, dry_run=False):
    r2_key = f"{slug}/osm-structures.geojson"
    size_kb = len(geojson_str.encode()) // 1024
    tmp = Path(f'_osm_tmp_{slug}.geojson')
    tmp.write_text(geojson_str, encoding='utf-8')
    print(f"    uploading {r2_key} ({size_kb} KB) ...", end=' ', flush=True)

    if dry_run:
        tmp.unlink()
        print("DRY RUN")
        return True

    cmd = [
        'node', WRANGLER_JS, 'r2', 'object', 'put', f'{R2_BUCKET}/{r2_key}',
        '--file', str(tmp),
        '--content-type', 'application/json',
        '--remote',
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=120)
        stdout = result.stdout.decode('utf-8', errors='replace')
        stderr = result.stderr.decode('utf-8', errors='replace')
        tmp.unlink()
        if result.returncode == 0 or 'success' in (stdout + stderr).lower():
            print("✅")
            return True
        print(f"❌  (exit {result.returncode})")
        err = (stderr or stdout).strip()
        if err:
            print(f"      {err[:200]}")
        return False
    except subprocess.TimeoutExpired:
        tmp.unlink(missing_ok=True)
        print("❌  upload timeout")
        return False
    except FileNotFoundError:
        tmp.unlink(missing_ok=True)
        print("❌  node/wrangler not found")
        sys.exit(1)


def process_zone(slug, zone, dry_run=False):
    print(f"\n  {slug}: {zone['name']}", flush=True)
    features = fetch_structures(slug, zone)

    count = len(features)
    print(f"    Structures: {count}", end='')
    if count == 0:
        print(" (none found — uploading empty collection)")
    else:
        by_type = Counter(f['properties']['structure_type'] for f in features)
        print(f" — {dict(by_type)}")

    geojson = {
        'type': 'FeatureCollection',
        'features': features,
        'metadata': {
            'source':        'openstreetmap',
            'via':           'geofabrik_pbf_osmconvert',
            'coastal':       True,
            'tide_station':  zone.get('tide_station'),
            'fetched_at':    time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'feature_count': count,
        }
    }
    return upload_to_r2(slug, json.dumps(geojson), dry_run=dry_run)


def main():
    ap = argparse.ArgumentParser(description='Extract OSM structures for TrollMap coastal zones')
    ap.add_argument('--zone', help='Process a single zone by slug')
    ap.add_argument('--dry-run', action='store_true', help='Extract but do not upload')
    ap.add_argument('--list', action='store_true', help='List all zones and exit')
    args = ap.parse_args()

    if not OSMCONVERT.exists():
        print(f"❌ osmconvert64.exe not found at {OSMCONVERT}")
        print(f"   Download from: https://wiki.openstreetmap.org/wiki/Osmconvert")
        sys.exit(1)

    if args.list:
        print(f"{'SLUG':40} NAME")
        print('-' * 75)
        for slug, data in COASTAL_CATALOG.items():
            print(f"  {slug:40} {data['name']}  (tide: {data['tide_station']})")
        return

    if args.zone:
        slug = args.zone
        if slug not in COASTAL_CATALOG:
            print(f"❌ Unknown zone slug: {slug}")
            print(f"   Valid slugs: {', '.join(COASTAL_CATALOG.keys())}")
            sys.exit(1)
        zones = [(slug, COASTAL_CATALOG[slug])]
    else:
        zones = list(COASTAL_CATALOG.items())

    print(f"TrollMap Coastal OSM Structure Extractor")
    print(f"osmconvert: {OSMCONVERT}")
    print(f"PBF dir:    {PBF_DIR}")
    print(f"Zones:      {len(zones)}")
    if args.dry_run:
        print(f"Mode:       DRY RUN")
    print(f"{'─'*60}")

    ok = fail = 0
    for slug, zone in zones:
        if process_zone(slug, zone, dry_run=args.dry_run):
            ok += 1
        else:
            fail += 1

    if TMP_DIR.exists():
        try:
            TMP_DIR.rmdir()
        except Exception:
            pass

    print(f"\n{'─'*60}")
    print(f"Done: {ok} uploaded, {fail} failed")
    if fail:
        sys.exit(1)


if __name__ == '__main__':
    main()
