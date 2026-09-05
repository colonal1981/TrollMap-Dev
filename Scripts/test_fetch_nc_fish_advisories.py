"""test_fetch_nc_fish_advisories.py -- run with `py .\scripts\test_fetch_nc_fish_advisories.py`.

The network call cannot be exercised from the session's container, so what is tested is the part
that decides the ANSWER: which water each point binds to, that the Web Mercator attribute fields
are never read, that one water keeps a row per population, and that the species floor carries the
meal limit that named it.

The Badin Lake rows are the real ones, copied from the live service on 2026-09-05.
"""
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_nc_fish_advisories as N

FAILS = []


def check(name, got, want):
    if got != want:
        FAILS.append('%s: got %r, want %r' % (name, got, want))


def poly(cx, cy, r):
    return {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'properties': {},
            'geometry': {'type': 'Polygon', 'coordinates': [[
                [cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r],
                [cx - r, cy - r]]]}}]}


tmp = tempfile.mkdtemp()
bounds = os.path.join(tmp, 'boundaries')
os.makedirs(bounds)
INDEX = {
    'badin_lake':    {'display_name': 'Badin Lake (Stanly Co, NC)', 'state': 'NC'},
    'high_rock_lake': {'display_name': 'High Rock Lake (Davidson Co, NC)', 'state': 'NC'},
}
json.dump(poly(-80.1123, 35.4585, 0.02), open(os.path.join(bounds, 'badin_lake.geojson'), 'w'))
json.dump(poly(-80.4000, 35.7000, 0.02), open(os.path.join(bounds, 'high_rock_lake.geojson'), 'w'))

BADIN_ADV = ('Elevated levels of chemicals called PCBs, along with mercury, may be found in '
             'catfish and largemouth bass in these waters.')


def feat(name, x, y, pop, meals, spc='catfish and largemouth bass'):
    return {'attributes': {'Wtr_Bdy': name, 'Site': name, 'Conty_x': 'Stanly,Montgomery',
                           'CntyAff': 'Montgomery,Stanly', 'Fsh_Spc': spc,
                           'Pollutnt': 'Mercury, Polychlorinated biphenyls (PCBs)',
                           'Popultn': pop, 'MlsAllw': meals, 'Advisory': BADIN_ADV,
                           # The trap: these are Web Mercator metres in fields named for degrees.
                           'Lat': 4226366.4566, 'Long': -8918057.5933},
            'geometry': {'x': x, 'y': y}}


FEATURES = [
    feat('Badin Lake', -80.1122744, 35.4585081, 'Pregnant Persons & Children < 15', '0'),
    feat('Badin Lake', -80.1122744, 35.4585081, 'Everyone', '1/week'),
    # the same row again, as the layer repeats one per map symbol
    feat('Badin Lake', -80.1122744, 35.4585081, 'Everyone', '1/week'),
    # just outside the boundary, the Lake Marion gauge case: must still bind
    feat('High Rock Lake', -80.4230, 35.7000, 'Everyone', '2/month', 'channel catfish'),
    # a Web Mercator pair leaking into the geometry: must be refused, never guessed
    feat('Badin Lake', -8918057.5933, 4226366.4566, 'Everyone', '1/week'),
    # a real point with no water we carry
    feat('Some Farm Pond', -80.1122744, 35.4585081, 'Everyone', '1/week'),
]

report = {}
bound, ambiguous, unbound = N.bind(FEATURES, INDEX, bounds, report, max_km=3.0)
waters = N.shape(bound, INDEX)

check('badin bound', 'badin_lake' in waters, True)
check('high rock bound from outside its boundary', 'high_rock_lake' in waters, True)
check('two waters bound', len(waters), 2)

b = waters['badin_lake']
check('the duplicate map-symbol row is dropped', len(b['advisories']), 2)
pops = sorted(a['population'] for a in b['advisories'])
check('a row per population', pops, ['Everyone', 'Pregnant Persons & Children < 15'])
meals = {a['population']: a['meals_allowed'] for a in b['advisories']}
check('meal limit for everyone', meals['Everyone'], '1/week')
check('meal limit for the sensitive group', meals['Pregnant Persons & Children < 15'], '0')
check('matched by containment', b['advisories'][0]['matched_by'], 'point inside our boundary')

check('species split', [s['species'] for s in b['species']], ['catfish', 'largemouth bass'])
check('every species carries both populations', len(b['species'][0]['advice']), 2)
check('and the contaminant with it', b['species'][0]['advice'][0]['contaminant'],
      'Mercury, Polychlorinated biphenyls (PCBs)')

hr = waters['high_rock_lake']
check('the outside point says which rule caught it',
      hr['advisories'][0]['matched_by'].startswith('nearest boundary'), True)
check('and how far out it was', hr['advisories'][0]['km_from_our_boundary'] > 0, True)

why = [u['why'] for u in unbound]
check('a Web Mercator geometry is refused, not guessed',
      any('not a Carolina degree pair' in w for w in why), True)
check('an unknown water is unbound', any('distinctive name token' in w for w in why), True)
check('nothing was silently dropped', len(unbound), 2)

# THE FIELDS NAMED Lat AND Long ARE NEVER READ. Badin's would be metres; if any of them reached
# the output the numbers would be in the millions.
blob = json.dumps(waters)
check('no Web Mercator value reached the output', '4226366' in blob or '8918057' in blob, False)

check('meals of 0 survives as a string, not a dropped falsy',
      meals['Pregnant Persons & Children < 15'], '0')
# "0" MEALS ALLOWED IS "DO NOT EAT". The layer uses "0" as a null marker on its image-URL
# columns and the first parser generalised that, rendering Badin's strongest advisory as
# "unstated". Nothing here reads those columns.
check('a literal "0" survives cleaning', N.clean('0'), '0')
check('real emptiness is still empty', N.clean('<Null>'), '')
check('species from "a and b"', N.species_list('catfish and largemouth bass'),
      ['catfish', 'largemouth bass'])

shutil.rmtree(tmp, ignore_errors=True)
if FAILS:
    print('FAIL (%d)' % len(FAILS))
    for f in FAILS:
        print('   ' + f)
    sys.exit(1)
print('ok -- 20 checks')
