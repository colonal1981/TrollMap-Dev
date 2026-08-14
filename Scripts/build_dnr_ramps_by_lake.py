#!/usr/bin/env python3
r"""build_dnr_ramps_by_lake.py - bind the live state DNR access feeds to registry slugs.

Personal use only, not for distribution or resale; not for navigation.

    py .\build_dnr_ramps_by_lake.py --registry "F:\TrollMapPipeline\registry"
    # ... fetches all four states live, reports, writes nothing. Then --go.

    py .\build_dnr_ramps_by_lake.py --registry "..." --from-dump    # offline, from registry\_dnr
    py .\build_dnr_ramps_by_lake.py --registry "..." --compare      # live vs the saved dump
    py .\build_dnr_ramps_by_lake.py --registry "..." --curated-report

WHY THIS EXISTS

Ryan, 2026-08-14: *"why can't the python script just use the ramp API to build lake-index.json
or some other means???"*

It can, and every part of it already existed except the wiring:

    fetch_dnr_paddle.py        a working Python ArcGIS client with the worker's filters
                               mirrored and a --compare diff. Paddle only.
    suggest_name_aliases.py    a DNR-name -> slug matcher with the two-signal safety rule
                               (loose name key AND a landing inside the lake's bounds).
    make_osm_ramps_by_lake.py  the by-lake bucket writer, keyed by slug.
    consolidate_lake_index.py  loads three such buckets at :457 and counts them at :512.

The DNR feeds are keyed by a WATERBODY NAME STRING; `consolidate_lake_index.py` reads buckets
keyed by SLUG. Nobody had written the step between. That is all this is.

WHAT IT FIXES

`registry/lake_index.json` says `ramp_sources: 0` on Broad River, Congaree, Santee and Wateree.
SCDNR lists ramps on all four. Measured over the 457-row registry: **67 rows the file calls
launch-less have live access on them.** The app stopped believing the file on 2026-08-14
(`e098c9d`) by reading the live index at runtime; this is the other half, for the Python side,
which has no live index to read -- `registryCut`, `check-lake-geo.mjs` and every count taken
off the JSON still see 155 instead of 222.

THE ARGUMENT THAT DOES *NOT* APPLY HERE, so nobody re-litigates it

`gis-toggles.js` says "Do not reintroduce a local fallback here -- a second stale copy is how
the snapshots drifted unnoticed in the first place." That is about the APP falling back to a
bundled copy at runtime instead of asking the worker. This is a build script writing a build
artifact, which is what `build_water_bindings.py` already does against USGS. Every other field
in `lake_index.json` is a build-time fact. `ramp_sources` is not special.

The default is therefore a LIVE FETCH, not a read of `registry/_dnr/`. That folder is a trap:
its files are dated 08-12 by mtime and their `fetched` stamps read 08-05 through 08-09, and
half of them (paddle, attractors, bank-pier) carry no stamp at all because they are
`fetch_dnr_paddle.py` output rather than saved worker responses. Two sources reading as one.
`--from-dump` exists for working offline and for `--compare`; it is not the normal path.

HOW A RAMP IS BOUND TO A LAKE, AND WHY NOT BY POSITION ALONE

**Name first, geometry as the guard.** That is the order `access-index.js` uses and it is not
an accident. A pure bbox test is hopeless on a river: `ocmulgee_river`'s bounding box contains
183 access points and the river has about 90 of them; `broad_river_2`'s contains ramps on the
tidal Broad at Beaufort, 150 miles from the water it names. The name is the strong signal and
the geometry only ever REMOVES.

Three name passes, cheapest first, mirroring the runtime matcher:

    1. exact, over every name a row answers to -- `name`, `display_name` and each
       `legacy_display_names` entry, which is where the curated disagreements live
       ("Clarks Hill Lake" is J. Strom Thurmond Reservoir).
    2. `registry/lake_aliases.json` -- the 42 pairs `suggest_name_aliases.py` proposed and a
       human accepted. Spelling ("Braodway"/"Broadway") and genuinely different names.
    3. loose key -- word order and generic water words stripped, so "Lake Wateree" meets
       "Wateree Lake (Kershaw Co, SC)". NEVER on its own: `lakeNameLooseKey` collapses
       "Lake Murray" and "Murray Pond" onto the same string and they are 12 miles apart.

Then the geometry guard, PER POINT, never all-or-nothing. This is the 2026-08-12 lesson from
`absorbDuplicateEntries`: rejecting a whole waterbody over one outlier cost 447 ramps across 55
lakes, including all four of Falls Lake's because the Eno River access sits 3 km outside the
bbox on an arm the boundary does not reach.

GEOMETRY vs BBOX, MEASURED RATHER THAN ASSUMED

The app only has `bounds_wsen`, a rectangle. The pipeline has `registry/boundaries/<slug>.geojson`
-- the real polygon or river centreline -- so the guard here can be DISTANCE TO THE WATER instead
of distance to a box, and that is the default.

It is worth much less than I first claimed, and the number is here so nobody re-argues it. On ten
lakes with boundary files, including the Ocmulgee and the Great Pee Dee, geometry admits 130
points and a plain bbox admits 132. Two points, both on the Ocmulgee.

The reason is that **the name pass is doing the work**. "A bbox gives the Ocmulgee 183 points" is
true of binding by POSITION ALONE, which is what a naive builder would do and what this file does
not do: 183 is how many access points sit in that rectangle, and only ~90 are named for the
river. Once the name has narrowed the field to one or two candidate lakes, the rectangle is
nearly as good as the outline.

So geometry stays on -- it is strictly more correct and costs one file read per matched lake --
but `--no-geometry` is a legitimate fast path, not a broken one, and the report says which test
each lake actually got rather than pretending they are the same.

WHAT IT WRITES

    registry/dnr_ramps_by_lake.json      slug -> [ {name, wb, type, src, lat, lon, meta} ]
    registry/dnr_paddle_by_lake.json     same shape, paddle launches

Two buckets, not one, because `consolidate_lake_index.py` counts `ramp_sources` as the number
of BUCKETS with content, and because `lake-registry.js`'s SOURCE_META labels access points per
bucket -- one bucket would have to label a canoe access "ramp" or a ramp "paddle". Both count
toward access: Ryan, 2026-08-14, asked for ramps AND paddle, which is what the app's planner
already does. A kayak launch is often the only access a small impoundment has.

Adding them to the index is one tuple in `consolidate_lake_index.py:457`:

    ('dnr_ramps_by_lake.json', 'dnr'), ('dnr_paddle_by_lake.json', 'dnr_paddle')

and two entries in `js/data/lake-registry.js` SOURCE_META so the points carry a label the app's
`liveAccessFor()` recognises. Both are listed at the end of the dry-run report so the run tells
you what it still needs rather than leaving it in a doc.

TESTED HOW

The bind, the three name passes, the per-point guard and both geometry modes are exercised by
`--from-dump` against the saved feeds; `--self-test` runs the known-answer cases (Broad River
must be 4 and must not include the Beaufort ramp). **The live fetch path is NOT exercised
here** -- the sandbox this was written in has no outbound network. It is deliberately the
thinnest part of the file: it imports `fetch_all` and `group` from `fetch_dnr_paddle.py` rather
than reimplementing paging, so the code that talks to ArcGIS is the code that has been talking
to ArcGIS since 08-04. `--compare` diffs a live fetch against the saved dump and is the one
command that proves it end to end.
"""
import argparse
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

