#!/usr/bin/env python3
"""
trollmap_garmin_bridge.py — Bridge TrollMap's LIVE waterbody data with
Garmin GMAPMF tile coverage.

Pulls the same ArcGIS ramp data that TrollMap's Cloudflare Worker uses
(SC/NC/GA/TN DNR feeds) to get the real, current waterbody list with
coordinates, then scans Garmin tiles to find which ones cover each
waterbody.

Can query the worker directly (/ramps endpoint) or hit the state ArcGIS
endpoints raw. Either way, the waterbody names and coordinates are the
same ones TrollMap's dropdown shows.

Usage:
    python trollmap_garmin_bridge.py "F:\\Garmin\\Charts\\Tiles"
    python trollmap_garmin_bridge.py "F:\\Garmin\\Charts\\Tiles" --states SC NC
    python trollmap_garmin_bridge.py "F:\\Garmin\\Charts\\Tiles" --lake "Wateree"
    python trollmap_garmin_bridge.py "F:\\Garmin\\Charts\\Tiles" --json garmin-coverage.json
    python trollmap_garmin_bridge.py --list-lakes          # just show waterbodies, no tile scan
    python trollmap_garmin_bridge.py --list-lakes --states GA TN

Personal use only, not for distribution or resale; not for navigation.
"""
from __future__ import annotations
import argparse, struct, json, sys, os, math
from pathlib import Path
from collections import defaultdict

try:
    import urllib.request, urllib.parse
    HAS_URLLIB = True
except ImportError:
    HAS_URLLIB = False

UNIT24 = 360.0 / (1 << 24)

# ─── TrollMap Worker URL (same one the app uses) ─────────────────────
WORKER_URL = "https://trollmap-worker.colonal1981.workers.dev"

# ─── Fallback: direct ArcGIS endpoints (same ones the worker queries) ─
ARCGIS_SOURCES = {
    'SC': {
        'url': "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/South_Carolina_Public_Water_Access_PUBLIC_VIEW/FeatureServer/0/query",
        'wb_field': 'Waterbody',
        'lat_field': 'Latitude',
        'lon_field': 'Longitude',
        'name_field': 'WaterAccessName',
        'filter': "WaterAccessType='Boat Ramp' AND Status='Active'",
        'id_field': 'OBJECTID',
    },
    'GA': {
        'url': "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/WRD_Water_Access_Points/FeatureServer/0/query",
        'wb_field': 'Waterbody',
        'lat_field': 'Latitude',
        'lon_field': 'Longitude',
        'name_field': 'Name',
        'filter': "Ramp='Y'",
        'id_field': 'FID',
    },
    'NC': {
        'url': "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/NCWRC_Boating_Access_Areas_view/FeatureServer/0/query",
        'wb_field': 'Water_Access',
        'lat_field': 'Latitude',
        'lon_field': 'Longitude',
        'name_field': 'BAA_Name',
        'filter': "1=1",
        'id_field': 'OBJECTID',
    },
    'TN': {
        'url': "https://services3.arcgis.com/PWXNAH2YKmZY7lBq/arcgis/rest/services/Boat_Launch_Sites/FeatureServer/0/query",
        'wb_field': 'Waterway',
        'lat_field': 'Latitude',
        'lon_field': 'Longitude',
        'name_field': 'Name',
        'filter': "Type='Boat Launch' AND IncludeWeb='Yes'",
        'id_field': 'OBJECTID',
    },
}

# ─── GMP Tile Readers ─────────────────────────────────────────────────

def u32(b, p): return struct.unpack_from('<I', b, p)[0]
def s24(b, p):
    v = b[p] | b[p+1]<<8 | b[p+2]<<16
    return v - 0x1000000 if v & 0x800000 else v

def sig(b, off):
    return b[off+2:off+12].rstrip(b'\0').decode('ascii', 'replace')

