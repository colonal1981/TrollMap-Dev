#!/usr/bin/env python3
"""
gmp_lake_mapper.py — Scan Garmin GMAPMF tile headers and map which tiles
cover which lakes. Now with live USGS GNIS lookup for ANY US lake.

Reads only the first ~0x30 bytes per tile (no decompression), so scanning
thousands of tiles takes seconds.

Usage:
    python gmp_lake_mapper.py "F:\\Garmin\\Charts\\Tiles" --lake "Wateree"
    python gmp_lake_mapper.py "F:\\Garmin\\Charts\\Tiles" --lake "Possum Kingdom"
    python gmp_lake_mapper.py "F:\\Garmin\\Charts\\Tiles" --search "crystal"
    python gmp_lake_mapper.py "F:\\Garmin\\Charts\\Tiles" --search "crystal" --state TX
    python gmp_lake_mapper.py "F:\\Garmin\\Charts\\Tiles" --state SC
    python gmp_lake_mapper.py "F:\\Garmin\\Charts\\Tiles" --all
    python gmp_lake_mapper.py "F:\\Garmin\\Charts\\Tiles" --coords -80.72 34.33
    python gmp_lake_mapper.py "F:\\Garmin\\Charts\\Tiles" --cache-stats

Personal use only, not for distribution or resale; not for navigation.
Based on Arena's find_wateree_tiles.py tile header reader.
"""
from __future__ import annotations
import argparse, struct, json, sys, math, os
from pathlib import Path
from collections import defaultdict

try:
    import urllib.request, urllib.parse
    HAS_URLLIB = True
except ImportError:
    HAS_URLLIB = False

UNIT24 = 360.0 / (1 << 24)
CACHE_FILE = os.path.join(os.path.expanduser('~'), '.gmp_lake_cache.json')

GNIS_API = (
    "https://carto.nationalmap.gov/arcgis/rest/services/"
    "geonames/MapServer/7/query"
)

# ─── GMP Tile Readers ──────────────────────────────────────────────────

def u32(b, p): return struct.unpack_from('<I', b, p)[0]
def s24(b, p):
    v = b[p] | b[p+1]<<8 | b[p+2]<<16
    return v - 0x1000000 if v & 0x800000 else v

def sig(b, off):
    return b[off+2:off+12].rstrip(b'\0').decode('ascii', 'replace')

def read_bounds(path: Path):
    """Read TRE bounds from a GMP file. Returns (W, E, S, N) or None."""
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
    """Read file size and TRE7 count for estimating tile data density."""
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
    """Check if tile WESN box overlaps lake WESN box (with padding)."""
    tw, te, ts, tn = tile_bounds
    lw, le, ls, ln = lake_bounds
    return not (te + pad < lw or tw - pad > le or tn + pad < ls or ts - pad > ln)

# ─── GNIS API Lookup ───────────────────────────────────────────────────

def web_mercator_to_wgs84(x, y):
    lng = x * 180.0 / 20037508.34
    lat = math.atan(math.exp(y * math.pi / 20037508.34)) * 360.0 / math.pi - 90.0
    return round(lng, 6), round(lat, 6)

def _gnis_query(where, max_records=200):
    """Run a GNIS ArcGIS REST query. Returns list of dicts."""
    params = {
        'where': where,
        'outFields': 'gaz_name,state_alpha,gaz_featureclass',
        'returnGeometry': 'true',
        'f': 'json',
        'resultRecordCount': str(max_records),
    }
    url = GNIS_API + '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode())
    results = []
    for f in data.get('features', []):
        geom = f.get('geometry', {})
        attrs = f.get('attributes', {})
        x, y = geom.get('x', 0), geom.get('y', 0)
        lng, lat = web_mercator_to_wgs84(x, y)
        results.append({
            'name': attrs.get('gaz_name', ''),
            'state': attrs.get('state_alpha', ''),
            'type': attrs.get('gaz_featureclass', ''),
            'lng': lng,
            'lat': lat,
        })
    return results

