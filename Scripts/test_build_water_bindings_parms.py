#!/usr/bin/env python3
"""
test_build_water_bindings_parms.py -- pins what a bound USGS site records about itself.

    py .\\scripts\\test_build_water_bindings_parms.py

`build_water_bindings.py` used to write `sorted(g['parms'] & LEVEL_PARMS)` -- it fetched 00010
and 63680 for every site and then intersected them away one line before writing. The Worker
paid for that twice: `conditions.js:siteParameters` re-fetches a series catalogue per site, up
to four per water block, at runtime, to relearn what was already on disk.

Both of the obvious fixes are wrong and this pins why. Read `written_parms` for the measurements.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_water_bindings import written_parms                       # noqa: E402

LEVEL = {'00062', '62614', '62615', '00065', '00060'}
FAILED = []


def check(label, got, want):
    if got != want:
        FAILED.append(label)
        print('FAIL %-56s got %r want %r' % (label, got, want))
    else:
        print('ok   %-56s %r' % (label, got))


# The Wateree tailrace: live flow, stage, temperature, oxygen and NAVD88 elevation.
check('live codes are all recorded, not just the level ones',
      written_parms({'00010', '00060', '00065', '00300', '63160'},
                    {'00010', '00060', '00065', '00300', '63160'}, LEVEL),
      ['00010', '00060', '00065', '00300', '63160'])

# A grab-sample-only code must NOT be written: it cannot answer a live request.
check('a qw-only code stays out',
      written_parms({'00060'}, {'00060', '00010', '00400', '71999'}, LEVEL),
      ['00060'])

# 02171000, Lake Marion near Pineville: 00060 exists only as a daily-values series. Taking the
# uv set alone would drop it, and 13 other bound sites with it.
check('a level code that is dv-only is NOT lost',
      written_parms({'00062', '62615'}, {'00060', '00062', '62615'}, LEVEL),
      ['00060', '00062', '62615'])

check('the result can only grow -- old level set is always a subset',
      set(written_parms({'00010'}, {'00060', '00065', '00010'}, LEVEL))
      >= ({'00060', '00065', '00010'} & LEVEL), True)

check('a site with no live series still records its level codes',
      written_parms(set(), {'00065', '00010'}, LEVEL), ['00065'])

check('empty in, empty out', written_parms(set(), set(), LEVEL), [])
check('None is tolerated', written_parms(None, None, LEVEL), [])
check('output is sorted and deduped',
      written_parms({'00065', '00010'}, {'00010', '00065'}, LEVEL), ['00010', '00065'])

print('\n%s' % ('ALL PASSED' if not FAILED else 'FAILED: %s' % ', '.join(FAILED)))
sys.exit(1 if FAILED else 0)
