"""Exercise build_water_chain's real functions -- imported from the shipped file, not copies."""
import importlib.util, sys, json, types
from pathlib import Path

# Load the script that sits NEXT TO THIS TEST, not next to the shell's working directory.
# A bare relative path here resolves against cwd, so running the test from the repo root
# instead of from scripts/ made it look for the module one folder too high.
HERE = Path(__file__).resolve().parent
TARGET = HERE / 'build_water_chain.py'
if not TARGET.exists():
    print(f'cannot find build_water_chain.py beside this test ({HERE})')
    sys.exit(2)
spec = importlib.util.spec_from_file_location('bwc', TARGET)
bwc = importlib.util.module_from_spec(spec); spec.loader.exec_module(bwc)
print(f'testing {TARGET}')

def eq(g, w, m): assert g == w, f'{m}: got {g!r} want {w!r}'

# --- normalize_gnis, against the exact contents of Ryan's registry
eq(bwc.normalize_gnis('gnis:1227425'), '1227425', 'wateree')
eq(bwc.normalize_gnis('gnis:988007.0'), bwc.normalize_gnis('gnis:988007'), 'float twin collides')
eq(bwc.normalize_gnis('gnis:981723.0'), '981723', 'other float')
eq(bwc.normalize_gnis('slug:lookout_shoals_lake'), None, 'slug')
eq(bwc.normalize_gnis('nhd:123388379'), None, 'nhd id')
eq(bwc.normalize_gnis('   '), None, 'whitespace')
eq(bwc.normalize_gnis('00991183'), '991183', 'zero padded')

# --- direction refuses rather than guesses
eq(bwc.direction_is_decreasing([(9,8),(8,7)]), True, 'dec')
eq(bwc.direction_is_decreasing([(7,8),(8,9)]), False, 'inc')
eq(bwc.direction_is_decreasing([(9,8),(7,8)]), None, 'mixed refuses')

# --- find_gdbs prefers extracted over zip, ignores plain NHD_H_, parses the vpu code
import tempfile, os
with tempfile.TemporaryDirectory() as t:
    d = __import__('pathlib').Path(t)
    (d/'0305').mkdir()
    (d/'0305'/'NHDPLUS_H_0305_HU4_GDB.gdb').mkdir()
    (d/'NHDPLUS_H_0305_HU4_GDB.zip').write_text('x')
    (d/'NHDPLUS_H_0304_HU4_GDB.zip').write_text('x')
    (d/'NHD_H_0304_HU4_GDB.zip').write_text('x')          # no VAA table, must be ignored
    (d/'NHDPLUS_H_0601_HU4_20220418_GDB.zip').write_text('x')
    g = bwc.find_gdbs(d)
    eq(sorted(g), ['0304','0305','0601'], 'vpu codes parsed incl. dated 0601 filename')
    assert str(g['0305']).endswith('.gdb'), 'extracted must beat zip'
    assert str(g['0304']).endswith('.zip'), '0304 only has a zip'
    eq(sorted(bwc.find_gdbs(d, ['0305'])), ['0305'], '--only filters')
    eq(bwc.find_gdbs(d, ['9999']), {}, '--only with no match')

# --- the walk, on the real Catawba topology
chain = ['lake_james','rhodhiss_lake','lake_hickory','lookout_shoals_lake','lake_norman',
         'mountain_island_lake','lake_wylie','fishing_creek_reservoir','great_falls_reservoir',
         'cedar_creek_reservoir_2','wateree_lake']
water_of, dn_of, hs = {}, {}, 1100
per = {}
for w in chain:
    per[w] = [hs, hs-5]
    for h in per[w]: water_of[h] = w
    hs -= 50
flat = sorted(water_of, reverse=True)
for a,b in zip(flat, flat[1:]): dn_of[a]=b
dn_of[flat[-1]] = 100; dn_of[100] = 0                    # tailrace below Wateree
for i,w in enumerate(chain):
    nxt,_ = bwc.walk_downstream(bwc.outlet_of(per[w], True), dn_of, water_of, exclude=w)
    eq(nxt, chain[i+1] if i+1 < len(chain) else None, f'{w} -> next')
eq(bwc.walk_downstream(bwc.outlet_of(per['cedar_creek_reservoir_2'],True), dn_of, water_of,
   exclude='cedar_creek_reservoir_2')[0], 'wateree_lake', 'CEDAR CREEK IS INFLOW TO WATEREE')
