"""audit_boundary_rings.py -- does it find a flattened boundary, repair it, and leave alone
the ones that are merely wrong in a way it cannot fix.

FIXTURES ARE SHAPED LIKE THE REAL FAULTS. A square with a square hole written the broken way
(two separate polygons) and the correct way (one polygon, two rings); a water that stops short
of its NHD acreage; and a genuine two-basin water whose parts do NOT contain each other and
must not be welded together.

The main() run is against a real directory on disk, because the previous test in this family
exercised the helpers, passed, and shipped a NameError in main().
"""
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('abr', HERE / 'audit_boundary_rings.py')
abr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(abr)


def sq(x, y, s):
    return [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]


OUTER = sq(-80.0, 33.0, 0.10)          # ~10 km on a side
HOLE = sq(-79.97, 33.03, 0.02)
FAR = sq(-79.5, 33.0, 0.05)            # a separate basin, contained by nothing

# --- area, against a figure that does not come from this file --------------------------------
# A 0.1 degree square at 33N: 0.1 deg lat is 11.12 km, 0.1 deg lon is 9.32 km -> ~103.6 km2.
a_outer = abs(abr.ring_area_m2(OUTER)) / 1e6
assert 100 < a_outer < 107, 'spherical area is %f km2, expected ~103.6' % a_outer
print('spherical ring area: %.1f km2 for a 0.1deg square at 33N' % a_outer)

# --- containment, on the shape that broke the Cooper -----------------------------------------
assert abr.point_in_ring(abr.rep_point(HOLE), OUTER), 'the hole must test as inside the outer'
assert not abr.point_in_ring(abr.rep_point(FAR), OUTER), 'a separate basin is not inside'
assert abr.point_in_ring(abr.rep_point(OUTER), OUTER), 'rep_point must land INSIDE its own ring'
print('containment and rep_point agree on the fixture')

# --- renest: the broken form is repaired, the correct form is untouched ----------------------
broken = [[OUTER], [HOLE]]
fixed, moved = abr.renest(broken)
assert moved == 1, moved
assert len(fixed) == 1 and len(fixed[0]) == 2, fixed
assert abr.acres_of(broken) > abr.acres_of(fixed), 'the broken form must measure LARGER'

good = [[OUTER, HOLE]]
same, moved2 = abr.renest(good)
assert moved2 == 0 and same == good, 'a file that already declares its holes must not be touched'

two_basins = [[OUTER], [FAR]]
kept, moved3 = abr.renest(two_basins)
assert moved3 == 0 and len(kept) == 2, 'two separate basins must NOT be welded into one'
print('renest: repairs the flattened form, leaves correct and multi-basin files alone')

# --- the numbers must agree with the correct form ---------------------------------------------
assert abs(abr.acres_of(fixed) - abr.acres_of(good)) < 1e-6, \
    'a repaired file must measure exactly what the correctly written one does'
delta = abr.acres_of(broken) - abr.acres_of(good)
assert delta > 0 and abs(delta - 2 * abs(abr.ring_area_m2(HOLE)) / abr.SQM_PER_ACRE) < 1e-6, \
    'the broken form overstates by exactly twice the hole -- added instead of subtracted'
print('the flattened form overstates by exactly 2x the hole area, as it must')


# --- main(), end to end, against files on disk -----------------------------------------------
def write(dirpath, slug, polys):
    geom = ({'type': 'Polygon', 'coordinates': polys[0]} if len(polys) == 1
            else {'type': 'MultiPolygon', 'coordinates': polys})
    json.dump({'type': 'FeatureCollection',
               'features': [{'type': 'Feature', 'properties': {'slug': slug}, 'geometry': geom}]},
              open(os.path.join(dirpath, slug + '.geojson'), 'w'))


def run(argv):
    old = sys.argv
    sys.argv = argv
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            rc = abr.main()
    finally:
        sys.argv = old
    return rc, buf.getvalue()


with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:
    reg = os.path.join(td, 'registry')
    bdir = os.path.join(reg, 'boundaries')
    os.makedirs(bdir)
    write(bdir, 'flattened_water', [[OUTER], [HOLE]])
    write(bdir, 'correct_water', [[OUTER, HOLE]])
    write(bdir, 'two_basin_water', [[OUTER], [FAR]])
    write(bdir, 'stops_short', [[sq(-80.4, 33.4, 0.05)]])
    open(os.path.join(bdir, 'broken.geojson'), 'w').write('{not json')

    correct_acres = abr.acres_of([[OUTER, HOLE]])
    json.dump({'bindings': {
        # a trace that covers only half of what NHD has -- the falls_lake shape
        'stops_short': {'nhd_acres': abr.acres_of([[sq(-80.4, 33.4, 0.05)]]) * 2.0,
                        'nhd_layer': 'NHDWaterbody'},
        # and one that agrees, so it must NOT be reported
        'correct_water': {'nhd_acres': correct_acres, 'nhd_layer': 'NHDWaterbody'},
    }}, open(os.path.join(reg, '_nhd_bindings.json'), 'w'))
    json.dump({'flattened_water': {}, 'correct_water': {}}, open(
        os.path.join(reg, 'lake_index.json'), 'w'))

    rc, txt = run(['x', '--registry', reg])
    assert rc == 0, txt
    assert 'flattened_water' in txt, txt
    assert 'correct_water' not in txt.split('STOPS SHORT')[0], \
        'a correctly written file must not be listed as flattened'
    assert 'two_basin_water' not in txt.split('STOPS SHORT')[0], \
        'two separate basins must not be reported as flattened'
    assert 'stops_short' in txt, 'a trace at half the NHD acreage must be reported'
    assert 'broken' in txt and 'unreadable' in txt, 'unparseable files must be named, not skipped'
    assert 'nothing was written' in txt, 'the default must not write'
    print('main() report: finds the flattened one, spares the correct and the two-basin one')

    # --fix repairs it, keeps a .bak, and a second pass finds nothing
    rc, txt = run(['x', '--registry', reg, '--fix'])
    assert rc == 0, txt
    assert '1 rewritten' in txt, txt
    assert os.path.exists(os.path.join(bdir, 'flattened_water.geojson.bak')), 'no .bak kept'
    after = json.load(open(os.path.join(bdir, 'flattened_water.geojson')))
    geom = after['features'][0]['geometry']
    assert geom['type'] == 'Polygon', geom['type']
    assert len(geom['coordinates']) == 2, 'the repaired file must carry outer + hole'
    assert after['features'][0]['properties'].get('slug') == 'flattened_water', \
        'properties must survive the rewrite'

    rc, txt = run(['x', '--registry', reg])
    assert 'none -- every multi-part boundary declares its own holes' in txt, txt
    print('--fix repairs it, keeps a .bak, and the second pass is clean')

    # the repaired file must measure what the correctly-written one does
    got = abr.acres_of(abr.read_polygons(after))
    assert abs(got - correct_acres) < 1e-6, '%f vs %f' % (got, correct_acres)
    print('repaired acreage equals the correctly-written file to the acre')

print('\nall audit_boundary_rings assertions pass')
