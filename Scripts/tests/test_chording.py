#!/usr/bin/env python3
"""
test_chording.py — the shortcut must cut the cove and refuse the point.

2026-08-08. Ryan drew a red line over the rendered runs: "i would never actually do what this is
showing... i know we have this just blindly following a contour but that isn't what a fisherman
would do." What he drew was a chord across a cove mouth and a straight run holding the band.

The tempting fix is a bigger --simplify-m. It is wrong, and this file is the reason: Douglas-
Peucker is shape-blind, so a chord across a cove mouth and a chord across a headland are the same
operation to it and opposite in the only way that matters. These tests pin the difference.

    py Scripts/tests/test_chording.py
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    'btr', os.path.join(HERE, '..', 'build_trolling_runs.py'))
btr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(btr)

FAILED = []


def check(name, got, want):
    ok = got == want
    print('  %s %-52s got %r want %r' % ('ok  ' if ok else 'FAIL', name, got, want))
    if not ok:
        FAILED.append(name)


def box(w, s, e, n, hi):
    return {'geometry': {'type': 'Polygon',
                         'coordinates': [[[w, s], [e, s], [e, n], [w, n], [w, s]]]},
            'properties': {'depth_max_dm': hi}}


# A lake at 34 N: 20 ft of water everywhere, with a 3 ft point pushing up into it.
DEEP = box(-81.00, 34.00, -80.90, 34.05, 60)
SHOAL = box(-80.960, 34.010, -80.950, 34.030, 10)
DI = btr.DepthIndex([DEEP, SHOAL])
DM = 40                      # the ~13 ft line we are trolling

print('DepthIndex')
check('open water reads deep', DI.shallowest_dm(-80.980, 34.020), 60)
# SHALLOWEST, not deepest. The first version took the max and reported 20 ft over a 3 ft point,
# which is the chord that puts the boat on the rocks.
check('a shoal inside deep water still reads shallow', DI.shallowest_dm(-80.955, 34.020), 10)
check('uncharted water reads None', DI.shallowest_dm(-80.80, 34.02), None)

print('steer()')
COVE = [(-80.995, 34.040), (-80.990, 34.040), (-80.988, 34.030), (-80.986, 34.022),
        (-80.984, 34.030), (-80.982, 34.040), (-80.978, 34.040)]
POINT = [(-80.970, 34.020), (-80.965, 34.020), (-80.960, 34.020), (-80.955, 34.020),
         (-80.952, 34.020), (-80.950, 34.020), (-80.945, 34.020)]

check('cuts across a cove mouth', len(btr.steer(COVE, DM, DI, 400.0, 6, 3)) < len(COVE), True)
check('refuses to cut across a point', len(btr.steer(POINT, DM, DI, 400.0, 6, 3)), len(POINT))

straight = [(-80.995 + i * 0.0004, 34.045) for i in range(9)]
check('collapses a straight run', len(btr.steer(straight, DM, DI, 400.0, 6, 3)), 2)

# No depth areas is the common case -- 988 packs have no soundings at all. Falling back to the
# raw contour is right; inventing a shortcut on no evidence is not.
check('returns None with no depth areas', btr.steer(COVE, DM, btr.DepthIndex([]), 400.0, 6, 3), None)
check('returns None on a two-point run', btr.steer(COVE[:2], DM, DI, 400.0, 6, 3), None)

long_run = [(-80.995 + i * 0.0020, 34.048) for i in range(12)]
o = btr.steer(long_run, DM, DI, 400.0, 6, 3)
longest = max(btr.metres(o[i], o[i + 1]) for i in range(len(o) - 1))
check('honours the chord ceiling', longest <= 401, True)

# Endpoints are never moved: a run's start and end are where the depth band begins and ends.
c = btr.steer(COVE, DM, DI, 400.0, 6, 3)
check('keeps the first vertex', c[0], COVE[0])
check('keeps the last vertex', c[-1], COVE[-1])

# An island is not water, so a chord may not cross one.
ISLAND = {'geometry': {'type': 'Polygon', 'coordinates': [
    [[-81.00, 34.00], [-80.90, 34.00], [-80.90, 34.05], [-81.00, 34.05], [-81.00, 34.00]],
    [[-80.976, 34.036], [-80.972, 34.036], [-80.972, 34.044], [-80.976, 34.044], [-80.976, 34.036]],
]}, 'properties': {'depth_max_dm': 60}}
DI2 = btr.DepthIndex([ISLAND])
check('an island reads as uncharted', DI2.shallowest_dm(-80.974, 34.040), None)
across = [(-80.985, 34.040), (-80.980, 34.040), (-80.974, 34.040), (-80.968, 34.040),
          (-80.962, 34.040)]
check('will not chord through an island',
      len(btr.steer(across, DM, DI2, 400.0, 6, 3)), len(across))

print()
if FAILED:
    print('%d FAILED: %s' % (len(FAILED), ', '.join(FAILED)))
    sys.exit(1)
print('all pass')
