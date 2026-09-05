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


def probe(hidden, legacy_hidden=None, wqx3=True, wqx3_error=False, legacy_error=False, bins=8,
          lo=0.1, hi=32.2):
    by = {}
    if legacy_hidden is not None or legacy_error:
        by['legacy'] = ({'error': 'timed out'} if legacy_error
                        else {'hidden_summer_do_depth_recs': legacy_hidden})
    if wqx3 or wqx3_error:
        by['wqx3'] = ({'error': 'timed out'} if wqx3_error
                      else {'hidden_summer_do_depth_recs': hidden})
    return {'hidden_summer_do_depth_recs': hidden, 'distinct_2ft_bins': bins,
            'min_depth_ft': lo, 'max_depth_ft': hi,
            'hidden_organizations': ['USGS'], 'by_api': by}


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
# A LEG THAT FAILED IS NOT A LEG THAT WAS NEVER ASKED. The first version said "not asked; re-run
# with --api both" over Badin Lake, which HAD been asked that way and got HTTP 500 -- sending Ryan
# to do the thing he had just done.
_failed = A.hidden_by(probe(2788, legacy_hidden=2788, wqx3=False, wqx3_error=True), 2788)
check('a failed 3.0 leg says it failed', 'failed' in _failed[1], True)
check('and does not tell him to re-run what he already ran',
      're-run the probe with --api both' in _failed[1], False)
check('and quotes the failure so he can judge it', 'timed out' in _failed[1], True)

# A LEG SKIPPED ON PURPOSE IS NOT A CEILING. After the probe learned to stop asking 3.0 about a
# lake 2.2 had answered, those legs carry `not_asked` -- and nothing is standing in the way there
# except the window.
_skipped = {'hidden_summer_do_depth_recs': 2788, 'distinct_2ft_bins': 30,
            'by_api': {'legacy': {'hidden_summer_do_depth_recs': 2788},
                       'wqx3': {'not_asked': '2.2 already found 2788'}}}
check('a deliberate skip is not a second ceiling',
      A.hidden_by(_skipped, 2788), ['the 2015 window'])
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

# --- 2b. A STACK OF GRABS IS NOT A CAST -------------------------------------------------------
# The three waters that crossed the three-record line for the first time on the both-dialect
# census. Only one of them is a profile, and counting records alone cannot tell them apart --
# which is the Wateree mistake exactly.

# Lake Bowen: 43 records over 8 bins, 0.1 to 32.2 ft.
check('a real cast is a hidden profile', A.classify(LAKE, {}, {}, bowen)[0], 'window_is_hiding_it')

# Cherokee Lake: 60 records, but two depths 220 ft apart.
cherokee = probe(60, legacy_hidden=0, bins=2, lo=0.0, hi=220.0)
st_c, d_c = A.classify(LAKE, {}, {}, cherokee)
check('sixty records in two bands is not a profile', st_c, 'needs_a_source')
check('and it is filed by what is wrong with it', d_c['reason'], 'records without a column')
check('and the count is not hidden from the reader', d_c['hidden_summer_do_depth_recs'], 60)
check('nor is the spread', d_c['distinct_2ft_bins'], 2)
check('and the sentence says what a person would say',
      'A stack of grabs, not a cast.' in d_c['why'], True)

# Watauga Lake: eight grabs, every one at one foot.
watauga = probe(8, legacy_hidden=0, bins=1, lo=1.0, hi=1.0)
check('eight grabs at one foot is not a profile',
      A.classify(LAKE, {}, {}, watauga)[0], 'needs_a_source')

# THE BOUNDARY IS THE RULE'S OWN NUMBER, BOTH TIMES.
check('two bands is under it', A.classify(LAKE, {}, {}, probe(43, legacy_hidden=0, bins=2))[0],
      'needs_a_source')
check('three bands clears it', A.classify(LAKE, {}, {}, probe(43, legacy_hidden=0, bins=3))[0],
      'window_is_hiding_it')

# A DEPTH WE ALREADY HOLD STILL BEATS A REFUSAL. Cherokee must not become a gap when NLA has
# drawn it -- the branch order matters and this is the assertion that pins it.
nla = {'visits': [{'year': '2012', 'thermoclineFt': 21.3, 'readings': 15,
                   'thermoclineNote': 'steepest gradient 1.5 C/m at 6.5 m'}]}
st_n, d_n = A.classify(LAKE, {}, nla, cherokee)
check('NLA outranks records-without-a-column', st_n, 'nla_unused')
check('and hands over the depth it holds', d_n['depthFt'], 21.3)


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
print('ok  -- %d checks: the ledger names every ceiling, and counts the spread and '
      'not just the records' % len(RAN))
