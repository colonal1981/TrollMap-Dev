#!/usr/bin/env python3
r"""test_coastal_species_map.py -- the coast reaches the plan form's checkboxes.

    py .\scripts\test_coastal_species_map.py

Reads registry/species_map.json and registry/regulations_table.json beside the pipeline root and
SKIPS if they are not there. No network and no PDFs: expand_species() is pure, which is the
point -- rebuilding the table needs four regulation books and this half does not.

WHAT BROKE. Two branches in build_regulations_table.py short-circuited on
`implicitly == 'statewide coastal'` and wrote `plan_species: []` with the basis "coastal species
-- the freshwater plan form has no checkbox for it". True when written; false from 2026-09-02,
when the form's nineteen-box saltwater catalogue went into plan_species.values. The cost was not
cosmetic: an SC or GA coastal water reached checkPlanLegality() with no species on any rule, so
a slot limit governed no checkbox and the planner was told the book says nothing.

Personal use only, not for distribution or resale; not for navigation.
"""
import json, os, sys, importlib.util

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(_HERE)
MAP = os.path.join(ROOT, 'registry', 'species_map.json')
TBL = os.path.join(ROOT, 'registry', 'regulations_table.json')
if not os.path.exists(MAP) or not os.path.exists(TBL):
    print('SKIP -- no registry/species_map.json or regulations_table.json beside the root')
    sys.exit(0)

_s = importlib.util.spec_from_file_location('brt', os.path.join(_HERE, 'build_regulations_table.py'))
B = importlib.util.module_from_spec(_s); _s.loader.exec_module(B)
SMAP = json.load(open(MAP, encoding='utf-8'))
TABLE = json.load(open(TBL, encoding='utf-8'))

FAILED = []
def check(name, got, want):
    if got == want:
        print('   ok   %s' % name)
    else:
        FAILED.append(name)
        print('   FAIL %s\n        got  %r\n        want %r' % (name, got, want))

def plan(phrase):
    return B.expand_species(phrase, SMAP)['plan_species']

print('\nthe five Ryan fishes, in whichever way each book spells them')
check('SC  Red Drum',                    plan('Red Drum'), ['Red Drum (Redfish)'])
check('NC  RED DRUM (CHANNEL BASS, ...)',
      plan('RED DRUM (CHANNEL BASS, RED FISH, OR PUPPY DRUM)'), ['Red Drum (Redfish)'])
# GEORGIA'S IS THE ONE THAT WAS BROKEN TWICE OVER: a bracketed alias list the map does not
# declare, and a footnote marker outside the bracket. Both are stripped, in that order, only
# after every exact test has failed.
check('GA  Red drum (Channel bass, ...)**B',
      plan('Red drum (Channel bass, Spottail bass, Redfish)**B'), ['Red Drum (Redfish)'])
check('SC  Spotted Seatrout',            plan('Spotted Seatrout'), ['Speckled Trout (Spotted Seatrout)'])
check('GA  Spotted seatrout',            plan('Spotted seatrout'), ['Speckled Trout (Spotted Seatrout)'])
check('NC  SPOTTED SEATROUT',            plan('SPOTTED SEATROUT'), ['Speckled Trout (Spotted Seatrout)'])
check('SC  Flounders (Southern, Summer & Gulf)',
      plan('Flounders (Southern, Summer & Gulf)'), ['Southern Flounder'])
check('GA  Flounder',                    plan('Flounder'), ['Southern Flounder'])
check('SC  Black Drum',                  plan('Black Drum'), ['Black Drum'])
check('SC  Sheepshead',                  plan('Sheepshead'), ['Sheepshead'])

print('\none row of the book, three fish on the form')
check('SC  Atlantic Croaker, Spot, Whiting', plan('Atlantic Croaker, Spot, Whiting'),
      ['Atlantic Croaker', 'Spot', 'Whiting (Southern Kingfish)'])

print('\na fish with no checkbox says so, and is not an UNMAPPED phrase')
for phrase in ('Wahoo', 'Blue Marlin', 'Red Snapper', 'Bigeye Tuna', 'Atlantic sturgeon'):
    check('%-22s -> declared, no box' % phrase,
          B.expand_species(phrase, SMAP)['basis'], 'no checkbox for this fish')

print('\nthe bracket strip is a LAST resort -- a declared phrase that needs its brackets wins')
# Georgia's own aggregate row is declared with the bracket in it, and the head alone would be a
# different rule: "all game fish" and "all game fish except catfish" are not the same permission.
check('Aggregate of all game fish (does not include catfish) stays declared',
      B.expand_species('Aggregate of all game fish (does not include catfish)', SMAP)['basis'],
      'no checkbox for this fish')

print('\nNOT ONE COASTAL PHRASE IN THE THREE BOOKS COMES BACK UNMAPPED')
unmapped = []
for st in ('SC', 'GA', 'NC'):
    for row in TABLE['statewide'][st]:
        sp = row.get('species')
        if not sp:
            continue
        if row.get('scope') == 'statewide coastal' or str(row.get('species_basis', '')).startswith('coastal'):
            if B.expand_species(sp, SMAP)['basis'] == 'UNMAPPED':
                unmapped.append('%s %s' % (st, sp))
check('unmapped coastal phrases', unmapped, [])

print('\nAND NOTHING THAT ALREADY MAPPED CHANGES ITS ANSWER')
# The regression that matters: this fix reaches every row in the file, not only the coastal
# ones, because the bracket fallback is new for all of them.
rows = [r for st in ('SC', 'GA', 'NC', 'TN') for r in TABLE['statewide'][st]]
for _w, rr in (TABLE.get('by_water') or {}).items():
    rows += rr if isinstance(rr, list) else []
same = newly = 0
moved = []
for r in rows:
    sp, was = r.get('species'), r.get('plan_species')
    if not sp or was is None:
        continue
    now = B.expand_species(sp, SMAP)['plan_species']
    if sorted(was) == sorted(now):
        same += 1
    elif not was and now:
        newly += 1
    else:
        moved.append((sp, was, now))
check('rows whose mapping moved', moved, [])
print('   .... %d unchanged, %d newly mapped' % (same, newly))
if newly == 0:
    FAILED.append('nothing was newly mapped -- the coastal branches are still short-circuiting')
    print('   FAIL nothing was newly mapped')

print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                else 'all checks passed'))
sys.exit(1 if FAILED else 0)