try:
    from fetch_dnr_paddle import SOURCES as PADDLE_SOURCES, fetch_all, group, flag_yes, _s
except ImportError as e:                                    # pragma: no cover
    raise SystemExit('build_dnr_ramps_by_lake.py must sit beside fetch_dnr_paddle.py (%s)' % e)


# ── The ramp feeds ───────────────────────────────────────────────────────────────────────────
#
# Mirrors RAMP_SOURCES in Worker/trollmap-worker.js and RESEARCH_RAMP_SOURCES in
# Worker/research/facts-util.js. THREE copies of this table now exist and that is a known cost,
# accepted for the same reason fetch_dnr_paddle.py accepted it: a second independent
# implementation is the only thing that catches a predicate which silently rejects every row --
# the failure that left TN at count:0 and GA ramps empty. `--compare` is what makes the cost
# worth paying, so run it when a state's numbers move.
RAMP_SOURCES = {
    'sc': {
        'url': 'https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/'
               'South_Carolina_Public_Water_Access_PUBLIC_VIEW/FeatureServer/0/query',
        'filter': lambda p: (p.get('WaterAccessType') == 'Boat Ramp'
                             and _s(p.get('Status')).lower() == 'active'
                             and _s(p.get('PublicAccess')).lower() != 'closed'),
        'name': lambda p: p.get('WaterAccessName'),
        'wb': lambda p: p.get('Waterbody'),
        'meta': lambda p: {'lanes': p.get('LaunchLanes'), 'dock': p.get('CourtesyDock'),
                           'county': p.get('County'), 'owner': p.get('Owner')},
        'src': 'SCDNR South Carolina Public Water Access',
    },
    'ga': {
        'url': 'https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/'
               'WRD_Water_Access_Points/FeatureServer/0/query',
        'id_field': 'FID',
        'filter': lambda p: (flag_yes(p.get('Ramp'))
                             and _s(p.get('Status')).lower() not in ('closed', 'inactive')),
        'name': lambda p: p.get('Name'),
        'wb': lambda p: p.get('Waterbody'),
        'meta': lambda p: {'lanes': p.get('NumLanes'), 'dock': p.get('Dock'),
                           'county': p.get('County'), 'owner': p.get('Owner')},
        'src': 'Georgia DNR WRD Water Access Points',
    },
    'nc': {
        'url': 'https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/'
               'NCWRC_Boating_Access_Areas_view/FeatureServer/0/query',
        'filter': lambda p: 'CLOSED' not in _s(p.get('Site_Status') or 'OPEN').upper(),
        'name': lambda p: p.get('BAA_Name'),
        'wb': lambda p: p.get('Water_Access') or p.get('BAA_Alias'),
        'meta': lambda p: {'lanes': p.get('Launch_Lane_No'),
                           'dock': p.get('Courtesy_Dock_No') or p.get('Fix_Dock_No'),
                           'county': p.get('County'), 'owner': p.get('Owner')},
        'src': 'NC Wildlife Resources Commission Boating Access Areas',
    },
    'tn': {
        'url': 'https://services3.arcgis.com/PWXNAH2YKmZY7lBq/arcgis/rest/services/'
               'Boat_Launch_Sites/FeatureServer/0/query',
        # IncludeWeb IS returned by this layer -- unlike Paddling_Access_Sites, where it is not
        # in the field list and testing it rejected all 34 sites. Verified 2026-08-04; the
        # asymmetry between the two TN feeds is real and is why this is not shared.
        'filter': lambda p: (p.get('Type') == 'Boat Launch'
                             and _s(p.get('IncludeWeb')).lower() == 'yes'
                             and not _s(p.get('Ramps')).strip().lower() in ('none', '0', '')),
        'name': lambda p: p.get('Name'),
        'wb': lambda p: p.get('Waterway'),
        'meta': lambda p: {'lanes': p.get('Lanes'), 'dock': p.get('CourtesyDock'),
                           'county': p.get('County'), 'owner': p.get('Owner')},
        'src': 'Tennessee Wildlife Resources Agency Boat Launch Sites',
    },
}

