#!/usr/bin/env python3
r"""
fetch_osm_structures.py — OSM fishing structures for every TrollMap waterbody:
lakes, rivers and coastal zones, in one script and one set of passes.

WHAT CHANGED, AND WHY
---------------------
The old script clipped a state PBF to one lake's bbox, scanned the clip, then
threw the clip away -- once per lake per state. osmconvert has to read the whole
extract to produce a clip, so the cost of a clip is the size of the extract, not
the size of the lake:

    1,482 lakes -> 2,803 clips -> ~848 GB read  -> ~6.5 hours   (measured: 30 s/lake)

The lakes do not move between clips and neither does the PBF. Reading each
extract ONCE and asking, for every structure found, "which waterbodies is this
inside?" costs:

    4 extracts -> 1.13 GB read -> a few minutes

That is the whole idea. The per-lake loop is gone; what is left is a scan phase
(4 passes, one per extract) and a write phase (one file per waterbody).

Two things follow from reading everything at once, and both are improvements:

  * There is no longer any need to guess which extracts a lake's bbox can reach.
    The old STATE_BOUNDS table existed only to avoid pointless clips, and getting
    it wrong was SILENT -- one extract too few on a border lake and the far bank's
    docks were simply absent. Every waterbody now participates in every pass.

  * Coastal zones are no longer a separate script. fetch_osm_coastal.py scanned
    the same three extracts for 22 more boxes and wrote the same R2 key,
    `{slug}/osm-structures.geojson`, so the two scripts could silently overwrite
    each other depending on which ran last. Coastal is folded in here.

    Coastal is NOT merged by flattening the two tag sets together. The coastal
    classifier deliberately reads some tags differently -- `natural=island` is
    SHORELINE on the coast and ISLAND on a lake, `waterway=dock` is MARINA on the
    coast and PIER on a lake -- so collection uses the union of both tag filters
    (the coastal one is a strict superset) and classification is chosen per slug.
    Lake output is byte-for-byte what it was; coastal output likewise.

Usage:
    py fetch_osm_structures.py                       # everything, upload
    py fetch_osm_structures.py --dry-run             # everything, no upload
    py fetch_osm_structures.py --out-dir osm_out     # also write files locally
    py fetch_osm_structures.py --lake lake_murray_sc # one waterbody
    py fetch_osm_structures.py --from-cache          # re-run writes, skip the scan
    py fetch_osm_structures.py --list

Requires:
    - pyosmium:  pip install osmium --break-system-packages
    - shapely (optional, big speedup on river point-in-polygon)
    - PBF extracts in F:\TrollMapPipeline\osm_pbf\
    - osmconvert64.exe is NO LONGER USED
"""

import sys
import json
import gzip
import math
import hashlib
import time
import argparse
import subprocess
import threading
from pathlib import Path
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

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

try:
    from coastal_catalog import COASTAL_CATALOG
except ImportError:
    print("ERROR: coastal_catalog.py not found in same directory")
    sys.exit(1)

try:
    from shapely.geometry import Polygon as _Poly, Point as _Point
    from shapely.ops import unary_union as _uu
    from shapely.prepared import prep as _prep
    HAVE_SHAPELY = True
except ImportError:
    HAVE_SHAPELY = False


# ── Config ────────────────────────────────────────────────────────────────────
PIPELINE            = Path(r'F:\TrollMapPipeline')
PBF_DIR             = PIPELINE / 'osm_pbf'
TMP_DIR             = PIPELINE / 'osm_tmp'
BOUNDARIES_DIR      = PIPELINE / 'lake_boundaries'
REGISTRY_BOUNDARIES = PIPELINE / 'registry' / 'boundaries'
INDEX_JSON          = PIPELINE / 'registry' / 'lake_index.json'
CHARTPACK_DIR       = PIPELINE / 'chartpack'
CACHE_FILE          = TMP_DIR / 'osm_scan_cache.json.gz'

R2_BUCKET   = 'trollmap-chartpacks'
WRANGLER_JS = r'C:\Users\Ryan\AppData\Roaming\npm\node_modules\wrangler\bin\wrangler.js'

