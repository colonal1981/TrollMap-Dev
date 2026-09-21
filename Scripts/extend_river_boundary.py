#!/usr/bin/env python3
r"""extend_river_boundary.py -- give a river pack the rest of its own channel, out of the neighbour
water that our clipper handed it to.

    py .\scripts\extend_river_boundary.py --slug congaree_river --into lake_marion
    py .\scripts\extend_river_boundary.py --slug congaree_river --into lake_marion --go

    # or, with no --into, take the river's OWN charted water back:
    py .\scripts\extend_river_boundary.py --slug congaree_river
    py .\scripts\extend_river_boundary.py --slug congaree_river --go

WHAT THIS IS FOR

Ryan, 2026-09-19: *"the congaree river pack still stops at the confluence... how do we get the river
to show at least down until it reaches near the lake ramps maybe... can both packs show that stretch
of river?"*

And his correction of how to think about it, the same day: *"garmin charts the water once it just
doesn't sort or separate the water like we do"*. That is the whole of the problem. Garmin surveyed one
continuous piece of water; OUR clipper cuts it into per-water packs by whichever named polygon each
piece falls inside. build_river_centrelines.py traces a geoconnex mainstem, which does not stop where
a river's name does, so congaree_river's line runs 157,700 m -- and everything past the Wateree
junction at station 131,500 fell inside lake_marion and went into that pack as lake water.

MEASURED, on the stretch below the junction, off the pack's own cross-sections:

    below station 131,500      width p10 100  p50 125  p90 145  max 355 m
    the 31 km above it         width p10 100  p50 130  p90 195  max 745 m
    deepest_line_ft            14 to 27 ft the whole way down, charted_frac 0.88-0.96
    the last station (157,700) still a 120 m channel with 22 ft in it

It is not lake. It is more river-like than the 31 km of Congaree above it, it has no river pack of
its own -- santee_river is the LOWER Santee, 40 to 52 km away below the dams -- and Low Falls Landing
sits on it at station 152,900. The chart for it already exists; only our clip is missing.

TWO SOURCES OF WATER, ONE CORRIDOR -- 2026-09-20

`--into <neighbour>` is the case above: the river's line runs on past where its own boundary stops,
and the rest of the channel is inside the neighbour's polygon.

WITHOUT `--into`, the source is the river's OWN charted depth areas, out of the extract, and the
span is the whole line rather than the tail. That is a different failure and it is not at a seam.
Measured on congaree_river, 2026-09-20:

    charted water within 250 m of its own centreline        7,004 acres
      inside registry/boundaries/congaree_river.geojson     5,332  (76.1%)
      OUTSIDE it                                            1,672  (23.9%)
    and 1,631 of those acres are beyond the outer ring, not in its 20 island holes

It is not the shallow margin. 44.5% of the 4-5 ft band is outside, 41.9% of 5-6, 38.2% of 6-7,
28.6% of 9-10, 25.8% of 12-13. Strip the 0-1 outline Garmin draws round every piece of water and
31.8% of the SOUNDED water is outside the line we clip to.

What that costs, at 33.76212 -80.74456: the shipped pack has every band from 0-1 to 9-10 within
28 m of that point and no 12-13. The 12-13 band -- 1,806 m2 of it, the deepest water in the
channel -- falls in the collar outside the boundary, so the off-lake rule drops it whole and the
app reads 1 ft over the thalweg. Ryan: *"Our problem was we were running over what we said was 1ft
deep when it was really 10ft"*.

WHOLE POLYGONS, NEVER THE CORRIDOR'S EDGE. The added piece is selected by whether its CENTROID
falls in the corridor and is then added entire, so every new edge is Garmin's own water edge. Two
reasons, and the first is this file's own:

  * a smooth buffer edge manufactures bank features that are not there (see above);
  * build_structure.py reads the boundary's outer ring AND its island holes as shore and runs its
    offshore test against them, so an arc would be treated as shoreline and would mis-rule every
    crown near it.

Centroid rather than "intersects", because at a confluence the neighbour's depth areas are huge and
touch the corridor from a kilometre off. Measured both ways on congaree_river:

    intersects, whole polygons     boundary 7,783 -> 15,887 acres
    centroid,  whole polygons      boundary 7,783 -> 10,355 acres

and the second is the one that closes the holes: hole centroids inside the boundary 104 -> 136,
16 of the 36 mid-channel holes gone, and all five spot checks in -- including Ryan's waypoint 0006
and that 12-13 ft thalweg.

THE CORRIDOR IS STILL snap_cap_m AND IS STILL NOT INVENTED HERE. A pack without one gets no
extension, exactly as below.

WHY THE OVERLAP IS FINE HERE, WHEN attach_arms.py REFUSES ONE

attach_arms.py --max-overlap is 20%, because a piece that is already inside a boundary would
duplicate that water in every downstream layer and "duplicated geometry is far harder to notice than
missing geometry." That rule is about a CLIPPING MISTAKE: an arm of one lake that was dropped. This is
not that. This water honestly is two things -- the river channel a kayak fishes and part of the lake
that floods it -- and Ryan chose to have it in both packs on 2026-09-19 with the alternatives in front
of him. Lake Marion keeps the channel, which on a flooded lake is where the fish are.

HOW FAR, AND HOW WIDE, WITHOUT PICKING EITHER

DOWNSTREAM: to the end of the pack's own centreline. Not a station anybody chose -- the line is what
the pack already ships and its last station is still mid-channel, so "the pack covers its own line"
is the rule. On congaree_river that is 157,700, which clears Low Falls by 4.8 km.

SIDEWAYS: `snap_cap_m`, which the pack carries and the producer set: "THE SNAP CAP IS THE RIVER'S OWN
WIDTH, not a number chosen here: three channel widths off the centreline is off this river." A pack
without one gets no extension rather than an invented corridor.

The corridor is then INTERSECTED with the neighbour's own boundary, so the piece added is Garmin's
water and not a synthetic shoreline. That matters beyond tidiness: build_water_features.py finds coves
and points by walking a shoreline, and a smooth buffer edge would manufacture bank features that are
not there.

A THIRD SOURCE: THE RAMP'S OWN ROUTE -- 2026-09-21

`--from-landings` is for water no centreline ever runs down. The Pack's Landing canal joins that
ramp to the Congaree mainstem in 1,313 m of charted water, and the congaree_river pack owned one
20 m cell of it in 48; the centreline corridor cannot reach it because the canal is a branch off
the line, not a stretch of it, and 3DHP has no polygon there to cut from -- see from_landings()
for the query and the four rows it returned. The spine is instead the route build_ramp_reach.py
already measured over Garmin's water and wrote into launches.json, and the width is three times
the water's own inscribed radius at each vertex, capped by the pack's snap_cap_m.

AFTERWARDS, THE PACK MUST BE REBUILT

A boundary change invalidates the clip, exactly as attach_arms.py says. The commands are printed at
the end. The original is copied to `registry/boundaries/_before_extend/<slug>.geojson` before the
first write -- not `.bak` beside it, because `registry/boundaries/*.geojson` is globbed by half a
dozen readers and a stray file becomes a water.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
import argparse
import json
import math
import os
import shutil
import sys

from shapely.geometry import LineString, Polygon, MultiPolygon, shape, mapping
from shapely.ops import transform as shapely_transform
from shapely.ops import unary_union
from shapely.geometry import Point

ACRES_PER_M2 = 1.0 / 4046.8564224


def rings_of(obj):
    """Every ring in a boundary file, whatever shape it is written in."""
    out = []
    feats = obj.get('features') if isinstance(obj, dict) and obj.get('features') else [obj]
    for f in feats:
        g = (f or {}).get('geometry') or f
        if not g:
            continue
        if g.get('type') == 'Polygon':
            out.append(g['coordinates'])
        elif g.get('type') == 'MultiPolygon':
            out.extend(g['coordinates'])
    return out


def as_multi(obj):
    """A boundary file as one shapely MultiPolygon."""
    polys = []
    for rings in rings_of(obj):
        if not rings or len(rings[0]) < 4:
            continue
        polys.append(Polygon(rings[0], rings[1:]))
    return MultiPolygon([p for p in polys if not p.is_empty])


def flat(lat0):
    """Flat-earth metres about `lat0`, and back. Good to a fraction of a metre over one river."""
    mlon = 111320.0 * math.cos(math.radians(lat0))
    mlat = 110540.0
    return (lambda x, y: (x * mlon, y * mlat),
            lambda x, y: (x / mlon, y / mlat))


def inside_span(line, station_m, bound):
    """First and last station index inside `bound`. The same outermost-inside rule the app uses --
    see waterSpanM() in js/modules/river-drifts.js, and its note on why there is no tolerance."""
    first = last = -1
    for i, pt in enumerate(line):
        if bound.covers(Point(pt[0], pt[1])):
            if first < 0:
                first = i
            last = i
    return first, last


def own_water(a, corridor, fwd, inv, mine, bbox, trim=False):
    """The charted depth areas inside `corridor`, as WHOLE polygons.

    Returns (keep, dropped, refused, n_read). `keep` is in lon/lat, ready to merge with the
    boundary.

    WHICH POLYGONS. build_ramp_reach.water_polys() already answers "every zoom-0 depth area near
    this water, off the tiles it sits on" -- the tile list out of registry/tile_lake_map.json, the
    C file of each B id, and zoom 0 only because the coarser levels are redraws of the same water
    rather than extra survey, and a generalised polygon closes the very gaps -- a canal mouth, a
    creek neck -- this is for. This file carried its own copy of that loop until 2026-09-21. There
    is one now, and it is the one the ramp routes were measured with.

    Then: centroid inside the corridor, and not already inside the boundary. Added WHOLE, so every
    edge of the result is Garmin's water edge and not the corridor's arc.

    WHY NOT CLIP TO THE CORRIDOR. Because build_structure.py reads this boundary's outer ring and
    its island holes AS SHORE, and its offshore test would then rule against an arc that is not a
    bank. Same reason --into intersects the neighbour's polygon rather than keeping the buffer.

    `trim` KEEPS A POLYGON WHOLE ONLY IF THE CORRIDOR CONTAINS IT, and cuts it to the corridor
    otherwise. There is no size to pick: either the piece of water fits inside the run or it is
    something larger that the run passes through. The canal is why. Its water is not separable by
    polygon -- the 8-9 and 9-10 ft bands that floor it are single pieces of 154 and 148 acres that
    carry straight on out into Lake Marion -- so every whole-polygon rule tried on 2026-09-21
    failed at one end or the other: refusing them left the canal with banks and no middle and the
    ramp connected to nothing, selecting them by centroid never saw them at all because their
    centroids are out in the lake, and taking them whole on a touch put 1,247 acres of Lake Marion
    into the Congaree, which is how the annex swallowed the Atlantic on 2026-09-20.

    THE TRIM'S EDGES ARE STILL GARMIN'S, EXCEPT AT THE TWO ENDS, AND THAT IS NOT LUCK. The
    corridor's half-width is three times the inscribed radius of the water at each vertex, so its
    flanks are by construction at least three channel-widths out -- on dry ground, not on water.
    A cut against it therefore follows the water's own bank everywhere along the run, and the only
    manufactured edges are the caps where the run starts and stops. The start is the ramp. The
    stop is the vertex where three widths first exceeds the pack's cap, which is the neck where
    the channel opens out, so the cap lands across the narrowest water there is.
    """
    from build_ramp_reach import water_polys
    polys, n_read = water_polys(a.extract, a.registry, a.slug, bbox)
    keep, dropped, trimmed = [], 0, 0
    for g in polys:
        gm = shapely_transform(fwd, g)
        # TWO SELECTORS, AND `trim` PICKS BETWEEN THEM. Without it this is centroid-in-corridor
        # and whole polygons, unchanged since 2026-09-20 and measured there: at a confluence the
        # neighbour's depth areas are huge and touch the corridor from a kilometre off, and
        # `intersects` let them in entire. With it, touching is enough -- what comes in is then
        # the part inside the corridor and not the kilometre behind it, and centroid would have
        # missed the piece that matters. The canal is the case: the bands that floor it run on
        # out into Lake Marion and their centroids are out there with them.
        if not trim:
            if not corridor.covers(gm.centroid):
                continue
        elif not corridor.intersects(gm):
            continue
        if mine.covers(g):
            dropped += 1          # already ours; nothing to add
            continue
        if trim and not corridor.covers(gm):
            # A GEOMETRYCOLLECTION HAS NO 'coordinates', AND THIS IS THE THIRD PLACE. An
            # intersection that grazes an edge comes back with lines and points in it.
            cut = gm.intersection(corridor)
            parts = [q for q in getattr(cut, 'geoms', [cut]) if q.geom_type == 'Polygon']
            if not parts:
                continue
            trimmed += 1
            keep.append(shapely_transform(inv, unary_union(parts)))
            continue
        keep.append(g)
    return keep, dropped, trimmed, n_read


def from_landings(a, mine, cap):
    """The corridor the RAMPS measure, for water a centreline never runs down.

    Returns (keep, dropped, refused, lat0, fwd). `keep` is None on a refusal, [] when there is
    nothing left to add.

    WHY THIS EXISTS. Ryan, 2026-09-21: *"i should be able to fish the railroad tracks from packs
    all the way through the canal and up the river which is what i actually do.... and i should be
    able to do that with congaree river selected so that it is an actual river plan"*. He could
    not, and the reason was not the annex and not the clip. Measured the same day against the
    congaree_river pack alone: Pack's Landing's nearest water in it is 1,093 m away and is a
    2-acre orphan joined to nothing, while the canal that actually connects the ramp to the
    mainstem is 1,313 m of charted water of which this pack owns ONE 20 m cell in 48. Lake Marion
    owns the other 47.

    AND 3DHP CANNOT FIX IT, WHICH IS WHY THE SOURCE HAD TO CHANGE. make_river_boundaries cuts
    these boundaries from 3DHP featuretype 1 and 2 -- River and Canal, so canals were never
    excluded. Queried over this canal on 2026-09-21: four waterbody rows in the whole box and not
    one of them is a Canal. Lake Marion is a single featuretype 3 polygon of 323.9250 km2 --
    80,043 acres -- and the canal is interior to it. The one River polygon down there is 0.0500
    km2 at the mouth, an island inside Marion's polygon with the Congaree's nearest river polygon
    over a kilometre off, so the 50 m join tolerance was never going to reach it, and --min-km2
    never touched it (that test is `km2 < 0.05`, and it runs on the assembled result). There is no
    wider featuretype net that finds this canal, and --lakes would hand the Congaree all 80,043
    acres of the lake. Garmin sounded it -- 8 to 10 ft down the middle, 25 depth-area polygons --
    and Garmin is the only source that knows it is there.

    SO THE SPINE IS A MEASURED ROUTE, NOT A LINE DRAWN HERE. build_ramp_reach.py floods the
    charted water off the same tiles and writes the way back out of the flood field into
    launches.json; Pack's Landing's is 72 points and 1,801 m by water against 2,367 straight. It
    is a shortest path by construction, it is over Garmin's water at 26 m cells rather than over
    the clip, and it is already on disk. Nothing here invents a course.

    HOW WIDE, WITHOUT PICKING IT. The same rule the centreline corridor uses -- three channel
    widths off the line is off this water -- but measured on the water the ROUTE is in instead of
    inherited from the river. congaree_river's snap_cap_m is 495 m, three widths of the Congaree;
    this canal is about 90 m across, and a 495 m corridor down it reaches a quarter mile into Lake
    Marion on both banks. Measured 2026-09-21: whole-polygon selection over a corridor that wide
    takes 762 acres against roughly 30 for the canal itself. So the half-width at each vertex is
    three times the inscribed radius of the charted water AT that vertex -- the distance from the
    route to its own nearest bank.

    AND WHERE THREE WIDTHS IS WIDER THAN THE RIVER, THE VERTEX IS PASSED OVER RATHER THAN CLAMPED
    TO THE CAP. Clamping is what snap_cap_m means on a centreline, where every station IS the
    river; on a ramp route most vertices are not. The first run of this, 2026-09-21, clamped: 35
    routes, 3,351 acres of corridor, 1,695 acres added -- almost all of it off Santee State Park,
    Poplar Creek, Red Cypress and Stumphole, lake ramps whose routes cross kilometres of open Lake
    Marion. Reaching the cap is the signal that the route has left any channel, and out there a
    ramp route has nothing to say.

    THE ROUTE IS ALSO READ FROM THE RAMP END AND STOPS AT THE FIRST WATER THE PACK ALREADY HAS.
    What is missing is the link between the two; past it the pack owns the water already.
    """
    lp = os.path.join(a.chartpack, a.slug, 'launches.json')
    if not os.path.isfile(lp):
        print('%s: no %s, so there is no measured route to follow' % (a.slug, lp))
        return None, 0, 0, 0.0, None
    with open(lp, encoding='utf-8') as fh:
        land = json.load(fh)
    want = [w.strip().lower() for w in (a.landings or '').split(',') if w.strip()]
    if not want:
        print('%s: --from-landings needs --landings. A ramp route is a statement that HE launches '
              'there, and nothing in the data says it: Pack\'s Landing is 1,801 m from the '
              'Congaree and 0 m from Lake Marion, so every measure files it under the lake. Its '
              'launches.json lists 35 landings that merely reach this water -- Saluda Shoals is '
              '14 km of route away and belongs to saluda_river_lower_saluda -- and taking them '
              'all adds 1,221 acres to a 30-acre problem.' % a.slug)
        return None, 0, 0, 0.0, None
    routes = [(r.get('name') or '?', r.get('route') or []) for r in (land.get('landings') or [])
              if (r.get('name') or '').strip().lower() in want]
    routes = [(n, rt) for n, rt in routes if len(rt) >= 2]
    missing = sorted(set(want) - set(n.strip().lower() for n, _ in routes))
    if missing:
        print('  not in %s launches.json, or already on its water: %s'
              % (a.slug, ', '.join(missing)))
    if not routes:
        print('%s: every landing in its launches.json is already on its own water' % a.slug)
        return [], 0, 0, 0.0, None

    pts = [p for _, rt in routes for p in rt]
    lat0 = sum(p[1] for p in pts) / len(pts)
    fwd, inv = flat(lat0)
    mlon = 111320.0 * math.cos(math.radians(lat0))
    bbox = (min(p[0] for p in pts) - cap / mlon, min(p[1] for p in pts) - cap / 110540.0,
            max(p[0] for p in pts) + cap / mlon, max(p[1] for p in pts) + cap / 110540.0)

    from build_ramp_reach import water_polys
    near, _n = water_polys(a.extract, a.registry, a.slug, bbox)
    if not near:
        print('%s: no charted water on its tiles anywhere near those routes' % a.slug)
        return None, 0, 0, lat0, fwd
    water = unary_union([shapely_transform(fwd, g) for g in near])
    bank = water.boundary

    print('%s: widening %d measured ramp route(s) by the water they run in' % (a.slug, len(routes)))
    circles, offchannel = [], 0
    for name, rt in routes:
        # RAMP FIRST, AND ALL THE WAY TO THE END OF THE ROUTE. trace() writes the channel end
        # first, so the route is read backwards; its far end is a cell the CENTRELINE itself runs
        # through, which is the mainstem by definition.
        #
        # This stopped at the first vertex inside the boundary for one run on 2026-09-21, on the
        # reasoning that past it the pack has the water already. It does not: congaree_river's
        # nearest water to Pack's Landing was a TWO-ACRE ORPHAN joined to nothing, the walk
        # stopped on it, and the corridor ended 85 m short of the Congaree with the ramp on 227
        # acres of canal that went nowhere. Whatever is already inside the boundary is dropped by
        # own_water anyway, so running the whole route costs nothing and is the only way to be
        # sure the far end is the river.
        walk_back = list(reversed(rt))
        halves, last_half, bridged = [], None, 0
        for lon, lat in walk_back:
            p = Point(*fwd(lon, lat))
            if not water.covers(p):
                continue
            half = 3.0 * bank.distance(p)
            if half > cap:
                # THREE WIDTHS HERE IS WIDER THAN THE RIVER ITSELF, SO THIS IS NOT A CHANNEL.
                # snap_cap_m exists because three channel widths off the line is off this water;
                # reaching it means the route has come out into open water. Clamping to the cap
                # out there is how the first run of this took 1,704 acres off Santee State Park,
                # Poplar Creek and Red Cypress, lake ramps whose routes cross kilometres of Lake
                # Marion, when the canal is 30.
                #
                # BUT A RUN THAT STOPS SHORT CONNECTS NOTHING, which is the whole job. The Pack's
                # Landing canal opens out 85 m before it meets water the pack already has, and
                # stopping at the last narrow vertex left the ramp on 201 acres of canal with an
                # 85 m break to the Congaree -- measured 2026-09-21, and no use to anybody. So
                # once the run has a measured width, it CARRIES THAT WIDTH across the opening
                # until it reaches the pack's own water, and the bridge is as wide as the channel
                # it came out of rather than as wide as the water it is crossing.
                if last_half is None:
                    offchannel += 1
                    continue
                half = last_half
                bridged += 1
            elif half <= 0:
                continue
            else:
                last_half = half
                halves.append(half)
            circles.append(p.buffer(half, resolution=8))
        if bridged:
            print('  %-24s carried its %.0f m width across %d vertex(es) of open water to reach '
                  'the pack' % (name, last_half, bridged))
        if halves:
            halves.sort()
            print('  %-24s %3d of %3d pts   half-width min %.0f  med %.0f  max %.0f m'
                  % (name, len(halves), len(rt), halves[0], halves[len(halves) // 2], halves[-1]))
        else:
            print('  %-24s %3d pts   nothing on this route is a channel' % (name, len(rt)))
    if offchannel:
        print('  %d route vertex(es) passed over: open water, not a channel' % offchannel)
    if not circles:
        print('%s: none of its measured routes runs on charted water' % a.slug)
        return None, 0, 0, lat0, fwd

    corridor = unary_union(circles)
    print('  corridor %.0f acres; ceiling %s m, the pack\'s own snap_cap_m'
          % (corridor.area * ACRES_PER_M2, cap))
    keep, dropped, trimmed, n_read = own_water(a, corridor, fwd, inv, mine, bbox, trim=True)
    print('  read %d charted polygon(s) off the tiles this water sits on' % n_read)
    return keep, dropped, trimmed, lat0, fwd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--slug', required=True, help='the river pack to extend')
    ap.add_argument('--into', help='the neighbour water whose polygon holds the rest. Leave it off '
                                   "to take the river's own charted water instead")
    ap.add_argument('--registry', default='registry')
    ap.add_argument('--chartpack', default='chartpack')
    ap.add_argument('--extract', default='extract',
                    help='where the per-tile layers live; read only when --into is absent')
    ap.add_argument('--to-station', type=float, default=None,
                    help='stop here instead of at the end of the pack\'s own line')
    ap.add_argument('--corridor-m', type=float, default=None,
                    help="override snap_cap_m, which is the pack's own three-channel-widths")
    ap.add_argument('--landings', default='',
                    help='comma-separated landing names, as launches.json spells them. '
                         'Required with --from-landings; see from_landings() for why this '
                         'cannot be derived.')
    ap.add_argument('--from-landings', action='store_true',
                    help="follow the measured ramp routes in the pack's launches.json "
                         'instead of the centreline. For water a centreline never runs '
                         'down -- the canal at a landing -- see from_landings().')
    ap.add_argument('--go', action='store_true', help='write; without it nothing is touched')
    a = ap.parse_args()

    bdir = os.path.join(a.registry, 'boundaries')
    mine_p = os.path.join(bdir, a.slug + '.geojson')
    theirs_p = os.path.join(bdir, a.into + '.geojson') if a.into else None
    cl_p = os.path.join(a.chartpack, a.slug, 'centreline.geojson')
    for p in [x for x in (mine_p, theirs_p, cl_p) if x]:
        if not os.path.isfile(p):
            print('missing: %s' % p)
            return 2

    with open(mine_p, encoding='utf-8') as fh:
        mine_raw = json.load(fh)
    theirs_raw = None
    if theirs_p:
        with open(theirs_p, encoding='utf-8') as fh:
            theirs_raw = json.load(fh)
    with open(cl_p, encoding='utf-8') as fh:
        cl = json.load(fh)

    feat = cl['features'][0]
    line = feat['geometry']['coordinates']
    props = feat['properties']
    station_m = props.get('station_m') or []
    if len(line) < 2 or len(station_m) != len(line):
        print('%s: centreline has no usable station_m' % a.slug)
        return 2

    cap = a.corridor_m if a.corridor_m is not None else props.get('snap_cap_m')
    if not cap or cap <= 0:
        print('%s: no snap_cap_m on the pack and no --corridor-m given, so there is no corridor '
              'this script is entitled to invent' % a.slug)
        return 2

    mine = as_multi(mine_raw)
    if mine.is_empty:
        print('%s: its boundary has no polygon in it' % a.slug)
        return 2
    theirs = as_multi(theirs_raw) if theirs_raw is not None else None
    if theirs is not None and theirs.is_empty:
        print('%s: its boundary has no polygon in it' % a.into)
        return 2

    if a.from_landings:
        keep, dropped, trimmed, lat0, fwd = from_landings(a, mine, cap)
        if keep is None:
            return 2
        if not keep:
            print('  every charted polygon along the measured routes is already inside '
                  'the boundary')
            return 0
    else:
        trimmed = 0
        first, last = inside_span(line, station_m, mine)
        if last < 0:
            print('%s: none of its own centreline is inside its own boundary' % a.slug)
            return 2
        stop_m = a.to_station if a.to_station is not None else station_m[-1]
        # WITH --into the span is the TAIL past where the boundary stops; that is the whole point of
        # that mode. Without it the river is short of its own water all the way down, so the span is
        # the whole line -- see TWO SOURCES OF WATER above.
        start_i = last if a.into else 0
        stop_i = max(i for i, s in enumerate(station_m) if s <= stop_m)
        if stop_i <= start_i:
            print('%s: its boundary already reaches station %s, and %s is not past it'
                  % (a.slug, station_m[last], stop_m))
            return 0

        if a.into:
            print('%s: boundary currently ends at station %s of %s'
                  % (a.slug, station_m[last], station_m[-1]))
            print('  extending along its own line to station %s  (%.1f km of channel)'
                  % (station_m[stop_i], (station_m[stop_i] - station_m[start_i]) / 1000.0))
        else:
            print('%s: taking back its own charted water along the whole line, station %s to %s '
                  '(%.1f km)' % (a.slug, station_m[start_i], station_m[stop_i],
                                 (station_m[stop_i] - station_m[start_i]) / 1000.0))
        print('  corridor half-width %s m  (%s)'
              % (cap, 'given' if a.corridor_m is not None else "the pack's own snap_cap_m"))

        lat0 = sum(p[1] for p in line[start_i:stop_i + 1]) / (stop_i - start_i + 1)
        fwd, inv = flat(lat0)
        seg = LineString(line[start_i:stop_i + 1])
        corridor = shapely_transform(fwd, seg).buffer(cap, resolution=8)

        if a.into:
            piece = corridor.intersection(shapely_transform(fwd, theirs))
            if piece.is_empty:
                print('  nothing of %s lies in that corridor' % a.into)
                return 1
            piece = shapely_transform(inv, piece)

            # Only the parts the line actually runs through. A corridor across a meander can clip a
            # slice of some other arm of the lake on the far side of a point, and that water is not
            # this river.
            parts = list(piece.geoms) if piece.geom_type == 'MultiPolygon' else [piece]
            keep = [p for p in parts if p.intersects(seg)]
            dropped = len(parts) - len(keep)
            if not keep:
                print('  the corridor met %s but not along the line itself' % a.into)
                return 1
        else:
            sb = seg.bounds
            pad_lon = cap / (111320.0 * math.cos(math.radians(lat0)))
            pad_lat = cap / 110540.0
            keep, dropped, trimmed, n_read = own_water(
                a, corridor, fwd, inv, mine,
                (sb[0] - pad_lon, sb[1] - pad_lat, sb[2] + pad_lon, sb[3] + pad_lat),
            )
            print('  read %d charted polygon(s) off the tiles this water sits on' % n_read)
            if not keep:
                print('  every charted polygon near the line is already inside the boundary')
                return 0

    added = MultiPolygon([g for k in keep
                          for g in (k.geoms if k.geom_type == 'MultiPolygon' else [k])])
    print('  adding %d polygon(s), %.0f acres%s'
          % (len(added.geoms), added.area * (111320.0 * math.cos(math.radians(lat0)) * 110540.0)
             * ACRES_PER_M2,
             ('' if not dropped else '  (%d %s)'
              % (dropped, 'off-line piece(s) dropped' if a.into
                 else 'already inside the boundary'))))

    if trimmed:
        print('  %d polygon(s) larger than the corridor were cut to it, banks kept' % trimmed)

    # DISSOLVED, NOT CONCATENATED. A boundary is read by half a dozen tools and several of them
    # take it at face value: laying the added polygons beside the old ones leaves parts that
    # overlap, which is an INVALID MultiPolygon under OGC rules, and shapely will answer
    # questions about it without complaining. Measured on congaree_river the first time this
    # ran, 2026-09-20: 15,503 acres as written, 10,732 after buffer(0) -- and
    # build_river_centrelines came back with 37.0 km of river where there are 162.9, with the
    # snap cap falling 480 m to 405. The union's edges are still every bit as real; it is the
    # same edges with the overlaps resolved.
    merged = unary_union(list(mine.geoms) + list(added.geoms))
    if merged.geom_type == 'Polygon':
        merged = MultiPolygon([merged])
    nf, nl = inside_span(line, station_m, merged)
    # The acreage above is the polygons' OWN area, which double-counts whatever already overlapped.
    # This is what the boundary actually becomes, and it is the number to quote.
    m2 = 111320.0 * math.cos(math.radians(lat0)) * 110540.0
    before = shapely_transform(fwd, mine).area * ACRES_PER_M2
    after = shapely_transform(fwd, merged).buffer(0).area * ACRES_PER_M2
    print('  boundary %.0f -> %.0f acres  (+%.0f net)' % (before, after, after - before))
    print('  stations inside afterwards: %s .. %s of %s'
          % (station_m[nf], station_m[nl], station_m[-1]))

    out = {'type': 'FeatureCollection', 'features': [{
        'type': 'Feature',
        'properties': (mine_raw.get('features') or [{}])[0].get('properties') or {},
        'geometry': mapping(merged),
    }]}

    if not a.go:
        print('\nDRY RUN -- nothing written. Add --go.')
        return 0

    bak_dir = os.path.join(bdir, '_before_extend')
    os.makedirs(bak_dir, exist_ok=True)
    bak = os.path.join(bak_dir, a.slug + '.geojson')
    if not os.path.exists(bak):
        shutil.copy2(mine_p, bak)
        print('\noriginal copied to %s' % bak)
    with open(mine_p, 'w', encoding='utf-8') as fh:
        json.dump(out, fh)
    print('wrote %s' % mine_p)
    print_rebuild(a.slug)
    return 0


def print_rebuild(slug):
    """The runbook's own commands, for one slug. Taken from REEXTRACT_RUNBOOK_2026-08-21 and
    RUN_STATE_2026-08-22 rather than written here -- `--only-lakes` is a BARE path or comma list, no
    `@`, which is the PowerShell here-string landmine from 2026-08-03.

    THE TWO LANE BUILDERS ARE LEFT OUT ON PURPOSE. build_trolling_runs and fit_trolling_runs make
    fitted lanes, which a river does not use -- `legRuns = drifts || runs` in smart-plan-v2, and as of
    2026-09-19 the planner no longer even requires the file. congaree_river's is 87 MB; rebuilding it
    over a longer clip would only make it bigger. build_water_features still runs: it writes the coves
    and points the plan reads, and it rewrites `near` on whatever runs happen to be there.

    AND build_water_graphs.py IS NOT IN THE LIST EITHER, WHICH TOOK RYAN THREE TRIES TO GET SAID.
    2026-09-19: *"why am i running water graphs on a river that can't use them?"*, then *"what
    transiting is done on a river... i launch i put baits in the water and i troll until i turn
    around and then i do it again then stop at the landing and am done for the day"*, then *"why
    would i continue to use something that is wrong that may or may not actually be needed"*.

    He was right every time and the answer was already in the tree. river-drifts.js
    `centrelineTransit()` -- written 2026-09-18, one day before the first of those questions -- makes
    the river transit out of the pack's own centreline, and smart-plan-v2 says it outright: *"A river
    plan now makes no route request at all, where it used to make one per leg plus one home."*
    NOTHING ON A RIVER READS water_graph.bin. Not the drifts (`legRuns = drifts || runs`), not the
    transits, not the reach gates. /water/<slug>/route is the LAKE path.

    Measured on his own 2026-09-19 Congaree day, which is what settles it: 23,101 m total, of which
    22,876 m is trolling and 225 m is transit -- four hops of 95, 90 and 40 m, the boat turning
    around. There is nothing on a river for a router to find.

    So this step was in the list because a rebuild runbook written for lakes had it, and it survived
    two defences of mine that this file's own siblings refute. It builds a 30 KB graph from unchanged
    MAR files for a water that will never open it. Out.

    WHICH ALSO RETIRES THE BATHY QUESTION FOR RIVERS. `water_graph_bathy.bin`, `_c2.bin` and
    `_c3.bin` in the pack are the measurement behind
    THE_LAND_TEST_IS_THE_WHOLE_BALLGAME_AND_THE_WHOLE_PROBLEM_2026-09-15.md, which put three ways
    forward in front of Ryan. All three are about making a river graph route better. A river does not
    route. That decision is a LAKE decision and it is not blocking anything here.
    """
    R = 'F:\\TrollMapPipeline'
    print('\nA BOUNDARY CHANGE INVALIDATES THE CLIP. Rebuild, in this order:\n')
    print('  py .\\scripts\\build_all_chartpacks.py `')
    print('     --extract  %s\\extract `' % R)
    print('     --registry %s\\registry `' % R)
    print('     --map      %s\\registry\\tile_lake_map.json `' % R)
    print('     --out      %s\\chartpack `' % R)
    print('     --report   %s\\registry\\charted.json `' % R)
    print('     --only-lakes %s\n' % slug)
    print('  py .\\scripts\\build_structure.py `')
    print('     --packs    %s\\chartpack `' % R)
    print('     --registry %s\\registry `' % R)
    print('     --report   %s\\registry\\_structure.json `' % R)
    print('     --force --only-lakes %s\n' % slug)
    print('  py .\\scripts\\build_water_features.py `')
    print('     --packs    %s\\chartpack --force --only-lakes %s\n' % (R, slug))
    print('  py .\\scripts\\build_river_centrelines.py `')
    print('     --registry %s\\registry --only %s\n' % (R, slug))
    print('  py .\\scripts\\upload_garmin_to_r2.py `')
    print('     --root     %s\\chartpack `' % R)
    print('     --registry %s\\registry `' % R)
    print('     --lake %s --all --jobs 6\n' % slug)
    print('  --all is what ships <slug>/boundary.geojson: it is opt-in, upload_garmin_to_r2 is the')
    print('  one writer for that key, and it reads registry\\boundaries.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