eq(bwc.walk_downstream(bwc.outlet_of(per['wateree_lake'],True), dn_of, water_of,
   exclude='wateree_lake')[0], None, 'WATEREE IS OUTFLOW')
eq(bwc.walk_downstream(1, {1:2,2:1}, {}, 'x')[0], None, 'cycle terminates')
eq(bwc.walk_downstream(1, {}, {}, 'x')[0], None, 'empty graph')

# --- the upstream inversion, exactly as main() does it
rows = {w: {'downstream': (chain[i+1] if i+1 < len(chain) else None)} for i,w in enumerate(chain)}
for r in rows.values(): r['upstream'] = []
for s,r in rows.items():
    if r['downstream'] in rows: rows[r['downstream']]['upstream'].append(s)
eq(rows['wateree_lake']['upstream'], ['cedar_creek_reservoir_2'], 'wateree fed by cedar creek only')
eq(rows['lake_james']['upstream'], [], 'james is the top')
eq(rows['wateree_lake']['downstream'], None, 'wateree is the bottom')
assert sum(len(r['upstream']) for r in rows.values()) == len(chain)-1, 'one inbound edge per link'

print('ALL build_water_chain assertions pass')

# --- find_repo_root: the bug that made this very test fail for Ryan, now guarded
import tempfile, os
from pathlib import Path as _P
with tempfile.TemporaryDirectory() as t:
    root = _P(t) / 'TrollMapPipeline'
    (root / 'registry').mkdir(parents=True)
    (root / 'registry' / 'lake_index.json').write_text('{}')
    (root / 'scripts').mkdir()
    cwd = os.getcwd()
    try:
        os.chdir(root)
        eq(bwc.find_repo_root(None), root, 'found from repo root')
        os.chdir(root / 'scripts')
        eq(bwc.find_repo_root(None), root, 'CLIMBS OUT OF scripts/ -- the case that broke')
        (root / 'a' / 'b').mkdir(parents=True)
        os.chdir(root / 'a' / 'b')
        eq(bwc.find_repo_root(None), root, 'climbs from any depth inside the repo')
        os.chdir(t)
        eq(bwc.find_repo_root(str(root / 'registry' / 'lake_index.json')), root,
           'explicit --registry path yields its repo root')
    finally:
        os.chdir(cwd)
print('find_repo_root assertions pass')


# --- the NaN that crashed the 0305 run -------------------------------------------------
# NHDPlus HR stores hydrosequences as float64 with NaN on flowlines that are not routed
# (InNetwork = 0). The old code did .astype('int64') on the whole column and raised
# IntCastingNaNError. These assertions are the regression guard.
import math
import numpy as np

nan = float('nan')
m, dropped = bwc.finite_int_map([900.0, nan, 800.0, 700.0], [800.0, 700.0, nan, 0.0])
eq(dropped, 2, 'two rows have a NaN on one side or the other')
eq(m, {900: 800, 700: 0}, 'only the fully finite rows survive, as ints not floats')
assert all(isinstance(k, int) and isinstance(v, int) for k, v in m.items()), 'ints, not floats'

m2, d2 = bwc.finite_int_map([nan, nan], [nan, nan])
eq((m2, d2), ({}, 2), 'all NaN -> empty map, not a crash')
eq(bwc.finite_int_map([], []), ({}, 0), 'empty input')
m3, d3 = bwc.finite_int_map([1.0, float('inf')], [2.0, 3.0])
eq((m3, d3), ({1: 2}, 1), 'inf is dropped too, not cast')

ints, d = bwc.finite_ints([905.0, nan, 900.0])
eq((ints, d), ([905, 900], 1), 'finite_ints skips NaN')
eq(bwc.finite_ints([nan]), ([], 1), 'all NaN -> empty list')
eq(bwc.outlet_of(bwc.finite_ints([905.0, nan, 900.0])[0], True), 900, 'outlet ignores NaN')
eq(bwc.outlet_of(bwc.finite_ints([nan])[0], True), None, 'no routed flowline -> no outlet')

