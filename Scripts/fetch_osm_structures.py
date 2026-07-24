#!/usr/bin/env python3
"""
fetch_osm_structures.py — Extracts fishing-relevant OSM structures for all
TrollMap lakes using osmconvert64 to clip PBF to lake bbox, then pyosmium
to extract features from the small clipped file.

Fast — osmconvert clips a 150MB PBF to a lake bbox in ~1 second.
No API calls, no rate limits.

Usage:
    py fetch_osm_structures.py
    py fetch_osm_structures.py --lake lake_wateree_fishing_creek
    py fetch_osm_structures.py --dry-run
    py fetch_osm_structures.py --list

Requires:
    - osmconvert64.exe in scripts directory
    - pyosmium: pip install osmium --break-system-packages
    - PBF files in F:\\TrollMapPipeline\\osm_pbf\\
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
    from lake_catalog import LAKE_CATALOG
except ImportError:
    print("ERROR: lake_catalog.py not found in same directory")
    sys.exit(1)

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPTS_DIR   = Path(__file__).parent
PBF_DIR       = Path(r'F:\TrollMapPipeline\osm_pbf')
OSMCONVERT    = SCRIPTS_DIR / 'osmconvert64.exe'
R2_BUCKET     = 'trollmap-chartpacks'
WRANGLER_JS   = r'C:\Users\Ryan\AppData\Roaming\npm\node_modules\wrangler\bin\wrangler.js'
TMP_DIR       = Path(r'F:\TrollMapPipeline\osm_tmp')

# Which PBF covers which states — lakes span these 4
PBF_FILES = [
    PBF_DIR / 'south-carolina-260717.osm.pbf',
    PBF_DIR / 'north-carolina-260717.osm.pbf',
    PBF_DIR / 'georgia-260717.osm.pbf',
    PBF_DIR / 'tennessee-260717.osm.pbf',
]

SKIP_SLUGS = {'sc_ga_coastal', 'saluda_river_arm'}
# ─────────────────────────────────────────────────────────────────────────────


def classify(tags):
    ww = tags.get('waterway', '')
    mm = tags.get('man_made', '')
    br = tags.get('bridge', '')
    rw = tags.get('railway', '')
    hw = tags.get('highway', '')
    pl = tags.get('place', '')
    nt = tags.get('natural', '')

    if ww in ('dam', 'weir') or mm == 'dam':             return 'DAM'
    if ww == 'boat_slipway':                              return 'BOAT_RAMP'
    if mm in ('pier', 'dock'):                            return 'PIER'
    if mm == 'breakwater':                                return 'BREAKWATER'
    if mm == 'groyne':                                    return 'GROYNE'
    if mm in ('buoy', 'artificial_reef'):                 return 'HAZARD_MARKER'
    if tags.get('fish_attractor') == 'yes':               return 'FISH_ATTRACTOR'
    if nt == 'rock' or tags.get('submerged') == 'yes' \
            or tags.get('hazard') == 'navigation':        return 'HAZARD'
    if br == 'yes':
        if rw:                                            return 'RAIL_BRIDGE'
        if hw in ('footway', 'path', 'pedestrian'):      return 'FOOT_BRIDGE'
        if hw:                                            return 'ROAD_BRIDGE'
        return 'BRIDGE'
    if pl == 'island' or nt == 'island':                  return 'ISLAND'
    return 'OTHER'


def tags_wanted(tags):
    checks = [
        ('waterway',       {'dam', 'weir', 'boat_slipway'}),
        ('man_made',       {'pier', 'dock', 'groyne', 'breakwater', 'buoy', 'artificial_reef'}),
        ('place',          {'island'}),
        ('natural',        {'rock', 'reef', 'island'}),
        ('fish_attractor', {'yes'}),
        ('submerged',      {'yes'}),
        ('hazard',         {'navigation'}),
    ]
    for key, vals in checks:
        if tags.get(key) in vals:
            return True
    if tags.get('bridge') == 'yes' and (tags.get('highway') or tags.get('railway')):
        return True
    return False


def make_feature(tags, osm_type, osm_id, lon, lat):
    t = dict(tags)
    structure_type = classify(t)
    if structure_type == 'OTHER':
        return None
    props = {
        'structure_type': structure_type,
        'source':         'osm',
        'query_method':   'pbf_clip',
        'osm_id':         osm_id,
        'osm_type':       osm_type,
    }
    name = t.get('name') or t.get('alt_name') or t.get('ref')
    if name:
        props['name'] = name
    for tag in ('waterway', 'man_made', 'bridge', 'railway', 'highway',
                'place', 'natural', 'operator', 'gauge', 'submerged', 'hazard'):
        if tag in t:
            props[tag] = t[tag]
    return {
        'type': 'Feature',
        'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
        'properties': props,
    }


BOUNDARIES_DIR = Path(r'F:\TrollMapPipeline\lake_boundaries')


def best_boundary_file(slug):
    """Return the best available boundary file path for a slug.
    Prefers _nhd.geojson over _3dhp.geojson."""
    nhd = BOUNDARIES_DIR / f"{slug}_nhd.geojson"
    dhp = BOUNDARIES_DIR / f"{slug}_3dhp.geojson"
    if nhd.exists():
        return nhd
    if dhp.exists():
        return dhp
    return None


def load_boundary_rings(slug):
    """
    Load all outer rings from the best available boundary GeoJSON.
    Prefers _nhd over _3dhp.
    Returns a list of rings, each a list of (lon, lat) tuples.
    Returns empty list if no boundary file.
    """
    boundary_file = best_boundary_file(slug)
    if boundary_file is None:
        return []
    try:
        with open(boundary_file, encoding='utf-8') as f:
            gj = json.load(f)
        rings = []
        for feat in gj.get('features', []):
            geom = feat.get('geometry', {})
            t = geom.get('type', '')
            c = geom.get('coordinates', [])
            if t == 'Polygon' and c:
                rings.append([(pt[0], pt[1]) for pt in c[0]])
            elif t == 'MultiPolygon':
                for poly in c:
                    if poly:
                        rings.append([(pt[0], pt[1]) for pt in poly[0]])
        return rings
    except Exception:
        return []


def point_in_ring(lon, lat, ring):
    """Ray casting point-in-polygon for a single ring."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if ((yi > lat) != (yj > lat)) and (lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def point_in_boundary(lon, lat, rings):
    """Returns True if point is inside any of the boundary rings."""
    for ring in rings:
        if point_in_ring(lon, lat, ring):
            return True
    return False


