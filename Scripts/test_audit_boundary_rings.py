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


def eq(g, w, m):
    assert g == w, '%s: got %r want %r' % (m, g, w)


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
    short_acres = abr.acres_of([[sq(-80.4, 33.4, 0.05)]])
    # AREA IS NOT COVERAGE. Every row below carries the two union percentages, because that is
    # what the audit reads now -- see the module docstring for the 40 false positives and the
    # one real miss that the old acres-against-one-piece test produced on the live registry.
    json.dump({'bindings': {
        # covers half its water: the falls_lake shape
        'stops_short': {'nhd_acres': short_acres * 2.0, 'nhd_union_acres': short_acres * 2.0,
                        'nhd_union_pieces': 1, 'nhd_layer': 'NHDWaterbody',
                        'registry_covers_pct_of_union': 50.0,
                        'union_covers_pct_of_registry': 100.0},
        # agrees, so it must NOT be reported at all
        'correct_water': {'nhd_acres': correct_acres, 'nhd_union_acres': correct_acres,
                          'nhd_union_pieces': 1, 'nhd_layer': 'NHDWaterbody',
                          'registry_covers_pct_of_union': 100.0,
                          'union_covers_pct_of_registry': 98.0},
        # THE ALTAMAHA CASE: three times the acreage of the ONE piece it matched, and it
        # covers every drop of the union. The old test called this 204% too large.
        'two_basin_water': {'nhd_acres': correct_acres / 3.0,
                            'nhd_union_acres': correct_acres, 'nhd_union_pieces': 17,
                            'nhd_layer': 'NHDArea',
                            'registry_covers_pct_of_union': 100.0,
                            'union_covers_pct_of_registry': 75.6},
        # THE NEUSE CASE: 1.4% large by area, so the old test never saw it, and it is
        # substantially in the wrong PLACE.
        'flattened_water': {'nhd_acres': correct_acres, 'nhd_union_acres': correct_acres,
                            'nhd_union_pieces': 21, 'nhd_layer': 'NHDArea',
                            'registry_covers_pct_of_union': 70.6,
                            'union_covers_pct_of_registry': 77.0},
    }}, open(os.path.join(reg, '_nhd_bindings.json'), 'w'))
    json.dump({'flattened_water': {}, 'correct_water': {}}, open(
        os.path.join(reg, 'lake_index.json'), 'w'))

    rc, txt = run(['x', '--registry', reg])
    assert rc == 0, txt
    assert 'flattened_water' in txt, txt
    assert 'correct_water' not in txt.split('MISSES WATER')[0], \
        'a correctly written file must not be listed as flattened'
    assert 'two_basin_water' not in txt.split('MISSES WATER')[0], \
        'two separate basins must not be reported as flattened'
    assert 'stops_short' in txt, 'a trace covering half its water must be reported'

    # --- the measurement, which is the whole point of this audit's second half --------------
    miss = txt.split('MISSES WATER')[1].split('CLAIMS WATER')[0]
    disp = txt.split('CLAIMS WATER')[1]
    assert 'stops_short' in miss, 'covers 50% of its union -- it misses water'
    assert 'flattened_water' in miss, 'covers 70.6% -- the neuse case the area test never saw'
    assert 'two_basin_water' not in miss, \
        'THE ALTAMAHA CASE: 3x the acreage of the one piece it matched, and it covers 100% of '\
        'the union. Area said 204% too large; coverage says it is fine.'
    assert 'correct_water' not in miss and 'correct_water' not in disp, \
        'a boundary that agrees appears on neither list'
    assert 'flattened_water' not in disp, '77% of it is water, above the 60% default'
    assert 'two_basin_water' not in disp, '75.6% of it is water, above the default too'
    rc2, txt2 = run(['x', '--registry', reg, '--min-mine', '80'])
    d2 = txt2.split('CLAIMS WATER')[1]
    assert 'flattened_water' in d2 and 'two_basin_water' in d2, \
        'raise the bar and both displaced ones appear: %s' % d2[:300]
    assert 'A WATER CAN BE ON BOTH LISTS' or True
    assert 'flattened_water' in txt2.split('MISSES WATER')[1].split('CLAIMS WATER')[0], \
        'and a water that both misses and is displaced belongs on BOTH lists'
    print('coverage, not area: the altamaha case clears and the neuse case is caught')
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


