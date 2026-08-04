#!/usr/bin/env python3
r"""make_river_boundaries.py - cut river boundaries from 3DHP, named by the DNR ramp feeds.

Personal use only, not for distribution or resale; not for navigation.

    # dump the feeds first (once):
    #   foreach ($s in 'SC','NC','GA','TN') {
    #     curl.exe -s "https://trollmap-worker.colonal1981.workers.dev/ramps?state=$s" `
    #       | Out-File -Encoding utf8 "registry\_dnr_ramps_$($s.ToLower()).json" }
    py .\make_river_boundaries.py `
       --gpkg  "F:\TrollMapPipeline\3dhp_all_CONUS_20260112_GPKG\3dhp_all_CONUS_20260112_GPKG.gpkg" `
       --feeds "F:\TrollMapPipeline\registry" `
       --index "F:\TrollMapPipeline\registry\lake_index.json" `
       --out   "F:\TrollMapPipeline\lake_boundaries"
    # ... reports what it would cut, writes nothing. Then --go.

WHY THIS EXISTS

"North Santee River" and 243 other DNR waterbodies reach the TrollMap picker from the live
SCDNR / NCWRC / GADNR ArcGIS feeds, with ramps, and resolve to nothing. They have no registry
row, so no boundary, so no chartpack -- while Garmin's contours for that water sit decoded on
disk. See RIVERS_AND_DNR_WATERBODIES_2026-08-03.md.

3DHP HAS the geometry: 3,308 `featuretype=1` (River) polygons across SC/NC/GA/TN. What it does
not have is names -- 2 of 3,308 carry a `gnisidlabel`, and both joins that would recover them
are dead (waterbody.mainstemid is NULL; flowline.waterbodyid3dhp is unindexed on a 56 GB file
and a single lookup times out).

So the name comes from the DNR feed and the shape comes from 3DHP, matched spatially. Verified
on the Ocmulgee before this was written -- see RIVER_METHOD_VERIFIED_2026-08-03.md:

    ramp -> nearest river polygon:  25 m, 10 m, 28 m   (ramps sit on the BANK, never inside)
    8 polygons -> 3 components; the 6-polygon run is 96 km of channel, and all three ramps
    seed that same component. The 0.19 and 0.01 km2 singletons drop out on their own.

THE TWO TOLERANCES, AND WHY THEY ARE WHAT THEY ARE

    --ramp-tol 100 m    Ramps are on the bank. Measured 10-28 m, so this is 3-10x margin and
                        still far short of reaching a parallel creek.
    --join-tol  50 m    3DHP splits at HUC12 boundaries and leaves hairline gaps. Requiring
                        true adjacency fragments every river that crosses one.

READING THE GPKG WITHOUT GEOPANDAS

Parsed here in pure Python so this runs anywhere:
  - header `GP`, flags byte; envelope length is {0:0,1:32,2:48,3:48,4:64}[(flags>>1)&7];
    WKB starts at 8 + envelope.
  - **Geometry is type 1006 -- MultiPolygon Z. Points are THREE doubles.** Parsing them as 2D
    drifts the offset and dies asking for a 66 GB buffer, which reads like file corruption
    rather than a parser bug. `typ // 1000`: 1=Z, 2=M, 3=ZM.
  - SRS is EPSG:6350 (Conus Albers, METRES). A lat/lon bbox query silently returns zero rows.
  - Use the rtree with INTERSECT semantics. Containment (`minx>=X0 AND maxx<=X1`) throws away
    long thin shapes, which is the entire population here.
"""
import argparse, codecs, glob, json, math, os, re, sqlite3, struct, sys, time
from collections import defaultdict

FLOW = re.compile(r'\b(river|creek|run|slough|bayou|canal|swamp|branch|fork|cut|waterway|icw)\b', re.I)


# --------------------------------------------------------------------------- gpkg