PBF_FILES = [
    PBF_DIR / 'south-carolina-260717.osm.pbf',
    PBF_DIR / 'north-carolina-260717.osm.pbf',
    PBF_DIR / 'georgia-260717.osm.pbf',
    PBF_DIR / 'tennessee-260717.osm.pbf',
]

SKIP_SLUGS = {'sc_ga_coastal', 'saluda_river_arm'}

# Slugs whose boundary files are unreliable dumps — use the hand-found catalog bbox.
BBOX_USE_CATALOG = {
    'lake_summit', 'lake_adger', 'buckhorn_reservoir', 'lake_mackintosh',
    'lake_reidsville', 'bear_creek_reservoir_ga', 'john_d_long_lake',
    'lookout_shoals_lake',
}

# Cell size for the bbox lookup grid, in degrees. 0.1 deg is ~11 km: small enough
# that a cell rarely holds more than a handful of waterbodies, large enough that a
# big river's bbox does not explode into tens of thousands of cells.
GRID_DEG = 0.1

# A bbox wider than this is almost certainly a broken boundary file rather than a
# real waterbody. It is not fatal -- point-in-polygon still throws out everything
# off the water -- but it is worth saying out loud, because a bbox that big pulls
# every bridge in four counties into the candidate set.
BBOX_SANITY_DEG = 3.0
# ─────────────────────────────────────────────────────────────────────────────


# ── Classification ────────────────────────────────────────────────────────────
# Two classifiers, chosen per slug. They are NOT interchangeable: the coastal one
# reclassifies natural=island as SHORELINE and waterway=dock as MARINA. Running the
# coastal classifier over a lake would silently rename structure types that the
# front end styles by name (js/modules/osm-structure.js STRUCTURE_STYLE).

def classify(tags):
    ww = tags.get('waterway', '')
    mm = tags.get('man_made', '')
    br = tags.get('bridge', '')
    rw = tags.get('railway', '')
    hw = tags.get('highway', '')
    pl = tags.get('place', '')
    nt = tags.get('natural', '')
    le = tags.get('leisure', '')

    if ww in ('dam', 'weir') or mm == 'dam':                   return 'DAM'
    if ww == 'boat_slipway' or le == 'slipway':                return 'BOAT_RAMP'
    if ww == 'dock':                                            return 'PIER'
    if mm in ('pier', 'dock'):                                  return 'PIER'
    if mm == 'breakwater':                                      return 'BREAKWATER'
    if mm == 'groyne':                                          return 'GROYNE'
    if mm in ('buoy', 'artificial_reef'):                       return 'HAZARD_MARKER'
    if tags.get('fish_attractor') == 'yes':                    return 'FISH_ATTRACTOR'
    if nt == 'rock' or tags.get('submerged') == 'yes' \
            or tags.get('hazard') == 'navigation':             return 'HAZARD'
    if br == 'yes':
        if rw:                                                  return 'RAIL_BRIDGE'
        if hw in ('footway', 'path', 'pedestrian'):            return 'FOOT_BRIDGE'
        if hw:                                                  return 'ROAD_BRIDGE'
        return 'BRIDGE'
    if pl in ('island', 'islet') or nt == 'island':           return 'ISLAND'
    return 'OTHER'


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


# The collection filter is the union of the two, which is exactly the coastal one:
# every tag the freshwater filter accepts, the coastal filter also accepts. A
# feature collected here may still be dropped later when its slug's classifier
# returns OTHER -- an inland natural=coastline, say -- and that is intended.
def tags_wanted(tags):
    checks = [
        ('waterway',       {'dam', 'weir', 'boat_slipway', 'dock', 'tidal_channel', 'boatyard'}),
        ('man_made',       {'pier', 'dock', 'jetty', 'groyne', 'breakwater',
                            'buoy', 'beacon', 'marina', 'artificial_reef'}),
        ('leisure',        {'marina', 'fishing', 'slipway'}),
        ('place',          {'island', 'islet'}),
        ('natural',        {'reef', 'shoal', 'rock', 'island', 'coastline', 'beach', 'mud'}),
        ('fish_attractor', {'yes'}),
        ('submerged',      {'yes'}),
        ('hazard',         {'navigation'}),
    ]
    for key, vals in checks:
        if tags.get(key) in vals:
            return True
    if tags.get('seamark:type'):
        return True
    if tags.get('bridge') == 'yes' and (tags.get('highway') or tags.get('railway')):
        return True
    return False


