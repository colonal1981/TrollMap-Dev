#!/usr/bin/env python3
r"""test_ga_access_species.py -- the JS and the Python read Georgia's 48 columns the same way.

    py .\scripts\test_ga_access_species.py

Reads WRD_Water_Access_Points_*.geojson beside the pipeline root and SKIPS if it is not there.
Needs node, because the point of the test is that both runtimes agree -- if node is missing the
Python cannot read the table either and the build would have failed anyway.

WHY THIS TEST EXISTS. build_dnr_ramps_by_lake.py keeps its SOURCE PREDICATE independent from the
Worker's on purpose, and says so: a second implementation is what catches a filter that silently
rejects every row. That argument does not extend to a table of forty-eight abbreviations. A
wrong predicate shows up as a count of zero; `HybStrpBas` mapped to the wrong fish is a wrong
fish that looks exactly like a right one. So the table has one home and this asserts that both
readers land on the same answer for every access point Georgia publishes.

Personal use only, not for distribution or resale; not for navigation.
"""
import glob, json, os, subprocess, sys, importlib.util

_HERE = os.path.dirname(os.path.abspath(__file__))
_UP1 = os.path.dirname(_HERE)                 # TrollMap-Dev/  or  TrollMapPipeline/
_UP2 = os.path.dirname(_UP1)                  # TrollMapPipeline/ when this is the repo copy

# THE SCRIPT IS DELIVERED TO TWO DIRECTORIES AND THE DOWNLOAD SITS IN ONE OF THEM. Looking only
# beside `..` made the repo copy print SKIP forever -- a check that cannot run is not a check
# that passed, which is the failure this codebase has written down more than once.
hits = (glob.glob(os.path.join(_UP1, 'WRD_Water_Access_Points*.geojson'))
        or glob.glob(os.path.join(_UP2, 'WRD_Water_Access_Points*.geojson')))
if not hits:
    print('SKIP -- no WRD_Water_Access_Points*.geojson in %s or %s' % (_UP1, _UP2))
    sys.exit(0)
REPO = _UP1 if os.path.isdir(os.path.join(_UP1, 'js', 'data')) else \
       os.path.join(_UP1, 'TrollMap-Dev')

_s = importlib.util.spec_from_file_location('bdr', os.path.join(_HERE, 'build_dnr_ramps_by_lake.py'))
B = importlib.util.module_from_spec(_s); _s.loader.exec_module(B)

FAILED = []
def check(name, got, want):
    if got == want:
        print('   ok   %s' % name)
    else:
        FAILED.append(name)
        print('   FAIL %s\n        got  %r\n        want %r' % (name, got, want))

FEATURES = json.load(open(hits[0], encoding='utf-8'))['features']
print('\n%s: %d access points' % (os.path.basename(hits[0]), len(FEATURES)))

# ── the JS answer for every point, in one node call ─────────────────────────────────────────
src = os.path.abspath(os.path.join(REPO, 'js', 'data', 'ga-access-species.js'))
script = (
    "import {readFileSync} from 'node:fs';"
    "const m = await import(%s);"
    "const F = JSON.parse(readFileSync(%s,'utf8')).features;"
    "process.stdout.write(JSON.stringify(F.map(f => m.gaAccessSpecies(f.properties))));"
    % (json.dumps('file://' + src.replace(os.sep, '/')), json.dumps(hits[0]))
)
proc = subprocess.run(['node', '--input-type=module', '-e', script],
                      capture_output=True, text=True, encoding='utf-8')
if proc.returncode != 0:
    print('FAIL -- node could not run gaAccessSpecies: %s' % (proc.stderr or '').strip()[:300])
    sys.exit(1)
JS = json.loads(proc.stdout)
PY = [B.ga_species(f['properties']) for f in FEATURES]

check('the two runtimes agree on every access point',
      sum(1 for a, b in zip(JS, PY) if a != b), 0)
if JS != PY:
    for i, (a, b) in enumerate(zip(JS, PY)):
        if a != b:
            print('        first disagreement at %d: js=%r py=%r' % (i, a, b))
            break

with_species = [s for s in PY if s]
waterbodies = {f['properties'].get('Waterbody') for f, s in zip(FEATURES, PY) if s}
print('\ncounted 2026-09-02 and asserted here so a layer change is visible')
check('access points carrying at least one species', len(with_species), 892)
check('distinct waterbodies with species', len(waterbodies - {None, ''}), 373)

# ── U IS NOT A YES ──────────────────────────────────────────────────────────────────────────
# The layer's whole vocabulary is Y, N, U, None and blank. `U` is unknown; a fish nobody has
# confirmed is not a fish on the roster, and reading it as one would put species on waters that
# have never been surveyed for them.
print('\nonly Y counts')
check("U is not a yes", B.ga_species({'Largemouth': 'U', 'Bluegill': 'Y'}), 'Bluegill')
check("N is not a yes", B.ga_species({'Largemouth': 'N', 'Bluegill': 'Y'}), 'Bluegill')
check("blank is not a yes", B.ga_species({'Largemouth': ' ', 'Bluegill': 'Y'}), 'Bluegill')
check("None is not a yes", B.ga_species({'Largemouth': None, 'Bluegill': 'Y'}), 'Bluegill')
check('no columns at all is empty, not an error', B.ga_species({}), '')

