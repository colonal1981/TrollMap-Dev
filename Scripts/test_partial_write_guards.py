#!/usr/bin/env python3
r"""test_partial_write_guards.py -- a narrowed run may not replace a whole-registry file.

    py .\scripts\test_partial_write_guards.py

SKIPS the end-to-end half if the agency page folders are not beside the root. No network.

THE FAILURE THIS GUARDS, WHICH ALREADY HAPPENED. Both builders rebuild their object from
scratch and replace the file. So a run narrowed to one state does not update that state -- it
DELETES the others. On 2026-09-02 `build_agency_lake_facts.py --state GA` was run to iterate on
a reader and took registry/agency_lake_facts.json from 83 waters to 16. Ryan rebuilt it by hand.
The same afternoon `build_dnr_ramps_by_lake.py --state ga --state sc --go` was one keystroke
from doing it to dnr_ramps_by_lake.json, which holds GA 307, SC 299, NC 120, TN 125.

A DRY RUN CANNOT SHOW EITHER OF THEM. Nothing is written, so nothing looks wrong -- which is why
the guards are asserted here rather than trusted to be noticed.

Personal use only, not for distribution or resale; not for navigation.
"""
import importlib.util, json, os, subprocess, sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_UP1 = os.path.dirname(_HERE)
ROOT = _UP1 if os.path.isdir(os.path.join(_UP1, 'registry')) else os.path.dirname(_UP1)

FAILED = []
def check(name, got, want):
    if got == want:
        print('   ok   %s' % name)
    else:
        FAILED.append(name)
        print('   FAIL %s\n        got  %r\n        want %r' % (name, got, want))

# ── the ramps build: which feeds a run did not fetch ────────────────────────────────────────
_s = importlib.util.spec_from_file_location('b', os.path.join(_HERE, 'build_dnr_ramps_by_lake.py'))
B = importlib.util.module_from_spec(_s); _s.loader.exec_module(B)

print('\nbuild_dnr_ramps_by_lake -- states_missing()')
check('all four is safe',                B.states_missing(['sc', 'nc', 'ga', 'tn']), [])
check('case does not matter',            B.states_missing(['SC', 'NC', 'GA', 'TN']), [])
check('ga+sc would delete NC and TN',    B.states_missing(['ga', 'sc']), ['NC', 'TN'])
check('ga alone would delete three',     B.states_missing(['ga']), ['SC', 'NC', 'TN'])

# ── the agency-facts build: end to end, because its guard has no --go to hide behind ────────
facts = os.path.join(ROOT, 'registry', 'agency_lake_facts.json')
folders = [os.path.join(ROOT, d) for d in ('Georgia_Lakes', 'Tennessee_Lakes')]
if not os.path.exists(facts) or not any(os.path.isdir(d) for d in folders):
    print('\nSKIP the end-to-end half -- no registry/agency_lake_facts.json or page folders')
    print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                    else 'all checks passed'))
    sys.exit(1 if FAILED else 0)

before = (os.path.getsize(facts), len(json.load(open(facts, encoding='utf-8'))['rows']))
print('\nbuild_agency_lake_facts -- a narrowed run against the real output path')
print('   .... %s currently holds %d waters' % (os.path.basename(facts), before[1]))
proc = subprocess.run([sys.executable, os.path.join(_HERE, 'build_agency_lake_facts.py'),
                       '--root', ROOT, '--state', 'GA', '--limit', '1'],
                      capture_output=True, text=True, encoding='utf-8', errors='replace')
check('a narrowed run exits 2', proc.returncode, 2)
check('and says so', 'REFUSING TO WRITE A PARTIAL FILE' in (proc.stdout or ''), True)
after = (os.path.getsize(facts), len(json.load(open(facts, encoding='utf-8'))['rows']))
check('the real file is untouched', after, before)

print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                else 'all checks passed'))
sys.exit(1 if FAILED else 0)