def gnis_search(name, state=None):
    """Search GNIS for lakes/reservoirs matching a name."""
    if not HAS_URLLIB:
        return []
    # Escape single quotes in name for SQL WHERE clause
    safe_name = name.replace("'", "''")
    where = (
        f"UPPER(gaz_name) LIKE UPPER('%{safe_name}%') "
        f"AND (gaz_featureclass='Lake' OR gaz_featureclass='Reservoir')"
    )
    if state:
        where += f" AND state_alpha='{state.upper()}'"
    try:
        return _gnis_query(where, max_records=50)
    except Exception as e:
        print(f"  [GNIS API error: {e}]")
        return []

def gnis_exact(name, state=None):
    """Search GNIS for an exact lake name match."""
    if not HAS_URLLIB:
        return []
    safe_name = name.replace("'", "''")
    where = (
        f"gaz_name='{safe_name}' "
        f"AND (gaz_featureclass='Lake' OR gaz_featureclass='Reservoir')"
    )
    if state:
        where += f" AND state_alpha='{state.upper()}'"
    try:
        return _gnis_query(where, max_records=10)
    except Exception as e:
        # Fall back to LIKE search
        return gnis_search(name, state)

# ─── Lake Cache ────────────────────────────────────────────────────────

def load_cache():
    try:
        with open(CACHE_FILE, 'r') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

def save_cache(cache):
    try:
        with open(CACHE_FILE, 'w') as f:
            json.dump(cache, f, indent=2)
    except Exception:
        pass  # non-critical

def cache_lake(cache, name, lng, lat, state, radius=0.15):
    """Add a GNIS result to the local cache."""
    key = f"{name}|{state}"
    cache[key] = {
        'name': name,
        'lng': lng,
        'lat': lat,
        'state': state,
        'radius': radius,
    }
    save_cache(cache)

# ─── Built-in Lake Database ───────────────────────────────────────────
# Format: "Name": (longitude, latitude, approx_radius_deg, "State")