eq(bwc.safe_int(nan), 0, 'safe_int(NaN)')
eq(bwc.safe_int(None), 0, 'safe_int(None)')
eq(bwc.safe_int(float('inf')), 0, 'safe_int(inf)')
eq(bwc.safe_int(np.float64(8.0)), 8, 'safe_int(numpy float)')
eq(bwc.safe_int(15001500005823.0), 15001500005823, 'safe_int keeps 14-digit precision')
eq(bwc.safe_int('nope', -1), -1, 'safe_int non numeric uses default')
eq(bwc.safe_float(nan), 0.0, 'safe_float(NaN)')
eq(bwc.safe_float(np.float64(12256.6175)), 12256.6175, 'safe_float(numpy)')

# a graph half built of unrouted flowlines still walks correctly through the routed part
water_of = {900: 'norman', 700: 'wylie', 600: 'wateree'}
dn_of, _ = bwc.finite_int_map([900.0, 850.0, nan, 800.0, 700.0, 650.0],
                              [850.0, 800.0, 750.0, 700.0, 650.0, 600.0])
eq(bwc.walk_downstream(900, dn_of, water_of, 'norman')[0], 'wylie', 'walk crosses the gap')
eq(bwc.walk_downstream(700, dn_of, water_of, 'wylie')[0], 'wateree', 'and keeps going')

print('NaN regression assertions pass')


# --- prefer_row: one water placed in two VPUs -------------------------------------------------
# process_vpu's "the GNIS join already claimed this slug" guard is PER-VPU. A water placed on its
# id in one basin can still be offered as a binding in the next, and the 283 waters validated
# against USACE surveyed drainage have to win that tie whatever the flowline counts say.
_g = {'match_via': 'gnis', 'flowlines': 2, 'vpu': '0305'}
_b = {'match_via': 'geometry', 'flowlines': 99, 'vpu': '0304'}
assert bwc.prefer_row(_g, _b) == (_g, 'GNIS beats geometry'), 'GNIS must win with FEWER flowlines'
assert bwc.prefer_row(_b, _g) == (_g, 'GNIS beats geometry'), 'and win from either argument side'
_b2 = dict(_b, flowlines=1)
assert bwc.prefer_row(_g, _b2) == (_g, 'GNIS beats geometry'), 'and win with more, too'

# same provenance on both sides: more flowlines means more of the water is in that VPU
_g2 = {'match_via': 'gnis', 'flowlines': 7, 'vpu': '0301'}
assert bwc.prefer_row(_g, _g2) == (_g2, 'more flowlines')
assert bwc.prefer_row(_g2, _g) == (_g2, 'more flowlines')
_bb = {'match_via': 'geometry', 'flowlines': 3, 'vpu': '0303'}
assert bwc.prefer_row(_b, _bb) == (_b, 'more flowlines')

# a tie keeps the row already held, so the merge is stable rather than order-dependent
_t1 = {'match_via': 'gnis', 'flowlines': 4, 'vpu': '0305'}
_t2 = {'match_via': 'gnis', 'flowlines': 4, 'vpu': '0304'}
assert bwc.prefer_row(_t1, _t2)[0] is _t1, 'an exact tie must not flip'
print('prefer_row assertions pass')


# --- norm_pid: the join key, normalised on both sides -----------------------------------------
# _nhd_bindings.json holds {45FC7FCA-...} and {d7218688-...} in opposite casings, read from the
# same geodatabases by the same code. A dict keyed on the raw string is one casing away from
# reporting "this lake has no flowlines" about a lake with plenty.
assert bwc.norm_pid('{D7218688-637B-48BC-87E8-6485082D8569}') == \
       bwc.norm_pid('{d7218688-637b-48bc-87e8-6485082d8569}')
assert bwc.norm_pid('{ABC}') == bwc.norm_pid('abc'), 'braces are packaging, not identity'
assert bwc.norm_pid('110970920') == '110970920', 'a digit id is left alone'
assert bwc.norm_pid('  110970920  ') == '110970920'
assert bwc.norm_pid(None) is None
assert bwc.norm_pid('') is None
assert bwc.norm_pid('   ') is None, 'whitespace is not an identifier -- the Number("") family'
assert bwc.norm_pid('{}') is None, \
    'an empty GUID is not an identifier, and two of them must not join to each other'
assert bwc.norm_pid('{') == '{', 'a lone brace is not a wrapper'
assert bwc.norm_pid(110970920) == '110970920', 'a numeric id from the GDB still keys correctly'
print('norm_pid assertions pass')
