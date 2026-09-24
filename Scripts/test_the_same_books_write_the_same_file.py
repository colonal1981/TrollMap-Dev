#!/usr/bin/env python3
r"""test_the_same_books_write_the_same_file.py -- a phrase tie in the species vocabulary is broken
by the spelling, not by Python's string hashing.

    py .\scripts\test_the_same_books_write_the_same_file.py

No network. Spawns a few short python processes with different PYTHONHASHSEED values, because the
bug only shows ACROSS processes: within one, a set of strings iterates the same way every time.

THE BUG. species_in_sentence() walks registry/species_map.json's phrases longest first, and the
phrases come out of a set. `Largemouth Bass` and `LARGEMOUTH BASS` are both in it, both fifteen
characters, and both match Georgia's PFA sentence `Largemouth bass between 16 and 24 inches must
be released immediately`. Two rebuilds from the same books on 2026-09-24 wrote Dodge County PFA
and Hugh M. Gillis PFA once with each spelling -- a diff that was nothing but the hash seed, in
the file whose diffs are how a real change gets reviewed.

Personal use only, not for distribution or resale; not for navigation.
"""
import json, os, subprocess, sys

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

SENTENCE = ('Largemouth bass between 16 and 24 inches must be released immediately. Bass up to 16 '
            'inches and over 24 inches can be kept (limit 5 per person).')
SMAP = {'book_phrases': {'LARGEMOUTH BASS': {}, 'Largemouth Bass': {}, 'Bass': {},
                         'Largemouth bass': {}, 'Striped Bass': {}}}

PROG = r'''
import importlib.util, json, sys
s = importlib.util.spec_from_file_location("b", sys.argv[1])
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
smap = json.loads(sys.argv[2]) if sys.argv[2] != "-" else json.load(open(sys.argv[4], encoding="utf-8"))
print(m.species_in_sentence(sys.argv[3], smap))
'''

def run(seed, smap_arg, smap_path=''):
    env = dict(os.environ, PYTHONHASHSEED=str(seed))
    p = subprocess.run([sys.executable, '-c', PROG, os.path.join(_HERE, 'build_regulations_table.py'),
                        smap_arg, SENTENCE, smap_path],
                       capture_output=True, text=True, encoding='utf-8', env=env)
    if p.returncode != 0:
        return 'ERROR: ' + (p.stderr or '').strip()[-300:]
    return p.stdout.strip()

SEEDS = range(8)

print('\nthe vocabulary built here')
got = {run(s, json.dumps(SMAP)) for s in SEEDS}
check('eight hash seeds give ONE answer', len(got), 1)
check('and it is the spelling the published table has carried', sorted(got), ['Largemouth Bass'])

print('\nthe shipped registry/species_map.json')
sp = os.path.join(ROOT, 'registry', 'species_map.json')
if os.path.exists(sp):
    got = {run(s, '-', sp) for s in SEEDS}
    check('eight hash seeds give ONE answer on the real vocabulary', len(got), 1)
    print('        answer: %s' % ', '.join(sorted(got)))
else:
    print('   .... no %s -- live case skipped' % sp)

print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                else 'all checks passed'))
sys.exit(1 if FAILED else 0)