STATES = ('sc', 'nc', 'ga', 'tn')
KINDS = ('ramps', 'paddle')


# ── Name keys. Ported from access-index.js; the tests below pin them to it. ──────────────────

def _dedup_key(n):
    """lowercase, drop parentheticals and anything after a comma, collapse punctuation."""
    n = _s(n).lower()
    out, depth = [], 0
    for ch in n:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth = max(0, depth - 1)
        elif depth == 0:
            out.append(ch)
    n = ''.join(out).split(',')[0]
    return ' '.join(''.join(c if c.isalnum() else ' ' for c in n).split())


GENERIC = {'lake', 'lakes', 'reservoir', 'pond', 'millpond', 'impoundment', 'sp', 'the'}


def loose_key(n):
    """Word order and generic water words removed. NEVER sufficient on its own -- 'Lake Murray'
    and 'Murray Pond' both reduce to 'murray' and are 12 miles apart. The geometry guard is what
    makes this safe, exactly as in access-index.js."""
    return ''.join(w for w in _dedup_key(n).split() if w not in GENERIC)


# ── Geometry ─────────────────────────────────────────────────────────────────────────────────

def _iter_coords(c):
    if not c:
        return
    if isinstance(c[0], (int, float)):
        yield c[0], c[1]
        return
    for s in c:
        for p in _iter_coords(s):
            yield p