LAKE_DB = {
    # South Carolina
    'Lake Wateree':         (-80.72, 34.33, 0.15, 'SC'),
    'Lake Murray':          (-81.22, 34.06, 0.20, 'SC'),
    'Lake Hartwell':        (-82.85, 34.45, 0.25, 'SC/GA'),
    'Lake Keowee':          (-82.88, 34.83, 0.10, 'SC'),
    'Lake Jocassee':        (-82.95, 34.97, 0.08, 'SC'),
    'Lake Greenwood':       (-81.95, 34.18, 0.12, 'SC'),
    'Lake Wylie':           (-81.05, 35.10, 0.12, 'SC/NC'),
    'Clarks Hill Lake':     (-82.25, 33.85, 0.20, 'SC/GA'),
    'Lake Marion':          (-80.35, 33.50, 0.20, 'SC'),
    'Lake Moultrie':        (-80.05, 33.30, 0.10, 'SC'),
    # North Carolina
    'Lake Norman':          (-80.88, 35.47, 0.15, 'NC'),
    'High Rock Lake':       (-80.22, 35.60, 0.10, 'NC'),
    'Badin Lake':           (-80.10, 35.40, 0.08, 'NC'),
    'Jordan Lake':          (-79.05, 35.70, 0.10, 'NC'),
    'Falls Lake':           (-78.68, 36.00, 0.10, 'NC'),
    'Lake James':           (-81.88, 35.73, 0.08, 'NC'),
    'Kerr Lake':            (-78.38, 36.60, 0.15, 'NC/VA'),
    'Lake Gaston':          (-77.90, 36.52, 0.15, 'NC/VA'),
    'Fontana Lake':         (-83.55, 35.45, 0.12, 'NC'),
    # Virginia
    'Smith Mountain Lake':  (-79.55, 37.07, 0.12, 'VA'),
    'Lake Anna':            (-77.85, 38.05, 0.10, 'VA'),
    'Buggs Island Lake':    (-78.50, 36.65, 0.15, 'VA'),
    'Claytor Lake':         (-80.60, 37.05, 0.08, 'VA'),
    # Georgia
    'Lake Lanier':          (-83.95, 34.25, 0.15, 'GA'),
    'Lake Oconee':          (-83.45, 33.55, 0.12, 'GA'),
    'Lake Sinclair':        (-83.25, 33.10, 0.10, 'GA'),
    'Lake Seminole':        (-84.80, 30.80, 0.15, 'FL/GA'),
    'Lake Allatoona':       (-84.60, 34.15, 0.12, 'GA'),
    'West Point Lake':      (-85.10, 33.00, 0.10, 'GA/AL'),
    # Florida
    'Lake Okeechobee':      (-80.80, 26.95, 0.25, 'FL'),
    'Lake Toho':            (-81.38, 28.20, 0.08, 'FL'),
    'Lake Kissimmee':       (-81.25, 27.95, 0.10, 'FL'),
    'Lake George':          (-81.55, 29.30, 0.08, 'FL'),
    # Alabama
    'Lake Guntersville':    (-86.25, 34.40, 0.15, 'AL'),
    'Lake Martin':          (-85.95, 32.75, 0.12, 'AL'),
    'Lay Lake':             (-86.50, 33.15, 0.10, 'AL'),
    'Lewis Smith Lake':     (-87.10, 34.10, 0.10, 'AL'),
    'Pickwick Lake':        (-88.20, 34.95, 0.15, 'AL/TN/MS'),
    'Wheeler Lake':         (-87.00, 34.60, 0.15, 'AL'),
    'Wilson Lake':          (-87.60, 34.75, 0.10, 'AL'),
    'Lake Eufaula (AL)':    (-85.15, 31.90, 0.15, 'AL/GA'),
    'Weiss Lake':           (-85.80, 34.15, 0.10, 'AL'),
    'Neely Henry Lake':     (-86.05, 33.75, 0.08, 'AL'),
    'Logan Martin Lake':    (-86.30, 33.50, 0.10, 'AL'),
    # Tennessee
    'Kentucky Lake':        (-88.10, 36.80, 0.25, 'KY/TN'),
    'Lake Barkley':         (-87.90, 36.90, 0.20, 'KY'),
    'Dale Hollow Lake':     (-85.45, 36.55, 0.12, 'TN/KY'),
    'Center Hill Lake':     (-85.80, 36.10, 0.12, 'TN'),
    'Old Hickory Lake':     (-86.40, 36.30, 0.12, 'TN'),
    'Percy Priest Lake':    (-86.60, 36.10, 0.10, 'TN'),
    'Chickamauga Lake':     (-85.10, 35.25, 0.12, 'TN'),
    'Watts Bar Lake':       (-84.70, 35.60, 0.12, 'TN'),
    'Norris Lake':          (-84.10, 36.25, 0.15, 'TN'),
    'Cherokee Lake':        (-83.50, 36.15, 0.10, 'TN'),
    'Douglas Lake':         (-83.40, 36.00, 0.10, 'TN'),
    'Fort Loudoun Lake':    (-84.20, 35.80, 0.10, 'TN'),
    'Tims Ford Lake':       (-86.25, 35.20, 0.08, 'TN'),
    'Woods Reservoir':      (-86.10, 35.18, 0.06, 'TN'),
    # Texas
    'Lake Fork':            (-95.60, 32.80, 0.12, 'TX'),
    'Sam Rayburn':          (-94.10, 31.10, 0.15, 'TX'),
    'Toledo Bend':          (-93.60, 31.40, 0.20, 'LA/TX'),
    'Lake Texoma':          (-96.60, 33.85, 0.15, 'TX/OK'),
    'Lake Amistad':         (-101.05, 29.45, 0.20, 'TX'),
    'Falcon Lake':          (-99.15, 26.90, 0.15, 'TX'),
    'Lake LBJ':             (-98.40, 30.55, 0.08, 'TX'),
    'Lake Travis':          (-97.90, 30.40, 0.12, 'TX'),
    'Lake Conroe':          (-95.55, 30.40, 0.08, 'TX'),
    'Richland Chambers':    (-96.10, 31.95, 0.10, 'TX'),
    'Cedar Creek Lake':     (-96.05, 32.15, 0.10, 'TX'),
    'Ray Roberts Lake':     (-97.05, 33.35, 0.10, 'TX'),
    'Lake Palestine':       (-95.45, 32.05, 0.10, 'TX'),
    'Lake Livingston':      (-95.10, 30.70, 0.15, 'TX'),
    'Lake Whitney':         (-97.40, 31.90, 0.10, 'TX'),
    'Choke Canyon':         (-98.35, 28.50, 0.10, 'TX'),
    'Lake O the Pines':     (-94.55, 32.75, 0.10, 'TX'),
    # Arkansas / Missouri / Oklahoma
    'Lake of the Ozarks':   (-92.65, 38.10, 0.20, 'MO'),
    'Table Rock Lake':      (-93.35, 36.60, 0.15, 'MO/AR'),
    'Bull Shoals Lake':     (-92.60, 36.40, 0.15, 'AR/MO'),
    'Beaver Lake':          (-93.90, 36.30, 0.12, 'AR'),
    'Truman Lake':          (-93.40, 38.25, 0.15, 'MO'),
    'Stockton Lake':        (-93.75, 37.65, 0.10, 'MO'),
    'Grand Lake':           (-94.80, 36.50, 0.12, 'OK'),
    'Lake Eufaula (OK)':    (-95.35, 35.30, 0.15, 'OK'),
    'Lake Tenkiller':       (-95.05, 35.60, 0.10, 'OK'),
    'Lake Texhoma':         (-96.60, 33.85, 0.15, 'OK/TX'),
    'Broken Bow Lake':      (-94.65, 34.15, 0.08, 'OK'),
    'DeGray Lake':          (-93.15, 34.23, 0.08, 'AR'),
    'Lake Ouachita':        (-93.55, 34.55, 0.10, 'AR'),
    'Greers Ferry Lake':    (-92.00, 35.55, 0.10, 'AR'),
    'Norfork Lake':         (-92.25, 36.40, 0.10, 'AR'),
    # Mississippi / Louisiana
    'Ross Barnett':         (-89.85, 32.43, 0.10, 'MS'),
    'Grenada Lake':         (-89.75, 33.80, 0.08, 'MS'),
    'Sardis Lake':          (-89.80, 34.40, 0.08, 'MS'),
    'Lake D Arbonne':       (-92.25, 32.65, 0.06, 'LA'),
    # Kentucky
    'Lake Cumberland':      (-84.95, 36.90, 0.15, 'KY'),
    'Cave Run Lake':        (-83.55, 38.10, 0.08, 'KY'),
    'Green River Lake':     (-85.30, 37.20, 0.08, 'KY'),
    'Barren River Lake':    (-86.10, 36.90, 0.08, 'KY'),
    # Midwest
    'Mille Lacs Lake':      (-93.65, 46.20, 0.15, 'MN'),
    'Lake of the Woods':    (-94.90, 49.00, 0.30, 'MN'),
    'Lake Winnebago':       (-88.40, 43.95, 0.12, 'WI'),
    'Rend Lake':            (-88.95, 38.05, 0.08, 'IL'),
    'Lake Shelbyville':     (-88.75, 39.40, 0.08, 'IL'),
    'Lake Erie West':       (-83.00, 41.70, 0.30, 'OH'),
    'Lake St Clair':        (-82.70, 42.40, 0.15, 'MI'),
    'Saginaw Bay':          (-83.85, 43.80, 0.20, 'MI'),
    'Houghton Lake':        (-84.75, 44.35, 0.08, 'MI'),
    # Northeast
    'Lake Champlain':       (-73.30, 44.55, 0.20, 'VT/NY'),
    'Oneida Lake':          (-75.90, 43.20, 0.10, 'NY'),
    'Lake Wallenpaupack':   (-75.15, 41.40, 0.06, 'PA'),
    'Raystown Lake':        (-78.05, 40.45, 0.08, 'PA'),
    'Candlewood Lake':      (-73.45, 41.48, 0.05, 'CT'),
    # West
    'Lake Mead':            (-114.75, 36.15, 0.25, 'NV/AZ'),
    'Lake Powell':          (-111.45, 37.10, 0.30, 'UT/AZ'),
    'Lake Havasu':          (-114.35, 34.50, 0.10, 'AZ/CA'),
    'Roosevelt Lake':       (-111.15, 33.65, 0.10, 'AZ'),
    'Flathead Lake':        (-114.15, 47.90, 0.10, 'MT'),
    'Lake Chelan':          (-120.20, 47.90, 0.08, 'WA'),
    'Lake Coeur d Alene':   (-116.80, 47.60, 0.10, 'ID'),
    'Clear Lake':           (-122.75, 39.05, 0.08, 'CA'),
    'Lake Shasta':          (-122.35, 40.80, 0.10, 'CA'),
    'Lake Oroville':        (-121.45, 39.55, 0.08, 'CA'),
    'Flaming Gorge':        (-109.50, 41.05, 0.15, 'UT/WY'),
    'Lake McConaughy':      (-101.95, 41.22, 0.10, 'NE'),
    'Lewis and Clark Lake':  (-98.55, 42.85, 0.10, 'SD/NE'),
    'Lake Sakakawea':       (-102.50, 47.70, 0.30, 'ND'),
    'Fort Peck Lake':       (-106.50, 47.65, 0.25, 'MT'),
}