# Only these tags survive the scan. Everything else is dropped at collection time so
# that holding a few hundred thousand candidate features in memory stays cheap. This
# is the union of every tag either classifier reads and every tag either writer emits.
KEEP_TAGS = (
    'waterway', 'man_made', 'bridge', 'railway', 'highway', 'place', 'natural',
    'leisure', 'seamark:type', 'fish_attractor', 'submerged', 'hazard',
    'operator', 'gauge', 'depth', 'name', 'alt_name', 'ref',
)

LAKE_PROP_TAGS = ('waterway', 'man_made', 'bridge', 'railway', 'highway',
                  'place', 'natural', 'operator', 'gauge', 'submerged', 'hazard')
COAST_PROP_TAGS = ('waterway', 'man_made', 'bridge', 'railway', 'highway',
                   'place', 'natural', 'leisure', 'operator',
                   'seamark:type', 'submerged', 'hazard', 'depth')


def make_feature(tags, osm_type, osm_id, lon, lat, coastal):
    structure_type = (classify_coastal if coastal else classify)(tags)
    if structure_type == 'OTHER':
        return None
    props = {
        'structure_type': structure_type,
        'source':         'osm',
        'query_method':   'pbf_scan',
        'osm_id':         osm_id,
        'osm_type':       osm_type,
    }
    name = tags.get('name') or tags.get('alt_name') or tags.get('ref')
    if name:
        props['name'] = name
    for tag in (COAST_PROP_TAGS if coastal else LAKE_PROP_TAGS):
        if tag in tags:
            props[tag] = tags[tag]
    return {
        'type': 'Feature',
        'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
        'properties': props,
    }


# ── Work list ─────────────────────────────────────────────────────────────────

def best_boundary_file(slug):
    """The boundary the pack was actually clipped against, so the OSM bbox matches
    the water the contours cover. registry/boundaries/ first: it covers all 1,502
    shipped slugs, where lake_boundaries/ covers 171."""
    reg = REGISTRY_BOUNDARIES / f"{slug}.geojson"
    if reg.exists():
        return reg
    for suffix in ('_nhd', '_3dhp', '_river'):
        fp = BOUNDARIES_DIR / f"{slug}{suffix}.geojson"
        if fp.exists():
            return fp
    return None


def _geom_bbox(path):
    """(s, n, w, e) over every coordinate in a GeoJSON file, or None."""
    try:
        gj = json.loads(Path(path).read_text(encoding='utf-8'))
    except Exception:
        return None
    lo_x = lo_y = float('inf')
    hi_x = hi_y = float('-inf')

    def eat(c):
        nonlocal lo_x, lo_y, hi_x, hi_y
        if not c:
            return
        if isinstance(c[0], (int, float)):
            x, y = c[0], c[1]
            if x < lo_x: lo_x = x
            if x > hi_x: hi_x = x
            if y < lo_y: lo_y = y
            if y > hi_y: hi_y = y
            return
        for sub in c:
            eat(sub)

    for feat in gj.get('features', []):
        eat((feat.get('geometry') or {}).get('coordinates'))
    if lo_x == float('inf'):
        return None
    return (lo_y, hi_y, lo_x, hi_x)


BBOX_BUFFER_DEG = 0.01                       # ~1 km, matches the old get_tight_bbox