def _iter_segments(geom):
    """Every line segment of a polygon ring or linestring, so distance is to the WATER and not
    to a corner of its bounding box."""
    t = (geom or {}).get('type')
    c = (geom or {}).get('coordinates')
    if not t or not c:
        return
    if t in ('Point',):
        yield (c[0], c[1], c[0], c[1])
        return
    rings = []
    if t == 'LineString':
        rings = [c]
    elif t in ('MultiLineString', 'Polygon'):
        rings = c
    elif t == 'MultiPolygon':
        rings = [r for poly in c for r in poly]
    elif t == 'GeometryCollection':
        for g in (geom.get('geometries') or []):
            for s in _iter_segments(g):
                yield s
        return
    for ring in rings:
        prev = None
        for pt in ring:
            if prev is not None:
                yield (prev[0], prev[1], pt[0], pt[1])
            prev = pt


def _seg_dist_m(lon, lat, x1, y1, x2, y2):
    """Metres from a point to a segment, in a local flat projection. Accurate to well under a
    percent at these latitudes and ranges, and this is a tolerance test, not navigation."""
    k = math.cos(math.radians(lat)) * 111320.0
    px, py = lon * k, lat * 111320.0
    ax, ay = x1 * k, y1 * 111320.0
    bx, by = x2 * k, y2 * 111320.0
    dx, dy = bx - ax, by - ay
    d2 = dx * dx + dy * dy
    if d2 <= 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / d2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


class Water(object):
    """One registry row's geometry, with the distance test it can actually support."""

    __slots__ = ('slug', 'bbox', 'segs', 'exact')

    def __init__(self, slug, bbox, segs):
        self.slug = slug
        self.bbox = bbox
        self.segs = segs
        self.exact = segs is not None

    def within(self, lat, lon, tol_m):
        w, s, e, n = self.bbox
        dlat = tol_m / 111320.0
        dlon = tol_m / (111320.0 * max(0.1, math.cos(math.radians(lat))))
        if not (s - dlat <= lat <= n + dlat and w - dlon <= lon <= e + dlon):
            return False                       # cheap reject before touching the geometry
        if self.segs is None:
            return True                        # bbox-only fallback, reported as such
        for (x1, y1, x2, y2) in self.segs:
            if _seg_dist_m(lon, lat, x1, y1, x2, y2) <= tol_m:
                return True
        return False


def load_water(registry, slug, bounds, want_geometry=True):
    bbox = tuple(bounds) if bounds and len(bounds) == 4 else None
    segs = None
    if want_geometry:
        fp = os.path.join(registry, 'boundaries', '%s.geojson' % slug)
        if os.path.exists(fp):
            try:
                gj = json.load(open(fp, encoding='utf-8'))
            except Exception:
                gj = None
            if gj:
                segs = []
                lo_x = lo_y = float('inf')
                hi_x = hi_y = float('-inf')
                feats = gj.get('features') if gj.get('type') == 'FeatureCollection' else [gj]
                for f in (feats or []):
                    g = f.get('geometry') if f.get('type') == 'Feature' else f
                    for sgm in _iter_segments(g):
                        segs.append(sgm)
                    for x, y in _iter_coords((g or {}).get('coordinates')):
                        lo_x = min(lo_x, x); hi_x = max(hi_x, x)
                        lo_y = min(lo_y, y); hi_y = max(hi_y, y)
                if segs and lo_x != float('inf'):
                    bbox = (lo_x, lo_y, hi_x, hi_y)     # the boundary outranks the index bbox
                else:
                    segs = None
    if not bbox:
        return None
    return Water(slug, bbox, segs)


# ── Feed loading ─────────────────────────────────────────────────────────────────────────────

def feed_live(kind, st):
    src = (RAMP_SOURCES if kind == 'ramps' else PADDLE_SOURCES)[st]
    feats = fetch_all(src['url'], src.get('id_field', 'OBJECTID'))
    wbs, stats = group(feats, src)
    return wbs, stats, src.get('src', src['url'])


def feed_dump(registry, kind, st):
    """registry/_dnr/<kind>_<st>.json, else the older flat registry/_dnr_<kind>_<st>.json."""
    for fp in (os.path.join(registry, '_dnr', '%s_%s.json' % (kind, st)),
               os.path.join(registry, '_dnr_%s_%s.json' % (kind, st))):
        if os.path.exists(fp):
            d = json.load(open(fp, encoding='utf-8-sig'))
            wbs = d.get('waterbodies') or {}
            n = sum(len(v or []) for v in wbs.values())
            return wbs, {'fetched': n, 'kept': n, 'filtered': 0, 'dropped': 0,
                         'stamp': d.get('fetched'), 'path': fp}, d.get('source') or fp
    return {}, {'fetched': 0, 'kept': 0, 'filtered': 0, 'dropped': 0, 'path': None}, None