def read_bounds(path: Path):
    try:
        with path.open('rb') as f:
            root = f.read(0x3D)
            if len(root) < 0x3D or sig(root, 0) != 'GMAPMF GMP':
                return None
            tre_off = u32(root, 0x19)
            f.seek(tre_off)
            tre_head = f.read(0x30)
            if len(tre_head) < 0x30 or sig(tre_head, 0) != 'GMAPMF TRE':
                return None
            north = s24(tre_head, 0x15) * UNIT24
            east  = s24(tre_head, 0x18) * UNIT24
            south = s24(tre_head, 0x1B) * UNIT24
            west  = s24(tre_head, 0x1E) * UNIT24
            return (west, east, south, north)
    except Exception:
        return None

def read_tile_size_info(path: Path):
    try:
        size = path.stat().st_size
        with path.open('rb') as f:
            root = f.read(0x3D)
            if len(root) < 0x3D:
                return size, 0
            tre_off = u32(root, 0x19)
            f.seek(tre_off)
            tre_head = f.read(0x84)
            if len(tre_head) < 0x84 or sig(tre_head, 0) != 'GMAPMF TRE':
                return size, 0
            tre7_sz = u32(tre_head, 0x80)
            return size, tre7_sz // 16
    except Exception:
        return 0, 0

def overlaps(tile_bounds, lake_bounds, pad=0.02):
    tw, te, ts, tn = tile_bounds
    lw, le, ls, ln = lake_bounds
    return not (te + pad < lw or tw - pad > le or tn + pad < ls or ts - pad > ln)

# ─── Data Fetchers ─────────────────────────────────────────────────────