def resolve_bbox(slug, warn):
    """(s, n, w, e) for a non-coastal slug, or None.

    lake_index.json is consulted before the boundary file purely for speed: its
    bounds_wsen is derived from the same geometry and was spot-checked against a
    fresh parse of 14 boundaries -- lakes, ponds and the three longest rivers --
    agreeing to the last stored digit on all of them. Parsing all 1,502 boundary
    files here instead would mean reading 209 MB of JSON before the first extract
    is even opened, and then reading it a second time for the point-in-polygon pass.
    """
    cat = LAKE_CATALOG.get(slug)
    if slug in BBOX_USE_CATALOG and cat:
        return tuple(cat['bbox'])

    b = (_index().get(slug) or {}).get('bounds_wsen')
    if b and len(b) == 4:
        w, s, e, n = b                       # index stores W,S,E,N
        return (s - BBOX_BUFFER_DEG, n + BBOX_BUFFER_DEG,
                w - BBOX_BUFFER_DEG, e + BBOX_BUFFER_DEG)

    bf = best_boundary_file(slug)
    if bf is not None:
        bb = _geom_bbox(bf)
        if bb:
            s, n, w, e = bb
            return (s - BBOX_BUFFER_DEG, n + BBOX_BUFFER_DEG,
                    w - BBOX_BUFFER_DEG, e + BBOX_BUFFER_DEG)
        warn.append(f"{slug}: boundary file {bf.name} has no usable coordinates")

    if cat:
        return tuple(cat['bbox'])
    return None


_INDEX_CACHE = {}


def _index():
    if not _INDEX_CACHE:
        try:
            _INDEX_CACHE.update(json.loads(INDEX_JSON.read_text(encoding='utf-8')))
        except Exception:
            _INDEX_CACHE['__empty__'] = {}
    return _INDEX_CACHE


def work_list(catalog_only=False):
    """Every waterbody that gets a file: lakes, rivers and coastal zones.

    Lakes and rivers come from what is actually built -- the chartpack directories --
    not from lake_catalog.py, which is hand-maintained, holds 96 entries and was
    written when the pipeline covered a few dozen curated lakes. 1,406 of the 1,482
    built freshwater packs are not in it and had never had structures fetched.

    Coastal zones come from COASTAL_CATALOG rather than from the chartpack dirs,
    because two of the 22 zones (coast_st_helena_sc, coast_core_sound_nc) have no
    pack yet and should still get structures.
    """
    warn = []
    entries = {}

    for slug, z in COASTAL_CATALOG.items():
        if slug in SKIP_SLUGS:
            continue
        s, n, w, e = z['bbox']
        entries[slug] = {
            'name':    z['name'],
            'bbox':    (s, n, w, e),
            'coastal': True,
            'tide_station': z.get('tide_station'),
        }

    if catalog_only:
        fresh = [s for s in LAKE_CATALOG if s not in SKIP_SLUGS]
    elif CHARTPACK_DIR.is_dir():
        fresh = [d.name for d in CHARTPACK_DIR.iterdir() if d.is_dir()]
    else:
        fresh = list(_index())

    for slug in sorted(set(fresh)):
        if slug in SKIP_SLUGS or slug.startswith('coast_') or slug in entries:
            continue
        bb = resolve_bbox(slug, warn)
        if bb is None:
            warn.append(f"{slug}: no boundary, no catalog bbox, no index bounds — SKIPPED")
            continue
        rec = _index().get(slug) or {}
        name = (LAKE_CATALOG.get(slug, {}).get('name')
                or rec.get('display_name') or rec.get('name') or slug)
        entries[slug] = {'name': name, 'bbox': bb, 'coastal': False,
                         'tide_station': None}

    for slug, e in entries.items():
        s, n, w, ee = e['bbox']
        if (n - s) > BBOX_SANITY_DEG or (ee - w) > BBOX_SANITY_DEG:
            warn.append(f"{slug}: bbox spans {ee-w:.2f} x {n-s:.2f} deg — suspiciously large")

    return entries, warn


# ── Scan phase ────────────────────────────────────────────────────────────────

def build_grid(entries):
    grid = defaultdict(list)
    for slug, e in entries.items():
        s, n, w, ee = e['bbox']
        gx0, gx1 = math.floor(w / GRID_DEG), math.floor(ee / GRID_DEG)
        gy0, gy1 = math.floor(s / GRID_DEG), math.floor(n / GRID_DEG)
        for gx in range(int(gx0), int(gx1) + 1):
            for gy in range(int(gy0), int(gy1) + 1):
                grid[(gx, gy)].append(slug)
    return dict(grid)


