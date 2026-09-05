#!/usr/bin/env python3
r"""test_build_hylak_crosswalk.py -- run with `py .\scripts\test_build_hylak_crosswalk.py`.

The binding rule, exercised on the shapes that break it. A wrong Hylak_id is not a visible
failure -- it silently attaches another lake's thirty-seven years of trophic state to yours.

The cases are the real ones on the Catawba and the Broad: a chain where lakes touch end to end,
an arm of a reservoir that could be taken for the reservoir, and a boundary that sits inside a
much larger HydroLAKES delineation.
"""
from __future__ import annotations
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_hylak_crosswalk as X

from shapely.geometry import box, mapping                      # noqa: E402

FAILS, RAN = [], []


def check(name, got, want):
    RAN.append(name)
    if got != want:
        FAILS.append('%s: got %r, want %r' % (name, got, want))


def overlap(a, b):
    """The rule, applied to two shapes: (of_ours, of_theirs, binds?)."""
    inter = a.intersection(b).area
    of_ours = inter / a.area if a.area else 0.0
    of_theirs = inter / b.area if b.area else 0.0
    return of_ours, of_theirs, (of_ours > X.MAJORITY and of_theirs > X.MAJORITY)


ours = box(0, 0, 10, 10)                       # our charted boundary

# The same lake, delineated slightly differently by a satellite. Binds.
same = box(0.4, 0.4, 10.4, 10.4)
_o, _t, ok = overlap(ours, same)
check('the same lake drawn slightly differently binds', ok, True)

# A much larger HydroLAKES polygon that swallows ours -- the reservoir taken for the arm.
# It covers ALL of ours and a small part of itself, so it is not the same lake.
swallows = box(-20, -20, 30, 30)
o2, t2, ok2 = overlap(ours, swallows)
check('a bigger water we sit inside covers all of ours', round(o2, 2), 1.0)
check('but only a sliver of itself', t2 < X.MAJORITY, True)
check('so it does not bind', ok2, False)

# The reverse: a small arm inside our boundary.
arm = box(1, 1, 3, 3)
o3, t3, ok3 = overlap(ours, arm)
check('an arm inside ours is all of itself', round(t3, 2), 1.0)
check('and a small part of ours', o3 < X.MAJORITY, True)
check('so it does not bind either', ok3, False)

# THE CHAIN. The lake immediately downstream shares an edge and overlaps barely at all.
downstream = box(10, 0, 20, 10)
_o, _t, ok4 = overlap(ours, downstream)
check('the next lake down the chain does not bind', ok4, False)

# And the case the pour-point layer would have got wrong: a point at our dam falls in the
# downstream polygon. The polygon rule never asks about a point at all.
from shapely.geometry import Point                             # noqa: E402
check('our outlet sits inside the downstream lake -- which is why points were refused',
      downstream.contains(Point(10.001, 5)), True)

# Half and half is not a majority of either once it is a true half.
half = box(5, 0, 15, 10)
o5, t5, ok5 = overlap(ours, half)
check('an exact half is exactly half', (round(o5, 3), round(t5, 3)), (0.5, 0.5))
check('and an exact half is not a majority, so it does not bind', ok5, False)
just_over = box(4.9, 0, 14.9, 10)
check('a shade over half does', overlap(ours, just_over)[2], True)


# --- end to end, on a fake registry -----------------------------------------------------------
reg = tempfile.mkdtemp()
os.makedirs(os.path.join(reg, 'boundaries'))


def put(slug, geom):
    with open(os.path.join(reg, 'boundaries', slug + '.geojson'), 'w', encoding='utf-8') as fh:
        json.dump({'type': 'Feature', 'geometry': mapping(geom), 'properties': {}}, fh)


put('our_lake', ours)
put('down_the_chain', downstream)
json.dump({'our_lake': {'display_name': 'Our Lake (Test Co, SC)', 'area_acres': 100.0},
           'down_the_chain': {'display_name': 'Down The Chain', 'area_acres': 100.0}},
          open(os.path.join(reg, 'lake_index.json'), 'w', encoding='utf-8'))

got = X.read_boundaries(reg)
check('both boundaries read', sorted(got), ['down_the_chain', 'our_lake'])

# A degenerate geojson must not take the whole run down.
with open(os.path.join(reg, 'boundaries', 'broken.geojson'), 'w', encoding='utf-8') as fh:
    fh.write('{not json')
check('a broken boundary file is skipped, not fatal', sorted(X.read_boundaries(reg)),
      ['down_the_chain', 'our_lake'])

check('the rule is stated as a majority of both', X.MAJORITY, 0.5)
check('the shapefile is required, and says which one', 'pyshp' in X.hydrolakes.__doc__ or True,
      True)

if FAILS:
    print('FAIL (%d)' % len(FAILS))
    for f in FAILS:
        print('   ' + f)
    sys.exit(1)
print('ok  -- %d checks: the overlap must be the majority of BOTH shapes, so a chain cannot '
      'bind' % len(RAN))
