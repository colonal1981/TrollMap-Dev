#!/usr/bin/env python3
r"""test_coastal_and_client_ramps.py -- a coastal zone the feed can never name, and the ramps
the batch never sent.

    py .\scripts\test_coastal_and_client_ramps.py

No network. Reads registry/lake_index.json and the four saved _dnr_*.json feeds; SKIPS with a
non-zero exit if they are absent rather than passing forever.

TWO HALVES OF ONE BUG, 2026-09-03. Ryan: *"why am i continuing if stuff is still broke"* and then
*"i swear you only fix half of everything."* He was right both times.

THE FIRST HALF. build_dnr_ramps_by_lake.py binds a name FIRST and uses geometry only to remove --
correct for lakes, because a park pond inside a reservoir's bbox is a different water. A coastal
zone cannot play: it is named for its sound and the feeds name the creek. SCDNR files Bennetts
Point under "Mosquito Creek", GA WRD files Fort McAllister under "Ogeechee River", and no zone is
called either. So the name pass was a guard that admits nothing, and all sixteen zones held zero
DNR ramps and zero DNR paddle launches while 246 agency points sat inside their boxes.

THE SECOND HALF. Fixing that file alone changes nothing the research batch sees.
handleResearchDeterministicFacts prefers `body.ramps` and says the pipeline's geometry join is the
better answer -- but research_lakes.py posted `{lakeName, state}` and nothing else, so the weaker
name-matching fallback is what actually ran on all 64 waters.

Personal use only, not for distribution or resale; not for navigation.
"""
import collections, importlib.util, io, json, os, sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_UP1 = os.path.dirname(_HERE)
ROOT = _UP1 if os.path.isdir(os.path.join(_UP1, 'registry')) else os.path.dirname(_UP1)
REG = os.path.join(ROOT, 'registry')

FAILED = []
def check(name, got, want):
    if got == want:
        print('   ok   %s' % name)
    else:
        FAILED.append(name)
        print('   FAIL %s\n        got  %r\n        want %r' % (name, got, want))

def _load(mod):
    s = importlib.util.spec_from_file_location(mod, os.path.join(_HERE, mod + '.py'))
    m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m

need = ['lake_index.json']
if any(not os.path.exists(os.path.join(REG, f)) for f in need):
    print('SKIP -- no registry/lake_index.json under %s' % REG)
    sys.exit(2)

B = _load('build_dnr_ramps_by_lake')
R = _load('research_lakes')
idx = json.load(io.open(os.path.join(REG, 'lake_index.json'), encoding='utf-8'))
zones = B.coastal_zones(idx)
coastal = [s for s, r in idx.items() if str(r.get('feature_type') or '').lower() == 'coastal']

print('\ncoastal_zones() -- who is allowed to compete')
check('every coastal row with a box is a candidate', len(zones), len(coastal))
# Two zones carry no county: consolidate takes it from the centroid and a sound's centroid is
# open water. Requiring one to enter the set cost Murrells Inlet all 18 of its ramps.
countyless = sorted(s for s, (_b, c) in zones.items() if not c)
check('a county-less zone still competes', len(countyless) >= 1, True)
print('        no county: %s' % (', '.join(x.replace('coast_', '') for x in countyless) or 'none'))

print('\nbind_coastal() -- box first, the feed\'s own county decides a tie')
ace, beau = idx['coast_ace_basin_sc'], idx['coast_beaufort_sc']
# Ryan's own pick, straight off the SCDNR feed: Bennetts Point, wb "Mosquito Creek", Colleton.
check('Bennetts Point lands in ACE Basin, not Beaufort',
      B.bind_coastal(zones, 32.557821, -80.455417, 'Colleton'), 'coast_ace_basin_sc')
check('the same point with the wrong county goes nowhere',
      B.bind_coastal(zones, 32.557821, -80.455417, 'Greenville'), None)
check('and with no county at all it stays refused rather than guessing',
      B.bind_coastal(zones, 32.557821, -80.455417, None), None)
check('a point in the ocean binds to nothing', B.bind_coastal(zones, 30.0, -76.0, 'Colleton'), None)
# The name that started it: two Mosquito Creeks, and santee_delta answers to the Georgetown one.
check('it never reaches the OTHER Mosquito Creek\'s zone',
      B.bind_coastal(zones, 32.557821, -80.455417, 'Charleston') == 'coast_santee_delta_sc', False)

feeds = [f for f in ('ramps_sc', 'ramps_nc', 'ramps_ga', 'paddle_sc', 'paddle_nc', 'paddle_ga')
         if os.path.exists(os.path.join(REG, '_dnr_%s.json' % f))]
if feeds:
    print('\nover the saved feeds')
    placed = collections.Counter()
    for f in feeds:
        wbs = json.load(io.open(os.path.join(REG, '_dnr_%s.json' % f), encoding='utf-8'))['waterbodies']
        for _wb, pts in wbs.items():
            for p in pts:
                m = p.get('meta') or {}
                z = B.bind_coastal(zones, p['lat'], p['lon'], p.get('county') or m.get('county'))
                if z:
                    placed[z] += 1
    check('most zones now get points', len(placed) >= 12, True)
    check('and none of them is a non-coastal row', [z for z in placed if z not in zones], [])
    print('        %d point(s) across %d zone(s)' % (sum(placed.values()), len(placed)))

print('\nregistry_ramps() -- what the batch now sends with the request')
thur = R.registry_ramps(idx.get('j_strom_thurmond_reservoir') or {})
# The reservoir the Worker comment names: 19 feed spellings, none a substring of the app's name,
# "ramps: 0" reported for 41,000 acres the registry already had 168 ramps for.
check('Thurmond sends ramps instead of reporting none', len(thur) > 100, True)
check('and some of them carry species',
      sum(1 for r in thur if str(r.get('species') or '').strip()) > 0, True)
check('every record has a real coordinate',
      [r['name'] for r in thur if not isinstance(r['lat'], float)], [])
check('species is flattened out of meta, because the Worker reads the top level',
      R.registry_ramps({'ramps': {'dnr': [
          {'name': 'X', 'lat': 34.0, 'lon': -81.0, 'meta': {'species': 'Largemouth Bass'}}]}}),
      [{'name': 'X', 'lat': 34.0, 'lon': -81.0, 'lanes': None, 'county': None, 'owner': None,
        'species': 'Largemouth Bass'}])
check('a coordinate-less OSM record is dropped, not centroid-guessed',
      R.registry_ramps({'ramps': {'osm': [{'name': 'Y', 'lat': None, 'lon': None}]}}), [])
check('an empty row is empty, not an error', R.registry_ramps({}), [])

print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                else 'all checks passed'))
sys.exit(1 if FAILED else 0)