class Collector:
    """Holds every candidate feature found so far and which waterbodies claim it.

    Shared across all four passes so that a structure on a state line -- the far
    bank of Lake Wylie, say -- is stored once and claimed by whichever waterbodies
    contain it, no matter which extract found it first.
    """

    def __init__(self, entries):
        self.boxes  = {s: e['bbox'] for s, e in entries.items()}
        self.grid   = build_grid(entries)
        self.ids    = {}                    # (otype, oid) -> feature index
        self.feats  = []                    # [otype, oid, lon, lat, tags]
        self.assign = defaultdict(list)     # slug -> [feature index]

    def take(self, otype, oid, lon, lat, tags):
        # First sighting wins, outright. Geofabrik cuts state extracts with complete
        # ways, so a structure on a state line appears in full in both -- same id,
        # same nodes, same centroid, therefore the same set of waterbodies claiming
        # it. Re-assigning on the second sighting would put it in the file twice.
        key = (otype, oid)
        if key in self.ids:
            return
        cell = (math.floor(lon / GRID_DEG), math.floor(lat / GRID_DEG))
        cands = self.grid.get(cell)
        if not cands:
            return
        boxes = self.boxes
        hits = []
        for slug in cands:
            s, n, w, e = boxes[slug]
            if s <= lat <= n and w <= lon <= e:
                hits.append(slug)
        if not hits:
            return
        idx = len(self.feats)
        self.ids[key] = idx
        self.feats.append([otype, oid, lon, lat,
                           {k: tags[k] for k in KEEP_TAGS if k in tags}])
        for slug in hits:
            self.assign[slug].append(idx)


class ScanHandler(osmium.SimpleHandler):
    def __init__(self, collector):
        super().__init__()
        self.c = collector
        self.seen_nodes = 0
        self.seen_ways = 0

    def node(self, n):
        self.seen_nodes += 1
        if not n.tags or not tags_wanted(n.tags):
            return
        try:
            lat = float(n.location.lat)
            lon = float(n.location.lon)
        except Exception:
            return
        self.c.take('node', n.id, lon, lat, n.tags)

    def way(self, w):
        self.seen_ways += 1
        if not w.tags or not tags_wanted(w.tags):
            return
        try:
            lats = [float(nd.lat) for nd in w.nodes if nd.location.valid()]
            lons = [float(nd.lon) for nd in w.nodes if nd.location.valid()]
        except Exception:
            return
        if not lats:
            return
        self.c.take('way', w.id, sum(lons) / len(lons), sum(lats) / len(lats), w.tags)


def scan(entries, pbfs, index_kind):
    c = Collector(entries)
    print(f"  grid: {len(c.grid):,} cells over {len(entries):,} waterbodies")
    for pbf in pbfs:
        if not pbf.exists():
            print(f"  ⚠️  missing extract: {pbf.name}  — structures in this state will be absent")
            continue
        t0 = time.time()
        before = len(c.feats)
        print(f"  {pbf.stem}: {pbf.stat().st_size/1e6:.0f} MB ...", end=' ', flush=True)
        h = ScanHandler(c)
        h.apply_file(str(pbf), locations=True, idx=index_kind)
        print(f"{h.seen_nodes/1e6:.1f}M nodes, {h.seen_ways/1e6:.2f}M ways → "
              f"+{len(c.feats)-before:,} new candidates  [{time.time()-t0:.0f}s]")
    return c


def _worklist_stamp(entries, pbfs):
    """What the cached candidates depend on. If any of it moved, the cache is a lie."""
    # hashlib, not hash(): str.__hash__ is salted per process, so a built-in hash
    # would differ between the run that wrote the cache and the run that reads it.
    blob = '\n'.join(f"{s}|{e['bbox'][0]:.5f}|{e['bbox'][1]:.5f}|"
                     f"{e['bbox'][2]:.5f}|{e['bbox'][3]:.5f}"
                     for s, e in sorted(entries.items()))
    return {
        'slugs':  len(entries),
        'digest': hashlib.md5(blob.encode('utf-8')).hexdigest(),
        'pbfs':   sorted(p.name for p in pbfs if p.exists()),
    }


def save_cache(c, stamp):
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    payload = {'stamp': stamp, 'feats': c.feats,
               'assign': {k: v for k, v in c.assign.items()}}
    with gzip.open(CACHE_FILE, 'wt', encoding='utf-8') as fh:
        json.dump(payload, fh)
    print(f"  scan cached → {CACHE_FILE}  ({CACHE_FILE.stat().st_size/1e6:.1f} MB)")


