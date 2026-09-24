#!/usr/bin/env python3
r"""build_ramp_reach.py - how far it is BY WATER from every landing to a river's own channel.

Personal use only, not for distribution or resale; not for navigation.

    py .\build_ramp_reach.py --registry "F:\TrollMapPipeline\registry" ^
                             --extract  "F:\TrollMapPipeline\extract" ^
                             --chartpack "F:\TrollMapPipeline\chartpack" --only congaree_river
    # ... reports, writes nothing. Then --go.

WHY THIS EXISTS

Ryan launches at Bates Bridge and also at Pack's Landing, which SCDNR files under Lake Marion.
Pack's reaches the Congaree along a canal that runs beside the railroad, and he fishes the canal
on the way: *"there is a canal that runs along the railroad tracks that leads directly into the
river. I fish the canal as well on my way to the river."*

Nothing in the pipeline could see that. The ramp binding is NAME-FIRST -- build_dnr_ramps_by_lake
matches the state feed's waterbody NAME to a slug and uses geometry only as a guard, and
access-index.js does the same at runtime -- so a landing the state files under "Lake Marion" can
never reach "Congaree River" however close it sits. The state, like Garmin, does not sort the
water the way we do.

STRAIGHT-LINE DISTANCE IS THE WRONG MEASURE AND SAYS SO OUT LOUD

    Pack's Landing   straight 2,367 m      by water 1,803 m
    Low Falls        straight   330 m      by water   254 m

The water route is SHORTER because it follows the canal instead of cutting across the swamp. A
rule built on straight-line distance would have put Pack's 564 m further away than it is, and I
proposed exactly that rule before Ryan said what the canal was.

WHAT IT MEASURES

The charted water is rasterised at 25 m and walked outward from the river's own centreline, 8-
connected, so what comes back is what a boat travels. Measured across the whole lower Santee
basin, 50 landings, the answer has a hole in it that nobody chose:

    25 m      Bates Bridge
    254 m     Low Falls
    1,270 m   Calhoun Subdivision
    1,803 m   Rimini / Pack's
    2,082 m   Santee State Park
    2,387 m   three unnamed
    3,073 m   one unnamed
    -- nothing between 3,073 and 6,044 --
    6,044 m   five more, and then Marion proper out to 35 km

THERE IS NO THRESHOLD IN HERE. Ryan: *"If you can have these ramps be both river and lake I do
not see the downside"*, and on the cut: annotate rather than filter. So this writes the distance
and every landing that has one, the app shows "Pack's Landing - 1.1 mi to the river", and the
choice is made in the boat. A number chosen here would be an arbitrary number, which is an AI
problem and not a fishing one.

ADDITIVE, NEVER SUBTRACTIVE. This does not move a landing off the water it is already filed
under and does not remove one. `lake_marion` keeps Pack's; the Congaree gains it.

WHAT IT CANNOT SEE, AND THE KNOWN CASE

It walks CHARTED water, so a real connection through water Garmin never sounded reads as no
path. The known instance is Cedar Creek Canoe Launch: the NPS and the paddling guides put the
Cedar Creek Canoe Trail at about 15 miles through the Congaree Wilderness to the river, taking
out at Hwy 601 -- which is Bates Bridge -- and this script says "no path" because the creek is
not sounded. It is already in the Congaree's OSM bucket and stays there; being additive is what
keeps that true. Reading USGS NHD flowlines as a second source for the CONNECTION question,
with the chart still answering the DEPTH question, is the fix and is not done here.

RIVERS SEED FROM THEIR LINE, LAKES FROM THEIR OWN WATER

A river has a channel to start the walk from -- `centreline.geojson`, which is what a boat
follows. A lake has no line, so it seeds from every cell of its OWN charted water: the depth
areas inside its boundary. Both then answer the same question, which is the one that matters --
can a boat get from this landing to this water, and how far is it.

Ryan asked for the second half by name: *"the part that is missing is that the river ramps do
not show as ramps the lakes can use"*. Bates Bridge is on the Congaree and 22.5 km of water from
Lake Marion; whether that is a Marion launch is his call in the boat, and the number is how he
makes it.
"""
import argparse
import json
import heapq
import math
import os
import re
import sys
from collections import deque

# ── THE COMPONENT CAP, AND WHY IT IS NOT 40,000 ANY MORE ─────────────────────────────────────
#
# This was 40,000, unreachable from the command line (nothing ever set `args.max_component_polys`)
# and it silently skipped the pool stamp on ten of the waters the app offers -- Norris, Hartwell,
# Thurmond, Lanier, Cherokee, Murray and four coastal packs. Those are the waters with the most
# arms and the most sub-impoundments, so it was off exactly where it earns its keep.
#
# MEASURED BEFORE IT WAS MOVED, 2026-09-22, timing components() alone:
#
#     wateree_lake       7,064 polygons     5.9 s
#     lake_marion       22,480 polygons    12.3 s
#     lake_murray       51,351 polygons   128.7 s      <- the most expensive of the four
#     cherokee_lake     72,103 polygons   112.1 s      <- 1.4x the polygons, LESS time
#
# So a polygon COUNT does not predict the cost. Murray is smaller than Cherokee and dearer,
# because what components() actually pays for is how many depth bands interlock, not how many
# there are -- and a count-based cap that admits Murray while excluding Cherokee is not measuring
# the thing it is protecting against. The worst case seen is about two minutes and roughly 3 GB
# resident, on a run that takes hours; the largest offered water is Norris at 82,745 polygons.
#
# 120,000 clears every water the app offers with headroom. It stays a flag because the real
# constraint is MEMORY, not time: `--jobs 6` means six of these at once, and lowering the cap is
# the lever if a run ever dies rather than finishing slowly.
MAX_COMPONENT_POLYS = 120000

# ── HIS BOAT, IN HIS WORDS ─────────────────────────────────────────────────────────────────────
#
# Ryan, 2026-09-24, asked what the Slayer Propel and the NK180 Pro actually draw: *"18 inches or
# so probably if the pedal drive is down... otherwise 6 inches or less because the nk180pro will
# kick up"*, and the motor itself runs at about 12 inches.
#
# THE CHART RESOLVES ONE OF THOSE THREE, AND IT IS THE ONE THAT MATTERS ON THE WAY OUT. The depth
# areas are whole-foot bands -- `0-1 ft` is the finest and the most common, 142,712 of the zoom-0
# polygons in a 92-tile sample on 2026-09-24 -- and this file reads a band's SHALLOW edge. So:
#
#     12 in, the motor        every metre of `0-1 ft` is under it, and no metre of `1-2 ft` is.
#                             The one draft the bands can answer exactly.
#     18 in, the pedal drive  falls INSIDE `1-2 ft`, which the chart cannot split.
#      6 in, the hull         falls inside `0-1 ft`, likewise.
#
# He transits on the motor -- at full speed, 5.5 mph flat, *"pedaling does not add anything to
# this really"* (2026-09-24) -- so the motor's foot is what a landing's way out is measured
# against: `under_motor_m` on every landing, shown in the app beside the distance. It is a
# MEASUREMENT of the route, not what the route is steered by; see --min-depth-ft for why steering
# by it was measured and turned down.
MOTOR_DRAFT_FT = 1.0

CELL_DEG = 0.00025          # ~26 m of latitude; the canal at Rimini is wider than one cell
MARGIN_DEG = 0.05           # how far outside the line to look for landings, ~5.5 km
BLOCK_CELLS = 2_000_000     # cells per vectorised point-in-polygon call; caps peak memory
SQ2 = math.sqrt(2.0)        # a diagonal step is longer than a side, and the cost is in metres


def load_json(path):
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


# Provenance order for WHOSE NAME SURVIVES a collapse. Identical to NAME_SOURCE_ORDER in
# js/data/launch-reach.js, and for the same reason: Google is not naming a landing, it is naming
# the nearest thing it knows about to a point. `ryan` is applied after this runs and so cannot
# appear here yet; it is listed to keep the two files reading the same.
_NAME_ORDER = ('ryan', 'dnr', 'natl', 'osm')


def _name_rank(src):
    if 'ryan' in src:
        return -1
    if 'places' in src:
        return len(_NAME_ORDER)          # Google filled a blank; it never wins
    for i, s in enumerate(_NAME_ORDER):
        if s in src:
            return i
    return len(_NAME_ORDER)


