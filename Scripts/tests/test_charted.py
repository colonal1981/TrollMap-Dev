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

print()
if FAILED:
    print('%d FAILED: %s' % (len(FAILED), ', '.join(FAILED)))
    sys.exit(1)
print('all pass')