def load_cache(entries, stamp, subset=None):
    if not CACHE_FILE.exists():
        print(f"❌ no scan cache at {CACHE_FILE} — run once without --from-cache")
        sys.exit(1)
    with gzip.open(CACHE_FILE, 'rt', encoding='utf-8') as fh:
        payload = json.load(fh)
    old = payload.get('stamp') or {}
    # --lake narrows the work list on purpose, so only the extract set and the
    # geometry of the slug being asked for have to match.
    if subset is None and old != stamp:
        print("❌ the cached scan was taken against a different work list:")
        print(f"     cached: {old.get('slugs')} waterbodies, extracts {old.get('pbfs')}")
        print(f"     now:    {stamp['slugs']} waterbodies, extracts {stamp['pbfs']}")
        print("   Re-run without --from-cache.")
        sys.exit(1)
    if subset is not None and old.get('pbfs') != stamp['pbfs']:
        print(f"⚠️  cached scan used extracts {old.get('pbfs')}, not {stamp['pbfs']}")
    c = Collector(entries)
    c.feats = payload['feats']
    c.assign = defaultdict(list, payload['assign'])
    print(f"  scan cache: {len(c.feats):,} candidates, "
          f"{len(c.assign):,} waterbodies with hits")
    return c


# ── Point-in-polygon ──────────────────────────────────────────────────────────
# Outer rings only, holes ignored — deliberately. A hole in one of these boundaries
# is nearly always an island, and a dock on an island shore sits just inside the
# hole. Honouring holes would drop exactly the structures worth marking.

def load_rings(slug):
    bf = best_boundary_file(slug)
    if bf is None:
        return []
    try:
        gj = json.loads(bf.read_text(encoding='utf-8'))
    except Exception:
        return []
    rings = []
    for feat in gj.get('features', []):
        geom = feat.get('geometry') or {}
        t, c = geom.get('type', ''), geom.get('coordinates') or []
        if t == 'Polygon' and c:
            rings.append([(p[0], p[1]) for p in c[0]])
        elif t == 'MultiPolygon':
            for poly in c:
                if poly:
                    rings.append([(p[0], p[1]) for p in poly[0]])
    return rings


