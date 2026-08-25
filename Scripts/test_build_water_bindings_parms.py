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
from build_water_bindings import written_parms, ogc_rows_from, OGC_PERIOD_TO_DATA_TYPE  # noqa: E402

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


# ── the adapter has to say what NWIS says, or the split above is inert ───────────────────────
#
# ogc_rows_from() adapted every field of the successor's catalogue into the RDB row shape except
# `data_type_cd`, so the accumulator that fills parms_uv and parms_dv found neither on any of
# 3,930 sites and `written_parms` collapsed back to `parms & LEVEL_PARMS`. No symptom: the union
# it falls back to still produces a valid-looking answer.

def _loc(no, key):
    return {'id': key, 'geometry': {'type': 'Point', 'coordinates': [-81.0, 34.0]},
            'properties': {'monitoring_location_number': no,
                           'monitoring_location_name': 'TEST GAUGE', 'site_type_code': 'ST'}}


def _ts(key, pc, period, stat=None, end='2026-08-21T18:00:00Z'):
    return {'properties': {'monitoring_location_id': key, 'parameter_code': pc,
                           'computation_period_identifier': period,
                           'statistic_id': stat, 'end': end}}


LOCS = [_loc('02175148', 'k1')]
rows = ogc_rows_from(LOCS, [
    _ts('k1', '00065', 'Points', '00011'),
    _ts('k1', '00060', 'Daily', '00003'),
    _ts('k1', '00065', 'Water Year', None),
    _ts('k1', '00010', 'Unknown', None),
])
by = {(r['parm_cd'], r['data_type_cd']) for r in rows}
check('a Points series is uv -- one value per reading', ('00065', 'uv') in by, True)
check('a Daily series is dv -- Mean, Max, Min, Median, Tidal', ('00060', 'dv') in by, True)
# An annual flood peak is not a gauge. 1,341 of the 3,786 sites that pass the level filter have
# NOTHING but a Water Year peak on their level parameter -- the same trapdoor as counting `qw`
# grab samples as gauges. Naming it `pk` is what makes that countable.
check('a Water Year peak is pk, and is neither', ('00065', 'pk') in by, True)
check('an unrecognised period guesses nothing', ('00010', '') in by, True)
check('every row carries the key at all',
      all('data_type_cd' in r for r in rows), True)
check('the adapter still fills the rest of the RDB shape',
      all(r['site_no'] == '02175148' and r['end_date'] == '2026-08-21' for r in rows), True)
check('a series whose site has no geometry is dropped, not defaulted',
      ogc_rows_from([], [_ts('k1', '00065', 'Points', '00011')]), [])
check('the map itself is the three periods and nothing else',
      sorted(OGC_PERIOD_TO_DATA_TYPE.items()),
      [('Daily', 'dv'), ('Points', 'uv'), ('Water Year', 'pk')])
# THE POINT OF ALL OF IT: with the adapter fixed, a live thermistor reaches the written parms.
check('a live 00010 is written once the adapter reports uv',
      written_parms({'00065', '00010'}, {'00065', '00010', '00060'}, LEVEL),
      ['00010', '00060', '00065'])

print('\n%s' % ('ALL PASSED' if not FAILED else 'FAILED: %s' % ', '.join(FAILED)))
sys.exit(1 if FAILED else 0)