def _collapse_landings(out):
    """One row per landing. Returns (collapsed, alias) where alias maps EVERY original 5 dp key
    -- absorbed or not -- to the key that survived, so coordinate-keyed override files still
    resolve. See the block in access_points() for the rule and the numbers."""
    keys = sorted(out, key=lambda k: (_name_rank(out[k]['src']), k))   # best namer is the seed
    kept, alias = {}, {}
    grid = {}
    cell = 0.004                          # ~440 m: wider than the 250 m name gate, so a 3x3
    for k in keys:                        # neighbourhood cannot miss a pair
        r = out[k]
        gx, gy = int(r['lat'] // cell), int(r['lon'] // cell)
        hit = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for kk in grid.get((gx + dx, gy + dy), ()):
                    q = kept[kk]
                    if abs(q['lat'] - r['lat']) < 0.0004 and abs(q['lon'] - r['lon']) < 0.0004:
                        hit = kk
                        break
                    if (q['name'] and r['name']
                            and q['name'].strip().lower() == r['name'].strip().lower()
                            and _metres(q, r) <= 250.0):
                        hit = kk
                        break
                if hit:
                    break
            if hit:
                break
        if hit is not None:
            q = kept[hit]
            q['filed'] |= r['filed']
            q['src'] |= r['src']
            if r['name'] and not q['name']:
                q['name'] = r['name']
            if r['access'] and not q['access']:
                q['access'] = r['access']
            # The restrictive word survives, exactly as it does within one feed above: a state
            # listing a marina as public water access is not the state saying the ramp is free.
            if r['listing'] and (r['listing'] == 'Semi-Private' or not q['listing']):
                q['listing'] = r['listing']
            alias[k] = hit
            continue
        kept[k] = r
        alias[k] = k
        grid.setdefault((gx, gy), []).append(k)
    if len(kept) != len(out):
        print('landings collapsed: %d rows -> %d landings (%d folded)'
              % (len(out), len(kept), len(out) - len(kept)))
    return kept, alias


def _metres(a, b):
    la = math.radians((a['lat'] + b['lat']) / 2.0)
    return math.hypot((b['lon'] - a['lon']) * math.cos(la) * 111320.0,
                      (b['lat'] - a['lat']) * 110540.0)


def access_points(registry):
    """Every landing we know, from every bucket, deduped on position.

    Keyed to 5 dp, which is 1.1 m -- the same two records from two feeds collapse, two real
    ramps on one lot do not.
    """
    out = {}
    for fn in ('dnr_ramps_by_lake.json', 'osm_ramps_by_lake.json', 'natl_ramps_by_lake.json'):
        p = os.path.join(registry, fn)
        if not os.path.isfile(p):
            continue
        src = fn.split('_')[0]
        body = load_json(p)
        if not isinstance(body, dict):
            continue
        for slug, rs in body.items():
            if not isinstance(rs, list):
                continue
            for r in rs:
                try:
                    la = float(r.get('lat') if r.get('lat') is not None else r.get('latitude'))
                    lo = float(r.get('lon') if r.get('lon') is not None
                               else (r.get('lng') if r.get('lng') is not None else r.get('longitude')))
                except (TypeError, ValueError):
                    continue
                k = (round(la, 5), round(lo, 5))
                rec = out.setdefault(k, {'lat': la, 'lon': lo, 'name': '', 'access': '',
                                         'listing': '', 'filed': set(), 'src': set()})
                rec['filed'].add(slug)
                rec['src'].add(src)
                nm = r.get('name') or r.get('NAME') or r.get('label')
                if nm and not rec['name']:
                    rec['name'] = nm
                # WHO IS ALLOWED TO LAUNCH THERE, WHERE THE FEED SAYS.
                #
                # OSM tags `access` and osm_ramps_by_lake.json has kept it all along; it stopped
                # at the registry and never reached the app, so the ramp list was offering
                # `access=private` slipways with nothing to tell them apart. OSM's
                # `leisure=slipway` covers a private dock ramp behind a house exactly as much as
                # a public landing, which is why Lake Murray has eight of them at 0 m of water.
                # Measured across the packs before this: 18 rows not freely public (15 private,
                # 2 customers, 1 `no` -- named "Abandon Boat Launch"), 31 positively public,
                # and 520 with no tag at all. So this answers for a minority and says nothing
                # for the rest, which is the truth and is why it is carried rather than assumed.
                ac = r.get('access')
                if ac and not rec['access']:
                    rec['access'] = str(ac)

                # AND WHETHER IT IS A PLACE THAT SELLS YOU THE LAUNCH.
                #
                # Ryan, working through the review deck: *"most of these are campgrounds or
                # marinas... almost all of them are pay to play"*. He was reading the truth off
                # the names; the national water-access layer has been carrying the same fact in
                # a field nothing ever read -- `type`, which is "Public" on 1,120 rows and
                # "Semi-Private" on 242.
                #
                # SEMI-PRIVATE WINS A DISAGREEMENT, and the disagreement is common: 45 of those
                # 242 are ALSO in a state agency's water-access feed -- Raysville Marina, Plum
                # Branch Yacht Club, Soap Creek Lodge & Marina, Trade Winds Marina. A state
                # listing a marina as public WATER ACCESS is not the state saying the ramp is
                # free, so the restrictive word is the one that survives. (The SC feed's own
                # `fee` field cannot settle it either: it is `false` on all 438 rows.)
                #
                # ONLY THESE TWO WORDS ARE CARRIED. The state feeds' `type` is the string "Boat
                # Ramp" on all 897 of their rows and says nothing about who may use it.
                t = r.get('type')
                if t in ('Public', 'Semi-Private') and (t == 'Semi-Private' or not rec['listing']):
                    rec['listing'] = t

    # ── ONE LANDING, ONE ROW, BEFORE IT IS WRITTEN ──────────────────────────────────────────
    #
    # The 5 dp key above is 1.1 m and the feeds do not agree to 1.1 m. Measured across every
    # launches.json on the drive on 2026-09-22, by running the READER'S OWN collapse over what
    # the producer had already shipped: **3,501 landing rows, 2,087 distinct landings, 1,414
    # folded -- 40.4% of every row in every pack is a duplicate the browser throws away on
    # load.** Hartwell ships 187 rows for 86 landings. On Wateree it is 33 rows for 21, and
    # nine of the twelve extras are one ramp arriving as a `dnr` row and a `natl` row two
    # metres apart.
    #
    # THIS IS THE READER'S RULE, NOT A NEW ONE. samePlace() and sameNamedPlace() in
    # js/data/launch-reach.js, ported with their numbers: 0.0004 deg (~40 m) by position, or
    # 250 m when two rows carry the same name. Both numbers are argued from measurement in that
    # file and neither is re-derived here -- a second answer to "is this the same landing" is
    # the defect this whole change exists to remove (see
    # claude/FIVE_SURFACES_FOUR_FEEDS_AND_EIGHTY_FIVE_RAMPS_DELETED_2026-09-22.md). collapse()
    # stays in the app as the safety net for a stale pack; after this it should fold nothing.
    #
    # WHY NOT A TIGHTER POSITION RULE. There is no empty band to put one in. Every cross-feed
    # pair under 400 m whose names disagree after stripping the generic words was measured, and
    # they start at 0.7 m: "Gilmore Inc" vs "Gilmore Docks", "Nance's Ferry" vs "Nance Ferry",
    # "Asheville Hwy" vs "Asheville Highway", "Hwy 25E 1" vs "Hwy 25E". Those are not two ramps
    # 0.7 m apart -- two ramps cannot be 0.7 m apart -- they are two feeds spelling one landing
    # differently, which is the exact case the name test cannot catch and position must.
    #
    # THE ALIAS MAP IS LOAD-BEARING. `_place_names.json` and `_launch_name_overrides.json` are
    # keyed by the coordinate of the record they were written against, and collapsing changes
    # which key survives. Every absorbed key points at its survivor so Ryan's corrections and
    # his `drop` flags still land on the landing he was looking at when he wrote them.
    out, alias = _collapse_landings(out)

    # A NAME GOOGLE KNEW AND NO FEED DID.
    #
    # name_launches_from_places.py asks Google Nearby Search what is at a landing nobody named
    # and writes the answers here. It is read LAST and only fills a blank: a name from SCDNR or
    # OSM is a name somebody chose for that landing, and Google's label for the car park it sits
    # in does not get to overwrite it. Only `accepted` records count -- the file also holds
    # unaccepted SUGGESTIONS, which are for a human to read and are not names.
    p = os.path.join(registry, '_place_names.json')
    if os.path.isfile(p):
        named = 0
        for key, r in (load_json(p).get('places') or {}).items():
            if not r.get('accepted') or not r.get('name'):
                continue
            try:
                la, lo = (float(v) for v in key.split(','))
            except ValueError:
                continue
            rec = out.get(alias.get((round(la, 5), round(lo, 5))))
            if rec is not None and not rec['name']:
                rec['name'] = str(r['name'])
                rec['src'].add('places')
                named += 1
        if named:
            print('names from Google Places: %d' % named)

    # AND RYAN'S OWN CORRECTIONS, WHICH BEAT EVERY FEED.
    #
    # He fishes these waters and SCDNR does not. Read last and it OVERWRITES rather than filling
    # a blank, because the cases that need it are exactly the ones where a feed is confidently
    # wrong: *"Dam Boat dock is buckhill landing which is on the lake not the river"*.
    #
    # Naming two records the same thing is also how a duplicate is retired -- collapse() in
    # js/data/launch-reach.js folds two rows sharing a name within 250 m into one, so *"1 ramp at
    # hwy 378 on the wateree"* is answered by giving both records the one name rather than by a
    # rule about those two coordinates.
    p = os.path.join(registry, '_launch_name_overrides.json')
    if os.path.isfile(p):
        fixed = dropped = gone = 0
        for key, r in (load_json(p).get('names') or {}).items():
            r = r or {}
            try:
                la, lo = (float(v) for v in key.split(','))
            except ValueError:
                continue
            k = alias.get((round(la, 5), round(lo, 5)))
            if k is None:
                # A DROP WITH NOTHING TO DROP IS NOT A WARNING. All 36 of his drops are unnamed
                # OSM slipway nodes, and on 2026-09-24 every one of them was already absent from
                # the feeds this reads -- checked by distance, not by key: 33 have no landing
                # within 250 m, and the other three are 125-225 m from a DIFFERENT, real ramp
                # (WT Billy Tolar, the one he kept at Hwy 378). The run printed thirty-six
                # "check the position" lines for a job already done, which is how the one that
                # matters -- a NAME he gave that no longer lands -- would be lost among them.
                if r.get('drop'):
                    gone += 1
                else:
                    print('!! name override at %s matches no landing -- check the position' % key)
                continue
            # AND HE CAN SAY IT IS NOT A LAUNCH AT ALL. OSM tags `leisure=slipway` on things
            # that are not one -- *"this a dirt road on parr reservoir... not a ramp"* -- and no
            # amount of naming fixes a record that should not be there. This is the only way a
            # landing leaves the data, and it takes a human saying so.
            if r.get('drop'):
                # pop, not del: two of his drops can resolve to ONE surviving landing now that
                # the feeds' copies of it are collapsed, and the second would have thrown.
                if out.pop(k, None) is not None:
                    dropped += 1
                continue
            if not r.get('name') or k not in out:
                continue
            out[k]['name'] = str(r['name'])
            out[k]['src'].add('ryan')
            fixed += 1
        if fixed or dropped or gone:
            print("Ryan's own corrections applied: %d named, %d dropped, %d drop(s) already gone "
                  "from the feeds" % (fixed, dropped, gone))
    return out


def water_polys(extract, registry, slug, bbox, with_depth=False):
    """Every zoom-0 depth-area polygon near this water, off the tiles it sits on.

    zoom 0 only: the coarser levels are redraws of the same water, not extra survey, and a
    generalised polygon closes the very gaps -- a canal mouth, a creek neck -- this walk is for.
    """
    from shapely.geometry import shape, box
    tmap_p = os.path.join(registry, 'tile_lake_map.json')
    tiles = []
    if os.path.isfile(tmap_p):
        tiles = (load_json(tmap_p).get('by_lake') or {}).get(slug) or []
    if not tiles:
        return [], 0
    import gzip
    win = box(*bbox)
    out, n, deep = [], 0, []
    for t in tiles:
        cid = 'C' + t[1:] if t[:1] in 'Bb' else t
        for ext in ('.geojson.gz', '.geojson'):
            fp = os.path.join(extract, 'depth_areas', cid + ext)
            if not os.path.isfile(fp):
                continue
            raw = gzip.open(fp, 'rb').read() if ext.endswith('.gz') else open(fp, 'rb').read()
            for f in (json.loads(raw).get('features') or []):
                if (f.get('properties') or {}).get('zoom') != 0:
                    continue
                n += 1
                try:
                    g = shape(f['geometry'])
                except Exception:
                    continue
                if g.is_empty:
                    continue
                if not g.is_valid:
                    g = g.buffer(0)
                if g.is_empty or 'Polygon' not in g.geom_type:
                    continue
                if g.intersects(win):
                    out.append(g)
                    if with_depth:
                        # THE BAND'S SHALLOW EDGE, BECAUSE THE CALLER IS ASKING ABOUT A FLOOR.
                        # '9-10 ft' is 9, not 10. This read the deep edge, and the question it
                        # feeds -- "may the boat be shallower than 6 ft here?" -- then got the
                        # wrong answer for every band that straddles the number: a '5-6 ft'
                        # polygon returned 6, passed `>= 6`, and was routed through and reported
                        # as deep water. Measured on Pack's Landing, 2026-09-21: 12 m under the
                        # floor by that reading against 215 m by the bands themselves, nearly all
                        # of it the 5-6 ft flat the ramp sits on. The shallow edge is what the
                        # polygon guarantees; the deep edge is only what it permits.
                        #
                        # Nothing here invents a depth: a polygon with no band readable is 0,
                        # which the caller treats as unknown and therefore avoids.
                        m = re.match(r'\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)',
                                     str((f.get('properties') or {}).get('band') or ''))
                        deep.append(float(m.group(1)) if m else 0.0)
            break
    return (out, n, deep) if with_depth else (out, n)


def walk(polys, line_pts, bbox, cell=CELL_DEG, depths=None, min_ft=0.0, shoal_cost=0.0,
         verbose=True):
    """Rasterise the water, seed every cell the channel runs through, flood outward.

    Returns (cost, prev, deep, nx, ny, w0, s0, step_m, nwet). `cost` is in METRES of water
    travelled, surcharged where the water is shallower than the floor; `prev` is the cell each
    cell was reached from, so a route is read back exactly rather than searched for again.

    Rasterising the whole bounding box would be tens of millions of point-in-polygon tests on a
    long river, nearly all of them over dry ground. Each polygon paints only its own box, which
    is the same work the water occupies and no more.
    """
    import numpy as np
    from shapely import intersects_xy
    w0, s0, e0, n0 = bbox
    nx = int((e0 - w0) / cell) + 1
    ny = int((n0 - s0) / cell) + 1
    wet = np.zeros(nx * ny, dtype=bool)
    for g in polys:
        gx0, gy0, gx1, gy1 = g.bounds
        i0 = max(0, int((gx0 - w0) / cell)); i1 = min(nx - 1, int((gx1 - w0) / cell) + 1)
        j0 = max(0, int((gy0 - s0) / cell)); j1 = min(ny - 1, int((gy1 - s0) / cell) + 1)
        if i1 < i0 or j1 < j0:
            continue
        # ONE PREDICATE CALL PER BLOCK, NOT PER CELL. This was `prep(g).covers(Point(x, y))`
        # once per cell, and the Python call overhead -- not the geometry -- was the whole cost:
        # a river's polygons cover millions of cells between them. `intersects_xy` runs the SAME
        # test in C over an array, and for a point `g.intersects(p)` and `g.covers(p)` are the
        # same question, so the answer is identical and not merely close. Blocked by rows so a
        # lake-sized polygon cannot materialise its whole bbox at once.
        ii = np.arange(i0, i1 + 1)
        xs = w0 + (ii + 0.5) * cell
        rows = max(1, int(BLOCK_CELLS // xs.size))
        for jb in range(j0, j1 + 1, rows):
            je = min(j1, jb + rows - 1)
            jj = np.arange(jb, je + 1)
            ys = s0 + (jj + 0.5) * cell
            hit = intersects_xy(g, np.tile(xs, jj.size), np.repeat(ys, xs.size))
            if not hit.any():
                continue
            wet[(np.repeat(jj, xs.size) * nx + np.tile(ii, jj.size))[hit]] = True
    nwet = int(wet.sum())
    # ── AND THE SAME WATER AGAIN, AT OR DEEPER THAN HE IS WILLING TO RUN ────────────────────
    #
    # Ryan, 2026-09-21, having followed the faired canal route on the chart: *"if i followed the
    # transit exactly i would be stuck in a tree right now if i was on the water... the last chunk
    # of the transit heads for shallow water where i know there is a stump field and laydown"*,
    # and then the number: *"i should not have to run shallower than 6ft or so that entire run"*.
    #
    # The chart already knew. Sampled at 5 m along the route that shipped, from Pack's Landing:
    # 455 m of 2,438 m in water charted under 6 ft, in FIVE separate stretches, one of them 103 m
    # long ending 80 m short of the river, and it touches 0-1 ft twice. That last stretch is the
    # stump field. A flood that counts cells has no opinion about any of it -- it took the short
    # way across the flat because the flat is short.
    #
    # AND THERE IS NO CLEAN WAY OUT, WHICH IS WHY THE FIRST ATTEMPT WAS WRONG. Flooding the 6 ft
    # water on its own and preferring it where it reaches is all-or-nothing: Pack's Landing sits
    # on a 5 ft flat, so no route of any length leaves it without going under 6 ft, the deep flood
    # never arrives, and the landing silently falls back to the shortest water -- the same 455 m.
    # Forcing the floor instead sent it 6,569 m around for an 1,826 m trip.
    #
    # THE COST IS LEXICOGRAPHIC AND THE WEIGHT IS NOT A CHOICE. Fewest metres under the floor
    # first, fewest metres second. A shallow metre is surcharged by the total extent of the water
    # in this window, which is longer than any route through it can be, so one shallow metre can
    # never be bought back with distance however far the detour runs. Nothing is tuned and nothing
    # is arbitrary: the surcharge is measured off the same raster it is applied to.
    #
    # Measured on this water, ramp to river, against the 26 m grid it already uses: 455 m under
    # 6 ft becomes 331 m, the five stretches become one -- the first 240 m off the landing, which
    # is the flat the ramp is built on -- and the line goes into the Congaree through 11 ft, then
    # 15 ft, then 20 ft. Ryan, told the mouth was the deep part: *"the mouth is 13-14ft at the
    # deepest"*. It is now the part the route aims at instead of the part it misses.
    deepwet = None
    if depths is not None and min_ft > 0:
        dw = np.zeros(nx * ny, dtype=bool)
        for g, ft in zip(polys, depths):
            if not ft or ft < min_ft:
                continue
            gx0, gy0, gx1, gy1 = g.bounds
            i0 = max(0, int((gx0 - w0) / cell)); i1 = min(nx - 1, int((gx1 - w0) / cell) + 1)
            j0 = max(0, int((gy0 - s0) / cell)); j1 = min(ny - 1, int((gy1 - s0) / cell) + 1)
            if i1 < i0 or j1 < j0:
                continue
            ii = np.arange(i0, i1 + 1)
            xs = w0 + (ii + 0.5) * cell
            rows = max(1, int(BLOCK_CELLS // xs.size))
            for jb in range(j0, j1 + 1, rows):
                je = min(j1, jb + rows - 1)
                jj = np.arange(jb, je + 1)
                ys = s0 + (jj + 0.5) * cell
                hit = intersects_xy(g, np.tile(xs, jj.size), np.repeat(ys, xs.size))
                if hit.any():
                    dw[(np.repeat(jj, xs.size) * nx + np.tile(ii, jj.size))[hit]] = True
        deepwet = dw.tobytes()
        if verbose:
            print('      %d of %d wet cells are %g ft or better' % (int(dw.sum()), nwet, min_ft),
                  flush=True)
    # The search below reads one cell at a time, where bytes beats a numpy array on scalar
    # indexing. Same bits, cheaper reads.
    wet = wet.tobytes()
    lat = (s0 + n0) / 2.0
    step = ((110540 * cell) + (111320 * math.cos(math.radians(lat)) * cell)) / 2.0
    NB = ((1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0),
          (1, 1, SQ2), (1, -1, SQ2), (-1, 1, SQ2), (-1, -1, SQ2))
    # ONE SEARCH, NOT TWO FLOODS. This was a breadth-first flood over the wet cells and a second
    # one over the cells at or past the floor, with the caller preferring whichever reached the
    # landing. Breadth-first counts CELLS, so a diagonal cost the same as a side -- 26 m for 36 --
    # and the field it left could only answer "how many cells", never "how deep". Dijkstra over
    # the same neighbours costs each step in METRES and can carry the depth in the same number,
    # so one field answers both and the second flood, the preference, and the fallback all go.
    shoal = 0.0 if deepwet is None else float(shoal_cost)
    INF = float('inf')
    cost = [INF] * (nx * ny)
    prev = [-1] * (nx * ny)
    q = []
    for x, y in line_pts:
        i = int((x - w0) / cell); j = int((y - s0) / cell)
        if not (0 <= i < nx and 0 <= j < ny):
            continue
        k = j * nx + i
        if wet[k] and cost[k] > 0.0:
            cost[k] = 0.0
            q.append((0.0, k))
    heapq.heapify(q)
    while q:
        d, u = heapq.heappop(q)
        if d > cost[u]:
            continue
        ui = u % nx; uj = u // nx
        for di, dj, w in NB:
            a = ui + di; b = uj + dj
            if not (0 <= a < nx and 0 <= b < ny):
                continue
            v = b * nx + a
            if not wet[v]:
                continue
            m = w * step
            c = d + m + (0.0 if deepwet is None or deepwet[v] else m * shoal)
            if c < cost[v]:
                cost[v] = c
                prev[v] = u
                heapq.heappush(q, (c, v))
    return cost, prev, deepwet, nx, ny, w0, s0, step, nwet


def refine(polys, depths, route, lo, la, cell=CELL_DEG, min_ft=0.0, shoal_cost=0.0, quarter=4):
    """Run the same search again, down the corridor the coarse one found, at a cell the channel fits in.

    THE CELL IS WIDER THAN THE CHANNEL, WHICH IS THE WHOLE PROBLEM. CELL_DEG is 0.00025 deg, about
    25.4 m here, and the canal at Rimini is roughly 34 m across. The deep water inside it is
    narrower than that again. At one cell per channel the search can choose the canal but it cannot
    choose a SIDE of the canal, so it cuts the corner at the mouth and clips the flat on the way.

    Ryan, 2026-09-21, looking at the line the coarse pass produced: *"the line that is populating
    now... is not the pink line... it still steers to shallow at the start and end of the canal"*.
    The pink line was the same objective computed at 6 m. Sampled at 5 m, launch to river: the
    coarse route carries 325 m under 6 ft in three pieces -- 258 m leaving the ramp, 30 m at
    station 1,100, and 25 m of 4-5 ft on the last corner before the river. At a quarter of the cell
    only the first survives, and that one is the flat Pack's Landing is built on, which no route of
    any length can avoid.

    A QUARTER, AND THE CANAL'S WIDTH IS WHY. 25.4 m goes to 6.4 m, so a 34 m canal is five cells
    across instead of one and the channel inside it can be resolved at all. It is not a tuning
    knob; it is the first power of two at which the water this is routing through has an inside.

    AND ONLY DOWN THE CORRIDOR, so it stays cheap. Rasterising a whole river at 6 m is eighteen
    times the coarse pass over ground that is mostly dry. The box here is the coarse route's own
    bounds plus four coarse cells, which for Pack's Landing is a few tens of thousands of cells --
    the run does not measurably change length. The coarse pass stays exactly as it was and still
    decides WHICH water; this decides where in it.

    The seed is the coarse route's channel end, so the refined line arrives at the same junction
    and the station already measured against it still means what it said.
    """
    if not route or len(route) < 2:
        return route
    fine = cell / float(quarter)
    xs = [p[0] for p in route]; ys = [p[1] for p in route]
    pad = cell * 4
    bbox = (min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)
    cost, prev, deep, nx, ny, w0, s0, step, nwet = walk(
        polys, [route[0]], bbox, cell=fine, depths=depths, min_ft=min_ft,
        shoal_cost=shoal_cost, verbose=False)
    INF = float('inf')
    i = int((lo - w0) / fine); j = int((la - s0) / fine)
    best, bij = None, None
    # The same outward ring the coarse pass uses for a landing on the bank, in the same metres --
    # seven coarse cells is 178 m, so at a quarter of the cell that is 28 rings and not 7.
    for r in range(0, 7 * quarter + 1):
        for a in range(i - r, i + r + 1):
            for b in range(j - r, j + r + 1):
                if 0 <= a < nx and 0 <= b < ny and cost[b * nx + a] < INF:
                    d = cost[b * nx + a]
                    if best is None or d < best:
                        best, bij = d, (a, b)
        if best is not None:
            break
    if best is None:
        return route            # nothing reachable at this scale; the coarse line is still a route
    out = trace(prev, nx, ny, w0, s0, fine, bij[0], bij[1])
    return out if len(out) >= 2 else route


def polyline_m(pts):
    """Length of a lon/lat line in metres, the same arithmetic the rest of this file uses."""
    total = 0.0
    for k in range(len(pts) - 1):
        (x0, y0), (x1, y1) = pts[k], pts[k + 1]
        cos = math.cos(math.radians((y0 + y1) / 2.0))
        total += math.hypot((x1 - x0) * 111320 * cos, (y1 - y0) * 110540)
    return total


def shoal_m(pts, deep_polys, probe=5.0):
    """How many metres of a line are NOT in water at or past the floor.

    AGAINST THE POLYGONS, NOT THE RASTER, and that is the whole point. This used to sample the
    coarse deep mask -- 25.4 m cells -- which for a line refined at 6.4 m reported 400 m on a
    route that measures 215 m against the charted bands themselves. A cell is marked shallow if
    any part of it is, so a line that correctly hugs the deep side of the channel runs through
    coarse cells flagged for water it never enters. The answer now does not depend on the grid
    the route happened to be found on.
    """
    inside = _index(deep_polys)
    if inside is None or len(pts) < 2:
        return 0.0
    try:
        from build_river_centrelines import to_albers
    except Exception:
        return 0.0
    xy = [to_albers(lon, lat) for lon, lat in pts]
    bad = 0.0
    for k in range(len(xy) - 1):
        (x0, y0), (x1, y1) = xy[k], xy[k + 1]
        seg = math.hypot(x1 - x0, y1 - y0)
        n = max(1, int(seg / probe) + 1)
        for q in range(n):
            f = (q + 0.5) / n
            if not inside(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f):
                bad += seg / n
    return bad


def trace(prev, nx, ny, w0, s0, cell, i, j):
    """The route the search already measured, read back out of the field.

    `walk()` costs its way outward from the channel and keeps, for every wet cell, the cell it
    was reached from. THE PATH WAS ALWAYS THERE AND WAS THROWN AWAY: the number that reaches
    launches.json -- Pack's Landing, 1,801 m by water against 2,367 straight -- was that field
    read at the landing's cell and nothing else.

    Ryan, 2026-09-21, on a plan that had just drawn a straight line from the ramp across two
    kilometres of swamp: *"right now it is still a transit all the way from the ramp till the
    river"*, and *"i should be able to fish the railroad tracks from packs all the way through
    the canal and up the river which is what i actually do"*. The app could not draw the route
    because nothing wrote one down.

    THIS USED TO SEARCH AND NOW IT READS. On a breadth-first field the walk back was steepest
    descent -- look at eight neighbours, take the first whose distance is one less -- which is a
    shortest path by construction but has to pick among ties, and the tie went to whatever came
    first in the neighbour list rather than to the water. Dijkstra already recorded which cell
    each one came from, so there is nothing to choose and nothing to get wrong; the route is the
    route that was costed. It also cannot dead-end, so the "no downhill neighbour" guard is gone
    with the search that needed it.

    NOT THE MAR GRAPH, deliberately. Marion's routing graph has the canal's two ends in its main
    component and no through-channel between them, so a shortest path from the ramp to the
    canal's south end comes back 14,712 m around the lake against 1,801 m down the canal. The
    field is over the charted water at 26 m cells and does not have that hole in it.
    """
    out = []
    u = j * nx + i
    if u < 0 or u >= nx * ny:
        return out
    while u != -1:
        out.append([round(w0 + (u % nx + 0.5) * cell, 6), round(s0 + (u // nx + 0.5) * cell, 6)])
        u = prev[u]
    out.reverse()          # channel first, landing last, the direction a boat leaves in
    return out

def boundary_rings(registry, slug):
    """Every ring of a water's registry boundary, whatever shape the file is written in."""
    p = os.path.join(registry, 'boundaries', slug + '.geojson')
    if not os.path.isfile(p):
        return []
    gj = load_json(p)
    feats = gj.get('features') if isinstance(gj, dict) and gj.get('features') else [gj]
    out = []
    for f in feats:
        g = (f or {}).get('geometry') or f
        if not g:
            continue
        if g.get('type') == 'Polygon':
            out.append(g['coordinates'])
        elif g.get('type') == 'MultiPolygon':
            out.extend(g['coordinates'])
    return out


# One water's charted depth areas, projected and prepared. See recentre().
_INSIDE = {}


def _index(polys):
    """A prepared "is this point in that water" test, built once per set of polygons.

    Ryan's 35 landings on the Congaree each want the same question asked of the same 40,597
    polygons, and the first shape of this rebuilt the projected copy and the R-tree inside every
    call: a two minute run became ten. It is memoised on the identity of the list it was handed.

    TWO SETS, NOT ONE, AND THAT IS THE WHOLE REASON THIS IS A FUNCTION. The fairing has to ask
    about the water (may the line go here at all) and about the water at or past his floor (does
    moving the line here make it shallower). Those are the same question over different polygons,
    so they are one builder used twice rather than two copies of it, and the cache holds both --
    it used to clear itself on every new list, which with two lists would have thrown one away
    and rebuilt it on the next call, forever.
    """
    if polys is None or not len(polys):
        return None
    key = id(polys)
    hit = _INSIDE.get(key)
    if hit is not None:
        return hit
    try:
        from shapely.ops import transform as shapely_transform
        from shapely.prepared import prep
        from shapely.strtree import STRtree
        from shapely.geometry import Point
        from build_river_centrelines import to_albers
    except Exception:
        return None
    gm = []
    for g in polys:
        try:
            q = shapely_transform(lambda a, b: to_albers(a, b), g)
        except Exception:
            continue
        if not q.is_empty:
            gm.append(q)
    if not gm:
        return None
    tree = STRtree(gm)
    ready = [prep(q) for q in gm]

    def inside(x, y, _t=tree, _r=ready, _P=Point):
        p = _P(x, y)
        for k in _t.query(p):
            if _r[k].covers(p):
                return True
        return False

    if len(_INSIDE) > 3:
        _INSIDE.clear()
    _INSIDE[key] = inside
    return inside

def recentre(route, polys, deep=None, step=50.0, probe=5.0, reach=3000.0, passes=6):
    """Make the traced route a line a boat would actually steer, and keep it in the water.

    Ryan, 2026-09-21: *"your 72 point route is garbage... it just needs to follow the middle of the
    canal and it does not... what are the purposes of these sharp turns... it is turning away from
    deeper water to go to shallow water"*.

    WHAT trace() GIVES AND WHY IT LOOKS LIKE THAT. Steepest descent on a BFS flood field is a
    shortest path and nothing else. Its points land on the 0.00025 deg cell -- 26 m -- and where
    several neighbours share a distance the tie goes to whichever came first in the neighbour list,
    so the sharp turns are the neighbour ORDER and not the water. The flood also knows how far a
    cell is from the channel and nothing at all about how deep it is, so at a bend it takes the
    inside, which in a canal is the shallow side. What it measures is right. What it draws is a
    staircase.

    AND THE RIVER'S OWN MACHINERY IS THE WRONG TOOL HERE, WHICH COST A RUN TO FIND OUT. The first
    attempt put this route through centre_on_water() and smooth_on_water(), which put the Congaree's
    centreline right. On the Pack's Landing canal it made it worse: 69 points and 3,666 m DRAWN for
    an 1,826 m route -- the line doubling back on itself -- p90 42 deg, 39% of points reversing.
    That machinery measures a cross-section on each station's normal, and the canal is 34 m wide
    with stations 50 m apart, so the stations are further apart than the channel is wide and the
    normals are meaningless. It is built for a 165 m river.

    SO THE CANAL IS SIMPLIFIED, NOT SOLVED. A ditch has no interesting middle: anywhere down it is
    down it. The staircase is already inside the water by construction, so the least line that
    stays within the water is the answer, and Douglas-Peucker finds exactly that -- the fewest
    vertices whose line is never further than the tolerance from the original.

    THE TOLERANCE IS THE WATER'S, AND IT IS CHECKED RATHER THAN TRUSTED. Start at half the median
    half-width of the water along the route, and if the simplified line leaves the charted water
    anywhere, halve it and try again. The loop ends on a line that is measurably wet, so the
    tolerance is not a number that has to be right -- it is a number that gets tested.
    """
    if not route or len(route) < 3:
        return route
    try:
        from shapely.geometry import LineString, Point
        from shapely.ops import transform as shapely_transform
        from shapely.prepared import prep
        from shapely.strtree import STRtree
        from build_river_centrelines import to_albers, to_lonlat
    except Exception as exc:
        print('    route not faired (%s)' % exc, flush=True)
        return route
    try:
        # BUILT ONCE PER WATER, NOT ONCE PER LANDING. The first shape of this projected every
        # depth-area polygon and rebuilt the index inside the call, so congaree_river's 35 landings
        # paid for 35 copies of the same 3,000-polygon tree and the step went from two minutes to
        # over ten. `polys` is the same list object for every landing on a water.
        inside = _index(polys)
        indeep = _index(deep)
        if inside is None:
            return route

        xy = [to_albers(lon, lat) for lon, lat in route]
        line = LineString(xy)
        if line.length <= 0:
            return route

        # ── FIRST PUT IT DOWN THE MIDDLE, AT THE STAIRCASE'S OWN SPACING ────────────────────
        #
        # Simplifying the staircase where it stands does not work and the measurement says so: a
        # 26 m tread deviates up to half a cell from the middle, so a tolerance big enough to take
        # the steps out is big enough to put a 34 m canal's line on the bank, and the wet test
        # then halves it away to nothing. Run on 2026-09-21 it returned 73 points and 2,455 m for
        # what had been 72 points and 2,412 m -- the same staircase, faired by nothing.
        #
        # THE FIRST PROBE WAS ALSO MEASURING THE WRONG THING. It walked out along the axes, so in
        # a canal running north-west it found the narrow diagonal and called that the width.
        # Sideways means perpendicular to where the boat is GOING, and the heading comes from a
        # five-point window rather than the neighbouring points, because the neighbouring points
        # are the tread and its normal is the tread's normal.
        #
        # The staircase's own 26 m spacing is already finer than the 34 m canal, so each point is
        # simply moved to the midpoint of its own crossing -- no resampling, no stations, none of
        # the river machinery that needs a channel wider than its station spacing.
        def _cross(k):
            a = xy[max(0, k - 2)]
            b = xy[min(len(xy) - 1, k + 2)]
            dx, dy = b[0] - a[0], b[1] - a[1]
            h = math.hypot(dx, dy)
            return (-dy / h, dx / h) if h else None

        # THE WATER'S OWN SCALE, measured across the way the boat is going. The first probe walked
        # the axes and found the narrow diagonal of a north-west canal and called it the width.
        half = []
        for k in range(0, len(xy), max(1, len(xy) // 40)):
            x, y = xy[k]
            nv = _cross(k)
            if nv is None or not inside(x, y):
                continue
            px, py = nv
            dl = dr = 0.0
            while dl < 400.0 and inside(x + px * (dl + probe), y + py * (dl + probe)):
                dl += probe
            while dr < 400.0 and inside(x - px * (dr + probe), y - py * (dr + probe)):
                dr += probe
            half.append((dl + dr) / 2.0)
        half.sort()
        span_m = half[len(half) // 2] * 2 if half else probe

        # ── FAIRED BY AVERAGING THE POINTS, NOT BY MOVING EACH ONE TO A MIDPOINT ────────────────
        #
        # Three attempts put each point on the middle of its own crossing -- centre_on_water() at
        # 50 m stations, then the same idea at the staircase's own 26 m spacing. Both made the line
        # WORSE, and for one reason: a midpoint is an independent estimate, its error is the width
        # of the channel, and applying independent errors to points 26 m apart is how you build a
        # saw-tooth rather than remove one. Measured on this route: 3,666 m drawn for an 1,826 m
        # route the first way, 3,038 m the second, against a staircase's 2,455 m.
        #
        # A moving average has no such error. It cannot move a point further than its neighbours
        # already are, it needs no normal and no cross-section, and in a ditch the local mean of
        # the water's own shortest path IS down the middle of it. The window is one channel width,
        # for the same reason it is everywhere else here: a wiggle shorter than the water is wide
        # is not the water's shape. And every moved point is checked -- one that lands dry keeps
        # where it was, so fairing can never beach the line.
        step_pts = max(1, int(round(span_m / max(1.0, line.length / max(1, len(xy) - 1)) / 2.0)))
        cur = list(xy)
        for _ in range(8):
            nxt = []
            moved = 0
            for k in range(len(cur)):
                lo2, hi2 = max(0, k - step_pts), min(len(cur) - 1, k + step_pts)
                m = hi2 - lo2 + 1
                ax = sum(q[0] for q in cur[lo2:hi2 + 1]) / m
                ay = sum(q[1] for q in cur[lo2:hi2 + 1]) / m
                if (k == 0 or k == len(cur) - 1) or not inside(ax, ay):
                    nxt.append(cur[k])
                else:
                    if math.dist((ax, ay), cur[k]) > 0.5:
                        moved += 1
                    nxt.append((ax, ay))
            cur = nxt
            if not moved:
                break
        if len(cur) >= 2:
            line = LineString(cur)
        tol = (span_m / 4.0) if span_m else probe
        tol = max(probe, tol)

        # WET IS THE TEST, not the tolerance. A sample every probe metres along the candidate, and
        # a candidate that leaves the water is not a course however tidy it looks.
        def shallow(cand):
            """Metres of `cand` that are not in the water, or None if it leaves the water at all.

            One walk answers both questions because they are asked at the same points. Before
            the routing cared about depth this only had to say wet or dry; now a simplification
            that stays wet can still cut a corner off the channel and onto the flat, which is
            exactly the move the cost function just paid metres to avoid.
            """
            n = max(2, int(cand.length / probe))
            bad = 0.0
            for k in range(n + 1):
                p = cand.interpolate(cand.length * k / n)
                if not inside(p.x, p.y):
                    return None
                if indeep is not None and not indeep(p.x, p.y):
                    bad += cand.length / n
            return bad

        # THE CENTRED LINE IS THE FLOOR, NOT THE STAIRCASE. The first shape of this returned the
        # ORIGINAL route when no tolerance survived the wet test, which threw the centring away
        # with the simplification -- and on the Pack's Landing canal no tolerance did survive, so
        # the run came back 73 points and 2,455 m, byte for byte the staircase it started from,
        # with nothing in the log to say so. A fairing that cannot simplify has still centred.
        base = shallow(LineString(xy))
        best = line
        while tol >= probe:
            cand = line.simplify(tol)
            if len(cand.coords) >= 2:
                bad = shallow(cand)
                # Never wetter than the water and never shallower than the line it came from.
                # `probe` of slack because both are sampled at that spacing and an exact
                # comparison would reject a line that is the same line.
                if bad is not None and (base is None or bad <= base + probe):
                    best = cand
                    break
            tol /= 2.0
        return [[round(lon, 6), round(lat, 6)]
                for lon, lat in (to_lonlat(x, y) for x, y in best.coords)]
    except Exception as exc:
        print('    route not faired (%s)' % exc, flush=True)
        return route

def _nearest_comp(tree, polys, comp_of, lo, la):
    """The component id of the charted water nearest this landing, or None."""
    if tree is None or not comp_of:
        return None
    from shapely.geometry import Point as _Pt
    pt = _Pt(lo, la)
    best = None
    for i in tree.query(pt.buffer(0.004)):        # ~400 m, the bank plus slack
        d = polys[i].distance(pt)
        if best is None or d < best[0]:
            best = (d, i)
    return None if best is None else comp_of.get(best[1])


def _pool_acres(tree, polys, comp_of, pool_ac, lo, la):
    c = _nearest_comp(tree, polys, comp_of, lo, la)
    return None if c is None else pool_ac.get(c)


def _on_main(tree, polys, comp_of, seed_comp, lo, la):
    """True/False/None -- None means it could not be determined, which is not False."""
    if seed_comp is None:
        return None
    c = _nearest_comp(tree, polys, comp_of, lo, la)
    return None if c is None else (c == seed_comp)


def reach_for(slug, args, points):
    cl_p = os.path.join(args.chartpack, slug, 'centreline.geojson')
    pts, st, kind = [], [], None
    if os.path.isfile(cl_p):
        feat = (load_json(cl_p).get('features') or [None])[0]
        if feat:
            pts = feat['geometry']['coordinates']
            st = (feat.get('properties') or {}).get('station_m') or []
            kind = 'centreline'
    if not pts:
        # A LAKE HAS NO LINE. Its own boundary is what says where it is, and the seed is the
        # charted water inside it -- so the walk starts from the whole lake rather than from a
        # channel down the middle of it, and a landing's distance is to the nearest water it
        # can actually reach.
        rings = boundary_rings(args.registry, slug)
        if not rings:
            return None, 'no centreline and no boundary'
        # boundary_rings() returns one RING LIST per polygon -- [outer, hole, hole...] -- so the
        # flatten is two deep, not one. It was one, and min() got handed a ring.
        pts = [tuple(q) for poly in rings for ring in poly for q in ring]
        kind = 'boundary'
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    bbox = (min(xs) - MARGIN_DEG, min(ys) - MARGIN_DEG, max(xs) + MARGIN_DEG, max(ys) + MARGIN_DEG)
    polys, nread, depths = water_polys(args.extract, args.registry, slug, bbox,
                                       with_depth=True)
    if not polys:
        return None, 'no charted water on its tiles'
    if kind == 'boundary':
        # Seeding on the RING alone would start the walk at the shoreline and make the middle of
        # the lake the far end of it. Seed every water cell inside the boundary instead: on a
        # lake, "how far to the water" is how far to the nearest part of it.
        from shapely.geometry import Polygon as _P
        from shapely.ops import unary_union as _uu
        try:
            box_polys = [_P(r[0], r[1:]) for r in boundary_rings(args.registry, slug)
                         if r and len(r[0]) >= 4]
            box_polys = [g if g.is_valid else g.buffer(0) for g in box_polys]
            own = _uu([g for g in box_polys if not g.is_empty])
            seeds = []
            for g in polys:
                if g.intersects(own):
                    c = g.intersection(own)
                    for part in (c.geoms if hasattr(c, 'geoms') else [c]):
                        if getattr(part, 'exterior', None) is not None:
                            seeds.extend(list(part.exterior.coords))
            if seeds:
                pts = seeds
        except Exception:
            pass                 # fall back to the ring, which is still an answer
    floor_ft = getattr(args, 'min_depth_ft', 0.0)
    cost, prev, deep, nx, ny, w0, s0, step, nwet = walk(polys, pts, bbox, depths=depths,
                                                       min_ft=floor_ft,
                                                       shoal_cost=getattr(args, 'shoal_cost', 0.0))
    # The same polygons the cost used, handed to the fairing so it cannot straighten the line
    # back out of the water the routing just paid to stay in.
    deep_polys = ([g for g, ft in zip(polys, depths or []) if ft and ft >= floor_ft]
                  if (depths and floor_ft > 0) else None)
    # And the water his motor runs in, to MEASURE each drawn route against -- see MOTOR_DRAFT_FT.
    motor_polys = ([g for g, ft in zip(polys, depths) if ft and ft >= MOTOR_DRAFT_FT]
                   if depths else None)
    # ── WHICH PIECE OF WATER IS THIS LANDING ON ────────────────────────────────────────────
    #
    # `water_m` does NOT mean 'how far to the lake'. On a lake the seed is EVERY water cell
    # inside the boundary (see the kind == 'boundary' branch above), so a landing standing on a
    # pool that happens to sit inside that boundary is seeded from underneath and scores 0.
    # Lake Marion's `Borrow Pit` reads water_m 0 while standing on a 208-acre pool it cannot
    # leave; Lake Monticello's sub-impoundment ramp reads 0 for a 285-acre Recreational Lake
    # behind a dike with a road on it. For a single-bodied lake the two sentences coincide, and
    # nothing here was ever wrong -- it answers a narrower question than its name suggests.
    #
    # THE RASTER CANNOT SETTLE THIS AND A FINER ONE IS THE WRONG ANSWER. CELL_DEG is ~26 m; a
    # flood at 25 m calls Monticello 100.0%% connected and at 6 m calls it 36.9%%. Two depth-area
    # polygons either side of a dike share no edge at ANY resolution, so adjacency answers it
    # exactly, once, off the polygons this function already loaded. Ryan settled the ground
    # truth by hand: the Borrow Pit, Wyboo Swamp and the Monticello Recreational Lake are all
    # dikes, and C. Alex Harvin III -- which comes back on the main body -- is passable.
    #
    # NOTHING IS FILTERED. The landing keeps its row, its water_m and its route; it gains the
    # size of the water it is actually on. Annotate, never filter -- the same rule as the reach
    # distance itself, one level down.
    comp_of, pool_ac, seed_comp = {}, {}, None
    if len(polys) <= getattr(args, 'max_component_polys', MAX_COMPONENT_POLYS):
        try:
            from water_polygons import components as _components
            _comps = _components(polys)
            _k = math.cos(math.radians((bbox[1] + bbox[3]) / 2.0)) or 1e-9
            for _ci, _ix in enumerate(_comps):
                pool_ac[_ci] = round(sum(polys[_i].area for _i in _ix)
                                     * (111320.0 ** 2) * _k / 4046.86, 1)
                for _i in _ix:
                    comp_of[_i] = _ci
            # THE SEED'S COMPONENT IS 'MAIN', not the largest -- on a river the seed is the
            # centreline and the biggest polygon set in a 5.5 km bbox may be the next water over.
            from shapely.geometry import Point as _Pt
            from shapely.strtree import STRtree as _T
            _tree = _T(polys)
            _tally = {}
            _step = max(1, len(pts) // 400)
            for _q in pts[::_step]:
                _pt = _Pt(_q[0], _q[1])
                _best = None
                for _i in _tree.query(_pt.buffer(0.002)):
                    _d = polys[_i].distance(_pt)
                    if _best is None or _d < _best[0]:
                        _best = (_d, _i)
                if _best is not None:
                    _c = comp_of.get(_best[1])
                    _tally[_c] = _tally.get(_c, 0) + 1
            if _tally:
                seed_comp = max(_tally, key=_tally.get)
        except Exception as _exc:
            print('   !! component stamp skipped on %s (%s: %s) -- landings will carry no pool'
                  % (slug, type(_exc).__name__, _exc))
            comp_of, pool_ac, seed_comp = {}, {}, None
    else:
        # NAMED, NOT SWALLOWED. Over the cap the landings carry on_main_water null, and
        # js/data/launch-reach.js reads null as REACHABLE -- Ryan's call, 2026-09-22 -- so a
        # water that lands here loses the check rather than losing its launches.
        print('   .. %s has %d charted polygons, over the component cap -- no pool stamp'
              % (slug, len(polys)))

    import numpy as np
    _ctree = None
    if comp_of:
        from shapely.strtree import STRtree as _T2
        _ctree = _T2(polys)
    PX = np.fromiter((p[0] for p in pts), dtype=float, count=len(pts))
    PY = np.fromiter((p[1] for p in pts), dtype=float, count=len(pts))
    got = []
    for (la, lo), rec in points.items():
        if not (bbox[0] <= lo <= bbox[2] and bbox[1] <= la <= bbox[3]):
            continue
        i = int((lo - w0) / CELL_DEG); j = int((la - s0) / CELL_DEG)
        best = None
        bestij = None
        # A landing sits ON THE BANK, never in the water -- make_river_boundaries measured
        # 25 m, 10 m, 28 m on the Ocmulgee. Look outward a few cells for the water it serves,
        # and stop at the first ring that has any, so the nearest water wins.
        INF = float('inf')
        for r in range(0, 7):
            for a in range(i - r, i + r + 1):
                for b in range(j - r, j + r + 1):
                    if 0 <= a < nx and 0 <= b < ny and cost[b * nx + a] < INF:
                        d = cost[b * nx + a]
                        if best is None or d < best:
                            best, bestij = d, (a, b)
            if best is not None:
                break
        if best is None:
            continue
        # ONE SCAN, NOT TWO, AND IN METRES. This was a `min()` over every seed point for the
        # distance and a second `min()` over the same points for the station, and the second
        # ranked by SQUARED DEGREES -- which stretches longitude by 1/cos(lat) and can hand back
        # a different point than the one the distance came from. Same scan, same metric, so the
        # station reported is the station that distance was measured to.
        cos = math.cos(math.radians(la))
        dm = np.hypot((PX - lo) * (111320 * cos), (PY - la) * 110540)
        k = int(dm.argmin())
        straight = float(dm[k])
        # THE ROUTE IS THE MEASUREMENT NOW, NOT A SIDE EFFECT OF IT. `water_m` used to be the
        # flood's cell count times the cell size, which charged 26 m for a 36 m diagonal and
        # could not be reconciled with the line the app draws. It is the length of that line.
        raw = trace(prev, nx, ny, w0, s0, CELL_DEG, bestij[0], bestij[1]) if bestij else None
        raw = refine(polys, depths, raw, lo, la, cell=CELL_DEG, min_ft=floor_ft,
                     shoal_cost=getattr(args, 'shoal_cost', 0.0)) if raw else None
        route = recentre(raw, polys, deep=deep_polys) if raw else None
        got.append({'name': rec['name'] or None, 'lat': rec['lat'], 'lon': rec['lon'],
                    'access': rec.get('access') or None,
                    'listing': rec.get('listing') or None,
                    'water_m': int(round(polyline_m(raw))) if raw else None,
                    'straight_m': int(round(straight)),
                    # Where on the river it comes in. A lake has no stations, and saying 0
                    # would read as the top of something.
                    'station_m': (st[k] if (kind == 'centreline' and k < len(st)) else None),
                    # The water route the distance above was measured along, channel end first.
                    # Without it the app can only draw a straight line, and a straight line from
                    # Pack's Landing crosses two kilometres of swamp.
                    'route': route,
                    # HOW MUCH OF THE WAY OUT IS TOO SHALLOW FOR HIS MOTOR, IN METRES, measured on
                    # the line the app DRAWS. This used to be `shoal_m`, metres under the routing
                    # preference -- 6 ft -- which nothing read and which meant nothing on the water:
                    # a blackwater river four feet deep reads its whole length. Under his motor's
                    # foot is the number he can act on, and js/data/launch-reach.js shallowAt()
                    # puts it beside the distance. Null when the pack carries no readable band.
                    'under_motor_m': (None if not motor_polys or not route
                                      else int(round(shoal_m(route, motor_polys)))),
                    # WHICH BODY OF WATER IT IS STANDING ON, and how big that body is. Null
                    # when the pool could not be determined -- a water over the component cap,
                    # or no polygon near the landing -- because unknown and 'on the main lake'
                    # must not look the same.
                    'pool_acres': _pool_acres(_ctree, polys, comp_of, pool_ac, lo, la),
                    'on_main_water': _on_main(_ctree, polys, comp_of, seed_comp, lo, la),
                    'filed': sorted(rec['filed']), 'src': sorted(rec['src'])})
    got.sort(key=lambda r: (r['water_m'] is None, r['water_m']))
    return {'slug': slug, 'cell_m': round(step, 1), 'water_cells': nwet, 'seed': kind,
            'polygons': len(polys), 'features_read': nread, 'landings': got}, None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--extract', required=True)
    ap.add_argument('--chartpack', required=True)
    ap.add_argument('--only', help='one slug, or a comma list. Default: every pack with a '
                                   'centreline (rivers). Name a lake explicitly and it seeds '
                                   'from its own charted water instead.')
    ap.add_argument('--all', action='store_true',
                    help='every water the APP OFFERS -- registry/lake_index.json -- that has a '
                         'pack, seeding rivers from their centreline and lakes from their own '
                         'charted water. The same gate upload_garmin_to_r2.py ships by, because '
                         'measuring water the app never shows is work nobody reads.')
    ap.add_argument('--out', help='default registry/_ramp_reach.json')
    # ── 2026-09-24: HIS DRAFT ARRIVED, AND STEERING BY IT WAS WORSE FOR HIS DRAFT ─────────────
    #
    # The note below ended "6.0 stays until Ryan says what his boat actually needs". He said it
    # -- the motor runs at about 12 inches, the pedal drive 18, the hull 6; see MOTOR_DRAFT_FT --
    # and the obvious change was to route at his motor's foot instead of the canal's six. It was
    # MEASURED before it was made, every landing on seven waters routed three ways and every route
    # read back against the same bands, and the obvious change loses on the thing it is for:
    #
    #                               metres of route under 1 ft -- where his motor cannot run
    #     water, landings           routed at 6 ft    routed at 1 ft    depth ignored
    #     congaree  Pack's Landing          10               126              --
    #     congaree  Low Falls                0                 8              --
    #     wateree_river, 6                 295               984             1,193
    #     black_river, 13                3,838             6,174             9,994
    #     little_pee_dee_river, 19      66,624            74,057            80,995
    #     wateree_lake, 15               1,944             1,783             2,249
    #     edisto 10, lynches 4          81 / 0            81 / 0            82 / 0
    #     the 67 swept, per landing     1 ft routing puts LESS under his motor on 4, MORE on 11,
    #                                   the same on 52 -- and 10,297 m more in total
    #
    # WHY. Routed at one foot the search is indifferent between two feet and twenty, so it takes
    # the shortest water that clears a foot -- and the shortest water hugs the margins, where the
    # chart's small shallow polygons are: the bars, the stump flats, the fringe. Routed at six it
    # keeps to the channel, and the channel is where the shallow patches are NOT. Preferring deep
    # water is how the route keeps his motor in the water; his draft is how the result is judged.
    # That is the relative thing he described -- *"it kept routing me in 1-2ft when there was 6ft
    # or deeper water right next to it"* -- and the six is what does it: on every water measured
    # but Lake Wateree it leaves less under his motor in total. Four landings of the 67 do better
    # at a foot and eleven do worse; a rule that has to pick one steering for every landing picks
    # the one that loses less.
    #
    # So the six stays, as a STEERING PREFERENCE and not as his boat, and what reaches him is the
    # draft he gave: `under_motor_m`, the metres of the drawn route under his motor's foot. The
    # old `shoal_m` -- metres under the six -- is no longer written; it read a blackwater river's
    # whole length and nothing ever showed it.
    #
    # SIX IS THE CANAL'S NUMBER, NOT HIS BOAT'S, AND IT IS THE DEFAULT ON 354 PACKS.
    #
    # Ryan, 2026-09-23, reading this file's own words back: *"There is no 6ft floor. I gave you
    # that number only for the canal between packs landing and the congaree. It kept routing me
    # in 1-2ft when there was 6ft or deeper water right next to it."*
    #
    # So the line below -- "it is his boat and his number" -- was a description of ONE canal
    # promoted to a standing preference for every water, and then attributed to him. What he
    # described is RELATIVE: the router took 1-2 ft while 6 ft sat beside it. An absolute floor
    # happens to fix that case and is the wrong shape for the complaint.
    #
    # MEASURED 2026-09-23 across all 354 packs, 2,323 landings:
    #
    #     shoal_m == 0, the floor never binds          1,577   68%
    #     over 500 m under the floor                     125    5.4%
    #     worst: Dunham Bluff, little_pee_dee_river   25,612 m
    #
    # At one end it does nothing; at the other the whole route is under it and `shoal_m` degrades
    # into route length. A blackwater river that is 4 ft for twenty miles is not a routing defect.
    # It discriminates only in the middle band, which is where the canal sits.
    #
    # (2026-09-23: "6.0 stays until Ryan says what his boat actually needs". He did, and it was
    # measured -- see the 2026-09-24 note at the top of this block for why it still stays.)
    #
    # The first two attempts at this could not honour it. A hard floor cannot leave Pack's
    # Landing at all -- the ramp sits on a 5 ft flat -- so it went round: 6,569 m against 1,826. Preferring a separate deep flood and
    # falling back when it does not arrive is the same failure said politely: it never arrived, so
    # every route on this river was the shortest-water one and a flag quietly said so.
    #
    # walk() now costs shallow metres ahead of all distance, so the floor is a preference the
    # search can always satisfy as well as the water allows instead of a gate it can fail. On this
    # river that is 455 m under 6 ft down to 331 m, in one stretch instead of five, and into the
    # Congaree through the 13 ft mouth rather than across the flat beside it.
    ap.add_argument('--min-depth-ft', type=float, default=6.0,
                    help='the depth the route STEERS toward where the water has it. 6 came off '
                         "ONE canal -- Pack's Landing to the Congaree, 2026-09-21 -- and is not "
                         'his boat: his motor runs at about 1 ft (MOTOR_DRAFT_FT), and routing at '
                         'that foot was measured on 2026-09-24 to put MORE of the route under it, '
                         'not less. It is a cost, not a gate: where no route can honour it the '
                         'shortest shallow crossing is taken. under_motor_m on each landing is '
                         'what the route leaves under his motor. 0 ignores depth entirely.')
    # TEN, AND THE SWEEP IS WHY IT IS NOT A TUNED NUMBER -- ON THIS ROUTE. Measured on
    # congaree_river, Pack's Landing to the Congaree, 2026-09-21, every value run end to end.
    # ONE LANDING ON ONE CANAL: the plateau is real where it was measured and has never been
    # swept anywhere else, which is the same caveat the floor above now carries.
    #
    #     0    2,455 m    770 m under 6 ft   73 pts   -- depth ignored; this is what shipped
    #     2    2,469 m    149 m              7 pts
    #     5    2,469 m    149 m              7 pts
    #    10    2,469 m    149 m              7 pts
    #    25    2,469 m    149 m              7 pts
    #   100    7,524 m     15 m            260 pts   -- round the lake, to save 240 m of 5 ft water
    #
    # There are two answers, not a curve: the canal, and the detour. Everything from 2 to 25 is
    # the same line to the metre, so the rate is not being fitted to anything -- it is being put
    # in the middle of a plateau an order of magnitude wide. Fourteen more metres of water buys
    # five sixths of the shallow back. Above the plateau it buys 5 km of paddling instead.
    ap.add_argument('--shoal-cost', type=float, default=10.0,
                    help='how many extra metres of route one metre of water under the floor is '
                         'worth avoiding. The exchange rate has to be said out loud: treat a '
                         'shallow metre as infinitely bad and the search pays any distance to '
                         'dodge it -- from Pack\'s Landing that is 7,524 m round the lake against '
                         '2,438 m down the canal, to save 240 m of 5 ft water a kayak does not '
                         'care about. 0 ignores depth and gives the shortest water.')
    ap.add_argument('--max-component-polys', type=int, default=MAX_COMPONENT_POLYS,
                    help='skip the pool stamp on a water with more charted polygons than this. '
                         'The stamp is what says a landing is on water it cannot leave, so a '
                         'water over the cap keeps every landing and loses the check -- null '
                         'reads as reachable in the app, not as blocked. Default %d, which '
                         'clears the largest water the app offers (Norris, 82,745). See the '
                         'timings above the constant: cost tracks how many depth bands '
                         'interlock, not how many there are, so this is a memory guard for '
                         '--jobs, not a time one.' % MAX_COMPONENT_POLYS)
    ap.add_argument('--go', action='store_true', help='write; without it nothing is touched')
    ap.add_argument('--jobs', type=int, default=0,
                    help='waters measured at once. Default: one per core, capped at the number '
                         'of waters. 1 runs in this process, which is what to use when a run '
                         'misbehaves and you want the traceback where you can see it.')
    a = ap.parse_args()

    try:
        import shapely  # noqa: F401
    except ImportError:
        print('shapely is required: the walk needs real polygon geometry, and a bbox '
              'approximation would put every landing on every river')
        return 2

    points = access_points(a.registry)
    print('access points on file: %d' % len(points))
    if a.only:
        slugs = [s.strip() for s in a.only.split(',') if s.strip()]
    elif a.all:
        # THE SAME GATE THE UPLOADER SHIPS BY. lake_index.json is the file the app reads, so a
        # slug that is not in it is a pack nobody can select. A pack directory must exist too:
        # reach_for() needs the pack's centreline or the water's boundary, and a slug with
        # neither is reported as skipped rather than silently dropped.
        idx = load_json(os.path.join(a.registry, 'lake_index.json'))
        slugs = sorted(s for s in idx
                       if os.path.isdir(os.path.join(a.chartpack, s))
                       and (os.path.isfile(os.path.join(a.chartpack, s, 'centreline.geojson'))
                            or os.path.isfile(os.path.join(a.registry, 'boundaries', s + '.geojson'))))
        print('the app offers %d waters; %d of them have a pack and something to seed from'
              % (len(idx), len(slugs)))
    else:
        import glob
        slugs = sorted(os.path.basename(os.path.dirname(p)) for p in
                       glob.glob(os.path.join(a.chartpack, '*', 'centreline.geojson')))
    print('waters to measure: %d' % len(slugs))

    # EVERY WATER IS ITS OWN QUESTION. reach_for() reads the registry and the extract and
    # returns an answer; it shares nothing with the next water and writes nothing. So the only
    # reason this ran one at a time was that it was written that way. The merge below is still
    # one writer in one process, which is the part that has to stay serial.
    jobs = a.jobs if a.jobs > 0 else min(len(slugs), os.cpu_count() or 1)
    jobs = max(1, min(jobs, len(slugs)))
    print('measuring %d at a time' % jobs)

    done_n = [0]

    def report(slug, res, why):
        done_n[0] += 1
        # THE COUNT IS THE POINT. A 355-water run reported in the order ASKED FOR printed
        # nothing at all for the first thirteen minutes, because the first slug alphabetically
        # was submitted near-last under biggest-first and every other finished answer sat behind
        # its future. Fourteen workers were pegged the whole time and there was no way to see
        # it. Printed as they finish now, with the count, so a long run says where it is.
        head = '%3d/%d' % (done_n[0], len(slugs))
        if res is None:
            print('   %s %-30s -- %s' % (head, slug, why))
            return
        gained = [r for r in res['landings'] if slug not in r['filed']]
        print('   %s %-30s %-10s %6d water cells, %3d landings reachable, %3d filed elsewhere'
              % (head, slug, res['seed'], res['water_cells'], len(res['landings']), len(gained)))
        for r in gained[:6]:
            print('        %7d m by water (%6d straight, %5s m under his motor)  %-32s '
                  'filed %s'
                  % (r['water_m'], r['straight_m'],
                     '-' if r['under_motor_m'] is None else r['under_motor_m'],
                     (r['name'] or '(unnamed)')[:32], r['filed']))

    out, skipped = {}, {}
    if jobs == 1:
        pairs = ((slug, reach_for(slug, a, points)) for slug in slugs)
    else:
        from concurrent.futures import ProcessPoolExecutor
        ex = ProcessPoolExecutor(max_workers=jobs)
        # Biggest first: the tail of a pool is one straggler, and on this data the straggler is
        # always a big water. Submitted in size order, the big ones start while there are still
        # small ones left to fill the gaps behind them.
        def _size(s):
            p = os.path.join(a.chartpack, s, 'centreline.geojson')
            b = os.path.join(a.registry, 'boundaries', s + '.geojson')
            return os.path.getsize(p) if os.path.isfile(p) else (
                os.path.getsize(b) if os.path.isfile(b) else 0)
        order = sorted(slugs, key=_size, reverse=True)
        futs = {ex.submit(reach_for, slug, a, points): slug for slug in order}
        # Reported AS THEY FINISH. The record is sorted by slug where it is written, so the file
        # two runs produce is the same whatever order the pool happened to return in.
        from concurrent.futures import as_completed
        pairs = ((futs[f], f.result()) for f in as_completed(futs))
    try:
        for slug, (res, why) in pairs:
            report(slug, res, why)
            if res is None:
                skipped[slug] = why
            else:
                out[slug] = res
    finally:
        if jobs != 1:
            ex.shutdown()

    dest = a.out or os.path.join(a.registry, '_ramp_reach.json')
    # MERGE, NEVER REPLACE. A run is often `--only` a handful of waters -- the lakes one hour,
    # the rivers the next -- and writing the whole file from one batch would delete every water
    # the batch did not measure. (This comment used to say 57 rivers "is hours". It was written
    # before the raster was vectorised and before the pool, it was the number Ryan was quoted,
    # and it was wrong: measure the run, do not trust this line.) build_all_chartpacks
    # learned this the same way and says so out loud: "merging into existing report".
    waters, skips, carried = dict(out), dict(skipped), 0
    if os.path.isfile(dest):
        try:
            prev = load_json(dest)
            for slug, rec in (prev.get('waters') or {}).items():
                if slug not in waters:
                    waters[slug] = rec
                    carried += 1
            for slug, why in (prev.get('skipped') or {}).items():
                if slug not in waters and slug not in skips:
                    skips[slug] = why
        except Exception as e:
            print('!! %s is unreadable (%s) -- refusing to overwrite it with this run alone'
                  % (dest, e))
            return 2
    if carried:
        print('\nmerging into the existing index: %d water(s) carried forward untouched' % carried)
    # SORTED, BECAUSE THE POOL FINISHES IN WHATEVER ORDER IT FINISHES. The console prints as
    # answers land, which is what makes a long run readable; the file has to be the same file
    # every time or a diff between two runs is mostly noise about ordering.
    doc = {'_note': 'build_ramp_reach.py -- water distance from a landing to a water. ADDITIVE: '
                    'nothing here removes a landing from the water it is filed under.',
           'cell_m': round(CELL_DEG * 110540, 1),
           'waters': {k: waters[k] for k in sorted(waters)},
           'skipped': {k: skips[k] for k in sorted(skips)}}
    # TWO WRITES, BECAUSE TWO READERS. The registry index is the build-time record, the same
    # shape every other _*.json in there has. `chartpack/<slug>/launches.json` is what the APP
    # reads: it already fetches per-water files out of the pack by name -- centreline.geojson,
    # boundary.geojson -- so a landing list rides the delivery that exists rather than needing
    # a new one. upload_garmin_to_r2 ships it under `launches`, opt-in like the rest of that
    # group. Both are written from the same measurement in the same run; they cannot drift.
    packs = []
    for slug, res in out.items():
        d = os.path.join(a.chartpack, slug)
        if os.path.isdir(d):
            packs.append((os.path.join(d, 'launches.json'),
                          {'slug': slug, 'cell_m': res['cell_m'], 'note': doc['_note'],
                           'landings': res['landings']}))
    if not a.go:
        print('\nDRY RUN -- nothing written. Add --go to write %s' % dest)
        print('   and %d pack file(s), e.g. %s' % (len(packs), packs[0][0] if packs else '-'))
        return 0
    with open(dest, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh)
    print('\nwrote %s' % dest)
    for fp, body in packs:
        with open(fp, 'w', encoding='utf-8') as fh:
            json.dump(body, fh)
    print('wrote %d pack launches.json' % len(packs))
    if packs:
        print('\nSHIP IT -- the app reads this out of the pack, so it has to reach R2:\n')
        print('  py .\\scripts\\upload_garmin_to_r2.py `')
        print('     --root     F:\\TrollMapPipeline\\chartpack `')
        print('     --registry F:\\TrollMapPipeline\\registry `')
        print('     --layers launches --lake %s --jobs 6'
              % ','.join(sorted(out)[:4] + (['...'] if len(out) > 4 else [])))
    return 0


if __name__ == '__main__':
    sys.exit(main())