def make_lake_bbox(lng, lat, radius):
    """Generate (W, E, S, N) bounding box from centroid and radius."""
    return (lng - radius, lng + radius, lat - radius, lat + radius)


def resolve_lake(name, state=None, cache=None, offline=False):
    """Resolve a lake name to (lng, lat, radius, state_str).

    Search order:
      1. Built-in LAKE_DB (partial match)
      2. Local cache (~/.gmp_lake_cache.json)
      3. USGS GNIS API (live lookup, cached on success)

    Returns list of (display_name, lng, lat, radius, state, source) tuples.
    """
    results = []

    # 1. Check built-in DB
    q = name.lower()
    for db_name, (lng, lat, rad, st) in LAKE_DB.items():
        if q in db_name.lower():
            if state and state.upper() not in st.upper():
                continue
            results.append((db_name, lng, lat, rad, st, 'built-in'))

    # 2. Check cache
    if cache:
        for key, entry in cache.items():
            if q in entry['name'].lower():
                if state and state.upper() != entry['state'].upper():
                    continue
                # Skip if already found in built-in
                if any(r[0] == entry['name'] and r[4] == entry['state']
                       for r in results):
                    continue
                results.append((
                    entry['name'], entry['lng'], entry['lat'],
                    entry.get('radius', 0.15), entry['state'], 'cache'
                ))

    # 3. If nothing found (or user wants more), try GNIS API
    if not results and not offline:
        print(f"  Not in local database. Searching USGS GNIS for '{name}'...")
        gnis_results = gnis_search(name, state)
        if gnis_results:
            print(f"  Found {len(gnis_results)} result(s) from GNIS:\n")
            for i, r in enumerate(gnis_results):
                print(f"    [{i+1}] {r['name']} ({r['state']}) — "
                      f"{r['type']} at {r['lat']:.4f}°N, {r['lng']:.4f}°W")
                results.append((
                    r['name'], r['lng'], r['lat'],
                    0.15, r['state'], 'gnis'
                ))
                # Cache the result
                if cache is not None:
                    cache_lake(cache, r['name'], r['lng'], r['lat'],
                              r['state'], 0.15)
            print()
        else:
            print(f"  No results found in GNIS either.\n")

    return results