# ============================================================================================
# A CUT IS NOT A DEFECT, AND THE FILE SAYS WHICH IT IS.
#
# cooper_river covers 27% of its NHD union and is exactly right: the NHD Cooper runs to the
# ocean and the registry keeps the freshwater half, cut at the SC Code 50-5-80 line. falls_lake
# covers 79% and is simply unfinished. The only thing that tells them apart from the outside is
# the `source` the cutter stamped on the boundary, so the report prints it.
# ============================================================================================
assert abr.source_of({'type': 'FeatureCollection', 'features': [
    {'properties': {'source': 'cooper_river_3dhp.geojson'}, 'geometry': None}]}
) == 'cooper_river_3dhp.geojson'
assert abr.source_of({'type': 'Feature', 'properties': {'source': 'x_river.geojson'}}
                     ) == 'x_river.geojson'
assert abr.source_of({'type': 'FeatureCollection', 'features': [
    {'properties': {}, 'geometry': None},
    {'properties': {'source': 'later_feature.geojson'}, 'geometry': None}]}
) == 'later_feature.geojson', 'the property may be on any part, not only the first'
assert abr.source_of({'type': 'Feature', 'properties': {}}) == '(none)', \
    'a boundary with no provenance says so rather than inventing one'
assert abr.source_of({'type': 'Feature'}) == '(none)', 'and a file with no properties at all'
print('source_of reads the provenance the cutter stamped, or admits there is none')


# A BINDING TOO OLD TO CARRY THE UNION FIELDS IS NOT SILENTLY SKIPPED. It is measured the old
# way and listed under its own heading, because "we measured it badly" and "we did not measure
# it" are different facts and only one of them is fixed by re-running match_waters_to_nhd.py.
with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:
    reg = os.path.join(td, 'registry')
    bdir = os.path.join(reg, 'boundaries')
    os.makedirs(bdir)
    write(bdir, 'old_binding', [[sq(-80.4, 33.4, 0.05)]])
    json.dump({'bindings': {'old_binding': {
        'nhd_acres': abr.acres_of([[sq(-80.4, 33.4, 0.05)]]) * 2.0,
        'nhd_layer': 'NHDWaterbody'}}}, open(os.path.join(reg, '_nhd_bindings.json'), 'w'))
    json.dump({'old_binding': {}}, open(os.path.join(reg, 'lake_index.json'), 'w'))
    rc, txt = run(['x', '--registry', reg])
    assert 'predate the union fields' in txt, txt
    assert 'old_binding' in txt.split('predate the union fields')[1], txt
    assert 'match_waters_to_nhd' in txt, 'and it says what to re-run'
    assert 'old_binding' not in txt.split('MISSES WATER')[1].split('CLAIMS WATER')[0], \
        'it must NOT be mixed into the coverage list it has no numbers for'
print('an old binding is measured the old way, under its own heading, and says what to re-run')