# ── the names have to be names the app knows ────────────────────────────────────────────────
# Every column either canonicalises to a plan-form species or is deliberately dropped as forage
# or rough fish. A name that does neither is a roster entry nobody can tick.
print('\nevery column lands somewhere the app understands')
cols = B._ga_species_columns()
check('columns read from the one definition', len(cols), 48)
script2 = (
    "const u = await import(%s);"
    "const names = %s;"
    "const out = names.map(n => {const c = u.uniqueResearchSpecies([n]); "
    "return [n, c.length ? c[0] : null];});"
    "process.stdout.write(JSON.stringify(out));"
    % (json.dumps('file://' + os.path.abspath(
        os.path.join(REPO, 'Worker', 'research', 'facts-util.js')).replace(os.sep, '/')),
       json.dumps(sorted(set(cols.values()))))
)
p2 = subprocess.run(['node', '--input-type=module', '-e', script2],
                    capture_output=True, text=True, encoding='utf-8')
if p2.returncode != 0:
    print('FAIL -- node could not run uniqueResearchSpecies: %s' % (p2.stderr or '').strip()[:200])
    sys.exit(1)
resolved = json.loads(p2.stdout)
dropped = [n for n, c in resolved if c is None]
kept = [(n, c) for n, c in resolved if c is not None]
# The forage and rough fish Georgia lists and the app deliberately never puts on a roster.
check('dropped as forage or rough fish', sorted(dropped),
      ['American Shad', 'Common Carp', 'Freshwater Drum', 'Hickory Shad', 'Longnose Gar',
       'Smallmouth Buffalo'])
print('   .... %d of %d column names reach a species' % (len(kept), len(resolved)))
for n, c in kept:
    if n != c:
        print('        %-28s -> %s' % (n, c))

# ── THE PADDLE LAUNCHES, WHICH ARE THE ACCESS A KAYAK ACTUALLY USES ────────────────────────
#
# The species counter added to the ramps build found this the first time it ran:
#
#     ramps  GA   659 pts, 218 waterbodies      659 of 659 points name a fish
#     paddle GA   722 pts, 288 waterbodies        0 of 722 points name a fish
#
# Same layer, same 895 features, different source table -- fetch_dnr_paddle.py filters on
# CanoeAcc where the ramp build filters on Ramp, and its meta dropped the species. South
# Carolina had the same hole for the same reason: its paddle launches come off the identical
# layer as its ramps, filtered to a different WaterAccessType, so a paddle launch arrived with
# no fish while the boat ramp two hundred yards away arrived with ten.
print('\nthe paddle sources carry species too')
_p = importlib.util.spec_from_file_location('fdp', os.path.join(_HERE, 'fetch_dnr_paddle.py'))
P = importlib.util.module_from_spec(_p); _p.loader.exec_module(P)

ga_paddle = [f['properties'] for f in FEATURES if P.SOURCES['ga']['filter'](f['properties'])]
named = [p for p in ga_paddle if P.SOURCES['ga']['meta'](p).get('species')]
check('GA paddle launches naming a fish', len(ga_paddle) - len(named), 3)
print('   .... %d of %d GA canoe-access points name a fish' % (len(named), len(ga_paddle)))

# SC's paddle meta must ASK for the field its layer publishes. Asserted on a synthetic feature
# because the SC layer is not on the drive as a geojson -- what is being tested is the reader,
# not the data.
check('SC paddle meta carries SpeciesList',
      P.SOURCES['sc']['meta']({'SpeciesList': 'Bluegill, Redbreast Sunfish'}).get('species'),
      'Bluegill, Redbreast Sunfish')

# ONE DEFINITION ON THE PYTHON SIDE TOO. build_dnr_ramps_by_lake.py imports ga_species from
# fetch_dnr_paddle.py rather than keeping its own; a second copy is how the table drifts.
#
# Asserted on the SOURCE, not on object identity: this test loads fetch_dnr_paddle.py a second
# time under its own module name, so `B.ga_species is P.ga_species` is False for a reason that
# has nothing to do with the code -- a check that fails for the wrong reason is worse than none.
_bsrc = open(os.path.join(_HERE, 'build_dnr_ramps_by_lake.py'), encoding='utf-8').read()
check('the build script imports the shared reader',
      'ga_species' in _bsrc.split('SOURCES = {')[0] and '\ndef ga_species(' not in _bsrc, True)
check('and both reach the same 48 columns',
      P._ga_species_columns() == B._ga_species_columns(), True)

print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                else 'all checks passed'))
sys.exit(1 if FAILED else 0)