def point_in_ring(lon, lat, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if ((yi > lat) != (yj > lat)) and \
                (lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def build_pip(slug):
    """A callable (lon, lat) -> bool, or None when the slug has no boundary."""
    rings = load_rings(slug)
    if not rings:
        return None, 0
    if HAVE_SHAPELY:
        polys = []
        for r in rings:
            if len(r) < 4:
                continue
            p = _Poly(r)
            if not p.is_valid:
                try:
                    p = p.buffer(0)
                except Exception:
                    continue
            if not p.is_empty and p.area > 0:
                polys.append(p)
        if polys:
            geom = _prep(_uu(polys))
            return (lambda lon, lat: geom.contains(_Point(lon, lat))), len(rings)
    boxed = [(min(x for x, _ in r), max(x for x, _ in r),
              min(y for _, y in r), max(y for _, y in r), r) for r in rings]

    def hit(lon, lat):
        for x0, x1, y0, y1, r in boxed:
            if x0 <= lon <= x1 and y0 <= lat <= y1 and point_in_ring(lon, lat, r):
                return True
        return False

    return hit, len(rings)


# ── Write phase ───────────────────────────────────────────────────────────────

_print_lock = threading.Lock()


def upload_to_r2(slug, path, retries=1):
    r2_key = f"{slug}/osm-structures.geojson"
    cmd =['node', WRANGLER_JS, 'r2', 'object', 'put', f'{R2_BUCKET}/{r2_key}',
           '--file', str(path), '--content-type', 'application/json', '--remote']
    last = ''
    for attempt in range(retries + 1):
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=180)
            out = (r.stdout.decode('utf-8', 'replace') +
                   r.stderr.decode('utf-8', 'replace'))
            if r.returncode == 0 or 'success' in out.lower():
                return True, 'ok'
            last = out.strip()[:200] or f'exit {r.returncode}'
        except subprocess.TimeoutExpired:
            last = 'upload timeout'
        except FileNotFoundError:
            return False, 'node/wrangler not found'
    return False, last


def build_and_upload(slug, entry, collector, args):
    coastal = entry['coastal']
    pip, nrings = (None, 0) if coastal else build_pip(slug)
    # Coastal zones get no point-in-polygon pass: their registry boundary IS the
    # bbox rectangle, so filtering against it would be a no-op that costs a file read.

    kept, dropped = [], 0
    for idx in collector.assign.get(slug, ()):
        otype, oid, lon, lat, tags = collector.feats[idx]
        if pip is not None and not pip(lon, lat):
            dropped += 1
            continue
        f = make_feature(tags, otype, oid, lon, lat, coastal)
        if f:
            kept.append(f)

    gj = {
        'type': 'FeatureCollection',
        'features': kept,
        'metadata': {
            'source':        'openstreetmap',
            'via':           'geofabrik_pbf_scan',
            'fetched_at':    time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'feature_count': len(kept),
        },
    }
    if coastal:
        gj['metadata']['coastal'] = True
        gj['metadata']['tide_station'] = entry.get('tide_station')

    text = json.dumps(gj)
    if args.out_dir:
        out = Path(args.out_dir)
        out.mkdir(parents=True, exist_ok=True)
        (out / f'{slug}.geojson').write_text(text, encoding='utf-8')

    if args.dry_run:
        ok, msg = True, 'DRY RUN'
    else:
        TMP_DIR.mkdir(parents=True, exist_ok=True)
        tmp = TMP_DIR / f'_osm_{slug}.geojson'
        tmp.write_text(text, encoding='utf-8')
        ok, msg = upload_to_r2(slug, tmp)
        if not args.keep_tmp:
            tmp.unlink(missing_ok=True)

    by_type = Counter(f['properties']['structure_type'] for f in kept)
    return {'slug': slug, 'name': entry['name'], 'coastal': coastal,
            'kept': len(kept), 'dropped': dropped, 'rings': nrings,
            'ok': ok, 'msg': msg, 'kb': len(text.encode()) // 1024,
            'by_type': dict(by_type)}


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description='OSM structures for every TrollMap waterbody, in four passes.')
    ap.add_argument('--lake', '--zone', dest='lake', action='append',
                    help='Restrict to this waterbody (lake, river or coastal zone). '
                         'Repeatable: --lake a --lake b. Topping up after new packs are '
                         'registered still costs a full scan, but one scan, not one each.')
    ap.add_argument('--dry-run', action='store_true', help='Build files but do not upload')
    ap.add_argument('--list', action='store_true', help='List the work list and exit')
    ap.add_argument('--out-dir', help='Also write each GeoJSON here')
    ap.add_argument('--catalog-only', action='store_true',
                    help='Freshwater side limited to lake_catalog.py (96 entries)')
    ap.add_argument('--from-cache', action='store_true',
                    help='Skip the scan and reuse the cached candidates')
    ap.add_argument('--jobs', type=int, default=4,
                    help='Parallel uploads (default 4; wrangler spawns a node per file)')
    ap.add_argument('--index', default='flex_mem',
                    help="pyosmium node location index. Default flex_mem (RAM). "
                         "Use 'sparse_file_array,F:\\TrollMapPipeline\\osm_tmp\\nodes.idx' "
                         "if a pass runs out of memory.")
    ap.add_argument('--pbf', action='append',
                    help='Restrict to extracts whose filename contains this string. '
                         'Spot checks only — skipping an extract silently loses the '
                         'structures it held.')
    ap.add_argument('--keep-tmp', action='store_true', help='Do not delete per-slug temp files')
    args = ap.parse_args()

    entries, warn = work_list(catalog_only=args.catalog_only)

    if args.lake:
        bad = [s for s in args.lake if s not in entries]
        if bad:
            for s in bad:
                print(f"❌ Unknown slug: {s}")
                near = [k for k in entries if s in k][:8]
                if near:
                    print("   did you mean: " + ', '.join(near))
            sys.exit(1)
        entries = {s: entries[s] for s in args.lake}

    if args.list:
        print(f"{'SLUG':45} {'KIND':7} NAME")
        print('-' * 96)
        for slug, e in sorted(entries.items()):
            print(f"  {slug:45} {'coastal' if e['coastal'] else 'fresh':7} {e['name']}")
        n_coast = sum(1 for e in entries.values() if e['coastal'])
        print(f"\n{len(entries)} waterbodies — {len(entries)-n_coast} fresh, {n_coast} coastal")
        for w in warn:
            print(f"  ⚠️  {w}")
        return

    pbfs = PBF_FILES
    if args.pbf:
        pbfs = [p for p in PBF_FILES if any(t.lower() in p.name.lower() for t in args.pbf)]
        skipped = [p.stem for p in PBF_FILES if p not in pbfs]
        if skipped:
            print(f"⚠️  --pbf given: NOT reading {', '.join(skipped)}. "
                  f"Any structure only in those extracts will be missing.")

    n_coast = sum(1 for e in entries.values() if e['coastal'])
    print("TrollMap OSM Structure Extractor — one pass per extract")
    print(f"PBF dir:      {PBF_DIR}")
    print(f"Waterbodies:  {len(entries):,}  ({len(entries)-n_coast:,} fresh, {n_coast} coastal)")
    print(f"Point-in-poly: {'shapely' if HAVE_SHAPELY else 'pure python (pip install shapely for speed)'}")
    print(f"Mode:         {'DRY RUN — nothing uploads' if args.dry_run else 'UPLOAD to R2'}")
    print('─' * 72)
    for w in warn:
        print(f"⚠️  {w}")
    if warn:
        print('─' * 72)

    t0 = time.time()
    stamp = _worklist_stamp(entries, pbfs)
    if args.from_cache:
        print("Scan: reusing cache")
        c = load_cache(entries, stamp, subset=args.lake)
    else:
        print(f"Scan: {len(pbfs)} extract(s)")
        c = scan(entries, pbfs, args.index)
        if not args.lake:
            save_cache(c, stamp)
    t_scan = time.time() - t0
    claimed = sum(1 for s in entries if c.assign.get(s))
    print(f"Scan done in {t_scan/60:.1f} min — {len(c.feats):,} candidate structures, "
          f"{claimed:,}/{len(entries):,} waterbodies with at least one")
    print('─' * 72)

    t1 = time.time()
    results = []
    order = sorted(entries.items())
    done = 0
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        for res in pool.map(lambda kv: build_and_upload(kv[0], kv[1], c, args), order):
            results.append(res)
            done += 1
            mark = '✅' if res['ok'] else '❌'
            with _print_lock:
                print(f"  [{done:>4}/{len(order)}] {mark} {res['slug']:42} "
                      f"{res['kept']:>4} kept  {res['dropped']:>5} off-water  "
                      f"{res['kb']:>4} KB"
                      + ('' if res['ok'] else f"   {res['msg']}"))
    t_write = time.time() - t1

    ok = [r for r in results if r['ok']]
    bad = [r for r in results if not r['ok']]
    total_feats = sum(r['kept'] for r in results)
    empty = [r for r in results if r['kept'] == 0]
    noring = [r for r in results if not r['coastal'] and r['rings'] == 0]
    types = Counter()
    for r in results:
        types.update(r['by_type'])

    print('─' * 72)
    print(f"Scan  {t_scan/60:.1f} min   Write {t_write/60:.1f} min   "
          f"Total {(time.time()-t0)/60:.1f} min")
    print(f"{len(ok)} written, {len(bad)} failed, {total_feats:,} structures")
    print(f"By type: {dict(types.most_common())}")
    if noring:
        print(f"⚠️  {len(noring)} freshwater waterbodies had no boundary polygon "
              f"(bbox only, no off-water filter): "
              f"{', '.join(r['slug'] for r in noring[:8])}"
              + (' …' if len(noring) > 8 else ''))
    if empty:
        print(f"ℹ️  {len(empty)} waterbodies have no structures at all "
              f"(an empty collection was still written)")
    if bad:
        print("FAILED:")
        for r in bad:
            print(f"  {r['slug']:45} {r['msg']}")
        print("Re-run just the writes with:  py fetch_osm_structures.py --from-cache")
        sys.exit(1)


if __name__ == '__main__':
    main()