def gpkg_wkb(blob):
    """Strip the GeoPackage binary header, return raw WKB."""
    if blob[:2] != b'GP':
        raise ValueError('not a GeoPackage blob')
    env = (blob[3] >> 1) & 7
    return blob[8 + {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[env]:]


def wkb_exterior_rings(wkb):
    """Exterior rings only, as [[(x, y), ...], ...]. Holes are dropped deliberately -- an
    island inside a river does not change where the river is, and keeping them doubles the
    vertex count for a mask that fills the outer ring anyway."""
    o = 0
    bo = '<' if wkb[o] == 1 else '>'
    o += 1
    typ = struct.unpack_from(bo + 'I', wkb, o)[0]
    o += 4
    base = typ % 1000
    dim = 2 + (1 if (typ // 1000) in (1, 3) else 0) + (1 if (typ // 1000) in (2, 3) else 0)
    out = []

    def one_poly(o):
        nrings = struct.unpack_from(bo + 'I', wkb, o)[0]
        o += 4
        ext = None
        for i in range(nrings):
            npt = struct.unpack_from(bo + 'I', wkb, o)[0]
            o += 4
            pts = struct.unpack_from(bo + '%dd' % (dim * npt), wkb, o)
            o += 8 * dim * npt
            if i == 0:
                ext = [(pts[j], pts[j + 1]) for j in range(0, len(pts), dim)]
        return ext, o

    if base == 3:
        e, o = one_poly(o)
        out.append(e)
    elif base == 6:
        ngeom = struct.unpack_from(bo + 'I', wkb, o)[0]
        o += 4
        for _ in range(ngeom):
            o += 1 + 4                      # each sub-geometry repeats byte-order + type
            e, o = one_poly(o)
            out.append(e)
    return [r for r in out if r and len(r) >= 4]


# --------------------------------------------------------------------------- feeds

# Garmin coverage is stored as a set of occupied grid cells, roughly 220 m square.
#
# The question being asked is only "is there charted data in this polygon", which does not
# need coordinates -- it needs presence. That distinction is worth 33 minutes: json.loads on
# one 32 MB tile costs 3.5 s, and there are 3.3 GB of them, which is ~38 minutes of parsing
# to build objects that are thrown away immediately. Scanning the decompressed bytes for
# coordinate pairs and dropping each into a grid cell costs ~5 minutes and constant memory.
GARMIN_CELL = 0.002          # degrees; ~222 m N-S, ~185 m E-W at 34 N
COORD_RE = re.compile(rb'\[\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*\]')


def garmin_coverage(extract, region, cache_path):
    """{(ix, iy)} of grid cells Garmin charts. Cached -- the scan is the slow part and its
    inputs change only when the extractor runs again.

    Only `contours` and `depth_areas` count. Those say the water has been SURVEYED; pois and
    docks say only that someone put a marker near it.

    TILE LETTER RULE, which has cost this project two debugging sessions: contours,
    depth_areas and hydrography are **C** tiles; pois, docks, garmin_shoreline and waterbody
    are **B** tiles. Globbing for B here finds nothing and reads as "Garmin has no data",
    which is the most expensive wrong answer available.
    """
    import gzip, hashlib

    files = []
    for layer in ('contours', 'depth_areas'):
        d = os.path.join(extract, layer)
        if not os.path.isdir(d):
            print('  !! no %s in --extract; coverage will be understated' % layer, flush=True)
            continue
        got = sorted(glob.glob(os.path.join(d, 'C*.geojson'))
                     + glob.glob(os.path.join(d, 'C*.geojson.gz')))
        if not got:
            print('  !! %s has no C* tiles -- contours are C tiles, not B' % layer, flush=True)
        files += got
    if not files:
        return set()

    # Cache key covers every input file's identity AND size, so a re-extract invalidates it.
    sig = hashlib.sha1(('|'.join('%s:%d' % (os.path.basename(f), os.path.getsize(f))
                                 for f in files)).encode()).hexdigest()[:16]
    if cache_path and os.path.exists(cache_path):
        try:
            blob = json.load(open(cache_path, encoding='utf-8'))
            if blob.get('sig') == sig and blob.get('cell') == GARMIN_CELL:
                cells = {tuple(c) for c in blob['cells']}
                print('  Garmin coverage read from cache: %d cells (%s)'
                      % (len(cells), os.path.basename(cache_path)), flush=True)
                return cells
            print('  cache is stale (extract changed) -- rescanning', flush=True)
        except Exception as exc:
            print('  cache unreadable (%s) -- rescanning' % exc, flush=True)

    W, S, E, N = region
    cells = set()
    t = time.time()
    for n, fp in enumerate(files, 1):
        try:
            op = gzip.open if fp.endswith('.gz') else open
            with op(fp, 'rb') as fh:
                raw = fh.read()
        except Exception as exc:
            print('    %s unreadable (%s)' % (os.path.basename(fp), exc), flush=True)
            continue
        for m in COORD_RE.finditer(raw):
            lon = float(m.group(1)); lat = float(m.group(2))
            if W <= lon <= E and S <= lat <= N:
                cells.add((int(lon / GARMIN_CELL), int(lat / GARMIN_CELL)))
        if n % 25 == 0 or n == len(files):
            print('    scanned %d/%d tiles, %d cells, %.0fs'
                  % (n, len(files), len(cells), time.time() - t), flush=True)

    if cache_path:
        try:
            json.dump({'sig': sig, 'cell': GARMIN_CELL, 'cells': sorted(cells)},
                      open(cache_path, 'w', encoding='utf-8'))
            print('  cached to %s -- later runs skip the scan' % cache_path, flush=True)
        except Exception as exc:
            # Not fatal: the coverage is already computed. It just costs the scan again.
            print('  could not write the cache (%s)' % exc, flush=True)
    return cells


def read_feeds(folder):
    """slug-ish name -> {'name', 'states', 'pts'}, deduped across state feeds.

    Savannah River is in BOTH the GA and SC feeds; the Intracoastal is in NC and SC. Importing
    per-feed would create two overlapping registry rows for one river and the picker would
    offer both. Merge on the normalised name and keep every ramp.
    """
    out = {}
    seen = {}   # key -> set of rounded (lat, lon), so a site in two feeds counts once
    tally = {'ramps': 0, 'paddle': 0}
    paddle_keys = set()
    ramps_keys = set()
    # FOUR states, not three. TWRA is a live source in the Worker's /ramps handler and both
    # ramps-loader.js and access-index.js request STATES = ['SC','NC','GA','TN'] -- so the app
    # has always had Tennessee ramps while this list has never seen them. Every river cut and
    # every coastal pointer produced so far was computed without a single TWRA landing.
    # A missing file warns below rather than raising, which is why nobody noticed.
    #
    # TWO feeds per state, not one. Ryan asked the right question on 2026-08-04 -- "did we
    # look at access sites when deciding it had a ramp or not, did we use that to assist with
    # river extraction" -- and the answer was no. Every count and every river cut before today
    # used /ramps only. That is not a rounding error on a kayak-fishing map: a river whose
    # only access is a canoe slide had ZERO landings here, so it owned no geometry and never
    # made the registry at all. TN's Barren Fork, Collins and Wolf are exactly that shape.
    #
    # The paddle feeds are NOT disjoint from the ramps feeds. NC serves both routes from one
    # layer (paddle is the non-motorized subset of the same sites), and a GA access point can
    # carry Ramp=Y and CanoeAcc=Y at once. Deduping on rounded coordinates keeps a site from
    # being weighted twice when ownership is decided. SC and TN happen to be disjoint -- SC
    # filters one layer on WaterAccessType, TN uses two views with different Type values --
    # but relying on that would be relying on an accident.
    for st in ('sc', 'nc', 'ga', 'tn'):
        for kind in ('ramps', 'paddle'):
            fp = os.path.join(folder, '_dnr_%s_%s.json' % (kind, st))
            if not os.path.exists(fp):
                print('  !! missing %s -- dump it with the curl in the docstring' % fp)
                continue
            raw = open(fp, 'rb').read()
            if raw[:3] == codecs.BOM_UTF8:
                raw = raw[3:]
            doc = json.loads(raw.decode('utf-8'))
            # A stale-cache body from the Worker carries the data some EARLIER deploy
            # computed. Cutting river geometry against it would bake a silent regression
            # into the registry, so refuse it rather than warn and carry on.
            if doc.get('stale'):
                raise SystemExit('%s is a STALE Worker response (%s). Re-pull it with '
                                 '&refresh before cutting anything.'
                                 % (fp, doc.get('staleError') or 'no error recorded'))
            for wb, sites in (doc.get('waterbodies') or {}).items():
                key = re.sub(r'[^a-z0-9]', '', wb.lower())
                fresh = []
                mark = seen.setdefault(key, set())
                for r in sites:
                    la, lo = r.get('lat'), r.get('lon')
                    if not (isinstance(la, (int, float)) and isinstance(lo, (int, float))):
                        continue
                    tag = (round(la, 5), round(lo, 5))
                    if tag in mark:
                        continue
                    mark.add(tag)
                    fresh.append((la, lo))
                if not fresh:
                    continue
                e = out.setdefault(key, {'name': title_case(wb), 'states': set(),
                                         'pts': [], 'pt_states': []})
                e['states'].add(st.upper())
                (ramps_keys if kind == 'ramps' else paddle_keys).add(key)
                e['pts'] += fresh
                # Which feed each ramp came from. Needed because a name present in two feeds may
                # be two DIFFERENT rivers -- the split below has to hand each piece its own state,
                # or both halves of "North River" get filed as GA/NC and the registry install puts
                # the Georgia one in North Carolina.
                e['pt_states'] += [st.upper()] * len(fresh)
                tally[kind] += len(fresh)
                if kind == 'paddle':
                    paddle_keys.add(key)
                # NC SHOUTS and GA/SC do not. Prefer the entry that is not all-caps.
                if wb != wb.upper() and e['name'].isupper():
                    e['name'] = title_case(wb)
    # The number that answers "would paddle launches have helped": waterbodies that have
    # NO boat ramp anywhere and exist in this list only because someone can put a kayak in.
    # Before 2026-08-04 every one of these had zero landings, owned no geometry, and was
    # therefore absent from the registry entirely.
    only_paddle = sorted(paddle_keys - ramps_keys)
    print('  feeds: %d ramp landings, %d paddle landings, %d waterbodies '
          '(%d reachable only by paddle)'
          % (tally['ramps'], tally['paddle'], len(out), len(only_paddle)), flush=True)
    if only_paddle:
        show = [out[k]['name'] for k in only_paddle[:8]]
        print('    paddle-only e.g.: %s%s'
              % ('; '.join(show), ' ...' if len(only_paddle) > 8 else ''), flush=True)
    return out


def title_case(s):
    """`NEUSE RIVER` -> `Neuse River`, leaving mixed-case feeds alone."""
    if s != s.upper():
        return s.strip()
    small = {'of', 'the', 'at'}
    return ' '.join(w if w in small else w.capitalize() for w in s.strip().lower().split())


def slugify(name):
    s = re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_')
    return re.sub(r'_+', '_', s)


def registry_key(nm):
    """The registry's own loose name form: no parenthetical, no trailing state, no 'Lake'."""
    n = re.sub(r'\(.*?\)', '', (nm or '').lower())
    n = re.sub(r',\s*[a-z/]{2,5}$', '', n)
    n = re.sub(r'\b(lake|reservoir|res|pond|impoundment|the)\b', ' ', n)
    return re.sub(r'[^a-z0-9]', '', n)


def registry_index(index_path):
    """Every name the registry answers to -> its slug. The set of keys is what tells this
    script which water is already built; the slug is what lets a DNR name that turns out to be
    an existing lake point AT that lake instead of becoming a dead entry in the picker -- SC's
    "Catawba River" ramp is on Lake Wylie, and saying so is more useful than dropping it."""
    if not index_path or not os.path.exists(index_path):
        return {}
    idx = json.load(open(index_path, encoding='utf-8'))
    out = {}
    for slug, v in idx.items():
        for nm in ([v.get('name'), v.get('display_name'), v.get('legacy_display_name')]
                   + (v.get('legacy_display_names') or [])):
            if nm:
                out.setdefault(registry_key(nm), slug)
    return out


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--gpkg', required=True, help='3dhp_all_CONUS_*.gpkg')
    ap.add_argument('--feeds', required=True,
                    help='folder holding _dnr_ramps_{sc,nc,ga,tn}.json AND '
                         '_dnr_paddle_{sc,nc,ga,tn}.json')
    ap.add_argument('--out', required=True, help='lake_boundaries folder')
    ap.add_argument('--index', help='lake_index.json -- skip waterbodies already in the registry')
    ap.add_argument('--only', help='comma list of DNR names. A filter on what gets WRITTEN; '
                                   'the region loaded still covers every feed so ownership is '
                                   'decided the same way a full run decides it.')
    ap.add_argument('--narrow-region', action='store_true',
                    help='draw the load region around --only alone. Faster and NOT equivalent: '
                         'competing names whose landings fall outside the box cannot claim '
                         'polygons, so a river can grow through a confluence it would lose in '
                         'a full run. Spot checks only.')
    ap.add_argument('--flowing-only', action='store_true',
                    help='only names that look like flowing water (river/creek/slough/...)')
    ap.add_argument('--ramp-tol', type=float, default=100.0, help='metres, ramp -> polygon')
    ap.add_argument('--join-tol', type=float, default=50.0, help='metres, polygon -> polygon')
    ap.add_argument('--no-split', action='store_true',
                    help='do NOT split a name whose ramps sit on unconnected water. Only for '
                         'comparing against the old behaviour -- the split is almost always '
                         'what you want.')
    ap.add_argument('--salt-line',
                    help='Saltwater_Freshwater_Dividing_Line.geojson. With --catalog, saltwater '
                         'ramps stop seeding river boundaries and become pointers to their '
                         'coastal zone instead.')
    ap.add_argument('--catalog',
                    help='coastal_catalog.py, for the 22 zone boxes')
    ap.add_argument('--coastal-slack-km', type=float, default=25.0,
                    help='NC/GA only: how far outside a coastal zone a ramp may sit and still '
                         'count as saltwater. Deliberately generous -- in those two states a '
                         'wrong pointer is free and a wrong river boundary is a thousand '
                         'square kilometres of marsh. SC is unaffected; it has the statute.')
    ap.add_argument('--extract',
                    help='per-tile extractor output (the same folder build_chartpack.py reads). '
                         'When given, a river extends past its ramps for as long as Garmin '
                         'actually charts the water, instead of by a fixed --pad-km guess.')
    ap.add_argument('--garmin-cache',
                    help='where to keep the scanned Garmin coverage. Defaults to '
                         '<extract>/_garmin_coverage.json. The scan reads 3.3 GB and is the '
                         'slow part; the cache makes every later run skip it.')
    ap.add_argument('--max-reach-km', type=float, default=25.0,
                    help='hard ceiling on the Garmin-led extension. Without it, a basin that '
                         'Garmin charts end to end would let the Ocmulgee grow down the '
                         'Altamaha again -- the exact bug --pad-km was reinstated to stop.')
    ap.add_argument('--pad-km', type=float, default=2.0,
                    help='how far past the outermost ramp a river may extend, km. This is a '
                         'REAL bound, not a speed knob: rivers in a basin are physically '
                         'connected, so without it the Ocmulgee grows through its confluence '
                         'into the Oconee, the Altamaha and the sea.')
    ap.add_argument('--min-km2', type=float, default=0.05,
                    help='drop a result smaller than this -- a lone pond by a boat ramp')
    ap.add_argument('--lakes', action='store_true',
                    help='Impoundments instead of flowing water. Widens the 3DHP pool to '
                         'featuretype 3 (Lake) alongside 1/2, and writes <slug>_lake.geojson '
                         'with kind=lake. Everything else -- ramp ownership, the connected '
                         'growth, the Garmin reach bound, the coastal cut -- is the same '
                         'machinery, because a reservoir scattered across 400 unnamed 3DHP '
                         'fragments is the same problem as a river. Intended with --only.')
    ap.add_argument('--go', action='store_true', help='write. Default is a dry run.')
    a = ap.parse_args()

    try:
        from pyproj import Transformer
        from shapely.geometry import Polygon, Point
        from shapely.ops import unary_union
        from shapely import STRtree
    except ImportError as exc:
        sys.exit('needs pyproj and shapely: %s' % exc)

    to_m = Transformer.from_crs('EPSG:4326', 'EPSG:6350', always_xy=True)
    to_ll = Transformer.from_crs('EPSG:6350', 'EPSG:4326', always_xy=True)

    feeds = read_feeds(a.feeds)
    registry = registry_index(a.index)
    known = set(registry)
    want = {re.sub(r'[^a-z0-9]', '', x.lower()) for x in a.only.split(',')} if a.only else None

    todo = []
    for key, e in feeds.items():
        if want is not None and key not in want:
            continue
        if want is None:
            if key in known:
                continue
            if a.flowing_only and not FLOW.search(e['name']):
                continue
        # The feed key survives the connected-component split below, which renames the pieces
        # ('north_river' -> 'north_river_1'). Ownership is a property of the NAME, not of the
        # piece, so the claim test has to look at the original.
        e['_fkey'] = key
        todo.append((key, e))
    # ── salt water is not a river ────────────────────────────────────────────
    #
    # Ryan's design, in his words: "can we have them map to the correct zones contours... so
    # if shem creek is in the list and I select it, trollmap pans to the correct area and
    # shows me contours... we only need the contours 1 time but they should be able to be
    # selected by both."
    #
    # So a saltwater waterbody gets NO boundary. It becomes a pointer: the coastal zone holds
    # the contours once, and the name carries its own viewport so selecting it pans there.
    # That is what stops twelve Georgia creeks each filling the same estuary and coming back
    # at 1,053 km2 apiece.
    #
    # Per RAMP, not per name. Seven SC waterbodies genuinely straddle US-17 with a landing on
    # each bank; forcing one answer would be wrong in both directions.
    coastal, zones = {}, {}
    fresh_all = None          # fkey -> freshwater ramps only; None when --salt-line is absent
    if a.salt_line and a.catalog:
        try:
            from classify_salt_fresh import load_dividers, build_index, classify
            import classify_salt_fresh as CSF
            from zone_coverage import parse_catalog, zone_of, nearest_zone
        except ImportError as exc:
            sys.exit('--salt-line needs classify_salt_fresh.py and zone_coverage.py beside '
                     'this file: %s' % exc)
        CSF.SEAWARD = (math.cos(math.radians(-45.0)), math.sin(math.radians(-45.0)))
        index = build_index(load_dividers(a.salt_line))
        zones = parse_catalog(a.catalog)
        print('salt/fresh: %d divider features, %d coastal zones'
              % (len(index), len(zones)), flush=True)

        def split_pts(e):
            """(fresh, salt) for one feed entry, each [(lat, lon, zone, state), ...]."""
            srcs = e.get('pt_states') or ([None] * len(e['pts']))
            fresh_pts, salt_pts = [], []
            for i, (lat, lon) in enumerate(e['pts']):
                st = (srcs[i] if i < len(srcs) else None) or 'SC'
                if st == 'SC':
                    # The statute. Exact, and the state Ryan actually fishes.
                    z = zone_of(lat, lon, zones)
                    verdict = classify(lon, lat, index, e['name'])[0]
                else:
                    # NC and GA publish no usable line, so zone membership is the classifier --
                    # with slack, because "outside every zone" would otherwise mean freshwater
                    # and turn every tidal creek just past a zone edge into a marsh-filling
                    # river. Turtle River: one ramp, 1,053 km2.
                    z = nearest_zone(lat, lon, zones, within_km=a.coastal_slack_km)
                    verdict = 'salt' if z else 'fresh'
                (salt_pts if verdict == 'salt' else fresh_pts).append((lat, lon, z, st))
            return fresh_pts, salt_pts

        # Ownership below is decided by landings, and a SALTWATER landing must not count.
        #
        # The Ashepoo is entirely saltwater, so it becomes a pointer and is never cut -- but its
        # ramps still sat nearest a freshwater polygon upstream, so it "owned" that water and
        # Chessie Creek and Horseshoe Creek, which really do launch on it, were left pointing at
        # a boundary that does not exist. Ownership therefore runs on freshwater ramps only.
        # Every name in the feeds is classified, not just the ones on this run's worklist,
        # because --only and --index change the worklist and must not change who owns what.
        fresh_all = {}
        for fkey, fe in feeds.items():
            fp, _sp = split_pts(fe)
            fresh_all[fkey] = [(lat, lon) for lat, lon, _z, _st in fp]

        kept, n_salt, n_fresh = [], 0, 0
        for key, e in todo:
            fresh_pts, salt_pts = split_pts(e)
            n_salt += len(salt_pts); n_fresh += len(fresh_pts)

            if salt_pts:
                # Group by zone. A name whose salt ramps span two zones is two pointers, the
                # same way a name on two unconnected rivers is two rivers.
                byzone = defaultdict(list)
                for lat, lon, z, st in salt_pts:
                    byzone[z].append((lat, lon, st))
                for gi, (z, pts) in enumerate(sorted(byzone.items(),
                                                     key=lambda kv: -len(kv[1]))):
                    nm = e['name'] if gi == 0 else '%s (%d)' % (e['name'], gi + 1)
                    lats = [p[0] for p in pts]; lons = [p[1] for p in pts]
                    PAD = 0.02          # ~2 km, so a single-ramp creek still gets a view
                    coastal[slugify(nm)] = {
                        'name': nm,
                        'zone': z,                       # None means orphan -- see below
                        'states': sorted({p[2] for p in pts}),
                        'ramps': len(pts),
                        'center': [round(sum(lats) / len(lats), 5),
                                   round(sum(lons) / len(lons), 5)],
                        'bounds': [round(min(lons) - PAD, 5), round(min(lats) - PAD, 5),
                                   round(max(lons) + PAD, 5), round(max(lats) + PAD, 5)],
                        'source': 'saltwater; contours come from the coastal zone',
                    }

            if fresh_pts:
                sub = dict(e)
                sub['pts'] = [(lat, lon) for lat, lon, _, _ in fresh_pts]
                sub['pt_states'] = [st for _, _, _, st in fresh_pts]
                sub['states'] = sorted({st for _, _, _, st in fresh_pts}) or e['states']
                kept.append((key, sub))

        orphan = [v['name'] for v in coastal.values() if not v['zone']]
        print('  %d saltwater ramps -> %d coastal pointers   %d freshwater ramps -> %d rivers'
              % (n_salt, len(coastal), n_fresh, len(kept)), flush=True)
        if orphan:
            # A pointer with no zone is a name that appears in the list and does nothing when
            # selected. Loud, because it is invisible in the app.
            print('  !! %d pointer(s) land in NO coastal zone and would resolve to nothing: %s'
                  % (len(orphan), ', '.join(orphan[:10])), flush=True)
        print(flush=True)
        todo = kept
    elif a.salt_line or a.catalog:
        sys.exit('--salt-line and --catalog go together')
    else:
        # Say so. Without these the run silently reverts to cutting saltwater as rivers, and
        # the output looks like a perfectly successful run of the wrong thing -- 241 waterbodies
        # instead of 123, every tidal creek carved as its own boundary. That happened, and the
        # only clue was a number nobody had memorised.
        print()
        print('  !! SALT/FRESH CLASSIFICATION IS OFF -- no --salt-line and --catalog.')
        print('     Every saltwater creek will be cut as a river instead of pointing at its')
        print('     coastal zone. Fine for an inland-only test; wrong for a real run.')
        print()

    todo.sort(key=lambda kv: -len(kv[1]['pts']))
    print('DNR waterbodies to attempt: %d' % len(todo))
    if not todo:
        sys.exit('nothing to do')

    con = sqlite3.connect('file:%s?mode=ro' % a.gpkg.replace('\\', '/'), uri=True)
    made, empty, small, deferred = [], [], [], []

    t0 = time.time()

    # ── load the river polygons ONCE ─────────────────────────────────────────
    #
    # This used to sit inside the per-waterbody loop: an rtree query, a blob fetch and a
    # pure-Python WKB parse, per waterbody, against a 56 GB file. Rivers overlap heavily, so
    # the SAME polygon was fetched from disk, unpacked point by point, validated and often
    # buffer(0)'d again for every one of the ~460 waterbodies whose ramp bbox touched it. The
    # work scaled with (waterbodies x overlapping polygons) when the actual input is 3,308
    # river polygons total -- small enough to hold in memory all day.
    #
    # Now: one bbox covering everything in `todo`, one read, one parse, one validity pass, one
    # index. Every waterbody after that is a tree query against geometry already in RAM. With
    # --only, the bbox covers just that river, so the single-river test stays fast too.
    pad = max(a.ramp_tol * 4, a.pad_km * 1000.0)
    todo_m = []
    RX0 = RY0 = float('inf'); RX1 = RY1 = float('-inf')
    for key, e in todo:
        pts_m = [to_m.transform(lo, la) for la, lo in e['pts']]
        x0 = min(p[0] for p in pts_m) - pad; x1 = max(p[0] for p in pts_m) + pad
        y0 = min(p[1] for p in pts_m) - pad; y1 = max(p[1] for p in pts_m) + pad
        todo_m.append((key, e, pts_m, (x0, y0, x1, y1)))
        RX0 = min(RX0, x0); RX1 = max(RX1, x1)
        RY0 = min(RY0, y0); RY1 = max(RY1, y1)

    # The per-waterbody boxes bound IDENTITY. The region load has to be wider than all of them
    # put together, or phase 2 cannot follow the chart past a ramp box -- the polygons past it
    # would never have been read. Widening only costs candidate rows in one query.
    if a.extract:
        reach_pad = a.max_reach_km * 1000.0
        RX0 -= reach_pad; RX1 += reach_pad
        RY0 -= reach_pad; RY1 += reach_pad

    # ── the region must cover EVERY feed's ramps, not just the ones being cut ─────
    #
    # Ownership is what stops a river growing through a confluence into its neighbour, and it
    # is decided by which name has the most landings ON a polygon. That test can only be won
    # by a ramp that reaches a polygon in the LOADED set -- so a region drawn around `todo`
    # alone silently disenfranchises every competing name whose landings fall outside it.
    #
    # The result is that --only does not give the same answer as a full run. Cutting Congaree
    # and Wateree by themselves produced a Congaree boundary reaching 34.3643 N -- 44 km past
    # its northernmost ramp, up the Broad and Saluda through the confluence at Columbia and
    # into Parr Shoals and Monticello, whose contours then shipped inside the Congaree pack.
    # Broad River has 8 landings and Saluda 2; in a full run they are there to out-vote it.
    #
    # So: load the region that covers ALL feeds. On a full run this changes nothing, because
    # todo already is all of them. On an --only run it costs one wider rtree query and a
    # bigger connected-component pass, and buys the guarantee that --only is a filter on the
    # OUTPUT rather than a change to the answer.
    if not a.narrow_region:
        for fkey, fe in feeds.items():
            for la, lo in (fresh_all[fkey] if fresh_all is not None and fkey in fresh_all
                           else fe['pts']):
                x, y = to_m.transform(lo, la)
                RX0 = min(RX0, x - pad); RX1 = max(RX1, x + pad)
                RY0 = min(RY0, y - pad); RY1 = max(RY1, y + pad)
    elif a.only:
        print('  !! --narrow-region with --only: ownership is decided only by landings inside '
              'the loaded box, so this can differ from a full run. Spot checks only.',
              flush=True)

    print('loading river polygons over the whole region once '
          '(%.0f x %.0f km) ...' % ((RX1 - RX0) / 1000.0, (RY1 - RY0) / 1000.0), flush=True)

    ids = [r[0] for r in con.execute(
        'SELECT id FROM rtree_hydro_3dhp_all_waterbody_shape '
        'WHERE maxx>=? AND minx<=? AND maxy>=? AND miny<=?', (RX0, RX1, RY0, RY1))]
    print('  %d candidate rows in the region bbox' % len(ids), flush=True)

    polys = []          # (id3dhp, areasqkm, shapely Polygon)
    bad = 0
    for i in range(0, len(ids), 900):
        b = ids[i:i + 900]
        # featuretype: 1=River, 2=Canal, 3=Lake. Lake mode ADDS 3 rather than swapping to
        # it, because a run-of-river impoundment is not consistently one or the other in
        # 3DHP -- Blewett Falls and Cheoah are dammed river, and dropping 1/2 would cut them
        # in half at whatever point the survey changed its mind.
        q = ('SELECT id3dhp,areasqkm,shape FROM hydro_3dhp_all_waterbody '
             'WHERE fid IN (%s) AND featuretype IN (%s)'
             % (','.join('?' * len(b)), '1,2,3' if a.lakes else '1,2'))
        for wid, km2, blob in con.execute(q, b):
            try:
                for ring in wkb_exterior_rings(gpkg_wkb(blob)):
                    p = Polygon(ring)
                    if not p.is_valid:
                        p = p.buffer(0)
                    if p.is_valid and p.area > 0:
                        polys.append((wid, km2 or 0.0, p))
            except Exception as exc:
                bad += 1
                if bad <= 5:
                    print('    geometry %s skipped (%s)' % (wid, exc), flush=True)
        if i % 9000 == 0 and i:
            print('    parsed %d/%d rows, %d polygons so far, %.0fs'
                  % (i, len(ids), len(polys), time.time() - t0), flush=True)

    if bad > 5:
        print('    (%d geometries skipped in total)' % bad, flush=True)
    print('  %d %s polygons loaded in %.0fs'
          % (len(polys), 'river/canal/lake' if a.lakes else 'river/canal', time.time() - t0),
          flush=True)
    if not polys:
        sys.exit('no featuretype %s polygons in the region -- check --gpkg'
                 % ('1/2/3' if a.lakes else '1/2'))

    # ── the coastal zones are cut OUT of the river polygons, here, once ─────
    #
    # Ryan's design has one rule about coastal water: the zone owns it. A saltwater name is a
    # pointer into its zone's chartpack rather than a boundary of its own. That rule was being
    # applied to whole 3DHP polygons, and 3DHP gives a whole river one polygon, so it could
    # only ever answer all or nothing about 200 km of water:
    #
    #     Edisto River     ONE polygon, 252 km2, 97% of it inside the coastal boxes
    #     Cape Fear River  ONE polygon, 168 km2, 86% inside
    #     Ashley River     ONE polygon,  50 km2, 90% inside
    #
    # Call them fresh and the boundary swallows the ACE Basin and the Wilmington estuary. Call
    # them salt and the Edisto above Orangeburg, the Cape Fear at Fayetteville and everything
    # else upstream disappears -- which is what was happening: five rivers with no boundary at
    # all, in this run and in every run before it.
    #
    # Neither answer is available per-polygon, so stop answering per-polygon. Subtract the zone
    # boxes from the geometry and the question resolves itself: what is left is the freshwater
    # river, the tidal part belongs to the coastal pack that already covers it, and no water is
    # served twice or lost. Everything downstream -- connectivity, seeds, ownership, extent --
    # then runs on freshwater geometry and needs no salt test of its own, which is why the
    # per-polygon salt classification that used to sit below is gone.
    #
    # The zone box is the instrument rather than SC's statutory line because the box is what
    # actually owns the contours. The statute still decides which RAMPS are saltwater, which is
    # where it is exact and where it was checked 14/14.
    if a.salt_line and a.catalog and zones:
        from shapely.geometry import Polygon as _Poly
        from shapely.ops import unary_union as _uu

        def zone_poly(z):
            """A catalog box in Albers metres. Edges densified because Albers is conic: a
            lat/lon rectangle is a curved quadrilateral here, and four corners would cut the
            corners off it."""
            N, ring = 12, []
            for i in range(N + 1):
                ring.append((z['w'] + (z['e'] - z['w']) * i / N, z['s']))
            for i in range(N + 1):
                ring.append((z['e'], z['s'] + (z['n'] - z['s']) * i / N))
            for i in range(N + 1):
                ring.append((z['e'] - (z['e'] - z['w']) * i / N, z['n']))
            for i in range(N + 1):
                ring.append((z['w'], z['n'] - (z['n'] - z['s']) * i / N))
            return _Poly([to_m.transform(lo, la) for lo, la in ring])

        sc_boxes, other_boxes = [], []
        for z in zones.values():
            (sc_boxes if z['state'] == 'SC' else other_boxes).append(zone_poly(z))
        # The NC/GA slack is the same allowance nearest_zone() gives a ramp, for the same
        # reason: in those two states the zone IS the classifier, so its edge has to be soft.
        coastal_area = _uu(sc_boxes + [p.buffer(a.coastal_slack_km * 1000.0)
                                       for p in other_boxes])
        clipped_polys, dropped, trimmed = [], 0, 0
        for wid, _km2, p in polys:
            if not p.intersects(coastal_area):
                clipped_polys.append((wid, p.area / 1e6, p))
                continue
            try:
                cut = p.difference(coastal_area)
            except Exception:
                clipped_polys.append((wid, p.area / 1e6, p))
                continue
            if cut.is_empty or cut.area <= 0:
                dropped += 1
                continue
            trimmed += 1
            # A cut can leave a river in several pieces -- above and below a zone. Each becomes
            # its own polygon, because the pieces genuinely are not connected any more.
            for q in getattr(cut, 'geoms', [cut]):
                if q.geom_type == 'Polygon' and q.area > 0:
                    clipped_polys.append((wid, q.area / 1e6, q))
        print('  coastal zones cut out: %d polygons dropped as entirely coastal, %d trimmed, '
              '%d -> %d polygons' % (dropped, trimmed, len(polys), len(clipped_polys)),
              flush=True)
        polys = clipped_polys
    else:
        # No zones to subtract. km2 still comes from the geometry rather than the GPKG's
        # areasqkm, which is per FEATURE -- a feature with five rings counted its whole area
        # five times.
        polys = [(wid, p.area / 1e6, p) for wid, _km2, p in polys]

    geoms = [p for (_, _, p) in polys]
    poly_bounds = [g.bounds for g in geoms]
    tree = STRtree(geoms)

    # `predicate='dwithin'` needs Shapely >= 2.0 built against GEOS >= 3.10. Probe it once,
    # here, rather than letting it raise on the first waterbody -- that would be after the
    # whole region load, which is the expensive part, and would look like the script dying
    # for no reason several minutes in.
    try:
        tree.query(geoms[0], predicate='dwithin', distance=1.0)
        def near(geom, tol):
            return (int(i) for i in tree.query(geom, predicate='dwithin', distance=tol))
        mode = "dwithin"
    except Exception as exc:
        # Fallback for an older Shapely: ask the index for everything whose envelope meets a
        # buffered copy, then confirm with an exact distance. Still index-filtered, so still
        # O(n log n) -- just a larger constant than dwithin.
        print('  (STRtree dwithin unavailable -- %s; using buffered query)' % exc, flush=True)
        def near(geom, tol):
            probe = geom.buffer(tol)
            for i in tree.query(probe):
                i = int(i)
                if geom.distance(geoms[i]) <= tol:
                    yield i
        mode = "buffered query"

    print('  spatial index built (%s), %.0fs total\n' % (mode, time.time() - t0), flush=True)

    # ── which name's landings CLAIM which polygon ───────────────────────────
    #
    # THE ASSUMPTION THAT WAS WRONG. Every bound in this script -- --pad-km, --max-reach-km,
    # `in_box` -- was written believing 3DHP models a river as a chain of short reaches, so
    # that bounding WHERE we look bounds what we get. Measured on the Pee Dee basin, 2026-08-04:
    #
    #     453 river/canal polygons, 19 of them more than 50 km across
    #     Lynches River        seeds exactly 1 polygon, OH9AH, 153 km across
    #     Waccamaw River       seeds exactly 1 polygon, OH5UM, 102 km
    #     Black River          seeds exactly 1 polygon, OH4LG,  78 km
    #     Great Pee Dee River  seeds exactly 1 polygon, OH654, 206 km
    #
    # 3DHP gives a whole named river ONE polygon. The seeds were never the problem -- those are
    # four different rivers, correctly identified. The growth was: --join-tol 50 m unions them
    # at the confluences, and no box can stop it, because `in_box` asks whether a polygon's
    # BOUNDING BOX meets this river's ramp box and a 206 km polygon's bbox meets every box in
    # the basin. It gets admitted whole. That is how seven names -- Pee Dee, Great Pee Dee,
    # Little Pee Dee, Little Pee Dee (2), Waccamaw, Black, Lynches -- came out of the 2026-08-03
    # run carrying one identical 190 x 182 km geometry, and why widening or tightening a
    # distance never moved it.
    #
    # So the bound has to be about OWNERSHIP, not distance: a polygon that another name's
    # landings sit on belongs to that name, and this river may not annex it. Polygons nobody
    # launches on stay free to join, which is what keeps 3DHP's HUC12 hairline splits working --
    # the Ocmulgee's 37 pieces are unclaimed fragments, not other people's rivers.
    #
    # Claims come from EVERY name in the feeds, not just the ones being cut. A river already in
    # the registry (skipped by --index) or filtered out by --flowing-only still owns its water;
    # otherwise which names happen to be on the worklist would change the shape of the answer.
    # ONE LANDING, ONE WATER. Seeding every polygon within --ramp-tol looks harmless -- 100 m
    # is a tight radius -- but at a confluence it is not a radius, it is a junction. SC's Black
    # Creek has a single ramp near where it meets the Great Pee Dee; within 100 m of it lie two
    # different 3DHP polygons, and taking both made "Black Creek" 0.0103 deg2 of water spanning
    # the Great Pee Dee AND the Black River, which then swallowed both as aliases of a creek.
    #
    # A boat ramp launches onto ONE body of water. The nearest polygon is that body -- ramps
    # were measured at 10-28 m from their own bank, so second place is a different river, not a
    # tie. Ties break on index so a re-run gives the same answer.
    def seed_of(pt):
        best = None
        for j in near(pt, a.ramp_tol):
            j = int(j)
            d = pt.distance(geoms[j])
            if best is None or d < best[0]:
                best = (d, j)
        return None if best is None else best[1]

    # MOST LANDINGS WINS, and the rest are names for the same water.
    #
    # Co-claiming is not enough, because a name can have landings on two rivers at once. SC's
    # Black Creek has two ramps: one on the Great Pee Dee's polygon, one on the Black River's.
    # Both are legitimately "near a Black Creek ramp", so under a shared claim Black Creek came
    # out as the union of two rivers -- 56.50 km2, bigger than either -- and then swallowed both
    # as aliases of a creek. The connected-component split cannot catch it: the Black River
    # flows INTO the Pee Dee, so the two polygons are one component and the ramps never look
    # unconnected.
    #
    # A polygon belongs to the name with the most landings on it. Great Pee Dee has 12 on
    # OH654, Black Creek 1, so OH654 is the Great Pee Dee's. Black River has 10 on OH4LG,
    # Black Mingo Creek 1, so OH4LG is the Black River's. A name left owning nothing is not a
    # missing river -- it is another name for water that already has one, which is exactly what
    # an alias is for. Ties go to the name with more landings overall, then alphabetically, so
    # a re-run never reshuffles.
    def ramp_pts(fkey, fe):
        return fresh_all[fkey] if fresh_all is not None else fe['pts']

    ramps_on = {}
    for fkey, fe in feeds.items():
        for la, lo in ramp_pts(fkey, fe):
            j = seed_of(Point(*to_m.transform(lo, la)))
            if j is not None:
                ramps_on.setdefault(j, {})
                ramps_on[j][fkey] = ramps_on[j].get(fkey, 0) + 1
    owner = {}
    for j, counts in ramps_on.items():
        owner[j] = min((-n, -len(ramp_pts(k, feeds[k])), k) for k, n in counts.items())[2]
    contested = sum(1 for v in ramps_on.values() if len(v) > 1)
    print('  %d of %d polygons carry a freshwater landing (%d carry more than one name)\n'
          % (len(owner), len(geoms), contested), flush=True)

    # ── which polygons are actually connected to which ──────────────────────
    #
    # One union-find pass over the index at --join-tol gives the river network's connected
    # components. This replaces an earlier attempt that split a name when its ramps were more
    # than N km apart, which was the wrong instrument: a real river with one remote 50 km
    # stretch between ramps would have been cut in half by it, and picking N was a guess.
    #
    # Connectivity is not a guess. The DNR feeds are merged by name, so "North River" arrives
    # as one entry holding a Georgia river and a North Carolina one -- 3 ramps, 506 km apart,
    # a box covering the coast, 959 polygons and 1,950 km2 of nonsense. Those two rivers are
    # not connected by water. A genuinely long river IS, however sparse its ramps, so it is
    # never split. The test answers the actual question instead of correlating with it.
    # ── which polygons Garmin actually charts ───────────────────────────────
    #
    # Ryan's question, when asked to pick a --pad-km: "is there a way to check how much of
    # these garmin has and match to that?" That retires the guess. This boundary exists for
    # exactly one purpose -- telling build_chartpack.py which decoded Garmin features belong to
    # this river -- so its right edge is not a distance past the last ramp, it is where the
    # chart stops. Extending past Garmin's coverage adds empty boundary; stopping short of it
    # throws away charted water already sitting on disk.
    has_garmin = None
    if a.extract:
        wll, sll = to_ll.transform(RX0, RY0)
        ell, nll = to_ll.transform(RX1, RY1)
        # A conic box's corners are not its lat/lon extremes -- the same trap that made the
        # span column print negative -- so widen generously. This only prefilters the scan.
        region_ll = (wll - 1.0, sll - 1.0, ell + 1.0, nll + 1.0)
        cache_fp = a.garmin_cache or os.path.join(a.extract, '_garmin_coverage.json')
        print('  indexing Garmin coverage from %s ...' % a.extract, flush=True)
        cells = garmin_coverage(a.extract, region_ll, cache_fp)

        if cells:
            # A polygon is charted if any occupied cell centre falls inside it. Walking the
            # polygon's own cell footprint keeps this proportional to the water, not to the
            # 3.3 GB the cells came from, and it short-circuits on the first hit.
            has_garmin = []
            for g in geoms:
                bx0, by0, bx1, by1 = g.bounds
                w0, s0 = to_ll.transform(bx0, by0)
                w1, s1 = to_ll.transform(bx1, by1)
                lo_x = int(min(w0, w1) / GARMIN_CELL); hi_x = int(max(w0, w1) / GARMIN_CELL)
                lo_y = int(min(s0, s1) / GARMIN_CELL); hi_y = int(max(s0, s1) / GARMIN_CELL)
                found = False
                # Cap the sweep. A pathological bbox must not turn one polygon into a
                # million containment tests; missing a charted polygon costs some extent,
                # hanging the run costs the afternoon.
                if (hi_x - lo_x + 1) * (hi_y - lo_y + 1) <= 40000:
                    for ix in range(lo_x, hi_x + 1):
                        for iy in range(lo_y, hi_y + 1):
                            if (ix, iy) not in cells:
                                continue
                            lon = (ix + 0.5) * GARMIN_CELL
                            lat = (iy + 0.5) * GARMIN_CELL
                            if g.contains(Point(*to_m.transform(lon, lat))):
                                found = True; break
                        if found:
                            break
                else:
                    # Too big to sweep: fall back to "any cell in the bbox at all".
                    found = any((ix, iy) in cells
                                for ix in range(lo_x, hi_x + 1, 8)
                                for iy in range(lo_y, hi_y + 1, 8))
                has_garmin.append(found)
            print('  %d of %d polygons carry Garmin data, %.0fs total\n'
                  % (sum(has_garmin), len(geoms), time.time() - t0), flush=True)
        else:
            print('  !! no Garmin coverage found -- extent falls back to --pad-km\n', flush=True)
    else:
        print('  no --extract given; extent is the --pad-km bound only\n', flush=True)

    # ── which polygons are saltwater ────────────────────────────────────────
    #
    # Phase 2 follows Garmin's coverage past the ramp box. On the coast that walked a
    # FRESHWATER river straight out into the estuary: New River came back 137 polygons and
    # 570 km2 from a single correctly-classified fresh ramp, and the Savannah added 134.
    #
    # The salt line already answers this. A freshwater river has no business extending into
    # saltwater -- that water belongs to a coastal zone, which holds its contours once. So the
    # divide bounds the EXTENSION as well as the classification, instead of one undoing the
    # other.
    parent = list(range(len(geoms)))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    # Saltwater is NOT a bridge between rivers.
    #
    # Ryan, on seeing one 291 km2 "Black River" spanning NC and SC: "i think those are 2
    # different black rivers... they are not the same water." He is right: the SC Black River
    # drains to the Pee Dee and the NC one to the Cape Fear, and they are joined only through
    # the tidal network. This used to need an explicit salt test here to stop the union-find
    # walking that join. It does not any more -- the coastal zones were cut out of the geometry
    # above, so the tidal network is not in `geoms` and there is nothing to walk through.
    for i in range(len(geoms)):
        for j in near(geoms[i], a.join_tol):
            j = int(j)
            ri, rj = find(i), find(j)
            if ri != rj:
                parent[ri] = rj
    ncomp = len({find(i) for i in range(len(geoms))})
    print('  %d connected water bodies in the network, %.0fs total\n' % (ncomp, time.time() - t0),
          flush=True)

    # ── split any name whose ramps land on unconnected water ────────────────
    expanded = []
    for key, e, pts_m, _bbox in todo_m:
        if a.no_split or len(pts_m) < 2:
            expanded.append((key, e, pts_m, _bbox)); continue

        # Which component does each ramp seed?
        comp_of_ramp = []
        for x, y in pts_m:
            j = seed_of(Point(x, y))
            comp_of_ramp.append(find(j) if j is not None else None)

        groups = defaultdict(list)
        for idx, c in enumerate(comp_of_ramp):
            if c is not None:
                groups[c].append(idx)
        if len(groups) < 2:
            # No split -- but the box may still be wrong. `_bbox` was built from EVERY ramp,
            # including any that seeded no polygon at all. North River came back GA/NC with
            # 1,008 polygons and 2,027 km2 for exactly this reason: its NC ramp found no river
            # within --ramp-tol, so it never formed a second component and no split fired,
            # while the box went on spanning 557 km from Georgia to North Carolina and let the
            # fill run through everything in between.
            #
            # A ramp that seeded nothing tells us nothing about where this water is. Rebuild
            # the box from the ones that did.
            seeding = [i for i, c in enumerate(comp_of_ramp) if c is not None]
            if seeding and len(seeding) < len(pts_m):
                gm = [pts_m[i] for i in seeding]
                x0 = min(p[0] for p in gm) - pad; x1 = max(p[0] for p in gm) + pad
                y0 = min(p[1] for p in gm) - pad; y1 = max(p[1] for p in gm) + pad
                print('  tightened %-28s %d of %d ramps sit on no river'
                      % (e['name'][:28], len(pts_m) - len(seeding), len(pts_m)), flush=True)
                expanded.append((key, e, pts_m, (x0, y0, x1, y1))); continue
            expanded.append((key, e, pts_m, _bbox)); continue

        # Biggest group keeps the plain name; the rest are numbered, so two North Rivers stay
        # tellable apart downstream instead of one overwriting the other's file.
        ordered = sorted(groups.values(), key=len, reverse=True)
        print('  split %-30s %d ramps sit on %d unconnected waters'
              % (e['name'][:30], len(pts_m), len(ordered)), flush=True)
        for gi, idxs in enumerate(ordered):
            sub = dict(e)
            sub['pts'] = [e['pts'][i] for i in idxs]
            src = e.get('pt_states') or []
            sub['states'] = sorted({src[i] for i in idxs if i < len(src)}) or sorted(e['states'])
            if gi:
                sub['name'] = '%s (%d)' % (e['name'], gi + 1)
            gm = [pts_m[i] for i in idxs]
            x0 = min(p[0] for p in gm) - pad; x1 = max(p[0] for p in gm) + pad
            y0 = min(p[1] for p in gm) - pad; y1 = max(p[1] for p in gm) + pad
            expanded.append(('%s_%d' % (key, gi) if gi else key, sub, gm, (x0, y0, x1, y1)))
    if len(expanded) != len(todo_m):
        print('  %d -> %d waterbodies after splitting\n' % (len(todo_m), len(expanded)), flush=True)
    todo_m = sorted(expanded, key=lambda t: -len(t[2]))

    t1 = time.time()
    for n, (key, e, pts_m, _bbox) in enumerate(todo_m, 1):
        el = time.time() - t1
        eta = (el / max(n - 1, 1)) * (len(todo_m) - n + 1) if n > 1 else 0
        print('  [%3d/%d] %-34s %2d ramps   %4.0fs elapsed%s'
              % (n, len(todo_m), e['name'][:34], len(e['pts']), el,
                 ('   ~%.0f min left' % (eta / 60)) if n > 3 else ''), flush=True)

        # Every proximity question is a query against the ONE index built above.
        #
        # This used to be two nested Python loops calling shapely's exact `.distance()` on
        # every pair -- O(len(chosen) x len(polys)) exact polygon-to-polygon distances, on
        # geometries with thousands of vertices each. It looked fine on the Ocmulgee because
        # the Ocmulgee matched 37 polygons, and 37 x 37 is nothing. Two thousand candidates is
        # three thousand times that, and there are ~460 waterbodies. It was not slow; it was
        # never going to finish.
        #
        # STRtree.query(..., predicate='dwithin') asks the index "what is within D of this"
        # instead of testing every candidate, so the same walk costs O(n log n).

        # seed: polygons within ramp-tol of any ramp  (metres, because the CRS is metres)
        mine = e.get('_fkey')
        seeds, standing_on = set(), {}
        for x, y in pts_m:
            j = seed_of(Point(x, y))
            if j is None:
                continue
            if owner.get(j) == mine:
                seeds.add(j)
            elif owner.get(j):
                standing_on[owner[j]] = standing_on.get(owner[j], 0) + 1
        # Owning nothing is not a missing river -- it is another name for water that already
        # has one. Decided per PIECE, not per name, because the connected-component split can
        # leave one piece owning water and another standing entirely on someone else's: the
        # Pee Dee's NC ramps own their own river while its SC ramps sit on the Great Pee Dee.
        if not seeds and standing_on:
            deferred.append((e['name'], mine, min((-n, k) for k, n in standing_on.items())[1]))
            continue

        if not seeds:
            empty.append((e['name'], list(e['pts']), sorted(e['states']))); continue

        # grow through contiguous polygons, BOUNDED BY THIS WATERBODY'S OWN RAMP BOX
        #
        # The bound is not a speed knob. Loading every river polygon once and walking a global
        # index made the sweep finish in seconds instead of never -- but it also removed the
        # only thing stopping a river from growing through its own confluence. Rivers in a
        # basin ARE connected: at --join-tol 50 the Ocmulgee reaches the Oconee, the Oconee
        # reaches the Altamaha, and the Altamaha reaches the Atlantic. Whichever waterbody ran
        # first would have swallowed the basin and the other 219 would have found their
        # polygons already claimed -- or worse, each would have produced the same blob.
        #
        # So the ramp box comes back as an explicit constraint. A river extends as far as its
        # own ramps reach, plus --pad-km. That IS the definition being used here: this script
        # cuts the water Ryan has access to, and access is what the DNR ramp feed describes.
        bx0, by0, bx1, by1 = _bbox
        def in_box(j):
            b = poly_bounds[j]
            return b[2] >= bx0 and b[0] <= bx1 and b[3] >= by0 and b[1] <= by1

        # Somebody else's river. Not a box refusal and NOT an edge: phase 2 must not follow it
        # either, or the ownership rule buys nothing.
        def owned_by_another(j):
            o = owner.get(j)
            return o is not None and o != mine

        chosen, frontier = set(seeds), list(seeds)
        clipped = 0
        taken = 0          # polygons refused because another name's landings own them
        edge = []          # polygons the ramp box refused -- phase 2 starts from their sources
        while frontier:
            nxt = []
            for i in frontier:
                for j in near(geoms[i], a.join_tol):
                    if j in chosen:
                        continue
                    if owned_by_another(j):
                        taken += 1
                        continue
                    if not in_box(j):
                        clipped += 1
                        edge.append(i)
                        continue
                    chosen.add(j); nxt.append(j)
            frontier = nxt

        # ── phase 2: follow the chart past the ramps ────────────────────────
        #
        # Phase 1 above establishes IDENTITY -- this is the water Ryan's landings reach, which
        # is what makes it his river rather than any river. Phase 2 establishes EXTENT: keep
        # going through contiguous polygons for as long as Garmin charts them.
        #
        # The two are separate on purpose. Dropping the box entirely and growing on "has
        # Garmin data" alone would merge the Ocmulgee into the Altamaha again wherever Garmin
        # charts a basin end to end -- the identity bound is what stops that, and --max-reach-km
        # is the belt to its braces.
        extended = 0
        if has_garmin is not None and edge:
            reach = a.max_reach_km * 1000.0
            core_bounds = [poly_bounds[i] for i in chosen]
            cx0 = min(b[0] for b in core_bounds) - reach
            cx1 = max(b[2] for b in core_bounds) + reach
            cy0 = min(b[1] for b in core_bounds) - reach
            cy1 = max(b[3] for b in core_bounds) + reach

            frontier = list(dict.fromkeys(edge))
            while frontier:
                nxt = []
                for i in frontier:
                    for j in near(geoms[i], a.join_tol):
                        if j in chosen or not has_garmin[j]:
                            continue
                        if owned_by_another(j):
                            taken += 1
                            continue
                        b = poly_bounds[j]
                        if not (b[2] >= cx0 and b[0] <= cx1 and b[3] >= cy0 and b[1] <= cy1):
                            continue
                        chosen.add(j); nxt.append(j); extended += 1
                frontier = nxt

        km2 = sum(polys[i][1] for i in chosen)
        if km2 < a.min_km2:
            small.append((e['name'], km2)); continue

        chosen_geoms = [polys[i][2] for i in chosen]
        merged = unary_union(chosen_geoms)
        parts = list(getattr(merged, 'geoms', [merged]))
        coords = [[list(to_ll.transform(x, y)) for x, y in g.exterior.coords] for g in parts]
        # Bounds from the TRANSFORMED ring, not from the projected box's corners.
        #
        # merged.bounds is in Albers metres. Transforming its SW and NE corners looks like it
        # gives the lat/lon box and does not: Albers is conic, so a projected rectangle maps
        # to a curved quadrilateral and the extreme latitude sits part-way along an edge, not
        # at a corner. On an east-west river that put the "north" corner SOUTH of the "south"
        # one and the reported span came out negative -- which is how this was noticed.
        # `coords` is already every vertex in lon/lat, so the real box is just its min and max.
        flat_ll = [pt for ring in coords for pt in ring]
        w  = min(pt[0] for pt in flat_ll); ee = max(pt[0] for pt in flat_ll)
        s  = min(pt[1] for pt in flat_ll); n  = max(pt[1] for pt in flat_ll)
        made.append({
            'key': key, 'fkey': mine, 'slug': slugify(e['name']), 'name': e['name'],
            'states': sorted(e['states']), 'ramps': len(e['pts']),
            'polys': len(chosen), 'seeds': len(seeds), 'km2': round(km2, 2),
            'clipped': clipped,
            'extended': extended,
            'taken': taken,
            'polyset': frozenset(polys[i][0] for i in chosen),
            'geom_m': merged,
            'bounds': [round(w, 5), round(s, 5), round(ee, 5), round(n, 5)],
            'coords': coords,
        })

    print()
    print('%-34s %-7s %6s %6s %8s  %8s  %s'
          % ('name', 'states', 'ramps', 'polys', 'km2', 'span', 'clip/ext/owned'))
    for r in sorted(made, key=lambda r: -r['km2']):
        # Diagonal of the lat/lon box. The old column measured latitude extent only, so an
        # east-west river -- which is most of them here -- reported a span of nearly zero and
        # gave no signal at all about a result that had run away down a confluence.
        wl, sl, el, nl = r['bounds']
        dy = (nl - sl) * 111.32
        dx = (el - wl) * 111.32 * math.cos(math.radians((nl + sl) / 2.0))
        km = math.hypot(dx, dy)
        print('  %-32s %-7s %5d %6d %8.2f  %5.0f km  %4d/%-4d/%-4d' %
              (r['name'][:32], '/'.join(r['states']), r['ramps'], r['polys'], r['km2'], km,
               r['clipped'], r['extended'], r.get('taken', 0)))
    print()
    # ── a name with no freshwater left is a coastal pointer, not a hole ─────
    #
    # Cutting the zones out of the geometry means a river that lies wholly inside one has
    # nothing left to be cut from -- the Ashley, the Cooper and the Waccamaw all land here.
    # That is the right answer about the WATER and the wrong answer about the NAME: dropping
    # it silently is how this project keeps producing entries that appear in the picker and
    # open nothing. The zone that swallowed the river is exactly the chartpack that serves it,
    # so the name points there, with its own ramps' viewport so selecting it still pans to the
    # right place.
    landless = []
    if zones:
        PAD = 0.02
        for nm, pts, sts in empty:
            zs = [zone_of(la, lo, zones) or nearest_zone(la, lo, zones,
                                                         within_km=a.coastal_slack_km)
                  for la, lo in pts]
            zs = [z for z in zs if z]
            if not zs:
                continue
            z = max(set(zs), key=zs.count)
            lats = [p[0] for p in pts]; lons = [p[1] for p in pts]
            coastal.setdefault(slugify(nm), {
                'name': nm, 'zone': z, 'states': sts, 'ramps': len(pts),
                'center': [round(sum(lats) / len(lats), 5), round(sum(lons) / len(lons), 5)],
                'bounds': [round(min(lons) - PAD, 5), round(min(lats) - PAD, 5),
                           round(max(lons) + PAD, 5), round(max(lats) + PAD, 5)],
                'source': 'no freshwater left after the coastal zones were cut out; '
                          'contours come from the coastal zone',
            })
            landless.append(nm)

    print('  cut: %d    no river polygon near any ramp: %d    below --min-km2: %d'
          '    owns no water: %d' % (len(made), len(empty), len(small), len(deferred)))
    if landless:
        print()
        print('  %d of those lie entirely inside a coastal zone -- they become pointers to it:'
              % len(landless))
        print('    ' + ', '.join(sorted(landless)[:30]))
        if len(landless) > 30:
            print('    ... and %d more' % (len(landless) - 30))
    rest = [nm for nm, _p, _s in empty if nm not in landless]
    if rest:
        print()
        print('  %d names with no river/canal polygon within --ramp-tol of any landing, and no'
              % len(rest))
        print('  coastal zone either. These are genuinely unplaced:')
        print('    ' + ', '.join(sorted(rest)[:30]))
        if len(rest) > 30:
            print('    ... and %d more' % (len(rest) - 30))

    # ── names that came out as literally the same water ─────────────────────
    #
    # 3DHP models a whole sound or estuary as ONE polygon. Every tributary creek's ramp sits on
    # it, so --ramp-tol seeds the same polygon for each of them and eight different names come
    # back carrying the identical geometry. On the first full run this was 34% of the output:
    # Beaufort River, Coosawhatchie, Factory Creek, Capers Creek, Chechessee, Battery Creek,
    # Euhaw Creek and Boyd Creek were all one 234.98 km2 polygon -- Port Royal Sound.
    #
    # This is NOT reported as an error, because it is not obviously wrong: the estuary really
    # is one body of water and each of those names really does launch onto it. What it IS, for
    # certain, is eight identical chartpacks. Reported, not resolved -- the choice of which
    # name owns the water is Ryan's, not this script's.
    # Grouped by GEOMETRY, not by polygon-id set.
    #
    # The polygon-id version of this test missed 30 of the 34 failures the verifier found on
    # 2026-08-03, and missed them for a silly reason: the Great Pee Dee came out as {OH654} and
    # the Pee Dee as {OH654, one hairline fragment}. Different sets, so no alias fired, so both
    # got a file -- two chartpacks of the same 43 km2 of river. Same story for Stevens Creek
    # Reservoir, which is a stretch of the Savannah with a dam on it, not a separate water.
    #
    # The threshold is the verifier's: 98% of the smaller inside the larger. Using the same
    # number in both places is the point -- the cutter must not write what the checker will
    # reject, or the check is theatre.
    par2 = list(range(len(made)))
    def find2(i):
        while par2[i] != i:
            par2[i] = par2[par2[i]]; i = par2[i]
        return i
    gm = [r['geom_m'] for r in made]
    if gm:
        tre = STRtree(gm)
        for i, g in enumerate(gm):
            for j in tre.query(g):
                j = int(j)
                if j <= i:
                    continue
                try:
                    inter = g.intersection(gm[j])
                except Exception:
                    continue
                smaller = min(g.area, gm[j].area)
                if smaller <= 0 or inter.is_empty:
                    continue
                if inter.area / smaller >= 0.98:
                    ri, rj = find2(i), find2(j)
                    if ri != rj:
                        par2[ri] = rj
    by_geom = defaultdict(list)
    for i, r in enumerate(made):
        by_geom[find2(i)].append(r)
    shared = [v for v in by_geom.values() if len(v) > 1]

    # The BIGGEST water owns the name; ties go to the name with the most ramps.
    #
    # Area first, because the relation being grouped on is containment: if the Stevens Creek
    # pool is 98% inside the Savannah, the Savannah is the river and the pool is a stretch of
    # it -- picking by ramp count alone could hand the Savannah's name to a tributary that
    # happens to have more landings. Where the two geometries really are the same size the
    # ramp count decides, which is the original rule and keeps Port Royal Sound beating the
    # eight creeks that drain into it. Both keys are deterministic, so a re-run does not
    # reshuffle which name won.
    aliases = {}
    for v in shared:
        v.sort(key=lambda r: (-r['km2'], -r['ramps'], r['name']))
        winner = v[0]
        for loser in v[1:]:
            aliases[loser['slug']] = {'alias_of': winner['slug'],
                                      'alias_name': winner['name'],
                                      'name': loser['name'],
                                      'states': loser['states']}
            loser['aliased_to'] = winner['slug']

    # ── names that never got a cut because they own no water ────────────────
    #
    # These never reached the loop above -- they were set aside at seed time. They are not
    # losses: each one is a second name for water that a different name owns, and pointing it
    # at that name is what makes selecting "Bull Creek" in the picker open the Great Pee Dee's
    # chartpack instead of failing silently. An owner that was itself aliased resolves through,
    # so nothing points at a file that was never written.
    written = {}
    for r in made:
        if r.get('aliased_to'):
            continue
        fk = r.get('fkey')
        if fk and (fk not in written or r['km2'] > written[fk]['km2']):
            written[fk] = r
    orphaned = []
    for dname, dkey, downer in deferred:
        tgt = written.get(downer)
        if tgt:
            aliases[slugify(dname)] = {'alias_of': tgt['slug'], 'alias_name': tgt['name'],
                                       'name': dname, 'states': sorted(feeds[dkey]['states'])}
            continue
        # The owner was not cut here. If the registry already has it, point at that instead --
        # SC's "Catawba River" ramp is on Lake Wylie, which is built; saying so makes the name
        # work in the picker, and dropping it would not.
        rslug = registry.get(registry_key(feeds[downer]['name']))
        if rslug:
            aliases[slugify(dname)] = {'alias_of': rslug,
                                       'alias_name': feeds[downer]['name'],
                                       'name': dname, 'states': sorted(feeds[dkey]['states']),
                                       'in_registry': True}
            continue
        orphaned.append((dname, downer))
    if deferred:
        print()
        print('  %d names own no water of their own (%d became aliases, %d could not be placed)'
              % (len(deferred), len(deferred) - len(orphaned), len(orphaned)))
        for dname, dkey, downer in deferred[:25]:
            print('    %-30s -> %s' % (dname[:30], feeds[downer]['name']))
        if len(deferred) > 25:
            print('    ... and %d more' % (len(deferred) - 25))
    if orphaned:
        print()
        print('  %d of those point at a name that was NOT cut in this run -- they would be dead'
              % len(orphaned))
        print('  entries in the picker. Usually it means the owner is already in --index, or')
        print('  --flowing-only filtered it out.')
        for dname, downer in orphaned[:15]:
            print('    %-30s wanted %s' % (dname[:30], feeds[downer]['name']))

    if shared:
        n_rows = sum(len(v) for v in shared)
        print()
        print('  SAME WATER UNDER SEVERAL NAMES -- %d of %d cuts (%d groups)'
              % (n_rows, len(made), len(shared)))
        print('  3DHP stores a sound as one polygon; every creek draining into it seeds that')
        print('  same polygon. One boundary is written per group; the rest become aliases.')
        for v in sorted(shared, key=lambda v: -len(v)):
            print('    %8.2f km2  %-26s <- %s'
                  % (v[0]['km2'], v[0]['name'][:26],
                     ', '.join(r['name'] for r in v[1:])[:100]))
        print()
        print('  %d boundaries + %d aliases = %d names, %d files'
              % (len(made) - len(aliases), len(aliases), len(made), len(made) - len(aliases)))
        print()

    if not a.go:
        print('\nDRY RUN -- nothing written. Add --go.')
        return

    os.makedirs(a.out, exist_ok=True)
    # Lake mode writes to its OWN aux filenames. Both runs share --out, and a lake run
    # covering six names would otherwise overwrite the river run's 158 coastal pointers and
    # 12 aliases with a near-empty file -- silently, since both are just "the output".
    aux = '_lake' if a.lakes else '_river'
    if coastal:
        cp = os.path.join(a.out, '_coastal_pointers.json' if not a.lakes
                          else '_lake_coastal_pointers.json')
        json.dump(coastal, open(cp, 'w', encoding='utf-8'), indent=2, sort_keys=True)
        print('  -> %s  (%d names pointing at coastal zones)' % (cp, len(coastal)))
    if aliases:
        ap_fp = os.path.join(a.out, aux + '_aliases.json')
        json.dump(aliases, open(ap_fp, 'w', encoding='utf-8'), indent=2, sort_keys=True)
        print('  -> %s  (%d aliases)' % (ap_fp, len(aliases)))
    for r in made:
        if r.get('aliased_to'):
            continue
        gj = {'type': 'FeatureCollection', 'features': [{
            'type': 'Feature',
            'properties': {'slug': r['slug'], 'name': r['name'],
                           'kind': 'lake' if a.lakes else 'river',
                           'states': r['states'], 'dnr_ramps': r['ramps'],
                           'polygons_3dhp': r['polys'],
                           'source': ('3DHP featuretype=1/2/3, seeded from DNR ramps'
                                      if a.lakes else
                                      '3DHP featuretype=1, seeded from DNR ramps')},
            'geometry': {'type': 'MultiPolygon', 'coordinates': [[c] for c in r['coords']]},
        }]}
        fp = os.path.join(a.out, r['slug'] + aux + '.geojson')
        json.dump(gj, open(fp, 'w', encoding='utf-8'))
        print('  -> %s  (%.2f km2)' % (fp, r['km2']))

    print('\nnext: install them, then build')
    print('  py .\\install_registry_boundary.py --registry ... --boundaries ... --labels ... \\')
    for r in made[:3]:
        print('     --lake %s=%s' % (r['slug'], r['states'][0]))


if __name__ == '__main__':
    main()