# ============================================================================================
# A MERGE MOVES THE NAME AND LEAVES THE GEOMETRY BEHIND.
#
# migrate_merged_slugs.py carries a merge through everything KEYED by slug. A boundary is a
# FILE named for a slug, in a directory that tool never opens -- so falls_lake kept its name
# and its 9,529.6-acre partial trace while brinkley_lake, the slug it retired, sat beside it
# holding 12,958. The retired polygon contains 99.8% of the keeper and adds 3,443 acres: the
# upper arms of Falls Lake, which the app has never drawn.
#
# The merge decision says so in its own reason field. It was recorded and then not carried out.
# ============================================================================================
with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:
    reg = os.path.join(td, 'registry')
    bdir = os.path.join(reg, 'boundaries')
    os.makedirs(bdir)
    small = sq(-78.70, 36.00, 0.05)
    big = sq(-78.70, 36.00, 0.06)          # ~44% more water, same corner
    write(bdir, 'keeper_lake', [[small]])
    write(bdir, 'retired_lake', [[big]])
    write(bdir, 'fat_keeper', [[big]])
    write(bdir, 'thin_retiree', [[small]])
    write(bdir, 'same_keeper', [[small]])
    write(bdir, 'same_retiree', [[small]])
    json.dump({'merges': [
        {'keep': 'keeper_lake', 'retire': 'retired_lake'},
        {'keep': 'fat_keeper', 'retire': 'thin_retiree'},
        {'keep': 'same_keeper', 'retire': 'same_retiree'},
        {'keep': 'no_file_keeper', 'retire': 'no_file_retiree'},
        {'retire': 'half_a_row'},
    ]}, open(os.path.join(reg, '_merge_decisions.json'), 'w'))
    json.dump({'bindings': {}}, open(os.path.join(reg, '_nhd_bindings.json'), 'w'))
    json.dump({'keeper_lake': {}, 'fat_keeper': {}, 'same_keeper': {}},
              open(os.path.join(reg, 'lake_index.json'), 'w'))

    rc, txt = run(['x', '--registry', reg])
    eq(rc, 0, txt)
    blk = txt.split('RETIRED holds a bigger polygon')[1]
    assert 'keeper_lake' in blk and 'retired_lake' in blk, \
        'the falls_lake case: the retiree holds more water and must be named'
    assert 'fat_keeper' not in blk, 'a keeper that is already the bigger one is not a finding'
    assert 'same_keeper' not in blk, 'and neither is a pair that agrees'
    assert 'no_file_keeper' not in blk, 'a pair with no boundary on disk is skipped, not crashed'
    assert 'half_a_row' not in blk, 'a decision missing keep or retire does not throw'

    # A RETIRED SLUG IS NOT IN THE INDEX, and its polygon is exactly what this compares against.
    # Measuring only indexed boundaries would make every one of these invisible.
    assert 'retired_lake' not in txt.split('MISSES WATER')[0].split('flattened')[1], \
        'the retiree is measured for this comparison, not reported as a fault of its own'

    # nothing is written -- swapping a boundary is the same judgement as re-tracing
    after = json.load(open(os.path.join(bdir, 'keeper_lake.geojson')))
    eq(after['features'][0]['geometry']['coordinates'], [[list(p) for p in small]],
       'REPORTED, NEVER SWAPPED -- the keeper file is untouched')
    rc, txt = run(['x', '--registry', reg, '--fix'])
    after = json.load(open(os.path.join(bdir, 'keeper_lake.geojson')))
    eq(after['features'][0]['geometry']['coordinates'], [[list(p) for p in small]],
       'and --fix does not swap it either; --fix only ever re-nests')
print('a merge that left the better polygon behind is found, named, and not acted on')

with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:
    reg = os.path.join(td, 'registry')
    os.makedirs(os.path.join(reg, 'boundaries'))
    write(os.path.join(reg, 'boundaries'), 'lonely', [[sq(-78.7, 36.0, 0.05)]])
    json.dump({'bindings': {}}, open(os.path.join(reg, '_nhd_bindings.json'), 'w'))
    json.dump({'lonely': {}}, open(os.path.join(reg, 'lake_index.json'), 'w'))
    rc, txt = run(['x', '--registry', reg])
    eq(rc, 0, 'no _merge_decisions.json is not an error')
    assert 'none -- every keeper traces at least as much water' in txt, txt
print('no merge decisions on disk is a clean pass, not a crash')