# ── The bind ─────────────────────────────────────────────────────────────────────────────────

def build_name_index(rows):
    """Every name a registry row answers to -> slug, at two strengths."""
    exact, loose = {}, {}
    for slug, r in rows.items():
        names = [r.get('name'), r.get('display_name'), r.get('legacy_display_name')]
        names += list(r.get('legacy_display_names') or [])
        for nm in names:
            if not nm:
                continue
            k = _dedup_key(nm)
            if k:
                exact.setdefault(k, []).append(slug)
            lk = loose_key(nm)
            if lk and len(lk) >= 3:
                loose.setdefault(lk, []).append(slug)
    return exact, loose


def bind(registry, rows, feeds, tol_m, geometry=True, verbose=False):
    """feeds: {kind: {state: (waterbodies, stats, src_label)}} -> {kind: {slug: [points]}}"""
    exact, loose = build_name_index(rows)
    aliases = {}
    fp = os.path.join(registry, 'lake_aliases.json')
    if os.path.exists(fp):
        for k, v in (json.load(open(fp, encoding='utf-8-sig')) or {}).items():
            aliases[_dedup_key(k)] = v

    cache = {}

    def water(slug):
        if slug not in cache:
            cache[slug] = load_water(registry, slug, (rows.get(slug) or {}).get('bounds_wsen'),
                                     want_geometry=geometry)
        return cache[slug]

    # Coarse 0.1-degree grid over every row's bbox, used only to answer "is this point inside
    # ANY registry lake at all" when a NAME failed. Cheap, and it is what separates an alias
    # candidate from water the region prune deliberately removed.
    grid = {}
    for slug, r in rows.items():
        b = r.get('bounds_wsen')
        if not b or len(b) != 4:
            continue
        for gx in range(int(math.floor(b[0] / 0.1)), int(math.floor(b[2] / 0.1)) + 1):
            for gy in range(int(math.floor(b[1] / 0.1)), int(math.floor(b[3] / 0.1)) + 1):
                grid.setdefault((gx, gy), []).append(slug)

    def locate(lat, lon):
        d = 0.01
        for slug in grid.get((int(math.floor(lon / 0.1)), int(math.floor(lat / 0.1))), ()):
            b = rows[slug]['bounds_wsen']
            if b[1] - d <= lat <= b[3] + d and b[0] - d <= lon <= b[2] + d:
                return slug
        return None

    out = {k: {} for k in feeds}
    rep = {'name_hit': 0, 'name_miss': 0, 'pts': 0, 'placed': 0,
           'dropped_geom': 0, 'no_geom_row': 0, 'by_pass': {'exact': 0, 'alias': 0, 'loose': 0},
           'bbox_only': set(), 'exact_geom': set(), 'unmatched_names': [], '_locate': locate}

    for kind, per_state in feeds.items():
        for st, (wbs, _stats, src_label) in per_state.items():
            for wb, items in (wbs or {}).items():
                items = items or []
                rep['pts'] += len(items)
                k, lk = _dedup_key(wb), loose_key(wb)
                cands, which = [], None
                if k in exact:
                    cands, which = exact[k], 'exact'
                elif k in aliases:
                    cands, which = [aliases[k]], 'alias'
                elif lk and lk in loose:
                    cands, which = loose[lk], 'loose'
                if not cands:
                    rep['name_miss'] += 1
                    if len(rep['unmatched_names']) < 4000:
                        rep['unmatched_names'].append((st.upper(), kind, wb, len(items), items))
                    continue
                rep['name_hit'] += 1
                rep['by_pass'][which] += 1

                # PER POINT, not all-or-nothing. Rejecting a waterbody over one outlier cost
                # 447 ramps across 55 lakes on 2026-08-12.
                for it in items:
                    try:
                        lat, lon = float(it['lat']), float(it['lon'])
                    except (KeyError, TypeError, ValueError):
                        continue
                    best = None
                    for slug in cands:
                        w = water(slug)
                        if w is None:
                            rep['no_geom_row'] += 1
                            continue
                        (rep['exact_geom'] if w.exact else rep['bbox_only']).add(slug)
                        if not w.within(lat, lon, tol_m):
                            continue
                        # More than one claimant: the SMALLEST wins. A reservoir's geometry
                        # swallows every pond near it and the pond is the more specific answer
                        # -- make_osm_ramps_by_lake.py's rule, kept.
                        acres = (rows.get(slug) or {}).get('area_acres') or 0
                        if best is None or acres < best[1]:
                            best = (slug, acres)
                    if best is None:
                        rep['dropped_geom'] += 1
                        continue
                    meta = it.get('meta') or {}
                    out[kind].setdefault(best[0], []).append({
                        'name': it.get('name') or 'Unnamed access point',
                        'wb': wb,
                        'type': 'Boat Ramp' if kind == 'ramps' else 'Paddle Launch',
                        'src': src_label or ('%s %s' % (st.upper(), kind)),
                        'lat': round(lat, 6),
                        'lon': round(lon, 6),
                        'meta': {kk: vv for kk, vv in meta.items() if vv not in (None, '')},
                    })
                    rep['placed'] += 1

    for kind in out:
        for v in out[kind].values():
            v.sort(key=lambda e: (e['name'], e['lat']))
    return out, rep


