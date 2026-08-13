#!/usr/bin/env python3
"""build_water_bindings.py - bind every water in the registry to its gauges and operator.

Personal use only, not for distribution or resale; not for navigation.

    py .\\build_water_bindings.py --registry "F:\\TrollMapPipeline\\registry"
    py .\\build_water_bindings.py --registry "..." --stage fetch    # network only, then stop
    py .\\build_water_bindings.py --registry "..." --stage bind     # offline, uses the cache

WHAT THIS IS FOR

`registry\\lake_index.json` holds 1,722 waters. The gauge and utility fields across all of
them, counted 2026-08-06:

    usgs 5    duke 4    dominion 2    normalPool 3    minPool 3

That is the whole of it, and the rivers -- the water where a release changes the day -- have
none. A curated row per lake does not reach 1,722 and never will, so both halves are derived:
gauges by spatial join, operators by name-match at request time.

Output is ONE file, `registry\\water_bindings.json`, which the Worker reads once into module
scope. Nothing here runs at request time.

THE BINDING RULE, AND WHY IT IS NOT NEGOTIABLE

    A gauge binds to a water only on NAME RELATION *AND* GEOMETRY. Never either alone.

This is measured, not cautious. Binding TVA's 43 dams by name alone produced five matches and
all five were wrong -- Bear Creek Dam (AL) -> Bear Creek Lake (Jackson Co, NC), Wilson Dam (AL)
-> Lake Wilson (Wilson Co, NC), and three more of exactly the same shape: a same-named water in
a different state. Each would have rendered a confident pool elevation for a lake hundreds of
miles from the dam producing it. Geometry alone is no better -- it put Old Hickory Dam on the
Harpeth River, a tributary, and Pickwick Dam on the adjacent reservoir.

So `name-only` matches are recorded and REFUSED. They are in the report to be looked at, not
to be shipped. See TVA_SOLVED_VIA_NWPS_2026-08-06.md.

TRAPS ENCODED HERE, EACH ONE PAID FOR

  * `srid=EPSG_4326` is REQUIRED on the NWPS bbox call. Without it the request succeeds and
    returns `{"gauges": []}` -- a well-formed empty answer that reads exactly like "no gauges
    in this box". It cost a wrong conclusion once already.

  * NEVER size a response by what a fetch tool displays. A previous session read a truncated
    321-point series, took the cut-off for the end of the data, and reported a gauge as 11 days
    stale when it was current. Every response here is written to disk and counted from disk,
    and the count is in the report.

  * A handbook-5 identifier is three letters plus a two-character state code: NRST1, BARK2,
    ABBN7, CKDT1. TVA's own `RestApi/locations` contains a record whose LocationID is the
    string "WL", which is not one. Calling /gauges/WL 404s, and a 404 here reads as "gauge
    missing" rather than "bad input" unless the shape is checked first. It is checked first.

  * Pool and tailwater are DIFFERENT GAUGES and both matter -- the lake and the release.
    NRST1 is Clinch River above Norris Dam (pool); NRTT1 is below it (tailwater). The IDs are
    NOT derivable from each other: that S->T looks like a pattern and it is not, CRTT1 and
    DUTT1 both 404. They are discovered from the "above"/"below" wording in the gauge name and
    never synthesised.

  * CO-OPS mdapi filters are silently ignored. `stations.json?type=X&state=SC` returns HTTP
    200 and the complete NATIONAL list -- 4,430 entries beginning with Eastport, Maine.
    Anyone trusting the parameter concludes South Carolina has 4,430 current stations. The
    national list is fetched once and filtered here.

  * USGS returns 404, not an empty body, when zero sites match. That is "no data", not an
    outage. A small pond must not report a pipeline failure.

  * CWMS office SAC (Charleston) reports zero locations. Do not build against it. The real
    offices are SAS, SAW, LRN and SAM.

ONE THING THIS SCRIPT DOES NOT KNOW, AND SAYS SO

`waterservices.usgs.gov` is decommissioned Q1 2027; the successor is the OGC API at
`api.waterdata.usgs.gov/ogcapi/v0/`. Whether the successor's monitoring-locations collection
carries period-of-record per parameter -- which is what lets a gauge dead since 2019 be
rejected at BUILD time instead of discovered as a blank panel on the water -- could not be
verified from the authoring environment (robots.txt). So the catalogue fetch tries the
successor first, falls back to NWIS `seriesCatalogOutput=true`, and RECORDS WHICH ONE IT USED
in the report under `usgs_catalogue_source`. Read that field before trusting the period-of-
record filtering.
"""
import argparse, json, math, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from collections import Counter, defaultdict

UA = 'TrollMap/1.0 (personal fishing app; contact via github.com/colonal1981)'

# Four states plus margin. Tiled because a server-side cap on a single huge box would look
# exactly like "that is all the gauges there are".
#
# THIS IS A FLOOR, NOT THE ANSWER. It was hand-authored to "four states plus margin" while the
# registry it serves is derived, and the two drifted: nine waters and 425,000 acres now poke out
# of it, including Kentucky Lake (144,086 ac, reaching 37.02 N against a 36.9 N ceiling), Lake
# Barkley and the Mississippi. Kentucky Dam's gauge sits at 37.024 -- outside the box, therefore
# never enumerated, therefore Kentucky Lake reads as a water with no gauge rather than a water
# whose gauge was never asked for. `bbox_covering` widens this to cover whatever the registry
# actually holds; it never narrows it, so the offshore margin here is kept.
BBOX_FLOOR = (-90.6, 30.2, -75.2, 36.9)
BBOX = BBOX_FLOOR
TILE_DEG = 1.5

NWPS = 'https://api.water.noaa.gov/nwps/v1'
TVA_LOCATIONS = 'https://www.tva.com/RestApi/locations?format=json'
CWMS = 'https://cwms-data.usace.army.mil/cwms-data'
CWMS_OFFICES = ('SAS', 'SAW', 'LRN', 'SAM')      # NOT SAC -- it reports nothing
COOPS_MD = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi'
USGS_OGC = 'https://api.waterdata.usgs.gov/ogcapi/v0'
USGS_NWIS = 'https://waterservices.usgs.gov/nwis'
STATES = ('SC', 'NC', 'GA', 'TN')

LID_RE = re.compile(r'^[A-Z]{3}[A-Z]\d$')        # handbook-5: NRST1, BARK2, ABBN7
# A USGS site number is 8-15 digits. "Hartwell-Line4b" is not one, and a CWMS `name` can be
# either, so the shape is the only thing that can tell them apart.
USGS_SITE_RE = re.compile(r'^\d{8,15}$')

# "above"/"below" is how pool and tailwater are told apart. Ordered longest-first so
# "tailwater" wins over a bare "below" in the same string.
TAILWATER_RE = re.compile(r'\b(tailrace|tailwater|below)\b', re.I)
POOL_RE = re.compile(r'\b(above|headwater|at\s+dam|pool)\b', re.I)
DAM_RE = re.compile(r'\bdam\b', re.I)


# ── plumbing ────────────────────────────────────────────────────────────────────────────────

def _cache_path(cache, tag):
    os.makedirs(cache, exist_ok=True)
    return os.path.join(cache, re.sub(r'[^A-Za-z0-9._-]+', '_', tag)[:150] + '.json')


PAUSE = 0.6      # seconds between successful requests; --pause overrides


