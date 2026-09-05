#!/usr/bin/env python3
r"""test_audit_limnology_gaps.py -- run with `py .\scripts\test_audit_limnology_gaps.py`.

WHAT THIS GUARDS. The ledger's job is to say what is standing between the app and a thermocline,
and on 2026-09-05 it turned out there can be TWO things at once. Lake Bowen carries 43 summer
depth-bearing oxygen records that the Worker cannot see for two independent reasons -- they are
before its 2015 window, AND they are only in the WQX 3.0 service while it asks 2.2. The probe's
headline counts are the best of the two dialects, so both waters look identical here.

The report used to print "THE 2015 WINDOW IS THE ONLY THING IN THE WAY" over that row. Widening
the window alone returns nothing for Bowen, and the report would have been the reason someone
believed the widening was broken.
"""
from __future__ import annotations
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import audit_limnology_gaps as A

FAILS = []
RAN = []


def check(name, got, want):
    RAN.append(name)
    if got != want:
        FAILS.append('%s: got %r, want %r' % (name, got, want))


LAKE = {'feature_type': 'lake', 'display_name': 'A Lake', 'state': 'SC', 'area_acres': 1463.2}


def probe(hidden, legacy_hidden=None, wqx3=True, wqx3_error=False, legacy_error=False):
    by = {}
    if legacy_hidden is not None or legacy_error:
        by['legacy'] = ({'error': 'timed out'} if legacy_error
                        else {'hidden_summer_do_depth_recs': legacy_hidden})
    if wqx3 or wqx3_error:
        by['wqx3'] = ({'error': 'timed out'} if wqx3_error
                      else {'hidden_summer_do_depth_recs': hidden})
    return {'hidden_summer_do_depth_recs': hidden, 'distinct_2ft_bins': 8,
            'max_depth_ft': 32.2, 'hidden_organizations': ['USGS'], 'by_api': by}


# --- 1. the ceiling, or the ceilings ----------------------------------------------------------

# Lake Bowen as measured: 43 in 3.0, 0 in 2.2.
bowen = probe(43, legacy_hidden=0)
check('Bowen is hidden by two things', A.hidden_by(bowen, 43),
      ['the 2015 window',
       'the 2.2 service the Worker asks -- these records are only in WQX 3.0'])

# Lake Moultrie as measured: both dialects see it, only the window is in the way.
moultrie = probe(2788, legacy_hidden=2788)
check('Moultrie is hidden by one thing', A.hidden_by(moultrie, 2788), ['the 2015 window'])

# The 2026-09-04 census: a legacy leg and no 3.0 leg at all, because the sweep was told to skip it.
check('a census that never asked 3.0 says so, rather than implying nothing is there',
      A.hidden_by(probe(2788, legacy_hidden=2788, wqx3=False), 2788),
      ['the 2015 window',
       'unknown -- the 3.0 service was not asked; re-run the probe with --api both'])
check('and a 3.0 leg that failed is not a 3.0 leg that answered',
      A.hidden_by(probe(2788, legacy_hidden=2788, wqx3=False, wqx3_error=True), 2788)[1][:7],
      'unknown')
check('a failed legacy leg cannot accuse the 2.2 service of hiding anything',
      A.hidden_by(probe(43, legacy_error=True), 43), ['the 2015 window'])
check('no probe at all is still honest about what it does not know',
      A.hidden_by(None, 0),
      ['the 2015 window',
       'unknown -- the 3.0 service was not asked; re-run the probe with --api both'])

# The boundary is the rule's own threshold: three records.
check('two records in 2.2 is not enough for the Worker either',
      len(A.hidden_by(probe(43, legacy_hidden=2), 43)), 2)
check('three records in 2.2 means the window really is the only ceiling',
      A.hidden_by(probe(43, legacy_hidden=3), 43), ['the 2015 window'])

# --- 2. and it reaches the verdict ------------------------------------------------------------

state, detail = A.classify(LAKE, {}, {}, bowen)
check('Bowen is still a window verdict', state, 'window_is_hiding_it')
check('and the verdict carries both ceilings', len(detail['hidden_by']), 2)
check('and still carries the count that earned it', detail['hidden_summer_do_depth_recs'], 43)

state2, detail2 = A.classify(LAKE, {}, {}, moultrie)
check('Moultrie carries one', detail2['hidden_by'], ['the 2015 window'])

# A REFUSAL IS NOT A VERDICT ABOUT THE LAKE. Two records is under the rule's three, so the water
# does not reach this branch at all and must not be labelled as though the window were the issue.
state3, _d3 = A.classify(LAKE, {}, {}, probe(2, legacy_hidden=2))
check('two hidden records is not a hidden profile', state3 == 'window_is_hiding_it', False)

# --- 3. what the app already shows still wins -------------------------------------------------

shown = {'limnology': {'thermocline': {'summerDepthFt': 22.5, 'method': 'wqp'}}}
state4, detail4 = A.classify(LAKE, shown, {}, bowen)
check('a depth the app already shows outranks the probe', state4, 'answered')
check('and it is the number the app shows', detail4['depthFt'], 22.5)

# --- 4. a river is not a lake -----------------------------------------------------------------

state5, _d5 = A.classify(dict(LAKE, feature_type='river'), {}, {}, bowen)
check('a river does not stratify', state5, 'not_applicable')

if FAILS:
    print('FAIL (%d)' % len(FAILS))
    for f in FAILS:
        print('   ' + f)
    sys.exit(1)
print('ok  -- %d checks: the ledger names every ceiling, not just the first one' % len(RAN))