def get_tight_bbox(slug, catalog_entry):
    """
    Get tight bbox from best available boundary file (_nhd preferred over _3dhp).
    Falls back to catalog bbox. Returns (s, n, w, e).
    Adds a small buffer (0.01 deg ~1km) around the boundary bbox.
    """
    boundary_file = best_boundary_file(slug)
    if boundary_file is not None:
        try:
            with open(boundary_file, encoding='utf-8') as f:
                gj = json.load(f)
            all_coords = []
            def collect(geom):
                if not geom:
                    return
                t = geom.get('type', '')
                c = geom.get('coordinates', [])
                if t == 'Point':
                    all_coords.append(c)
                elif t in ('LineString', 'MultiPoint'):
                    all_coords.extend(c)
                elif t in ('Polygon', 'MultiLineString'):
                    for ring in c:
                        all_coords.extend(ring)
                elif t == 'MultiPolygon':
                    for poly in c:
                        for ring in poly:
                            all_coords.extend(ring)
            for feat in gj.get('features', []):
                collect(feat.get('geometry'))
            if all_coords:
                lons = [c[0] for c in all_coords]
                lats = [c[1] for c in all_coords]
                buf = 0.01
                return (min(lats)-buf, max(lats)+buf, min(lons)-buf, max(lons)+buf)
        except Exception:
            pass
    return catalog_entry['bbox']