def fetch(url, cache, tag, force=False, tries=6, pause=None, allow_404=True):
    """GET with an on-disk cache. Returns (payload, note). Never raises for a missing thing.

    The cache is the point, not an optimisation: it puts every response on disk where it can be
    counted, re-read and diffed, instead of living only in memory where a truncated read looks
    identical to a short one.

    RATE LIMITS, retuned 2026-08-07 after NWPS started answering 429. Was tries=3, pause=0.25 --
    four requests a second sustained, then giving up after 1s, 2s and 4s of backoff. That is
    faster than NWPS will tolerate across a bbox enumeration and nowhere near patient enough
    once it complains. Now: six attempts, backoff 5s/10s/20s/40s/80s capped at 120, and
    `Retry-After` honoured when the server sends it, because a server that tells you how long
    to wait has given you the answer and guessing over the top of it is just rudeness.

    Losing nothing to a stop is what makes waiting cheap here -- every response is already on
    disk, so a re-run resumes instead of restarting.
    """
    pause = PAUSE if pause is None else pause
    p = _cache_path(cache, tag)
    if os.path.exists(p) and not force:
        try:
            with open(p, 'r', encoding='utf-8') as fh:
                return json.load(fh), 'cached'
        except Exception:
            pass                                   # corrupt cache entry -> refetch
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read().decode('utf-8', 'replace')
            data = json.loads(raw) if raw.strip()[:1] in '[{' else {'_text': raw}
            with open(p, 'w', encoding='utf-8') as fh:
                json.dump(data, fh)
            time.sleep(pause)
            return data, 'fetched'
        except urllib.error.HTTPError as e:
            # 404 from USGS means "no sites matched", not an outage. Same for a gauge that
            # simply does not exist. Cache the negative so a re-run does not re-ask.
            if e.code == 404 and allow_404:
                with open(p, 'w', encoding='utf-8') as fh:
                    json.dump({'_http': 404}, fh)
                return {'_http': 404}, 'http404'
            last = 'HTTP %d' % e.code
            if e.code in (429, 500, 502, 503, 504):
                # Honour Retry-After when the server sends one; it knows and we do not.
                _ra = None
                try:
                    _ra = float((e.headers or {}).get('Retry-After') or 0) or None
                except (TypeError, ValueError):
                    _ra = None
                time.sleep(min(_ra or (5 * (2 ** attempt)), 120))
                continue
            break
        except Exception as e:
            last = type(e).__name__
            time.sleep(2 ** attempt)
    return None, last or 'failed'


def bbox_covering(index, floor, pad_deg=0.05):
    """The floor box widened to contain every water in the index, plus a margin.

    Only ever grows. A registry that gains a water outside the box moves the box; one that
    loses waters does not shrink it, because the floor's offshore reach is deliberate and no
    lake's bounds imply it.

    THE PAD IS SMALL ON PURPOSE. It only has to cover `--margin-km` -- 3 km, about 0.027 deg --
    because a gauge further outside a water than that cannot bind to it however well the name
    matches. A generous pad reads as harmless and is not: every tile tag is built from the box
    origin, so nudging an edge by a hundredth of a degree renames all 55 cached tiles and
    re-downloads the entire enumeration to gain nothing. 0.05 leaves the east and west edges on
    the floor, where the registry does not reach past them, and moves only the rows that
    Kentucky Lake and the Chattahoochee actually need.
    """
    w, s, e, n = floor
    for rec in (index.values() if isinstance(index, dict) else index):
        b = (rec or {}).get('bounds_wsen')
        if not (isinstance(b, list) and len(b) == 4):
            continue
        w = min(w, b[0] - pad_deg); s = min(s, b[1] - pad_deg)
        e = max(e, b[2] + pad_deg); n = max(n, b[3] + pad_deg)
    if (w, s, e, n) == tuple(floor):
        return tuple(floor)

    # GROW IN WHOLE TILES, ANCHORED ON THE FLOOR'S SOUTH-WEST CORNER. A cache tag is built from
    # a tile's coordinates, so a box edge that moves by any amount other than a whole step
    # renames every tile behind it. Widening south by half a degree the naive way renamed all
    # 55 tiles and re-downloaded the entire enumeration to add one row. Snapped: the interior
    # grid lines never move, so only the new rows and the one row whose far edge was clamped
    # against the old ceiling are fetched again.
    fw, fs = floor[0], floor[1]
    w = fw - math.ceil(max(0.0, fw - w) / TILE_DEG) * TILE_DEG
    s = fs - math.ceil(max(0.0, fs - s) / TILE_DEG) * TILE_DEG
    if e > floor[2]:
        e = fw + math.ceil((e - fw) / TILE_DEG) * TILE_DEG
    if n > floor[3]:
        n = fs + math.ceil((n - fs) / TILE_DEG) * TILE_DEG
    return (round(w, 3), round(s, 3), round(e, 3), round(n, 3))


def tiles(bbox, step):
    x0, y0, x1, y1 = bbox
    out = []
    y = y0
    while y < y1:
        x = x0
        while x < x1:
            out.append((round(x, 4), round(y, 4), round(min(x + step, x1), 4), round(min(y + step, y1), 4)))
            x += step
        y += step
    return out


# ── name relation ───────────────────────────────────────────────────────────────────────────

# Words that describe a KIND of water rather than WHICH water. A match on these carries no
# identity. The list is deliberately short because the real generic-token defence below is
# derived from the registry itself rather than hand-authored.
_NOISE = {
    'lake', 'lakes', 'reservoir', 'reservoirs', 'river', 'creek', 'pond', 'ponds', 'branch',
    'fork', 'run', 'bay', 'sound', 'inlet', 'harbor', 'harbour', 'impoundment', 'dam', 'pool',
    'tailwater', 'tailrace', 'the', 'of', 'at', 'near', 'above', 'below', 'and', 'north',
    'south', 'east', 'west', 'upper', 'lower', 'middle', 'old', 'new', 'big', 'little',
}


def tokens(s):
    s = re.sub(r'\(.*?\)', ' ', s or '')
    s = re.sub(r'[^a-z0-9 ]+', ' ', s.lower())
    return [t for t in s.split() if len(t) >= 3 and t not in _NOISE and not t.isdigit()]


def build_weak_tokens(index, threshold=6):
    """Tokens shared by many waters cannot identify one of them.

    Derived rather than listed. On a registry with hundreds of "Mill Creek"s and "Long Pond"s,
    `mill` and `long` are worth nothing as evidence, and which words those are is a property of
    THIS registry, not of English. A hand-authored stoplist would be wrong the moment the
    registry grows.
    """
    df = Counter()
    for rec in index.values():
        names = {rec.get('name'), rec.get('display_name')}
        names.update(rec.get('legacy_display_names') or [])
        seen = set()
        for n in names:
            seen.update(tokens(n))
        df.update(seen)
    return {t for t, c in df.items() if c >= threshold}


def name_relation(water_names, gauge_name, weak):
    """The token that relates a gauge name to a water name, or None.

    Strong iff the gauge name shares at least one NON-weak token with the water's name. Every
    shared token is collected before judging: returning on the first hit would let a weak match
    ("bear", shared by dozens of Bear Creeks) short-circuit a strong one later in the same name
    and silently downgrade a good binding to nothing.

    A match on weak tokens ALONE is not evidence and returns None -- which, combined with the
    geometry requirement, is the pair of signals that would have refused all five of the
    wrong TVA bindings.
    """
    g = set(tokens(gauge_name))
    if not g:
        return None
    shared = set()
    for n in water_names:
        shared |= (set(tokens(n)) & g)
    if not shared:
        return None
    strong = sorted(shared - weak)
    return strong[0] if strong else None


# ── geometry ────────────────────────────────────────────────────────────────────────────────

def _rings(geom):
    t = (geom or {}).get('type')
    c = (geom or {}).get('coordinates') or []
    if t == 'Polygon':
        return [c]
    if t == 'MultiPolygon':
        return c
    return []


VERTEX_SAMPLE_CAP = 3000


