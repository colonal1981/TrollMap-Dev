"""Unit tests for bind_dams_to_waters, plus an end-to-end run against a synthetic registry."""
import importlib.util, sys, json, tempfile, io, contextlib, math
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location('bdw', HERE / 'bind_dams_to_waters.py')
bdw = importlib.util.module_from_spec(spec); spec.loader.exec_module(bdw)
def eq(g, w, m): assert g == w, f'{m}: got {g!r} want {w!r}'

# --- name splitting is the whole reason the hand table can be retired ------------------------
# USACE writes one structure name where Duke publishes per powerhouse.
eq(bdw.name_aliases('Rocky Creek-Cedar Creek'), ['rocky creek cedar creek', 'rocky creek', 'cedar creek'],
   'the two powerhouses Duke posts releases under must both appear')
eq(bdw.name_aliases('Great Falls-Dearborn Dam'), ['great falls dearborn', 'great falls', 'dearborn'],
   '"Dam" is noise, the two halves are not')
eq(bdw.name_aliases('Cowans Ford'), ['cowans ford'], 'a single name yields itself once')
eq(bdw.name_aliases('Lookout Shoals'), ['lookout shoals'], 'no spurious splitting')
eq(bdw.name_aliases('Wateree'), ['wateree'], 'plain')
eq(bdw.name_aliases(''), [], 'empty')
eq(bdw.name_aliases('Dam'), [], 'a name that is only noise is not a name')
assert 'saddle' not in ' '.join(bdw.name_aliases('Great Falls-Dearborn Saddle Dike')), \
    'structure words are noise, or a dike becomes a powerhouse'

# aliases must be spelled the way Worker/conditions.js:normalizeDamName() spells them
eq(bdw.dam_key('CEDAR CREEK DAM'), 'cedar creek', 'duke spelling')
eq(bdw.dam_key('Lake Wateree Dam'), 'wateree', 'gauge spelling')
eq(bdw.dam_key(None), None, 'none')

# --- numbers -------------------------------------------------------------------------------
eq(bdw.num('4,360'), 4360.0, 'thousands separator')
eq(bdw.num(''), None, 'empty'); eq(bdw.num(None), None, 'none'); eq(bdw.num('n/a'), None, 'not a number')
eq(bdw.num(0), 0.0, 'zero is a number')
assert abs(bdw.km_between(-80.7, 34.3, -80.7, 34.3) - 0) < 1e-9, 'same point'
d = bdw.km_between(-80.70, 34.30, -80.70, 34.40)
assert 11.0 < d < 11.2, f'0.1 degree of latitude is ~11.1 km, got {d}'

# --- end to end ------------------------------------------------------------------------------
with tempfile.TemporaryDirectory() as t:
    root = Path(t); (root / 'registry' / 'boundaries').mkdir(parents=True); (root / 'Dams').mkdir()
    # two lakes on one river, a degree apart, with very different drainage
    def box(w, s, e, n):
        return {'type': 'Feature', 'properties': {},
                'geometry': {'type': 'Polygon',
                             'coordinates': [[[w, s], [w, n], [e, n], [e, s], [w, s]]]}}
    json.dump(box(-81.0, 35.0, -80.9, 35.1), open(root/'registry'/'boundaries'/'upper_lake.geojson', 'w'))
    json.dump(box(-81.0, 34.0, -80.9, 34.1), open(root/'registry'/'boundaries'/'lower_lake.geojson', 'w'))
    json.dump(box(-81.0, 34.0, -80.9, 34.1), open(root/'registry'/'boundaries'/'decoy_lake.geojson', 'w'))
    json.dump({'upper_lake': {}, 'lower_lake': {}, 'decoy_lake': {}},
              open(root/'registry'/'lake_index.json', 'w'))
    # chain drainage in km2; 2590 km2 = 1000 sq mi, 12950 = 5000 sq mi
    json.dump({'waters': {'upper_lake': {'drainage_km2': 2589.988},
                          'lower_lake': {'drainage_km2': 12949.94},
                          'decoy_lake': {'drainage_km2': 25.9}}},
              open(root/'registry'/'water_chain.json', 'w'))

    def dam(name, lon, lat, drain, owner='Duke Energy'):
        return {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
                'properties': {'nidId': name[:6], 'name': name, 'ownerNames': owner,
                               'riverName': 'Test River', 'drainageArea': drain,
                               'yearCompleted': 1920}}
    json.dump({'features': [
        dam('Upper', -80.95, 35.0, 1000),                 # on upper_lake's south edge
        dam('Rocky Creek-Cedar Creek', -80.95, 34.0, 5000),  # on lower_lake, two powerhouses
        dam('Wrong Water', -80.95, 34.0, 99999),          # sits on lower_lake, drainage absurd
        dam('Far Away', -70.0, 20.0, 1000),               # nowhere near anything
        dam('Not Duke', -80.95, 35.0, 1000, owner='Somebody Else'),
    ]}, open(root/'Dams'/'dams.geojson', 'w'))

    out = root / 'b.json'
    sys.argv = ['x', '--registry', str(root/'registry'/'lake_index.json'),
                '--dams', str(root/'Dams'/'dams.geojson'), '--json', str(out), '--owner', 'Duke']
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = bdw.main()
    text = buf.getvalue()
    eq(rc, 0, text[-400:])
    got = json.loads(out.read_text())
    by = {r['dam']: r for r in got['bindings']}

    assert by['Upper']['verdict'].startswith('CONFIRMED'), by['Upper']
    eq(by['Upper']['slug'], 'upper_lake', 'nearest water with matching drainage')

    rc2 = by['Rocky Creek-Cedar Creek']
    assert rc2['verdict'].startswith('CONFIRMED'), rc2
    eq(rc2['slug'], 'lower_lake', 'DRAINAGE PICKS THE WATER, not proximity alone -- '
                                  'decoy_lake is the same distance away')

    assert by['Wrong Water']['verdict'].startswith('REFUSED'), \
        f"a dam whose drainage disagrees must be REFUSED, not bound: {by['Wrong Water']}"

    assert 'Far Away' not in by, 'a dam near nothing must not bind'
    assert 'Not Duke' not in by, '--owner filter'

    # the table releaseDirection() reads
    eq(got['dams']['rocky creek'], 'lower_lake', 'Duke posts under one powerhouse...')
    eq(got['dams']['cedar creek'], 'lower_lake', '...or the other, and both must resolve')
    eq(got['dams']['rocky creek cedar creek'], 'lower_lake', 'and the full structure name too')
    assert 'wrong water' not in got['dams'], 'a refused binding contributes no name'
print('ALL bind_dams_to_waters assertions pass')
