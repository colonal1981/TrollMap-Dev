#!/usr/bin/env python3
"""
test_charted.py — a shoreline outline is not a survey.

2026-08-08. Measured on the shipped packs: Willow Lake reported 0.9327 charted, Everetts 0.9083,
Bear Garden Swamp 0.8549, Lommond 0.9406, Yohola 0.8263, Kolomoki 0.8933 — and every one has ZERO
contours and exactly one depth band, (0, 3), one to three polygons of it. Garmin draws that band
around every piece of water whether or not anyone ever sounded it, and charted_fraction was
filling it and calling most of the lake surveyed.

`charted` drives Ryan's ship rule — "if it has bathymetry ship it" — and the "well charted"
filter in the picker, so the wrong number ships the wrong lakes and hides the right ones.

    py Scripts/tests/test_charted.py
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    'bcp', os.path.join(HERE, '..', 'build_chartpack.py'))
bcp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bcp)

FAILED = []


def check(name, got, want):
    ok = got == want
    print('  %s %-56s got %r want %r' % ('ok  ' if ok else 'FAIL', name, got, want))
    if not ok:
        FAILED.append(name)


def band(lo, hi):
    return {'geometry': {'type': 'Polygon', 'coordinates': [[]]},
            'properties': {'depth_min_dm': lo, 'depth_max_dm': hi}}


def line():
    return {'geometry': {'type': 'LineString', 'coordinates': [[-81.0, 34.0], [-80.9, 34.0]]}}


H = bcp.LakeMask._has_soundings

print('_has_soundings')
# The six lakes above, exactly: nothing but the 0-1 ft edge.
check('only the 0-1 ft edge band is not a survey', H([band(0, 3)]), False)
check('three copies of it are still not a survey', H([band(0, 3)] * 3), False)
check('no depth areas at all is not a survey', H([]), False)
check('a band below the edge IS a survey', H([band(0, 3), band(3, 6)]), True)
# Wateree's shape: shallow margin plus real depth.
check('a fully surveyed lake passes', H([band(0, 3), band(3, 6), band(70, 73)]), True)
check('contours alone are enough', H([band(0, 3)], [line()]), True)
check('an empty contour list does not rescue it', H([band(0, 3)], []), False)
# A malformed band must not be read as evidence.
check('a band with no depth is not evidence', H([{'properties': {}}]), False)
check('a null depth_max_dm is not evidence',
      H([{'properties': {'depth_max_dm': None}}]), False)



# ---------------------------------------------------------------------------
# EVERY MASK ANSWERS THE SAME CALL
#
# 2026-08-08. The charted fix gave LakeMask.charted_fraction a second argument so a 0-1 ft
# shoreline outline could not pass as coverage, and updated _flush to pass it. BboxMask -- the
# mask used for exactly one thing, coastal zone rectangles -- kept the old signature. Every
# coastal zone then died in _flush with `TypeError: takes 2 positional arguments but 3 were
# given`, unhandled, before one file was written. coast_st_helena_sc and coast_core_sound_nc
# shipped holding nothing but a water_graph.bin from a different script, while tile B4E0FB had
# 83,106 contours inside St Helena's own box.
#
# Ryan found it by asking why ACE Basin drew nothing in the app. Nine tests in this file passed
# throughout, because they all test _has_soundings and none of them build a pack.
#
# A duck-typed interface with two implementations and no test that they agree is a trap that
# springs on whichever branch is rarer -- here, 22 zones out of 1,722 waters.
# ---------------------------------------------------------------------------
print('mask interface')
import inspect

_spec = importlib.util.spec_from_file_location(
    'bc', os.path.join(HERE, '..', 'build_chartpack.py'))
_bc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_bc)

_MASKS = [_bc.LakeMask, _bc.BboxMask]
_ref = inspect.signature(_bc.LakeMask.charted_fraction)
for _cls in _MASKS:
    check('%s.charted_fraction matches LakeMask' % _cls.__name__,
          list(inspect.signature(_cls.charted_fraction).parameters), list(_ref.parameters))

# And the shape the caller actually uses, which is the call that crashed.
_rect = [[(-80.65, 32.20), (-80.20, 32.20), (-80.20, 32.55), (-80.65, 32.55), (-80.65, 32.20)]]
_zone = _bc.build_mask(_rect, 0.0025)
check('a zone rectangle picks BboxMask', type(_zone).__name__, 'BboxMask')
try:
    _zone.charted_fraction([], [])
    _ok = True
except TypeError:
    _ok = False
check('a zone survives the two-argument call _flush makes', _ok, True)
check('a zone still reports charted as None, not a land/water ratio',
      _zone.charted_fraction([], []), None)
check('a point inside the zone box is inside the mask', (-80.4, 32.4) in _zone, True)

# Every method _flush and the tile loop reach for, on both masks.
for _cls in _MASKS:
    for _name in ('charted_fraction', 'cell_of', '__contains__'):
        check('%s has %s' % (_cls.__name__, _name), hasattr(_cls, _name), True)

print()
if FAILED:
    print('%d FAILED: %s' % (len(FAILED), ', '.join(FAILED)))
    sys.exit(1)
print('all pass')
