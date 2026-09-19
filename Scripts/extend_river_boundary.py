#!/usr/bin/env python3
r"""extend_river_boundary.py -- give a river pack the rest of its own channel, out of the neighbour
water that our clipper handed it to.

    py .\scripts\extend_river_boundary.py --slug congaree_river --into lake_marion
    py .\scripts\extend_river_boundary.py --slug congaree_river --into lake_marion --go

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--slug', required=True, help='the river pack to extend')
    ap.add_argument('--into', required=True, help='the neighbour water whose polygon holds the rest')
    ap.add_argument('--registry', default='registry')
    ap.add_argument('--chartpack', default='chartpack')
    ap.add_argument('--to-station', type=float, default=None,
                    help='stop here instead of at the end of the pack\'s own line')
    ap.add_argument('--corridor-m', type=float, default=None,
                    help="override snap_cap_m, which is the pack's own three-channel-widths")
    ap.add_argument('--go', action='store_true', help='write; without it nothing is touched')
    a = ap.parse_args()

    bdir = os.path.join(a.registry, 'boundaries')
    mine_p = os.path.join(bdir, a.slug + '.geojson')
    theirs_p = os.path.join(bdir, a.into + '.geojson')
    cl_p = os.path.join(a.chartpack, a.slug, 'centreline.geojson')
    for p in (mine_p, theirs_p, cl_p):
        if not os.path.isfile(p):
            print('missing: %s' % p)
            return 2

    with open(mine_p, encoding='utf-8') as fh:
        mine_raw = json.load(fh)
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
    theirs = as_multi(theirs_raw)
    if mine.is_empty or theirs.is_empty:
        print('one of the two boundaries has no polygon in it')
        return 2

    first, last = inside_span(line, station_m, mine)
    if last < 0:
        print('%s: none of its own centreline is inside its own boundary' % a.slug)
        return 2
    stop_m = a.to_station if a.to_station is not None else station_m[-1]
    start_i = last
    stop_i = max(i for i, s in enumerate(station_m) if s <= stop_m)
    if stop_i <= start_i:
        print('%s: its boundary already reaches station %s, and %s is not past it'
              % (a.slug, station_m[last], stop_m))
        return 0

    print('%s: boundary currently ends at station %s of %s'
          % (a.slug, station_m[last], station_m[-1]))
    print('  extending along its own line to station %s  (%.1f km of channel)'
          % (station_m[stop_i], (station_m[stop_i] - station_m[start_i]) / 1000.0))
    print('  corridor half-width %s m  (%s)'
          % (cap, 'given' if a.corridor_m is not None else "the pack's own snap_cap_m"))

    lat0 = sum(p[1] for p in line[start_i:stop_i + 1]) / (stop_i - start_i + 1)
    fwd, inv = flat(lat0)
    seg = LineString(line[start_i:stop_i + 1])
    corridor = shapely_transform(fwd, seg).buffer(cap, resolution=8)
    piece = corridor.intersection(shapely_transform(fwd, theirs))
    if piece.is_empty:
        print('  nothing of %s lies in that corridor' % a.into)
        return 1
    piece = shapely_transform(inv, piece)

    # Only the parts the line actually runs through. A corridor across a meander can clip a slice of
    # some other arm of the lake on the far side of a point, and that water is not this river.
    parts = list(piece.geoms) if piece.geom_type == 'MultiPolygon' else [piece]
    keep = [p for p in parts if p.intersects(seg)]
    dropped = len(parts) - len(keep)
    if not keep:
        print('  the corridor met %s but not along the line itself' % a.into)
        return 1

    added = MultiPolygon(keep)
    print('  adding %d polygon(s), %.0f acres%s'
          % (len(keep), added.area * (111320.0 * math.cos(math.radians(lat0)) * 110540.0)
             * ACRES_PER_M2,
             ('' if not dropped else '  (%d off-line piece(s) dropped)' % dropped)))

    merged = MultiPolygon(list(mine.geoms) + keep)
    nf, nl = inside_span(line, station_m, merged)
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
