"""Exercise build_water_chain's real functions -- imported from the shipped file, not copies."""
import importlib.util, sys, json, types
spec = importlib.util.spec_from_file_location('bwc', 'build_water_chain.py')
bwc = importlib.util.module_from_spec(spec); spec.loader.exec_module(bwc)

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
