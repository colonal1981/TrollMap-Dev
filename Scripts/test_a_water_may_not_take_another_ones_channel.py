#!/usr/bin/env python3
"""A nested water may not take channel the outer water's own centreline runs down.

2026-09-20. `clip_excluded` cuts a water that owns its own boundary out of the pack that
contains it, and that rule is right -- bathymetry describes one body of water, and a contour
two lakes both claim is one lake's line lying in the other's collar.

It goes wrong where the inner water's outline reaches across the outer one's live channel.
Ryan's waypoint 0006 at 33.76719 -80.65320 sits in 8-9 ft of the Congaree's main channel.
`bates_old_river` is nested inside congaree_river, its hand-cut outline crosses the mouth, so
the Congaree gave those 1.46 acres up -- and Bates does not sound them either: 8 m to the
nearest band in its own pack. Water that falls between two packs is in neither.

Ryan, who fishes it: *"bates didn't have its own boundary we had to cut it... but bates also
doesn't actually touch the congaree anymore... it did 100 years ago... but i dont think it
touches it now except during high water events"*, and the rule for what a pack owes:
*"if i see the congaree when selecting lake marion i don't really care... but if i select the
congaree i should see all of the congaree"*.

Two of the five pairs `nested_inside` finds cut the outer river's own line out of its own pack:

    congaree_river <- bates_old_river         41 m of centreline inside the cut
    yadkin_river   <- south_yadkin_river   8,717 m of it

The exception is the centreline itself and nothing wider: a feature the line passes through is
channel by construction, so there is no corridor to invent.

Synthetic, so the shapes are known rather than argued about.
"""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_chartpack import LakeMask, clip_excluded

FAIL = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        FAIL.append(msg)


def ring(w, s, e, n):
    return [(w, s), (e, s), (e, n), (w, n), (w, s)]


def feat(geom):
    return {'type': 'Feature', 'properties': {}, 'geometry': geom}


def poly(w, s, e, n):
    return feat({'type': 'Polygon', 'coordinates': [ring(w, s, e, n)]})


def main():
    # A river running west to east, and an oxbow whose outline reaches across its mouth.
    river = ring(-80.6600, 33.7670, -80.6400, 33.7676)
    oxbow = ring(-80.6545, 33.7668, -80.6500, 33.7690)
    deg = 250 / 111320.0
    # `exclude` is a list of RING LISTS, one per excluded water -- the same shape
    # load_boundary returns, and what clip_excluded flattens back out of exclude_rings.
    mask = LakeMask([river], deg, exclude=[[oxbow]])
    check(bool(getattr(mask, 'excluded', None)), 'the oxbow is excluded from the river mask')

    from shapely.geometry import LineString
    chan = LineString([(-80.6600, 33.7673), (-80.6400, 33.7673)])

    # A band in the channel, under the oxbow's overhang. This is 0006's 8-9 ft polygon.
    band = poly(-80.6535, 33.7671, -80.6510, 33.7675)
    kept, st = clip_excluded([band], mask)
    check(st.get('trimmed', 0) + st.get('emptied', 0) == 1 and not st.get('channel_kept'),
          'without the channel it is cut or emptied -- the defect, reproduced')

    kept, st = clip_excluded([band], mask, chan)
    check(st.get('channel_kept') == 1 and len(kept) == 1,
          'with the channel it is kept whole -- the river keeps its own channel')
    check(kept and kept[0]['geometry'] == band['geometry'],
          'and kept UNCHANGED, not cut and reassembled')

    print('\n--- the rule the exception must not swallow ---')
    # Water up inside the oxbow proper, nowhere near the line. That is the oxbow's, still.
    up = poly(-80.6530, 33.7683, -80.6510, 33.7688)
    kept, st = clip_excluded([up], mask, chan)
    check(not st.get('channel_kept') and (st.get('emptied') or st.get('trimmed')),
          'water up inside the oxbow is still given up -- the exception is the line, '
          'not the whole overlap')

    print('\n--- everything else is untouched ---')
    far = poly(-80.6450, 33.7671, -80.6430, 33.7675)
    kept, st = clip_excluded([far], mask, chan)
    check(st.get('untouched') == 1 and not st.get('channel_kept'),
          'a band nowhere near the exclusion never reaches the channel test')
    kept, st = clip_excluded([band], mask, None)
    check(not st.get('channel_kept'),
          'channel=None is the old behaviour exactly -- every lake is unchanged')

    print('\n--- a contour the line crosses is channel too ---')
    ct = feat({'type': 'LineString',
               'coordinates': [(-80.6530, 33.7669), (-80.6530, 33.7680)]})
    kept, st = clip_excluded([ct], mask, chan)
    check(st.get('channel_kept') == 1, 'a contour crossing the centreline is kept whole')

    print('\n%s  %d failure(s)' % ('FAILED' if FAIL else 'ALL PASS', len(FAIL)))
    for f in FAIL:
        print('   - ' + f)
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