def do_search(name, state=None, offline=False):
    """Interactive GNIS search — print results without tile scanning."""
    # Always check built-in DB and cache first
    q = name.lower()
    builtin_hits = [(k, v) for k, v in LAKE_DB.items() if q in k.lower()]
    if state:
        builtin_hits = [(k, v) for k, v in builtin_hits
                        if state.upper() in v[3].upper()]
    cache = load_cache()
    cache_hits = []
    for key, entry in cache.items():
        if q in entry['name'].lower():
            if state and state.upper() != entry['state'].upper():
                continue
            if not any(k == entry['name'] for k, _ in builtin_hits):
                cache_hits.append(entry)

    if builtin_hits:
        print(f"\nBuilt-in database matches:\n")
        print(f"  {'#':>3s}  {'Name':<35s} {'State':>5s}  "
              f"{'Lat':>9s}  {'Lng':>10s}")
        print(f"  {'─'*3}  {'─'*35} {'─'*5}  {'─'*9}  {'─'*10}")
        for i, (k, (lng, lat, rad, st)) in enumerate(builtin_hits, 1):
            print(f"  {i:3d}  {k:<35s} {st:>5s}  {lat:9.4f}  {lng:10.4f}")

    if cache_hits:
        print(f"\nCached results:\n")
        for entry in cache_hits:
            print(f"  {entry['name']} ({entry['state']}) — "
                  f"{entry['lat']:.4f}°N, {entry['lng']:.4f}°W")

    if offline:
        if not builtin_hits and not cache_hits:
            print(f"\nNo offline results for '{name}'. "
                  f"Try without --offline to search GNIS.")
        return

    print(f"\nSearching USGS GNIS for '{name}'", end='')
    if state:
        print(f" in {state.upper()}", end='')
    print("...\n")

    results = gnis_search(name, state)
    if not results:
        print("No results found.")
        return

    print(f"Found {len(results)} lake(s)/reservoir(s):\n")
    print(f"  {'#':>3s}  {'Name':<35s} {'State':>5s}  {'Type':<12s}  "
          f"{'Lat':>9s}  {'Lng':>10s}")
    print(f"  {'─'*3}  {'─'*35} {'─'*5}  {'─'*12}  {'─'*9}  {'─'*10}")

    for i, r in enumerate(results, 1):
        print(f"  {i:3d}  {r['name']:<35s} {r['state']:>5s}  "
              f"{r['type']:<12s}  {r['lat']:9.4f}  {r['lng']:10.4f}")

    # Save to cache
    cache = load_cache()
    for r in results:
        cache_lake(cache, r['name'], r['lng'], r['lat'], r['state'])
    print(f"\n  ({len(results)} results cached for future offline use)")