# ── Reporting ────────────────────────────────────────────────────────────────────────────────

def report(rows, out, rep, tol_m, dst_names, geometry):
    print('\n%d access points over %d matched waterbody names (%d names matched nothing)'
          % (rep['pts'], rep['name_hit'], rep['name_miss']))
    print('   name passes: %d exact, %d alias, %d loose'
          % (rep['by_pass']['exact'], rep['by_pass']['alias'], rep['by_pass']['loose']))
    print('   %d points placed, %d dropped by the %s guard at %.0f m'
          % (rep['placed'], rep['dropped_geom'],
             'boundary-geometry' if geometry else 'bounding-box', tol_m))
    if geometry:
        print('   %d lakes judged against real boundary geometry, %d against a bbox only%s'
              % (len(rep['exact_geom']), len(rep['bbox_only']),
                 ' <- no boundary file' if rep['bbox_only'] else ''))

    lakes = sorted(set(list(out['ramps']) + list(out.get('paddle') or {})))
    print('\n%d registry rows gain access from the DNR feeds' % len(lakes))

    gained = []
    for s in lakes:
        r = rows.get(s) or {}
        had = bool(r.get('ramps')) or bool(r.get('ramp_sources'))
        if not had:
            gained.append((s, len(out['ramps'].get(s) or []),
                           len((out.get('paddle') or {}).get(s) or []), r))
    print('%d of them read ramp_sources: 0 in the index today\n' % len(gained))
    gained.sort(key=lambda t: -(t[1] + t[2]))
    print('   %-30s %-8s %5s %6s  %s' % ('slug', 'type', 'ramps', 'paddle', 'name'))
    for s, nr, npd, r in gained[:20]:
        print('   %-30s %-8s %5d %6d  %s'
              % (s, r.get('feature_type') or '?', nr, npd, r.get('display_name') or s))
    if len(gained) > 20:
        print('   ... %d more' % (len(gained) - 20))

    # A NAME THAT MATCHED NOTHING IS TWO DIFFERENT THINGS, and reporting them as one cries wolf.
    #
    # 714 names match nothing here, and the loudest -- Kentucky Reservoir at 65 ramps, Allatoona
    # at 27, Old Hickory at 38 -- are not naming failures at all: those lakes are not IN the
    # 457-row index. They were cut by the region prune. Listing them as "candidates for
    # lake_aliases.json" would send you off to alias water the app deliberately does not carry,
    # and after the third such list nobody reads the section.
    #
    # So: does this waterbody's water land inside ANY registry row? If yes, the registry has the
    # lake and could not spell it -- that is an alias candidate and worth a human minute. If no,
    # it is out of region and the silence is correct.
    inside, outside = [], 0
    for st, kind, wb, n, items in rep['unmatched_names']:
        hit = False
        for it in items[:8]:
            try:
                lat, lon = float(it['lat']), float(it['lon'])
            except (KeyError, TypeError, ValueError):
                continue
            if rep['_locate'](lat, lon):
                hit = True
                break
        if hit:
            inside.append((st, kind, wb, n))
        else:
            outside += 1
    print('\n%d unmatched names are outside every registry row -- water the region prune '
          'removed,\n   which is the correct silence and needs nothing.' % outside)
    if inside:
        print('\n%d unmatched names DO land inside a registry lake -- the registry has the water '
              'and\n   could not spell it. These are the alias candidates; feed them to '
              'suggest_name_aliases.py:' % len(inside))
        for st, kind, wb, n in sorted(inside, key=lambda t: -t[3])[:12]:
            print('   %-3s %-7s %4d pts  %s' % (st, kind, n, wb))
        if len(inside) > 12:
            print('   ... %d more' % (len(inside) - 12))

    print('\nTO MAKE THE INDEX READ THEM, two edits this script does NOT make:')
    print("   consolidate_lake_index.py:457  add ('dnr_ramps_by_lake.json', 'dnr') and")
    print("                                      ('dnr_paddle_by_lake.json', 'dnr_paddle')")
    print("   js/data/lake-registry.js       SOURCE_META += dnr: 'Boat ramp (DNR)',")
    print("                                                dnr_paddle: 'Paddle launch (DNR)'")
    print('   The second matters: without a label carrying "ramp"/"launch", the app\'s')
    print('   liveAccessFor() will not count these points. See test/live-ramps-reach-the-filter.')


