#!/usr/bin/env python3
r"""test_the_batch_offers_what_the_preset_says.py -- the mirror was inverted on its first line.

    py .\scripts\test_the_batch_offers_what_the_preset_says.py

No network. Reads registry/lake_index.json and the app's own js/data/water-filter.js; SKIPS with a
non-zero exit if either is absent.

THE BUG. `load_lakes()` in research_lakes.py carries the comment "PRESETS.research in
js/data/water-filter.js: minAcres 1000, includeRivers false. Mirrored rather than reinvented -- if
that preset changes, this must follow it." The preset it names reads:

    keep: (rec, { bath, isCoastal, isRiver, acres }, cfg) => {
      if (isCoastal) return true;
      if (isRiver && !cfg.includeRivers) return false;
      return bath !== 'no' && acres >= (cfg.minAcres ?? 1000);
    }

The script inverted the FIRST line: `feature_type != "lake"` plus `slug.startswith("coast_")`
dropped exactly the waters the preset admits before it looks at anything else. So the batch has
never offered a coastal zone. The preset's own label says why it is written that way -- Ryan asked
for a filter *"mainly for coastal and large impoundments"*.

64 offered against the preset's 80. All sixteen coastal zones were the difference.

THE TEST READS THE PRESET, NOT A COPY OF IT. A mirror asserted against a restatement of the thing
it mirrors is not a mirror; that is how this one drifted in the first place.

Personal use only, not for distribution or resale; not for navigation.
"""
import importlib.util, io, json, os, re, sys

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

reg = os.path.join(ROOT, 'registry', 'lake_index.json')
wf = os.path.join(ROOT, 'TrollMap-Dev', 'js', 'data', 'water-filter.js')
if not os.path.exists(reg) or not os.path.exists(wf):
    print('SKIP -- need registry/lake_index.json and TrollMap-Dev/js/data/water-filter.js')
    sys.exit(2)

_s = importlib.util.spec_from_file_location('r', os.path.join(_HERE, 'research_lakes.py'))
R = importlib.util.module_from_spec(_s); _s.loader.exec_module(R)
idx = json.load(io.open(reg, encoding='utf-8'))
src = io.open(wf, encoding='utf-8').read()

print('\nthe preset, read out of the app')
block = src[src.index('  research: {'):]
block = block[:block.index('\n  },')]
check('minAcres is 1000', re.search(r'minAcres:\s*(\d+)', block).group(1), '1000')
check('includeRivers is false', re.search(r'includeRivers:\s*(\w+)', block).group(1), 'false')
# The line the script inverted.
check('COASTAL PASSES BEFORE ANYTHING ELSE',
      bool(re.search(r'if\s*\(isCoastal\)\s*return true;', block)), True)
check('and a river is the one behind the switch',
      bool(re.search(r'if\s*\(isRiver\s*&&\s*!cfg\.includeRivers\)\s*return false;', block)), True)

class A:
    min_acres = 1000
    include_rivers = False
    lake = None
    todo = None
    from_report = None
    repo = 'TrollMap-Dev'
    state = None

# load_lakes reaches for --todo/--lake branches first; the registry branch is what this tests.
offered = R.load_lakes(A(), os.path.join(ROOT, 'registry'))
names = {n for n, _st, _al in offered}
slugs = {s for s, r in idx.items()
         if (r.get('display_name') or r.get('name') or s) in names}
coastal = {s for s, r in idx.items()
           if str(r.get('feature_type') or '').lower() == 'coastal' or s.startswith('coast_')}
rivers = {s for s, r in idx.items() if str(r.get('feature_type') or '').lower() == 'river'}
big = {s for s, r in idx.items()
       if str(r.get('feature_type') or '').lower() == 'lake' and (r.get('area_acres') or 0) >= 1000}

print('\nwhat the batch offers now')
check('every coastal zone is offered', sorted(coastal - slugs), [])
check('no river is offered without the switch', sorted(rivers & slugs), [])
check('every lake at or over 1000 acres is offered', sorted(big - slugs), [])
check('and nothing else is', sorted(slugs - (coastal | big)), [])
print('        %d water(s): %d coastal + %d lakes >= 1000 ac' % (len(slugs), len(coastal), len(big)))

A2 = type('A2', (A,), {'include_rivers': True})
riv = {n for n, _s, _a in R.load_lakes(A2(), os.path.join(ROOT, 'registry'))}
check('--include-rivers admits them', len(riv) > len(names), True)
# A SUPERSET, AND ONLY RIVERS ADDED. Not "names plus every river": a river faces the acreage rule
# too once the switch is on -- the app's own line is `return bath !== 'no' && acres >= minAcres`
# AFTER the river gate, so 36 of the 58 pass and 22 are under 1,000 acres. Asserting the count
# instead of the shape is how a test ends up measuring my arithmetic rather than the code.
check('nothing already offered is lost', sorted(names - riv), [])
riv_slugs = {s for s, r in idx.items() if (r.get('display_name') or r.get('name') or s) in (riv - names)}
check('and everything new is a river', sorted(riv_slugs - rivers), [])
print('        --include-rivers: %d water(s), +%d rivers (%d of the %d are under %d ac)'
      % (len(riv), len(riv) - len(names), len(rivers) - len(riv_slugs), len(rivers), A.min_acres))

print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                else 'all checks passed'))
sys.exit(1 if FAILED else 0)