def main():
    ap = argparse.ArgumentParser(
        description='Map Garmin GMAPMF tiles to US lake coverage.\n'
                    'Searches built-in DB (127 major lakes), local cache, '
                    'then USGS GNIS (~132K lakes) live.',
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('tiles_root', nargs='?', type=Path, default=None,
                    help='Root directory with .GMP tiles (e.g. F:\\Garmin\\Charts\\Tiles)')
    ap.add_argument('--lake', type=str, default=None,
                    help='Search for a specific lake by name (partial match)')
    ap.add_argument('--search', type=str, default=None,
                    help='Search GNIS for a lake name (no tile scan)')
    ap.add_argument('--state', type=str, default=None,
                    help='Filter to lakes in a specific state (e.g. SC, TX)')
    ap.add_argument('--all', action='store_true',
                    help='Map all lakes in built-in database + cache')
    ap.add_argument('--coords', nargs=2, type=float, metavar=('LNG', 'LAT'),
                    help='Search by coordinates (longitude latitude)')
    ap.add_argument('--name', type=str, default='Custom Location',
                    help='Name for --coords search')
    ap.add_argument('--radius', type=float, default=None,
                    help='Search radius in degrees (default: per-lake or 0.15)')
    ap.add_argument('--json', type=str, default=None,
                    help='Write JSON output to file')
    ap.add_argument('--pad', type=float, default=0.02,
                    help='Overlap padding in degrees (default: 0.02)')
    ap.add_argument('--offline', action='store_true',
                    help='Skip GNIS API lookups (use only built-in DB + cache)')
    ap.add_argument('--cache-stats', action='store_true',
                    help='Show cache statistics and exit')
    ap.add_argument('--cache-clear', action='store_true',
                    help='Clear the lake cache and exit')
    args = ap.parse_args()

    # Handle cache management commands
    if args.cache_stats:
        cache = load_cache()
        print(f"Lake cache: {CACHE_FILE}")
        print(f"  {len(cache)} cached lake(s)")
        if cache:
            by_state = defaultdict(int)
            for entry in cache.values():
                by_state[entry['state']] += 1
            for st in sorted(by_state, key=lambda s: -by_state[s]):
                print(f"    {st}: {by_state[st]}")
        return

    if args.cache_clear:
        try:
            os.remove(CACHE_FILE)
            print("Cache cleared.")
        except FileNotFoundError:
            print("No cache file to clear.")
        return

    # Handle --search (no tiles needed)
    if args.search:
        do_search(args.search, args.state, offline=args.offline)
        return

    # Everything else needs tiles_root
    if not args.tiles_root:
        ap.error("tiles_root is required (unless using --search, --cache-stats, "
                 "or --cache-clear)")

    cache = load_cache()

    # Build search list
    if args.coords:
        radius = args.radius or 0.15
        lakes_to_scan = [(args.name, args.coords[0], args.coords[1],
                          radius, '??', 'coords')]
    elif args.lake:
        resolved = resolve_lake(args.lake, args.state, cache, args.offline)
        if not resolved:
            print(f"No lakes matching '{args.lake}'.")
            if not args.offline:
                print("(GNIS API was also checked)")
            print("\nTip: try --search to browse GNIS, or --coords LNG LAT")
            sys.exit(1)
        lakes_to_scan = resolved
    elif args.state:
        st = args.state.upper()
        lakes_to_scan = []
        for k, (lng, lat, rad, s) in LAKE_DB.items():
            if st in s:
                lakes_to_scan.append((k, lng, lat, rad, s, 'built-in'))
        # Also include cached lakes for this state
        for key, entry in cache.items():
            if entry['state'].upper() == st:
                if not any(l[0] == entry['name'] for l in lakes_to_scan):
                    lakes_to_scan.append((
                        entry['name'], entry['lng'], entry['lat'],
                        entry.get('radius', 0.15), entry['state'], 'cache'
                    ))
        if not lakes_to_scan:
            print(f"No lakes in state '{args.state}' in built-in DB or cache.")
            print(f"Tip: try --search to find lakes via GNIS")
            sys.exit(1)
    elif args.all:
        lakes_to_scan = []
        for k, (lng, lat, rad, s) in LAKE_DB.items():
            lakes_to_scan.append((k, lng, lat, rad, s, 'built-in'))
        # Include all cached lakes not already in built-in
        for key, entry in cache.items():
            if not any(l[0] == entry['name'] and l[4] == entry['state']
                       for l in lakes_to_scan):
                lakes_to_scan.append((
                    entry['name'], entry['lng'], entry['lat'],
                    entry.get('radius', 0.15), entry['state'], 'cache'
                ))
    else:
        # Default: just built-in DB
        lakes_to_scan = [(k, lng, lat, rad, s, 'built-in')
                         for k, (lng, lat, rad, s) in LAKE_DB.items()]

    # Scan tiles
    c_tiles = list(args.tiles_root.rglob('C*.GMP'))
    print(f"Scanning {len(c_tiles)} C-tiles for bounds...")

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
            print(f"  ...{i+1}/{len(c_tiles)} scanned")

    print(f"Read {len(tile_data)} tile headers ({errors} failed/skipped)\n")

    # Map lakes to tiles
    results = {}
    for lake_name, lng, lat, radius, state, source in sorted(
            lakes_to_scan, key=lambda x: x[0]):
        if args.radius:
            radius = args.radius
        lake_bbox = make_lake_bbox(lng, lat, radius)

        matches = []
        for td in tile_data:
            if overlaps(td['bounds'], lake_bbox, pad=args.pad):
                w, e, s, n = td['bounds']
                matches.append({
                    'tile': td['name'],
                    'path': td['path'],
                    'bounds': f"W={w:.4f} E={e:.4f} S={s:.4f} N={n:.4f}",
                    'size_mb': td['size'] / 1024 / 1024,
                    'tre7_count': td['tre7_count'],
                })

        results[lake_name] = {
            'state': state,
            'source': source,
            'centroid': (lng, lat),
            'tiles': matches,
            'tile_count': len(matches),
        }

    # Print report
    print("=" * 72)
    print("LAKE → TILE COVERAGE MAP")
    print("=" * 72)

    covered = []
    uncovered = []
    for lake_name, info in sorted(results.items()):
        if info['tiles']:
            covered.append((lake_name, info))
        else:
            uncovered.append((lake_name, info))

    if covered:
        print(f"\nCOVERED ({len(covered)} lakes):\n")
        for lake_name, info in covered:
            total_mb = sum(t['size_mb'] for t in info['tiles'])
            total_tre7 = sum(t['tre7_count'] for t in info['tiles'])
            src_tag = f" [{info['source']}]" if info['source'] != 'built-in' else ''
            print(f"  {lake_name} ({info['state']}){src_tag}")
            print(f"    {info['tile_count']} tiles, {total_mb:.1f} MB total, "
                  f"{total_tre7} TRE7 entries")
            for t in info['tiles']:
                print(f"      {t['tile']:12s}  {t['size_mb']:6.1f} MB  "
                      f"{t['tre7_count']:5d} TRE7  {t['bounds']}")
            print()

    if uncovered:
        print(f"NOT COVERED ({len(uncovered)} lakes):\n")
        for lake_name, info in uncovered:
            lng, lat = info['centroid']
            print(f"  {lake_name} ({info['state']})  "
                  f"({lat:.2f}°N, {lng:.2f}°W)")

    # Reverse map: tile → lakes
    tile_to_lakes = defaultdict(list)
    for lake_name, info in results.items():
        for t in info['tiles']:
            tile_to_lakes[t['tile']].append(lake_name)

    if tile_to_lakes:
        print(f"\n{'=' * 72}")
        print(f"TILE → LAKE REVERSE MAP ({len(tile_to_lakes)} tiles)")
        print(f"{'=' * 72}\n")
        for tname in sorted(tile_to_lakes.keys()):
            lake_list = tile_to_lakes[tname]
            print(f"  {tname}: {', '.join(sorted(lake_list))}")

    # Summary
    print(f"\n{'=' * 72}")
    print(f"SUMMARY")
    print(f"{'=' * 72}")
    print(f"  Total tiles scanned:  {len(tile_data)}")
    print(f"  Lakes searched:       {len(lakes_to_scan)}")
    n_builtin = sum(1 for l in lakes_to_scan if l[5] == 'built-in')
    n_cache = sum(1 for l in lakes_to_scan if l[5] == 'cache')
    n_gnis = sum(1 for l in lakes_to_scan if l[5] == 'gnis')
    parts = []
    if n_builtin: parts.append(f"{n_builtin} built-in")
    if n_cache:   parts.append(f"{n_cache} cached")
    if n_gnis:    parts.append(f"{n_gnis} from GNIS")
    if parts:
        print(f"    ({', '.join(parts)})")
    print(f"  Lakes with coverage:  {len(covered)}")
    print(f"  Lakes without:        {len(uncovered)}")
    if covered:
        total_unique_tiles = len(tile_to_lakes)
        total_size = sum(
            td['size'] for td in tile_data
            if td['name'] in tile_to_lakes
        )
        print(f"  Unique tiles needed:  {total_unique_tiles}")
        print(f"  Total tile data:      {total_size / 1024 / 1024:.1f} MB")

    # JSON output
    if args.json:
        with open(args.json, 'w') as f:
            json.dump(results, f, indent=2, default=str)
        print(f"\nJSON written to {args.json}")


if __name__ == '__main__':
    main()