def curated_report(rows, out, tol_m):
    """Ryan, 2026-08-14: "measure first, decide after." Which curated ramps are genuinely the
    only thing holding access on a lake, and which are already covered."""
    uniq, covered, lakes_at_risk = 0, 0, []
    for slug, r in rows.items():
        cur = (r.get('ramps') or {}).get('curated') or []
        if not cur:
            continue
        others = []
        for t, v in (r.get('ramps') or {}).items():
            if t != 'curated':
                others += v or []
        others += (out['ramps'].get(slug) or []) + ((out.get('paddle') or {}).get(slug) or [])
        alone = []
        for c in cur:
            try:
                clat, clon = float(c['lat']), float(c['lon'])
            except (KeyError, TypeError, ValueError):
                continue
            k = math.cos(math.radians(clat)) * 111320.0
            near = any(math.hypot((float(o.get('lon', 0)) - clon) * k,
                                  (float(o.get('lat', 0)) - clat) * 111320.0) <= tol_m
                       for o in others if o.get('lat') is not None)
            if near:
                covered += 1
            else:
                uniq += 1
                alone.append(c.get('name'))
        if alone and not others:
            lakes_at_risk.append((slug, r.get('display_name') or slug, len(alone)))
    print('\n── curated ramp coverage, at %.0f m ──' % tol_m)
    print('%d curated ramps are within %.0f m of a DNR/natl/osm/garmin ramp -- redundant'
          % (covered, tol_m))
    print('%d curated ramps have no other source near them' % uniq)
    print('\n%d lakes would have NO access at all if the curated bucket went away:'
          % len(lakes_at_risk))
    for slug, disp, n in sorted(lakes_at_risk, key=lambda t: -t[2])[:25]:
        print('   %-30s %2d curated ramp(s)   %s' % (slug, n, disp))
    if len(lakes_at_risk) > 25:
        print('   ... %d more' % (len(lakes_at_risk) - 25))
    print('\nNothing deleted. This is the list to read before deciding.')


# ── Self test ────────────────────────────────────────────────────────────────────────────────