class StructureHandler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.features = []

    def node(self, n):
        if not tags_wanted(n.tags):
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
        if not tags_wanted(w.tags):
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
    """Use osmconvert64 to clip PBF to bbox. Returns True on success."""
    # osmconvert bbox format: left,bottom,right,top (w,s,e,n)
    bbox_str = f"{w},{s},{e},{n}"
    cmd = [
        str(OSMCONVERT),
        str(pbf_path),
        f'--complete-ways',
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


def fetch_structures(slug, catalog_entry):
    s, n, w, e = get_tight_bbox(slug, catalog_entry)
    print(f"    bbox: S{s:.4f} N{n:.4f} W{w:.4f} E{e:.4f}")

    # Load boundary rings for point-in-polygon filtering
    rings = load_boundary_rings(slug)
    if rings:
        print(f"    PIP filter: {len(rings)} boundary polygon(s)")
    else:
        print(f"    PIP filter: none (no 3DHP boundary — bbox only)")

    TMP_DIR.mkdir(exist_ok=True)
    all_features = []
    seen = set()

    for pbf in PBF_FILES:
        if not pbf.exists():
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

        handler = StructureHandler()
        handler.apply_file(str(clipped), locations=True)
        clipped.unlink(missing_ok=True)

        new = 0
        for feat in handler.features:
            fid = f"{feat['properties']['osm_type']}/{feat['properties']['osm_id']}"
            if fid in seen:
                continue
            # Point-in-polygon filter — only keep features on the water
            if rings:
                lon, lat = feat['geometry']['coordinates']
                if not point_in_boundary(lon, lat, rings):
                    continue
            seen.add(fid)
            all_features.append(feat)
            new += 1
        print(f"→ {new} features")

    return all_features


def upload_to_r2(slug, geojson_str, dry_run=False):
    r2_key = f"{R2_BUCKET}/supplemental/{slug}/osm-structures.geojson"
    size_kb = len(geojson_str.encode()) // 1024
    tmp = Path(f'_osm_tmp_{slug}.geojson')
    tmp.write_text(geojson_str, encoding='utf-8')
    print(f"    uploading {size_kb} KB ...", end=' ', flush=True)

    if dry_run:
        tmp.unlink()
        print("DRY RUN")
        return True

    cmd = [
        'node', WRANGLER_JS, 'r2', 'object', 'put', r2_key,
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


def process_lake(slug, catalog_entry, dry_run=False):
    print(f"\n  {slug}: {catalog_entry['name']}", flush=True)
    features = fetch_structures(slug, catalog_entry)

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
            'fetched_at':    time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'feature_count': count,
        }
    }
    return upload_to_r2(slug, json.dumps(geojson), dry_run=dry_run)


def main():
    ap = argparse.ArgumentParser(description='Extract OSM structures from PBF for TrollMap lakes')
    ap.add_argument('--lake', help='Process a single lake by slug')
    ap.add_argument('--dry-run', action='store_true', help='Extract but do not upload')
    ap.add_argument('--list', action='store_true', help='List all lakes and exit')
    args = ap.parse_args()

    if not OSMCONVERT.exists():
        print(f"❌ osmconvert64.exe not found at {OSMCONVERT}")
        print(f"   Download from: https://wiki.openstreetmap.org/wiki/Osmconvert")
        sys.exit(1)

    if args.list:
        print(f"{'SLUG':45} NAME")
        print('-' * 80)
        for slug, data in LAKE_CATALOG.items():
            skip = ' [SKIP]' if slug in SKIP_SLUGS else ''
            print(f"  {slug:45} {data['name']}{skip}")
        return

    if args.lake:
        slug = args.lake
        if slug not in LAKE_CATALOG:
            print(f"❌ Unknown slug: {slug}")
            sys.exit(1)
        lakes = [(slug, LAKE_CATALOG[slug])]
    else:
        lakes = [(s, d) for s, d in LAKE_CATALOG.items() if s not in SKIP_SLUGS]

    print(f"TrollMap OSM Structure Extractor")
    print(f"osmconvert: {OSMCONVERT}")
    print(f"PBF dir:    {PBF_DIR}")
    print(f"Lakes:      {len(lakes)}")
    if args.dry_run:
        print(f"Mode:       DRY RUN")
    print(f"{'─'*60}")

    ok = fail = 0
    for slug, data in lakes:
        if process_lake(slug, data, dry_run=args.dry_run):
            ok += 1
        else:
            fail += 1

    # Cleanup tmp dir
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