def load_boundary(path):
    """Returns (polygons, sampled_vertices) or None.

    The vertex sample exists because "near the water" has to mean near the WATER, not near its
    bounding box. Norris Lake's box is 69 km by 22 km; a gauge standing on dry ground in the
    middle of it is zero km outside the box and would pass a box test with nothing to do with
    the lake. Shoreline vertices sit metres apart, so a decimated sample is accurate to well
    under the margin we care about and turns a 20,000-vertex ring into something cheap enough
    to test every candidate against.
    """
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            g = json.load(fh)
    except Exception:
        return None
    polys = []
    feats = g.get('features') if g.get('type') == 'FeatureCollection' else [g]
    for f in (feats or []):
        polys += _rings(f.get('geometry') if 'geometry' in f else f)
    if not polys:
        return None
    pts = [pt for poly in polys for ring in poly for pt in ring]
    step = max(1, len(pts) // VERTEX_SAMPLE_CAP)
    return polys, pts[::step]


def km_to_shore(lon, lat, verts):
    """Great-circle-ish km to the nearest sampled shoreline vertex."""
    best = float('inf')
    cos = math.cos(math.radians(lat))
    for vx, vy in ((p[0], p[1]) for p in verts):
        d = math.hypot((vx - lon) * 111.32 * cos, (vy - lat) * 110.57)
        if d < best:
            best = d
            if best < 0.05:
                break
    return best


def point_in_polys(lon, lat, polys):
    """Ray casting, outer ring minus holes."""
    for poly in polys:
        if not poly:
            continue
        if not _in_ring(lon, lat, poly[0]):
            continue
        if any(_in_ring(lon, lat, h) for h in poly[1:]):
            continue                                # in a hole -> not in the water
        return True
    return False


def _in_ring(x, y, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y):
            if x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
                inside = not inside
        j = i
    return inside


def km_outside_box(lon, lat, wsen):
    """0 if inside the bounds box, else great-circle-ish km to its nearest edge."""
    w, s, e, n = wsen
    dx = max(w - lon, 0.0, lon - e)
    dy = max(s - lat, 0.0, lat - n)
    if dx == 0 and dy == 0:
        return 0.0
    return math.hypot(dx * 111.32 * math.cos(math.radians(lat)), dy * 110.57)


# ── fetch stage ─────────────────────────────────────────────────────────────────────────────

class RateLimited(Exception):
    """The upstream is refusing us and no amount of continuing will help."""


def fetch_all(cache, force, report):
    src = {}
    # A 429 that survives every retry used to fall through as `0 gauges` and the loop carried
    # on, so a rate-limited run finished with a full-looking report and a hole in it -- the
    # 2026-08-07 run got 36 tiles and then wrote zero for all 45 that followed. An empty answer
    # and a refused answer are not the same thing and must not print the same way. Three in a
    # row means stop: everything already fetched is on disk, so a re-run costs nothing but the
    # tiles that genuinely have not been asked for yet.
    _consecutive_429 = 0

    # NWPS is the backbone: NWS ingests TVA, Corps and USGS alike, so one enumeration covers
    # every operator at once. Tiled so a silent cap cannot masquerade as an empty region.
    gauges, per_tile = {}, []
    for (x0, y0, x1, y1) in tiles(BBOX, TILE_DEG):
        url = ('%s/gauges?bbox.xmin=%s&bbox.ymin=%s&bbox.xmax=%s&bbox.ymax=%s&srid=EPSG_4326'
               % (NWPS, x0, y0, x1, y1))          # srid is REQUIRED -- see module docstring
        d, note = fetch(url, cache, 'nwps_%s_%s_%s_%s' % (x0, y0, x1, y1), force)
        if note == 'HTTP 429':
            _consecutive_429 += 1
            print('  nwps %7.2f %6.2f  REFUSED (429) -- not recorded' % (x0, y0))
            if _consecutive_429 >= 3:
                report['nwps_tiles'] = per_tile
                raise RateLimited(
                    'NWPS refused %d tiles in a row. %d of %d tiles are cached; nothing is '
                    'lost. Wait for the limit to clear and re-run --stage fetch: cached tiles '
                    'are skipped, so it picks up where this stopped.'
                    % (_consecutive_429, len(per_tile), len(tiles(BBOX, TILE_DEG))))
            continue
        _consecutive_429 = 0
        got = (d or {}).get('gauges') or []
        per_tile.append({'bbox': [x0, y0, x1, y1], 'n': len(got), 'note': note})
        for g in got:
            if g.get('lid'):
                gauges[g['lid']] = g
        print('  nwps %7.2f %6.2f  %5d gauges  (%s)' % (x0, y0, len(got), note))
    src['nwps'] = gauges
    report['nwps_tiles'] = per_tile
    report['nwps_gauges_deduped'] = len(gauges)
    # If any tile is suspiciously round, a cap is likelier than a coincidence. Say so.
    caps = sorted({t['n'] for t in per_tile if t['n'] in (100, 250, 500, 1000, 2000)})
    if caps:
        report['nwps_possible_page_cap'] = caps
        print('  !! tile counts landed exactly on %s -- check for a server-side cap' % caps)

    d, note = fetch(TVA_LOCATIONS, cache, 'tva_locations', force)
    tva = d if isinstance(d, list) else (d or {}).get('Locations') or []
    src['tva'] = [t for t in tva if isinstance(t, dict)]
    bad = [t.get('LocationID') for t in src['tva'] if not LID_RE.match(str(t.get('LocationID') or ''))]
    report['tva'] = {'n': len(src['tva']), 'note': note, 'malformed_location_ids': bad}
    print('  tva  %d dams (%s)%s' % (len(src['tva']), note,
                                     '  malformed lid: %s' % bad if bad else ''))

    cw = {}
    for off in CWMS_OFFICES:
        url = '%s/locations?office=%s&location-kind=PROJECT&page-size=2000' % (CWMS, off)
        d, note = fetch(url, cache, 'cwms_%s' % off, force)
        # CWMS answers /locations as a bare JSON ARRAY -- 167 rows for SAS -- not the
        # {"locations": {"locations": [...]}} envelope its other CDA endpoints use. The
        # unwrapping chain assumed the envelope and went straight through `.get` on a list:
        # AttributeError, 2026-08-07, after every NWPS tile had already been fetched. Accept
        # both shapes, and treat anything else as empty rather than guessing.
        if isinstance(d, list):
            rows = d
        else:
            rows = (d or {}).get('locations') or []
            if isinstance(rows, dict):
                rows = rows.get('locations') or []
        cw[off] = rows if isinstance(rows, list) else []
        print('  cwms %s  %d locations (%s)' % (off, len(cw[off]), note))
    src['cwms'] = cw
    report['cwms'] = {k: len(v) for k, v in cw.items()}

    # The national list, on purpose: mdapi's state/name filters are silently ignored.
    coops = {}
    for typ in ('tidepredictions', 'currentpredictions', 'waterlevels', 'physocean', 'met'):
        d, note = fetch('%s/stations.json?type=%s' % (COOPS_MD, typ), cache, 'coops_%s' % typ, force)
        rows = (d or {}).get('stations') or []
        keep = [s for s in rows
                if isinstance(s.get('lat'), (int, float))
                and BBOX[0] <= s.get('lng', s.get('lon', 999)) <= BBOX[2]
                and BBOX[1] <= s['lat'] <= BBOX[3]]
        coops[typ] = keep
        print('  coops %-18s national %5d -> in-box %4d (%s)' % (typ, len(rows), len(keep), note))
    src['coops'] = coops
    report['coops'] = {k: len(v) for k, v in coops.items()}

    # USGS catalogue: successor first, NWIS fallback, and SAY WHICH.
    usgs, used = {}, None
    for st in STATES:
        d, note = fetch('%s/collections/monitoring-locations/items?state_code=%s&limit=10000&f=json'
                        % (USGS_OGC, st), cache, 'usgs_ogc_%s' % st, force)
        feats = (d or {}).get('features') or []
        if feats:
            usgs[st] = feats
            used = used or 'ogcapi/v0 monitoring-locations'
            print('  usgs %s  %d sites (ogc, %s)' % (st, len(feats), note))
            continue
        # `62614`/`62615` are also reservoir elevation and are deliberately NOT requested here.
        # Every lake site this catalogue returns already carries 00062 or 00065, so adding them
        # would re-download 30 MB of catalogue for a set of sites nobody has shown to exist. The
        # bind stage accepts them if they ever turn up (ELEV_PARMS), which costs nothing.
        d, note = fetch('%s/site/?format=rdb&stateCd=%s&parameterCd=00060,00065,00010,00062,63680'
                        '&hasDataTypeCd=iv&siteStatus=active&seriesCatalogOutput=true'
                        % (USGS_NWIS, st), cache, 'usgs_nwis_%s' % st, force)
        rows = parse_rdb((d or {}).get('_text') or '')
        usgs[st] = rows
        used = used or 'waterservices NWIS seriesCatalogOutput (successor returned nothing)'
        print('  usgs %s  %d series rows (nwis, %s)' % (st, len(rows), note))
    src['usgs'] = usgs
    report['usgs_catalogue_source'] = used
    report['usgs'] = {k: len(v) for k, v in usgs.items()}
    return src


def parse_rdb(text):
    """USGS RDB: '#' comments, a header line, a type line, then tab-separated rows."""
    hdr, out = None, []
    for line in (text or '').splitlines():
        if not line or line.startswith('#'):
            continue
        f = line.split('\t')
        if hdr is None:
            hdr = f
            continue
        if f and f[0].startswith('5s'):
            continue                                # the type/width line
        if len(f) == len(hdr):
            out.append(dict(zip(hdr, f)))
    return out


# ── bind stage ──────────────────────────────────────────────────────────────────────────────

def bind(index, boundaries_dir, src, cache, force, margin_km, report, overrides=None,
         lake_rivers=None):
    overrides = overrides or {}
    weak = build_weak_tokens(index)

    # ONE WATERSHED IS NOT AN AMBIGUITY. Counting frequency alone demoted `edisto` and
    # `saluda` -- both real, both ours -- because "Edisto River", "North Edisto River",
    # "South Edisto River" and the rest push the token past the threshold. Those are the SAME
    # water system stacked on itself, which is the opposite of the "Mill Creek in nine
    # counties" case the rule exists for, and demoting them left those waters with no strong
    # token at all and therefore no way to bind by name. So a token stays weak only if the
    # waters carrying it are actually SCATTERED: under ~1.5 degrees of centroid spread in both
    # axes it is one watershed, and the token identifies it perfectly well.
    spread = defaultdict(list)
    for rec in index.values():
        c = rec.get('centroid')
        if not (isinstance(c, (list, tuple)) and len(c) == 2):
            continue
        seen = set()
        for nm in (rec.get('name'), rec.get('display_name'),
                   *(rec.get('legacy_display_names') or [])):
            seen.update(tokens(nm))
        for t in seen:
            spread[t].append(c)
    rescued = set()
    for t in list(weak):
        pts = spread.get(t) or []
        if len(pts) < 2:
            continue
        dx = max(p[0] for p in pts) - min(p[0] for p in pts)
        dy = max(p[1] for p in pts) - min(p[1] for p in pts)
        if dx <= 1.5 and dy <= 1.5:
            weak.discard(t)
            rescued.add(t)
    report['weak_tokens_rescued_as_one_watershed'] = sorted(rescued)

    report['weak_tokens'] = sorted(weak)[:80]
    report['weak_token_count'] = len(weak)

    # A water whose every name token is weak ("Long Pond", "Mill Creek") can never produce a
    # name signal, so it can never bind however close a gauge sits. That is the correct answer
    # -- the name genuinely does not identify it -- but it must be VISIBLE, not silently
    # absent, or it reads later as a coverage bug rather than an ambiguity.
    allweak = []
    for slug, rec in index.items():
        ns = [rec.get('name'), rec.get('display_name')] + list(rec.get('legacy_display_names') or [])
        tk = set()
        for n in ns:
            tk |= set(tokens(n))
        if tk and not (tk - weak):
            allweak.append(slug)
    report['unbindable_by_name'] = {'count': len(allweak), 'sample': sorted(allweak)[:40]}

    # Pre-bucket gauges by a coarse cell so each water tests a handful, not 3,000.
    cell = defaultdict(list)
    for lid, g in src['nwps'].items():
        lat, lon = g.get('latitude'), g.get('longitude')
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        cell[(int(lon), int(lat))].append((lid, g, lon, lat))

    # CO-OPS AND CWMS WERE FETCHED AND NEVER USED. 1,158 tide stations and 4,204 Corps
    # projects sat in the cache while all 17 bound coastal zones took an NWPS RIVER-STAGE gauge
    # in a field called `pool` -- Pamlico Sound, 3,000 km2 of tidal water, was reading "Neuse
    # River at Cherry Branch Ferry Terminal". The depth palette shifts coastal contours by the
    # tide, so coastal wants a tide station and nothing else will do.
    tide_cell = defaultdict(list)
    for kind, rows in (src.get('coops') or {}).items():
        for st in rows:
            try:
                slat = float(st.get('lat')); slon = float(st.get('lng'))
            except (TypeError, ValueError):
                continue
            tide_cell[(int(slon), int(slat))].append((kind, st, slon, slat))
    usace_cell = defaultdict(list)
    for off, rows in (src.get('cwms') or {}).items():
        for lo in rows:
            try:
                slat = float(lo.get('latitude')); slon = float(lo.get('longitude'))
            except (TypeError, ValueError):
                continue
            usace_cell[(int(slon), int(slat))].append((off, lo, slon, slat))

    tva_by_lid = {str(t.get('LocationID')): t for t in src.get('tva', [])
                  if LID_RE.match(str(t.get('LocationID') or ''))}

    # THE USGS CATALOGUE WAS FETCHED FOR TWO MONTHS AND READ BY NOBODY. `fetch_all` pulled
    # 152,176 series rows across the four states, `report['usgs']` printed the counts so the
    # run looked like it had them, and `bind()` never touched `src['usgs']` -- the comment on
    # the USACE block below says so out loud ("about ten made it in") and the wiring still did
    # not happen. Same shape as the alias file and the `--registry` default: a source that is
    # fetched, counted, and dropped, where the only symptom is an absence.
    #
    # What it costs: Monticello Reservoir, 6,660 acres of Ryan's own water, had no binding at
    # all while `MONTICELLO RES NR JENKINSVILLE, SC` (02160900, parm 00062, reporting daily)
    # sat in the cache. And 97 of the 244 bound waters carried no `pool` -- Thurmond, Moultrie,
    # Lanier, Walter F. George, West Point, Jordan, Greenwood -- every one of which has a USGS
    # reservoir-elevation gauge with its own name on it.
    #
    # WHY THE SERIES ROWS COLLAPSE SO FAR. The NWIS request asks for `seriesCatalogOutput`, so
    # one row is one PARAMETER at one site, not one site: 23,004 SC rows are 300-odd sites.
    # Dedup on site_no and union the parameter codes.
    # These are the codes the Worker's `fetchUsgs` already knows how to read, and they have to
    # be the same list on both sides: binding a site on a parameter the Worker cannot render
    # would put a gauge on the screen with no reading under it.
    ELEV_PARMS = {'00062',         # elevation of reservoir water surface above datum
                  '62614',         # lake/reservoir elevation, NGVD29
                  '62615'}         # lake/reservoir elevation, NAVD88
    LEVEL_PARMS = ELEV_PARMS | {'00065',   # gage height, local datum
                                '00060'}   # discharge -- flow, not level, but it is what a
                                           # river has, and a river's binding needs it
    usgs_sites = {}
    for st, rows in (src.get('usgs') or {}).items():
        for r in rows:
            if not isinstance(r, dict):
                continue
            try:
                slat = float(r.get('dec_lat_va')); slon = float(r.get('dec_long_va'))
            except (TypeError, ValueError):
                continue
            no = str(r.get('site_no') or '').strip()
            if not USGS_SITE_RE.match(no):
                continue
            g = usgs_sites.setdefault(no, {'site': no, 'name': (r.get('station_nm') or '').strip(),
                                           'lat': slat, 'lon': slon, 'state': st,
                                           'site_type': (r.get('site_tp_cd') or '').strip(),
                                           'parms': set(), 'end': ''})
            if r.get('parm_cd'):
                g['parms'].add(str(r['parm_cd']).strip())
            end = (r.get('end_date') or '').strip()
            if end > g['end']:
                g['end'] = end
    # A site with a thermistor and no stage sensor is real and is of no use to anyone deciding
    # whether to launch. Drop it here rather than filtering it in five places downstream.
    usgs_sites = {k: v for k, v in usgs_sites.items() if v['parms'] & LEVEL_PARMS}
    usgs_cell = defaultdict(list)
    for g in usgs_sites.values():
        usgs_cell[(int(g['lon']), int(g['lat']))].append(g)
    report['usgs_sites_with_level'] = len(usgs_sites)
    print('  usgs: %d distinct sites carry a level/flow parameter '
          '(%d lake-elevation)' % (len(usgs_sites),
                                   sum(1 for g in usgs_sites.values()
                                       if g['site_type'].startswith('LK'))))

    bindings, tally = {}, Counter()
    rejected_name_only, review_geom_only = [], []

    for slug, rec in index.items():
        wsen = rec.get('bounds_wsen')
        if not (isinstance(wsen, list) and len(wsen) == 4):
            tally['no_bounds'] += 1
            continue
        names = [rec.get('name'), rec.get('display_name')] + list(rec.get('legacy_display_names') or [])
        # The river the lake IS. An impoundment is almost never named after the water it
        # impounds -- Kentucky Lake is the Tennessee River, Belews Lake is Belews Creek,
        # Tuckertown is the Yadkin -- so every gauge on it reads "<River> at <town>" and shares
        # no token with the lake's own name. All six Kentucky Lake gauges failed here and landed
        # in review_geom_only. Names come from 3DHP flowlines inside the boundary, via
        # build_lake_rivers.py. Geometry is still required, so handing the same river name to
        # five TVA pools cannot bind a gauge to water it is not on.
        names += ((lake_rivers or {}).get(slug, {}).get('rivers') or [])
        names = [n for n in names if n]

        bnd = load_boundary(os.path.join(boundaries_dir, slug + '.geojson'))
        polys, verts = bnd if bnd else (None, None)

        w, s, e, n = wsen
        cand, tcand, ucand, gcand = [], [], [], []
        for ix in range(int(math.floor(w)) - 1, int(math.floor(e)) + 2):
            for iy in range(int(math.floor(s)) - 1, int(math.floor(n)) + 2):
                cand += cell.get((ix, iy), [])
                tcand += tide_cell.get((ix, iy), [])
                ucand += usace_cell.get((ix, iy), [])
                gcand += usgs_cell.get((ix, iy), [])

        def _how_far(lon_, lat_, _polys=polys, _verts=verts, _wsen=wsen):
            """(km outside, is_inside). Shoreline distance, never the box, when we have rings."""
            if _polys and point_in_polys(lon_, lat_, _polys):
                return 0.0, True
            if _verts:
                return km_to_shore(lon_, lat_, _verts), False
            return km_outside_box(lon_, lat_, _wsen), False

        pool = tail = None
        others = []
        geom_only = []
        for lid, g, lon, lat in cand:
            gname = g.get('name') or ''
            tok = name_relation(names, gname, weak)
            inside = bool(polys) and point_in_polys(lon, lat, polys)
            if inside:
                d_km = 0.0
            elif verts:
                # Distance to the SHORELINE. A box test would call a gauge on dry land in the
                # middle of a sprawling reservoir's bounding box "zero km outside".
                d_km = km_to_shore(lon, lat, verts)
            else:
                # No boundary polygon for this slug -- fall back to the box and say so, rather
                # than silently applying a weaker test under the same name.
                d_km = km_outside_box(lon, lat, wsen)
            geom = 'inside' if inside else ('near' if d_km <= margin_km else None)
            if geom == 'near' and not verts:
                geom = 'box'                        # weaker evidence, kept distinguishable

            if tok and geom:
                conf = {'inside': 'name+geom', 'near': 'name+near', 'box': 'name+box'}[geom]
            elif tok and not geom:
                rejected_name_only.append({'slug': slug, 'lid': lid, 'gauge': gname,
                                           'token': tok, 'km_outside': round(d_km, 1)})
                tally['rejected_name_only'] += 1
                continue
            elif geom and not tok:
                review_geom_only.append({'slug': slug, 'lid': lid, 'gauge': gname,
                                         'geom': geom, 'km_outside': round(d_km, 1)})
                tally['review_geom_only'] += 1
                # A gauge STRICTLY INSIDE the polygon is standing in the water. That is not an
                # ambiguous match waiting on a second signal, it is a fact about where the
                # instrument is. The two-signal rule exists to choose the ONE primary gauge, so
                # it still governs `pool` and `tailwater` -- it has no business refusing a
                # SECONDARY reading. Kept out of the pool/tailwater race by living in its own
                # list, and labelled so nothing downstream mistakes it for a named match.
                if geom == 'inside':
                    geom_only.append({'lid': lid, 'name': gname, 'lat': lat, 'lon': lon,
                                      'confidence': 'geom_only_inside', 'km_outside': 0.0,
                                      'wfo': (g.get('wfo') or {}).get('abbreviation'),
                                      'rfc': (g.get('rfc') or {}).get('abbreviation')})
                    tally['geom_only_accepted'] += 1
                continue
            else:
                continue

            entry = {'lid': lid, 'name': gname, 'lat': lat, 'lon': lon, 'confidence': conf,
                     'km_outside': round(d_km, 1),
                     'wfo': (g.get('wfo') or {}).get('abbreviation'),
                     'rfc': (g.get('rfc') or {}).get('abbreviation')}
            if lid in tva_by_lid:
                t = tva_by_lid[lid]
                entry['tva'] = {'dam': t.get('Name'), 'top_of_gates_ft': t.get('TopOfGatesFt'),
                                'river': t.get('River'), 'river_mile': t.get('RiverMile')}

            # Pool vs tailwater from the WORDING. Never synthesised from the other's id --
            # NRST1 -> NRTT1 looks like a rule and is not; CRTT1 and DUTT1 both 404.
            if TAILWATER_RE.search(gname) and DAM_RE.search(gname):
                tail = entry if tail is None else tail
            elif POOL_RE.search(gname) or inside:
                pool = entry if pool is None else pool
            else:
                others.append(entry)

        # ── USGS, second pass ───────────────────────────────────────────────────────────
        # Runs AFTER the NWPS pass on purpose. NWS ingests USGS, so 911 of the 1,092 active
        # sites are the same physical instrument already enumerated under a handbook-5 id --
        # binding both would put one gauge on a lake twice under two names. Going second means
        # the NWPS entry is already in hand and can be deduped against by position.
        #
        # 0.6 km is the colocation radius: wide enough for the two agencies' coordinates for the
        # same structure to disagree (they routinely differ by a couple hundred metres, dam
        # crest vs stilling well) and narrow enough that Lake Blalock's own gauge does not get
        # eaten by the Pacolet River gauge 1.0 km away.
        #
        # COLOCATED IS NOT DUPLICATE. The first cut of this dropped the USGS record whenever an
        # NWPS gauge sat on top of it, and that threw away the reading the whole change was for:
        # Lanier's USGS site is 0.01 km from `Chattahoochee River at Lake Sidney Lanier`,
        # Moultrie's is 0.00 km from `Lake Moultrie at Pinopolis Dam`. One physical
        # installation, two agency records -- and it is the USGS record that carries `00062`,
        # elevation of the reservoir surface. Dropping it left seven big lakes poolless while
        # the pool reading sat on disk. So: MERGE the USGS identity onto the entry already
        # placed there, and let it promote that entry to `pool` when the site type says lake and
        # a level parameter is present.
        placed = ([pool] if pool else []) + ([tail] if tail else []) + others + geom_only

        def _colocated(lon_, lat_, _p=placed):
            for e in _p:
                plon, plat = e.get('lon'), e.get('lat')
                if not isinstance(plon, (int, float)) or not isinstance(plat, (int, float)):
                    continue
                if math.hypot((lon_ - plon) * 111.0 * math.cos(math.radians(lat_)),
                              (lat_ - plat) * 111.0) <= 0.6:
                    return e
            return None

        # ORDER DECIDES WHO BECOMES `pool`, SO IT MUST NOT BE CELL-ITERATION ORDER. Table Rock
        # has two sites 350 m apart -- the reservoir (LK, stage) and its TAILRACE (ST) -- and
        # whichever arrived first took the slot. Sort by evidence instead: a lake site reporting
        # elevation above datum, then a lake site reporting stage, then everything else, and
        # site number last so a re-run cannot reshuffle a tie.
        def _grade(g):
            lake = g['site_type'].startswith(('LK', 'ES'))
            return (0 if (lake and (ELEV_PARMS & g['parms'])) else
                    1 if (lake and '00065' in g['parms']) else
                    2 if lake else 3, g['site'])

        for g in sorted(gcand, key=_grade):
            glon, glat, gname = g['lon'], g['lat'], g['name']
            g_level = sorted(g['parms'] & LEVEL_PARMS)
            g_is_lake = g['site_type'].startswith(('LK', 'ES'))
            # A LAKE SITE CARRYING A LEVEL PARAMETER IS A POOL GAUGE. `00062` is elevation above
            # datum and `00065` is stage on a local datum -- North Saluda, Table Rock and
            # Reelfoot report only the latter, and refusing them over the choice of datum would
            # leave three lakes poolless on a technicality. Which one it is travels with the
            # entry so the app can say "elevation" or "stage" rather than guess.
            g_pool_grade = g_is_lake and bool((ELEV_PARMS | {'00065'}) & g['parms'])

            # A TAILRACE IS NOT THE SAME READING AS THE POOL. The merge exists for one
            # installation carrying two agency records; a tailrace 350 m below the dam is a
            # second, different measurement and belongs in `tailwater`, not folded into pool.
            g_tail = bool(TAILWATER_RE.search(gname))
            hit = None if g_tail else _colocated(glon, glat)
            if hit is not None:
                if hit.get('usgs_site'):
                    # NEVER OVERWRITE AN IDENTITY. Two USGS sites can both land inside the
                    # colocation radius, and the second one silently replacing the first put
                    # Table Rock's tailrace site number on a record still named for the
                    # reservoir -- a row that reads as one gauge and cites another.
                    hit.setdefault('usgs_also', []).append(g['site'])
                    tally['usgs_second_site_at_same_spot'] += 1
                    continue
                hit['usgs_site'] = g['site']
                hit['usgs_name'] = gname
                hit['usgs_parms'] = g_level
                hit['usgs_site_type'] = g['site_type']
                tally['usgs_merged_into_nwps'] += 1
                # Promote only into an EMPTY pool slot, and never at the expense of a tailwater:
                # `Lake Moultrie at Pinopolis Dam` reads pool, `... Tailrace` does not.
                if pool is None and g_pool_grade and hit is not tail:
                    if hit in others:
                        others.remove(hit)
                    if hit in geom_only:
                        geom_only.remove(hit)
                    hit['pool_from'] = 'usgs:%s' % (sorted(ELEV_PARMS & g['parms'])[0] if (ELEV_PARMS & g['parms']) else '00065')
                    pool = hit
                    tally['usgs_pool_via_merge'] += 1
                continue
            tok = name_relation(names, gname, weak)
            d_km, inside = _how_far(glon, glat)
            geom = 'inside' if inside else ('near' if d_km <= margin_km else None)
            if geom == 'near' and not verts:
                geom = 'box'
            is_lake_site = g_is_lake

            if tok and geom:
                conf = {'inside': 'name+geom', 'near': 'name+near', 'box': 'name+box'}[geom]
            elif tok and not geom:
                rejected_name_only.append({'slug': slug, 'usgs_site': g['site'], 'gauge': gname,
                                           'token': tok, 'km_outside': round(d_km, 1)})
                tally['rejected_name_only'] += 1
                continue
            elif geom == 'inside' and is_lake_site:
                # A gauge standing IN the water binds on geometry alone -- the same rule the
                # NWPS pass uses. Restricted to lake/estuary site types because `site_tp_cd`
                # says what the instrument is on: an `ST` gauge inside a reservoir polygon is
                # a feeder creek at the head of a cove, not the lake. That is the tributary
                # noise the geom-only tier was already producing, and USGS hands us the field
                # that distinguishes it, so there is no reason to guess.
                review_geom_only.append({'slug': slug, 'usgs_site': g['site'], 'gauge': gname,
                                         'geom': 'inside', 'km_outside': 0.0})
                tally['review_geom_only'] += 1
                geom_only.append({'usgs_site': g['site'], 'name': gname, 'lat': glat,
                                  'lon': glon, 'confidence': 'geom_only_inside',
                                  'km_outside': 0.0, 'source': 'usgs',
                                  'site_type': g['site_type'], 'parms': g_level})
                tally['geom_only_accepted'] += 1
                continue
            else:
                if geom:
                    tally['usgs_geom_only_stream_skipped'] += 1
                continue

            entry = {'usgs_site': g['site'], 'name': gname, 'lat': glat, 'lon': glon,
                     'confidence': conf, 'km_outside': round(d_km, 1), 'source': 'usgs',
                     'site_type': g['site_type'], 'state': g['state'],
                     'parms': g_level, 'last_value': g['end']}

            # POOL ONLY FROM A GAUGE THAT MEASURES POOL. A stream gauge with a lake's name on it
            # is the inflow or the tailrace, and calling it `pool` would put a creek stage in
            # the field the app reads to say how far down the lake is. The site type is the
            # discriminator, and USGS hands it to us -- there is nothing to infer.
            if TAILWATER_RE.search(gname) and DAM_RE.search(gname):
                tail = entry if tail is None else tail
            elif g_pool_grade:
                if pool is None:
                    entry['pool_from'] = 'usgs:%s' % (sorted(ELEV_PARMS & g['parms'])[0] if (ELEV_PARMS & g['parms']) else '00065')
                    pool = entry
                    tally['usgs_pool'] += 1
                else:
                    others.append(entry)
            else:
                others.append(entry)
            placed.append(entry)
            tally['usgs_bound'] += 1

        # ── human overrides, last word ──────────────────────────────────────────────────
        # THE TWO-SIGNAL RULE IS RIGHT AND IT CANNOT SEE EVERYTHING. Lake Robinson is fed and
        # drained by Black Creek. `BLACK CREEK NEAR HARTSVILLE` sits 0.48 km below the dam at
        # the south end and `BLACK CREEK NEAR MCBEE` sits 3.0 km up the creek at the north end
        # -- the tailwater and the inflow, exactly the two readings that matter. Neither name
        # contains "Robinson", so the rule refuses both, and it is right to: "Black Creek" is a
        # name a dozen creeks share, and relaxing the rule to catch this would let all of them
        # through. What is missing is not a better rule, it is a fact only Ryan has.
        #
        # These facts live in `registry/gauge_overrides.json`, keyed by SLUG, and NOT in
        # `curated_lakes.json` -- which is where they briefly went on 2026-08-12 before that
        # file turned out to be a 2026-06-23 bulk upload with no authored commit whose own
        # `_README` claimed "hand-maintained by Ryan" about data Ryan did not write. A fact
        # whose value is that a person vouched for it must not live in a file that lies about
        # who vouched. Hence the `by`/`on` requirement in the override file.
        #
        #   "lake_robinson": [ {"site": "02130910", "role": "tailwater", "why": ..., "by": ...} ]
        #   role is pool | tailwater | gauge, and defaults to pool
        #
        # Overrides go LAST and WIN. A gauge a person checked outranks a derived one -- the same
        # order the ramp merge above uses, and the whole point of an override.
        for cu in (overrides.get(slug) or []):
            site = str((cu or {}).get('site') or '').strip()
            if not USGS_SITE_RE.match(site):
                continue
            g = usgs_sites.get(site)
            role = (cu.get('role') or 'pool').lower()
            ce = {'usgs_site': site, 'source': 'usgs', 'confidence': 'override',
                  'name': (g or {}).get('name') or cu.get('name') or ('USGS %s' % site),
                  'lat': (g or {}).get('lat'), 'lon': (g or {}).get('lon'),
                  'site_type': (g or {}).get('site_type'),
                  'parms': sorted((g or {}).get('parms', set()) & LEVEL_PARMS)
                           or [p.strip() for p in str(cu.get('params') or '').split(',') if p.strip()],
                  'km_outside': 0.0,
                  'why': cu.get('why'), 'by': cu.get('by'), 'on': cu.get('on')}
            if not (cu.get('by') and cu.get('on')):
                # Not fatal -- the gauge is still bound -- but an override whose author is
                # unrecorded is exactly the thing this file was created to stop.
                print('   !! override %s -> %s has no `by`/`on`. Say who decided it and when.'
                      % (slug, site))
                tally['override_without_author'] += 1
            if g is None:
                # Named by hand and absent from the catalogue: the site may be outside the four
                # states, or report a parameter the catalogue query does not ask for. Say so
                # rather than dropping it -- Ryan put it there on purpose.
                ce['note'] = 'not in the USGS catalogue fetched here; curated on trust'
                tally['override_site_not_in_catalogue'] += 1
            # Drop any derived entry for the same site so the curated one is not a duplicate.
            others = [o for o in others if o.get('usgs_site') != site]
            geom_only = [o for o in geom_only if o.get('usgs_site') != site]
            if role == 'tailwater':
                tail = ce
            elif role == 'pool':
                pool = ce
            else:
                others.append(ce)
            tally['override_' + (role if role in ('pool', 'tailwater') else 'gauge')] += 1

        if not (pool or tail or others or geom_only):
            tally['unbound'] += 1
            continue

        b = {'slug': slug, 'display_name': rec.get('display_name'), 'state': rec.get('state'),
             'feature_type': rec.get('feature_type'), 'centroid': rec.get('centroid')}
        if pool:
            b['pool'] = pool
        if tail:
            b['tailwater'] = tail
        if others:
            # A 90 km river reach may have three useful gauges and which one matters depends on
            # where you launch. All of them are recorded; the Worker picks the nearest to the
            # chosen ramp at request time. Storing them costs a few KB in a file built once,
            # and it keeps the upstream gauges -- which is the interesting question on a river,
            # because a release upstream reaches the ramp later.
            b['gauges'] = sorted(others, key=lambda x: x['km_outside'])
        if geom_only:
            # Named matches first, then the in-the-water-but-unnamed ones. Sorting the merged
            # list by distance alone would put every geometry-only entry, all at 0.0 km, ahead
            # of a named gauge 200 m off the bank -- which inverts the evidence.
            b['gauges'] = (b.get('gauges') or []) + sorted(geom_only, key=lambda x: x['name'])

        # `natl` was the only ramp source read, so 146 of 218 bound waters shipped an empty
        # ramp list while the index held osm and curated ramps for them. Curated first -- a
        # hand-checked ramp outranks a harvested one -- then natl, then osm, deduped on name.
        ramps, seen_r = [], set()
        for rsrc in ('curated', 'natl', 'osm'):
            for r in ((rec.get('ramps') or {}).get(rsrc) or []):
                nm = (r.get('name') or '').strip()
                if not isinstance(r.get('lat'), (int, float)) or nm.lower() in seen_r:
                    continue
                seen_r.add(nm.lower())
                ramps.append({'name': nm, 'lat': r.get('lat'), 'lon': r.get('lon'),
                              'source': rsrc})
        b['ramps'] = ramps[:12]

        # Tide stations. A measured water-level station outranks a harmonic-prediction-only
        # one, and the flag survives into the output because a prediction is a model and the
        # palette should be able to say so when that is all there is.
        tides, seen_t = [], set()
        for kind, st, slon, slat in sorted(tcand, key=lambda x: x[0] != 'waterlevels'):
            sid = str(st.get('id') or '')
            if not sid or sid in seen_t:
                continue
            d_t, ins_t = _how_far(slon, slat)
            if not (ins_t or d_t <= max(margin_km, 5.0)):
                continue
            seen_t.add(sid)
            tides.append({'id': sid, 'name': st.get('name'), 'lat': slat, 'lon': slon,
                          'kind': kind, 'measured': kind == 'waterlevels',
                          'shefcode': st.get('shefcode'), 'km_outside': round(d_t, 1)})
        if tides:
            b['tides'] = sorted(tides, key=lambda x: (not x['measured'], x['km_outside']))[:6]
            tally['bound_tides'] += 1

        # USACE projects. The `name` field on a CWMS location is an id, and what KIND of id
        # depends on the record: a SITE row carries a USGS site number ("02196835", Butler
        # Creek), a PROJECT row carries a component label ("Hartwell-Powerhouse",
        # "Hartwell-Line4b"). Both were about to be written into a field called `usgs_site`,
        # which would have put a transmission line where a gauge number belongs. So: keep the
        # raw id under its own name and promote it to `usgs_site` only when it actually looks
        # like one. This USED to be the only route by which any USGS site id reached the output
        # at all -- 152,176 series rows catalogued, about ten arriving, via a field on a Corps
        # record. The USGS pass above is now the real route; this one stays because a CWMS
        # project legitimately cites the site it reads from, and that citation is worth keeping.
        usace, seen_u = [], set()
        for off, lo, slon, slat in ucand:
            site = str(lo.get('name') or '').strip()
            label = (lo.get('public-name') or '').strip() or (lo.get('long-name') or '').strip()
            # A row with an id and no human name is telemetry -- a turbine, a line, a sensor
            # channel. It is real, and it is of no use to anyone choosing where to fish.
            if not site or not label or site in seen_u:
                continue
            d_u, ins_u = _how_far(slon, slat)
            named_u = name_relation(names, '%s %s' % (lo.get('public-name') or '',
                                                      lo.get('long-name') or ''), weak)
            # Inside the polygon is a fact; a name match plus proximity is the two-signal rule.
            # Anything else is a Corps site that merely shares a bounding box.
            if not (ins_u or (named_u and d_u <= margin_km)):
                continue
            seen_u.add(site)
            row = {'office': off, 'cwms_name': site, 'name': label,
                   'lat': slat, 'lon': slon, 'km_outside': round(d_u, 1),
                   'confidence': 'name+geom' if named_u else 'geom_only_inside'}
            if USGS_SITE_RE.match(site):
                row['usgs_site'] = site
            usace.append(row)
        if usace:
            b['usace'] = sorted(usace, key=lambda x: x['km_outside'])[:6]
            tally['bound_usace'] += 1
        for legacy in ('usgs', 'duke', 'dominion', 'normalPool', 'minPool'):
            if rec.get(legacy) is not None:
                b.setdefault('curated', {})[legacy] = rec[legacy]
        bindings[slug] = b
        tally['bound'] += 1
        tally['bound_pool'] += 1 if pool else 0
        tally['bound_tailwater'] += 1 if tail else 0

    # reachId only for waters we actually bound -- one call each, not 1,722.
    print('\nharvesting NWM reach ids for %d bound waters' % len(bindings))
    done = 0
    for slug, b in bindings.items():
        # THE FIRST ENTRY IS NOT NECESSARILY AN NWPS ENTRY. Once USGS sites can win `pool`,
        # taking `pool.lid` and giving up on a miss would drop the reach for exactly the waters
        # this change was made to improve -- Thurmond's pool is now a USGS site with no lid at
        # all, while a perfectly good NWPS gauge sits in `gauges[]` one line down. Scan for the
        # first entry that actually carries a handbook-5 id.
        lid = None
        for e in ([b.get('pool'), b.get('tailwater')] + list(b.get('gauges') or [])):
            cand_lid = (e or {}).get('lid')
            if cand_lid and LID_RE.match(cand_lid):
                lid = cand_lid
                break
        if not lid:
            continue                                # the "WL" case -- bad input, not a 404
        d, _ = fetch('%s/gauges/%s' % (NWPS, lid), cache, 'nwps_gauge_%s' % lid, force)
        rid = str(((d or {}).get('reachId') or '')).strip()
        if rid:
            b['reach'] = {'comid': rid, 'from_lid': lid}
            tally['reach_bound'] += 1
        else:
            # Dam tailwaters are not NWM reaches -- NRTT1 returns "". Expected, not an error.
            tally['reach_empty'] += 1
        done += 1
        if done % 100 == 0:
            print('  %d/%d' % (done, len(bindings)))

    # A FETCHED SOURCE THAT NOTHING READS MUST NOT BE SILENT. `src['usgs']` was populated,
    # counted into the report, printed at the end of every run, and never consulted -- for two
    # months, while the report's own `usgs: {SC: 23004, ...}` line made the run look like it
    # had the data. The only symptom was an absence, and an absence is the one thing no output
    # shows. So the list of sources bind() actually reads is written down HERE, next to the
    # code that reads them, and anything in `src` that is not in it says so loudly. Adding a
    # source to fetch_all and forgetting to wire it up is now a line of output, not silence.
    CONSUMED = {'nwps', 'tva', 'cwms', 'coops', 'usgs'}
    unread = sorted(set(src) - CONSUMED)
    if unread:
        print('\n!! %d FETCHED SOURCE(S) NOT READ BY bind(): %s' % (len(unread), ', '.join(unread)))
        print('   They were downloaded, cached and counted in the report. Nothing used them.')
        print('   Either wire them into bind() or stop fetching them -- do not leave both.')
    report['sources_fetched_but_unread'] = unread

    report['tally'] = dict(tally)
    report['rejected_name_only_sample'] = rejected_name_only[:60]
    report['rejected_name_only_total'] = len(rejected_name_only)
    report['review_geom_only_sample'] = review_geom_only[:60]
    report['review_geom_only_total'] = len(review_geom_only)
    # THE SAMPLE IS NOT THE LIST. 671 geometry-only matches were queued "for review" and 60 of
    # them were written down, so the review could not be done from the file that asked for it.
    # main() lifts this into its own file and drops the key, so the report stays readable.
    report['_full_review_lists'] = {'review_geom_only': review_geom_only,
                                    'rejected_name_only': rejected_name_only}
    return bindings


# ── main ────────────────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--cache', default=None, help='default <registry>\\_bindings_cache')
    ap.add_argument('--out', default=None, help='default <registry>\\water_bindings.json')
    ap.add_argument('--report', default=None, help='default <registry>\\_water_bindings.json')
    ap.add_argument('--review-out', default=None,
                    help='default <registry>\\_water_bindings_review.json; the FULL '
                         'geometry-only and name-only lists, not a sample of them')
    ap.add_argument('--lake-rivers', default=None,
                    help='_lake_rivers.json from build_lake_rivers.py -- the river each lake '
                         'IS, so a gauge named for the river matches the lake. DEFAULTS to '
                         '<registry>/_lake_rivers.json and warns if it is absent: an optional '
                         'flag that silently changes the output is how --aliases went unread.')
    ap.add_argument('--overrides', default=None,
                    help='default <registry>\\gauge_overrides.json; gauge bindings a human\n                         decided, which win over every derived pass')
    ap.add_argument('--stage', choices=('fetch', 'bind', 'all'), default='all')
    ap.add_argument('--margin-km', type=float, default=3.0,
                    help='how far outside a water a gauge may sit and still count as ON it. '
                         'A dam gauge is on the boundary edge by construction.')
    ap.add_argument('--force', action='store_true', help='ignore the response cache')
    ap.add_argument('--pause', type=float, default=None,
                    help='seconds between requests (default %.2f). Raise it if NWPS answers '
                         '429; the cache means a slower run costs only wall clock.' % PAUSE)
    a = ap.parse_args()
    if a.pause is not None:
        globals()['PAUSE'] = a.pause
        print('throttled to %.2fs between requests' % a.pause)

    reg = a.registry
    cache = a.cache or os.path.join(reg, '_bindings_cache')
    out = a.out or os.path.join(reg, 'water_bindings.json')
    rep_path = a.report or os.path.join(reg, '_water_bindings.json')

    # THE BOX IS SIZED FROM THE REGISTRY, BEFORE ANYTHING IS FETCHED. Read the index first --
    # it is the thing being served, so it is the thing that decides how far to look.
    with open(os.path.join(reg, 'lake_index.json'), 'r', encoding='utf-8') as fh:
        index = json.load(fh)
    global BBOX
    BBOX = bbox_covering(index, BBOX_FLOOR)
    if BBOX != BBOX_FLOOR:
        print('gauge box widened past the hand-authored floor to cover the registry:')
        print('   floor  W %.3f  S %.3f  E %.3f  N %.3f' % BBOX_FLOOR)
        print('   using  W %.3f  S %.3f  E %.3f  N %.3f' % BBOX)
    report = {'bbox': list(BBOX), 'bbox_floor': list(BBOX_FLOOR), 'tile_deg': TILE_DEG,
              'margin_km': a.margin_km}

    print('fetching (cache: %s)' % cache)
    try:
        src = fetch_all(cache, a.force, report)
    except RateLimited as e:
        # Write what we DID get, then stop with a non-zero exit. Half a fetch is a fine thing
        # to keep; half a fetch presented as a whole one is not, which is why --stage bind
        # must not be allowed to run off the back of this.
        report['aborted'] = str(e)
        with open(rep_path, 'w', encoding='utf-8') as fh:
            json.dump(report, fh, indent=1)
        print('\nSTOPPED -- %s' % e)
        print('partial report -> %s' % rep_path)
        sys.exit(2)

    if a.stage == 'fetch':
        with open(rep_path, 'w', encoding='utf-8') as fh:
            json.dump(report, fh, indent=1)
        print('\nfetch only. -> %s' % rep_path)
        print('usgs catalogue came from: %s' % report.get('usgs_catalogue_source'))
        return

    print('\n%d waters in the index' % len(index))

    # THE DEFAULT IS THE POINT. `--aliases` and `--registry` were both optional flags with no
    # default, and both silently changed the output when omitted -- 41 curated aliases went
    # unread for weeks, and the R2 registry publish just did not happen. The warning for a
    # missing file has to live OUTSIDE the block it gates, or a run without it looks normal.
    ovr_path = a.overrides or os.path.join(reg, 'gauge_overrides.json')
    overrides = {}
    if os.path.exists(ovr_path):
        with open(ovr_path, encoding='utf-8') as fh:
            doc = json.load(fh)
        overrides = doc.get('overrides') if isinstance(doc, dict) else None
        overrides = overrides if isinstance(overrides, dict) else {}
        unknown = sorted(set(overrides) - set(index))
        print('gauge overrides: %d water(s), %d entr(ies) from %s'
              % (len(overrides), sum(len(v or []) for v in overrides.values()),
                 os.path.basename(ovr_path)))
        if unknown:
            # A slug that is not in the index binds nothing and reads, from the output, exactly
            # like an override that was never written. Say it out loud.
            print('   !! %d override slug(s) are not in the index and will bind NOTHING: %s'
                  % (len(unknown), ', '.join(unknown[:8])))
        report['gauge_overrides_unknown_slugs'] = unknown
    else:
        print('!! NO OVERRIDE FILE at %s -- every binding will be derived.' % ovr_path)
        print('   That is fine if nothing needs a human decision. It is NOT fine if you expect')
        print('   Lake Robinson to have a tailwater; that gauge is named for the creek and the')
        print('   two-signal rule refuses it on purpose.')
    report['gauge_overrides'] = {k: [x.get('site') for x in (v or [])]
                                 for k, v in overrides.items()}

    # curated_lakes.json's `usgs` field used to be promoted here. It is not any more -- four of
    # its five entries are now derived independently by the USGS pass and the fifth reports only
    # water temperature. Name any row that still carries one, so a field going quiet is a line
    # of output rather than an absence.
    stale = sorted(s for s, r in (index.items() if isinstance(index, dict)
                                  else ((x.get('slug'), x) for x in index))
                   if isinstance(r, dict) and r.get('usgs') and s not in overrides)
    if stale:
        print('   note: %d index row(s) still carry a curated `usgs` field that this script no '
              'longer reads: %s' % (len(stale), ', '.join(stale[:8])))
        print('   They are derived now. Move any that are not to %s.' % os.path.basename(ovr_path))
    report['curated_usgs_no_longer_read'] = stale

    # DEFAULTS, and says so when it cannot find the file. An optional flag whose absence
    # silently changes the output is the exact shape of the --aliases bug: 41 curated aliases
    # went unread for a week and every run looked normal.
    lr_path = a.lake_rivers or os.path.join(reg, '_lake_rivers.json')
    lake_rivers = None
    if os.path.exists(lr_path):
        try:
            lake_rivers = json.load(open(lr_path, encoding='utf-8')).get('lakes') or {}
            print('lake rivers: %d lake(s) carry the river they are, from %s'
                  % (len(lake_rivers), os.path.basename(lr_path)))
        except (OSError, ValueError) as ex:
            print('!! %s is unreadable (%s) -- every reservoir will fail the name test again'
                  % (lr_path, ex))
    else:
        print('!! no %s -- an impoundment is not named after the river it impounds, so every\n'
              '   gauge reading "<River> at <town>" will fail the name test and land in the\n'
              '   review pile. Build it: py .\\scripts\\build_lake_rivers.py' % lr_path)
    report['lake_rivers_loaded'] = len(lake_rivers or {})

    bindings = bind(index, os.path.join(reg, 'boundaries'), src, cache, a.force,
                    a.margin_km, report, overrides, lake_rivers)

    full = report.pop('_full_review_lists', None)
    if full:
        rev_path = a.review_out or os.path.join(reg, '_water_bindings_review.json')
        with open(rev_path, 'w', encoding='utf-8') as fh:
            json.dump(full, fh, indent=1)
        print('-> %s  (%d geometry-only + %d name-only, IN FULL)'
              % (rev_path, len(full['review_geom_only']), len(full['rejected_name_only'])))

    with open(out, 'w', encoding='utf-8') as fh:
        json.dump({'_note': 'built by build_water_bindings.py; name AND geometry, never either '
                            'alone -- name-only matches are refused, see the report',
                   'bindings': bindings}, fh)
    with open(rep_path, 'w', encoding='utf-8') as fh:
        json.dump(report, fh, indent=1)

    t = report['tally']
    print('\n%d of %d waters bound' % (t.get('bound', 0), len(index)))
    print('   pool %d   tailwater %d   nwm reach %d' %
          (t.get('bound_pool', 0), t.get('bound_tailwater', 0), t.get('reach_bound', 0)))
    print('   refused as name-only  %d   (all five were wrong last time this was tried)'
          % report['rejected_name_only_total'])
    print('   geometry-only, review %d   (of which %d accepted as secondary, strictly inside)'
          % (report['review_geom_only_total'], t.get('geom_only_accepted', 0)))
    print('   tide stations bound %d   usace projects bound %d'
          % (t.get('bound_tides', 0), t.get('bound_usace', 0)))
    print('   usgs sites bound %d   (of which %d became a pool reading)   '
          'deduped against nwps %d   stream-gauge-in-a-lake skipped %d'
          % (t.get('usgs_bound', 0), t.get('usgs_pool', 0),
             t.get('usgs_dupe_of_nwps', 0), t.get('usgs_geom_only_stream_skipped', 0)))
    if report.get('weak_tokens_rescued_as_one_watershed'):
        print('   kept as strong (one watershed, not an ambiguity): %s'
              % ', '.join(report['weak_tokens_rescued_as_one_watershed'][:12]))
    print('   unbound %d' % t.get('unbound', 0))
    print('   usgs catalogue source: %s' % report.get('usgs_catalogue_source'))
    print('-> %s' % out)
    print('-> %s' % rep_path)


if __name__ == '__main__':
    main()