def self_test(registry, tol_m, geometry):
    """Known answers, from Ryan's own screen. Asserting "more than zero" would pass with the
    tidal Broad River at Beaufort counted, which is the bug this whole file is about."""
    idx = json.load(open(os.path.join(registry, 'lake_index.json'), encoding='utf-8-sig'))
    feeds = {k: {st: feed_dump(registry, k, st) for st in STATES} for k in KINDS}
    if not any(feeds['ramps'][st][0] for st in STATES):
        raise SystemExit('self-test needs registry/_dnr dumps; none found')
    out, _rep = bind(registry, idx, feeds, tol_m, geometry=geometry)
    fails = []

    def check(label, got, want):
        print('   %-58s %s (got %s, want %s)'
              % (label, 'ok' if got == want else 'FAIL', got, want))
        if got != want:
            fails.append(label)

    # The four numbers Ryan read off his own screen on 2026-08-14. The browser reaches them by a
    # different route entirely -- name variants, then a bbox prune, then a per-point absorb --
    # so these agreeing is two independent implementations landing on the same answer, which is
    # the only kind of agreement worth anything here.
    r = out['ramps']
    check('broad_river_2 ramps', len(r.get('broad_river_2') or []), 4)
    check('congaree_river ramps', len(r.get('congaree_river') or []), 3)
    check('santee_river ramps', len(r.get('santee_river') or []), 4)
    check('wateree_river ramps', len(r.get('wateree_river') or []), 3)
    names = [p['name'] for p in (r.get('broad_river_2') or [])]
    check('the tidal Broad at Beaufort is not on broad_river_2',
          'Broad River' in names, False)
    check('99 Island is not double-counted onto broad_river_2',
          names.count('99 Island'), 0 if '99 Island' not in names else 1)
    print('\n   %s' % ('ALL PASS' if not fails else 'FAILED: %s' % ', '.join(fails)))
    return 1 if fails else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--state', action='append', help='sc|nc|ga|tn (repeatable; default all)')
    ap.add_argument('--tol-m', type=float, default=250.0,
                    help='how far off the water an access point may sit. Default 250 m against '
                         'real boundary geometry; raise it for --no-geometry, where the same '
                         'number means distance from a rectangle.')
    ap.add_argument('--from-dump', action='store_true',
                    help='read registry/_dnr instead of fetching. Offline only -- those files '
                         'are older than their mtimes say.')
    ap.add_argument('--no-geometry', action='store_true',
                    help='bbox only, ignoring registry/boundaries. Much looser on rivers.')
    ap.add_argument('--compare', action='store_true',
                    help='fetch live AND read the dump, and report where they differ')
    ap.add_argument('--curated-report', action='store_true')
    ap.add_argument('--self-test', action='store_true')
    ap.add_argument('--go', action='store_true', help='write. Default is a dry run.')
    a = ap.parse_args()

    R = a.registry
    if not os.path.isdir(R):
        raise SystemExit('no such registry folder: %s' % R)
    geometry = not a.no_geometry
    if a.self_test:
        return self_test(R, a.tol_m, geometry)

    print('MODE: %s, %s, %s'
          % ('WRITING' if a.go else 'DRY RUN -- nothing will be changed',
             'from registry/_dnr' if a.from_dump else 'LIVE from the state ArcGIS feeds',
             'boundary geometry' if geometry else 'bounding boxes only'))
    states = [s.lower() for s in (a.state or STATES)]
    bad = [s for s in states if s not in RAMP_SOURCES]
    if bad:
        raise SystemExit('unknown state(s): %s' % ', '.join(bad))

    idx = json.load(open(os.path.join(R, 'lake_index.json'), encoding='utf-8-sig'))
    print('%d registry rows' % len(idx))

    feeds = {k: {} for k in KINDS}
    for kind in KINDS:
        for st in states:
            if a.from_dump:
                wbs, stats, label = feed_dump(R, kind, st)
                stamp = stats.get('stamp')
                print('   %-6s %s  %4d pts, %3d waterbodies  [dump%s]'
                      % (kind, st.upper(), stats['kept'], len(wbs),
                         ', fetched %s' % stamp[:10] if stamp else ', no fetch stamp'))
            else:
                wbs, stats, label = feed_live(kind, st)
                print('   %-6s %s  %4d pts, %3d waterbodies  (fetched %d, filtered %d, '
                      'dropped %d)' % (kind, st.upper(), stats['kept'], len(wbs),
                                       stats['fetched'], stats['filtered'], stats['dropped']))
                if a.compare:
                    dwbs, dstats, _ = feed_dump(R, kind, st)
                    same = dwbs == wbs
                    print('        vs dump: %s (dump %d pts, live %d pts)'
                          % ('MATCH' if same else 'DIFFER', dstats['kept'], stats['kept']))
            feeds[kind][st] = (wbs, stats, label)

    out, rep = bind(R, idx, feeds, a.tol_m, geometry=geometry)
    dst = {'ramps': os.path.join(R, 'dnr_ramps_by_lake.json'),
           'paddle': os.path.join(R, 'dnr_paddle_by_lake.json')}
    report(idx, out, rep, a.tol_m, dst, geometry)

    if a.curated_report:
        curated_report(idx, out, max(a.tol_m, 150.0))

    if a.go:
        if a.from_dump:
            print('\nREFUSING TO WRITE FROM A DUMP. The dumps are stale by days and their '
                  'mtimes lie about it.\nDrop --from-dump to fetch, or delete this guard if '
                  'you really mean to freeze old data.')
            return 2
        print()
        for kind, path in dst.items():
            with open(path, 'w', encoding='utf-8', newline='') as fh:
                json.dump(out[kind], fh, indent=1, ensure_ascii=False)
            print('-> %s  (%d lakes, %d points)'
                  % (path, len(out[kind]), sum(len(v) for v in out[kind].values())))
        print('   now re-run consolidate_lake_index.py, after making the two edits above')
    else:
        print('\nDRY RUN -- nothing written. Add --go.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