def fetch_from_worker(state):
    """Pull waterbody data from TrollMap's deployed worker."""
    url = f"{WORKER_URL}/ramps?state={state}"
    req = urllib.request.Request(url, headers={'User-Agent': 'TrollMap-Garmin-Bridge/1.0'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())

def fetch_from_arcgis(state):
    """Pull directly from the state ArcGIS endpoint (fallback if worker is down)."""
    src = ARCGIS_SOURCES[state]
    all_features = []
    offset = 0
    page_size = 1000
    while True:
        params = {
            'outFields': f"{src['wb_field']},{src['lat_field']},{src['lon_field']},{src['name_field']}",
            'where': src['filter'],
            'f': 'json',
            'resultOffset': str(offset),
            'resultRecordCount': str(page_size),
            'orderByFields': src['id_field'],
        }
        url = src['url'] + '?' + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={'User-Agent': 'TrollMap-Garmin-Bridge/1.0'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
        features = data.get('features', [])
        all_features.extend(features)
        if len(features) < page_size:
            break
        offset += page_size

    # Group by waterbody
    waterbodies = {}
    for feat in all_features:
        attrs = feat.get('attributes', feat.get('properties', {}))
        wb = str(attrs.get(src['wb_field'], 'Unknown') or 'Unknown').strip()
        lat = attrs.get(src['lat_field'])
        lon = attrs.get(src['lon_field'])
        if not lat or not lon:
            # Try geometry fallback
            geom = feat.get('geometry', {})
            if 'y' in geom:
                lat, lon = geom['y'], geom['x']
            elif 'coordinates' in geom:
                lon, lat = geom['coordinates'][0], geom['coordinates'][1]
            else:
                continue
        lat, lon = float(lat), float(lon)
        if abs(lat) < 1 or abs(lon) < 1:
            continue
        if wb not in waterbodies:
            waterbodies[wb] = []
        waterbodies[wb].append({
            'name': str(attrs.get(src['name_field'], 'Unnamed') or 'Unnamed').strip(),
            'lat': round(lat, 6),
            'lon': round(lon, 6),
        })

    return {
        'state': state,
        'waterbodyCount': len(waterbodies),
        'count': sum(len(v) for v in waterbodies.values()),
        'waterbodies': waterbodies,
    }


def fetch_waterbodies(states, use_worker=True):
    """Fetch waterbody data for given states. Returns merged dict."""
    all_waterbodies = {}  # name -> {state, ramps: [{lat, lon, name}]}

    for state in states:
        print(f"  Fetching {state} ramp data...", end=' ', flush=True)
        try:
            if use_worker:
                data = fetch_from_worker(state)
            else:
                data = fetch_from_arcgis(state)

            wbs = data.get('waterbodies', {})
            count = data.get('count', 0)
            print(f"{len(wbs)} waterbodies, {count} ramps")

            for wb_name, ramps in wbs.items():
                if not wb_name or wb_name.lower() in ('unknown', 'unknown waterbody'):
                    continue
                display_name = f"{wb_name}, {state}" if not wb_name.endswith(f", {state}") else wb_name
                if display_name not in all_waterbodies:
                    all_waterbodies[display_name] = {
                        'state': state,
                        'raw_name': wb_name,
                        'ramps': [],
                    }
                all_waterbodies[display_name]['ramps'].extend(ramps)

        except Exception as e:
            print(f"ERROR: {e}")
            if use_worker:
                print(f"    Retrying {state} via direct ArcGIS...", end=' ', flush=True)
                try:
                    data = fetch_from_arcgis(state)
                    wbs = data.get('waterbodies', {})
                    print(f"{len(wbs)} waterbodies")
                    for wb_name, ramps in wbs.items():
                        if not wb_name or wb_name.lower() in ('unknown', 'unknown waterbody'):
                            continue
                        display_name = f"{wb_name}, {state}"
                        if display_name not in all_waterbodies:
                            all_waterbodies[display_name] = {
                                'state': state,
                                'raw_name': wb_name,
                                'ramps': [],
                            }
                        all_waterbodies[display_name]['ramps'].extend(ramps)
                except Exception as e2:
                    print(f"ERROR: {e2}")

    return all_waterbodies


def waterbody_bbox(ramps, margin=0.05):
    """Compute bounding box from ramp coordinates + margin."""
    lats = [r['lat'] for r in ramps if r.get('lat')]
    lons = [r['lon'] for r in ramps if r.get('lon')]
    if not lats or not lons:
        return None
    return (
        min(lons) - margin,   # west
        max(lons) + margin,   # east
        min(lats) - margin,   # south
        max(lats) + margin,   # north
    )


CACHE_FILE = os.path.join(os.path.expanduser('~'), '.trollmap_waterbodies_cache.json')

def load_wb_cache():
    try:
        with open(CACHE_FILE, 'r') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None

def save_wb_cache(data):
    try:
        with open(CACHE_FILE, 'w') as f:
            json.dump(data, f)
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser(
        description='Bridge TrollMap live waterbody data with Garmin tile coverage.\n'
                    'Pulls from the same ArcGIS feeds TrollMap uses (SC/NC/GA/TN DNR).',
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('tiles_root', nargs='?', type=Path, default=None,
                    help='Garmin tile directory (e.g. F:\\Garmin\\Charts\\Tiles)')
    ap.add_argument('--states', nargs='+', default=['SC', 'NC', 'GA', 'TN'],
                    help='States to query (default: SC NC GA TN)')
    ap.add_argument('--lake', type=str, default=None,
                    help='Filter to a specific waterbody (partial match)')
    ap.add_argument('--list-lakes', action='store_true',
                    help='Just list waterbodies from the ArcGIS feeds (no tile scan)')
    ap.add_argument('--json', type=str, default=None,
                    help='Write JSON coverage map to file')
    ap.add_argument('--pad', type=float, default=0.02,
                    help='Overlap padding in degrees (default: 0.02)')
    ap.add_argument('--margin', type=float, default=0.05,
                    help='Waterbody bbox margin in degrees (default: 0.05)')
    ap.add_argument('--direct', action='store_true',
                    help='Query ArcGIS directly instead of through TrollMap worker')
    ap.add_argument('--offline', action='store_true',
                    help='Use cached waterbody data (no network)')
    ap.add_argument('--covered-only', action='store_true',
                    help='Only show waterbodies that have Garmin coverage')
    args = ap.parse_args()

    args.states = [s.upper() for s in args.states]

    # Fetch waterbody data
    print("Fetching TrollMap waterbody data from ArcGIS feeds...")
    if args.offline:
        cached = load_wb_cache()
        if cached:
            all_waterbodies = cached
            print(f"  Loaded {len(all_waterbodies)} waterbodies from cache")
        else:
            print("  No cache found. Run without --offline first.")
            sys.exit(1)
    else:
        all_waterbodies = fetch_waterbodies(args.states, use_worker=not args.direct)
        save_wb_cache(all_waterbodies)
        print(f"  Cached {len(all_waterbodies)} waterbodies to {CACHE_FILE}")

    # Filter by lake name if requested
    if args.lake:
        q = args.lake.lower()
        filtered = {k: v for k, v in all_waterbodies.items() if q in k.lower()}
        if not filtered:
            print(f"\nNo waterbodies matching '{args.lake}'. Try --list-lakes to see all.")
            sys.exit(1)
        all_waterbodies = filtered

    # --list-lakes mode: just show waterbodies
    if args.list_lakes:
        print(f"\n{'=' * 72}")
        print(f"TROLLMAP WATERBODIES ({len(all_waterbodies)} from {', '.join(args.states)})")
        print(f"{'=' * 72}\n")

        by_state = defaultdict(list)
        for name, info in all_waterbodies.items():
            by_state[info['state']].append((name, info))

        for state in sorted(by_state.keys()):
            entries = sorted(by_state[state], key=lambda x: x[0])
            print(f"  {state} ({len(entries)} waterbodies):")
            for name, info in entries:
                n_ramps = len(info['ramps'])
                bbox = waterbody_bbox(info['ramps'], args.margin)
                if bbox:
                    w, e, s, n = bbox
                    print(f"    {name:<45s} {n_ramps:3d} ramps  "
                          f"({s:.2f}–{n:.2f}°N, {w:.2f}–{e:.2f}°W)")
                else:
                    print(f"    {name:<45s} {n_ramps:3d} ramps  (no coords)")
            print()
        return

    # Tile scanning requires tiles_root
    if not args.tiles_root:
        ap.error("tiles_root is required (unless using --list-lakes)")

    # Scan Garmin tiles
    print(f"\nScanning Garmin tiles...")
    c_tiles = list(args.tiles_root.rglob('C*.GMP'))
    print(f"  Found {len(c_tiles)} C-tiles")

    tile_data = []
    errors = 0
    for i, path in enumerate(c_tiles):
        bounds = read_bounds(path)
        if bounds is None:
            errors += 1
            continue
        size, tre7 = read_tile_size_info(path)
        tile_data.append({
            'path': str(path),
            'name': path.stem,
            'bounds': bounds,
            'size': size,
            'tre7_count': tre7,
        })
        if (i+1) % 500 == 0:
            print(f"    ...{i+1}/{len(c_tiles)} scanned")

    print(f"  Read {len(tile_data)} tile headers ({errors} failed/skipped)\n")

    # Cross-reference waterbodies with tiles
    print("=" * 72)
    print("TROLLMAP WATERBODY → GARMIN TILE COVERAGE")
    print("=" * 72)

    results = {}
    covered = []
    uncovered = []
    skipped = 0

    for wb_name in sorted(all_waterbodies.keys()):
        info = all_waterbodies[wb_name]
        bbox = waterbody_bbox(info['ramps'], args.margin)
        if not bbox:
            skipped += 1
            continue

        matches = []
        for td in tile_data:
            if overlaps(td['bounds'], bbox, pad=args.pad):
                w, e, s, n = td['bounds']
                matches.append({
                    'tile': td['name'],
                    'path': td['path'],
                    'bounds_wesn': [w, e, s, n],
                    'size_mb': round(td['size'] / 1024 / 1024, 1),
                    'tre7_count': td['tre7_count'],
                })

        entry = {
            'state': info['state'],
            'ramp_count': len(info['ramps']),
            'bbox_wesn': list(bbox),
            'tile_count': len(matches),
            'tiles': matches,
            'total_mb': round(sum(m['size_mb'] for m in matches), 1),
            'total_tre7': sum(m['tre7_count'] for m in matches),
        }
        results[wb_name] = entry

        if matches:
            covered.append((wb_name, entry))
        else:
            uncovered.append((wb_name, entry))

    # Print covered
    if not args.covered_only:
        print(f"\nCOVERED BY GARMIN ({len(covered)}/{len(results)} waterbodies):\n")
    else:
        print(f"\nGARMIN-COVERED WATERBODIES ({len(covered)}):\n")

    for wb_name, info in covered:
        print(f"  {wb_name}  ({info['ramp_count']} ramps)")
        print(f"    {info['tile_count']} tiles, {info['total_mb']} MB, "
              f"{info['total_tre7']} TRE7 entries")
        for t in info['tiles']:
            w, e, s, n = t['bounds_wesn']
            print(f"      {t['tile']:12s}  {t['size_mb']:6.1f} MB  "
                  f"{t['tre7_count']:5d} TRE7  "
                  f"W={w:.4f} E={e:.4f} S={s:.4f} N={n:.4f}")
        print()

    if not args.covered_only and uncovered:
        print(f"\nNO GARMIN COVERAGE ({len(uncovered)} waterbodies):\n")
        for wb_name, info in uncovered:
            w, e, s, n = info['bbox_wesn']
            print(f"  {wb_name}  ({info['ramp_count']} ramps)")
            print(f"    bbox: {s:.2f}–{n:.2f}°N, {w:.2f}–{e:.2f}°W")

    # Reverse map
    tile_to_wbs = defaultdict(list)
    for wb_name, info in results.items():
        for t in info['tiles']:
            tile_to_wbs[t['tile']].append(wb_name)

    if tile_to_wbs:
        print(f"\n{'=' * 72}")
        print(f"GARMIN TILE → WATERBODY REVERSE MAP ({len(tile_to_wbs)} tiles)")
        print(f"{'=' * 72}\n")
        for tname in sorted(tile_to_wbs.keys()):
            wb_list = tile_to_wbs[tname]
            print(f"  {tname}: {', '.join(sorted(wb_list))}")

    # Summary
    total_wbs = len(results)
    print(f"\n{'=' * 72}")
    print(f"SUMMARY")
    print(f"{'=' * 72}")
    print(f"  States queried:            {', '.join(args.states)}")
    print(f"  Total waterbodies:         {len(all_waterbodies)}")
    if skipped:
        print(f"  Skipped (no coords):       {skipped}")
    print(f"  With Garmin coverage:      {len(covered)}")
    print(f"  Without Garmin coverage:   {len(uncovered)}")
    print(f"  Garmin tiles scanned:      {len(tile_data)}")
    if covered:
        unique_tiles = len(tile_to_wbs)
        total_size = sum(
            td['size'] for td in tile_data
            if td['name'] in tile_to_wbs
        )
        print(f"  Unique Garmin tiles used:  {unique_tiles}")
        print(f"  Total tile data:           {total_size / 1024 / 1024:.1f} MB")

    pct = len(covered) / total_wbs * 100 if total_wbs else 0
    print(f"\n  Garmin coverage rate: {len(covered)}/{total_wbs} = {pct:.0f}%")

    # JSON output
    if args.json:
        output = {
            'summary': {
                'states': args.states,
                'waterbodies_total': len(all_waterbodies),
                'covered': len(covered),
                'uncovered': len(uncovered),
                'coverage_pct': round(pct, 1),
                'garmin_tiles_scanned': len(tile_data),
                'unique_tiles': len(tile_to_wbs),
            },
            'waterbodies': results,
            'tile_to_waterbodies': dict(tile_to_wbs),
        }
        with open(args.json, 'w') as f:
            json.dump(output, f, indent=2, default=str)
        print(f"\nJSON written to {args.json}")


if __name__ == '__main__':
    main()