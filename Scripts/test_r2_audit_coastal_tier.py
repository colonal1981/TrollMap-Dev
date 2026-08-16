#!/usr/bin/env python3
"""An empty COASTAL_PRIMARY means the tier is OFF, not that nothing qualifies.

Personal use only, not for distribution or resale; not for navigation.

`upload_garmin_to_r2.py` writes `if primary and slug.startswith("coast_") and ...`. The leading
`primary and` is the whole point: COASTAL_PRIMARY is `set()` by default, and empty means every
zone is primary and ships every layer. `r2_audit.py` imported the constant and then rewrote the
condition without that guard, so every coastal zone read as secondary and 127 live objects --
338.6 MB over 16 zones, boundary.geojson included -- landed on a proposed delete list.

These assertions are the guard, from both sides: tier off deletes nothing, tier on still deletes
what it always did.
"""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r2_audit as A

FAIL = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        FAIL.append(msg)


def main():
    heavy = A.LAYERS['contours']
    kept = sorted(A.KEEP_ON_SECONDARY_COAST)[0]
    pipeline_file = A.LAYERS[sorted(A.PIPELINE_ONLY)[0]]

    check(A.COASTAL_PRIMARY == set(),
          'COASTAL_PRIMARY ships empty -- the tier is off by default (%r)' % (A.COASTAL_PRIMARY,))

    # ── tier OFF, which is how the uploader actually runs ────────────────────────────────
    saved = A.COASTAL_PRIMARY
    try:
        A.COASTAL_PRIMARY = set()
        check(A.deletable('coast_charleston_sc', heavy) is None,
              'tier off: a coastal zone keeps %s' % heavy)
        check(A.deletable('coast_charleston_sc', A.LAYERS['boundary']) is None,
              'tier off: a coastal zone keeps boundary -- the file the map draws')
        check(A.deletable('coast_savannah_ga', A.LAYERS['depth_areas']) is None,
              'tier off: a coastal zone keeps depth_areas')

        # the rules that are NOT about the tier must still fire
        check(A.deletable('coast_charleston_sc', pipeline_file) == 'pipeline-only',
              'tier off: a pipeline-only layer is still deletable (%s)' % pipeline_file)
        slug = sorted(A.SKIP_SLUGS)[0]
        check(A.deletable(slug, heavy) == 'skip-slug',
              'tier off: %s is still a skip-slug' % slug)
        check(A.deletable('coast_charleston_sc', 'index.json') is None,
              'a filename the uploader does not own is never judged')

        # ── tier ON, the behaviour the rule was written for ──────────────────────────────
        A.COASTAL_PRIMARY = {'coast_charleston_sc'}
        check(A.deletable('coast_charleston_sc', heavy) is None,
              'tier on: a PRIMARY zone keeps %s' % heavy)
        check(A.deletable('coast_savannah_ga', heavy) == 'coastal-secondary',
              'tier on: a SECONDARY zone drops %s' % heavy)
        check(A.deletable('coast_savannah_ga', kept) is None,
              'tier on: a secondary zone keeps %s' % kept)
        check(A.deletable('lake_wateree', heavy) is None,
              'tier on: the coastal rule never touches a lake pack')
    finally:
        A.COASTAL_PRIMARY = saved

    print('\n%s  %d failure(s)' % ('FAILED' if FAIL else 'ALL PASS', len(FAIL)))
    for f in FAIL:
        print('   - ' + f)
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
