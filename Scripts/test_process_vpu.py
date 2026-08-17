"""End-to-end test of process_vpu with a fake pyogrio, so the function that actually
crashed on 0305 is exercised, not just the helpers around it."""
import importlib.util, sys, types, os
from pathlib import Path
import numpy as np, pandas as pd

HERE = Path(__file__).resolve().parent
nan = float('nan')

# --- a fake 0305: the Catawba chain, plus NaN-hydrosequence flowlines like the real table,
#     plus the two-polygons-one-name trap, plus a lake whose arms are separate polygons.
CHAIN = [('lake_james','1012434'), ('rhodhiss_lake','1000779'), ('lake_hickory','986720'),
         ('lake_norman','991183'), ('mountain_island_lake','990701'), ('lake_wylie','1227721'),
         ('fishing_creek_reservoir','1247757'), ('great_falls_reservoir','1222852'),
         ('cedar_creek_reservoir_2','1237715'), ('wateree_lake','1227425')]

vaa_rows, fl_rows, wb_rows = [], [], []
npid, hs = 1, 1000
for slug, gnis in CHAIN:
    pid = 'wb_' + gnis
    # Norman gets two polygons under one GNIS id -- arms split in NHD. One lake, not two.
    pids = [pid, pid + '_arm'] if slug == 'lake_norman' else [pid]
    for k, p in enumerate(pids):
        wb_rows.append({'Permanent_Identifier': p, 'GNIS_ID': ('0' + gnis if k else gnis),
                        'GNIS_Name': slug.replace('_',' ').title(), 'AreaSqKm': 10.0 + k,
                        'FType': 390})
    for i in range(2):
        vaa_rows.append({'NHDPlusID': npid, 'HydroSeq': float(hs), 'DnHydroSeq': float(hs-5),
                         'LevelPathI': 5823.0, 'TotDASqKm': float(1000 + (1000-hs)*3),
                         'StreamOrde': 8.0, 'Divergence': 0.0,
                         'DivDASqKm': float(1000 + (1000-hs)*3)})
        fl_rows.append({'NHDPlusID': npid, 'WBArea_Permanent_Identifier': pids[i % len(pids)]})
        npid += 1; hs -= 5
    # a connector flowline between lakes, in the network but in no waterbody
    vaa_rows.append({'NHDPlusID': npid, 'HydroSeq': float(hs), 'DnHydroSeq': float(hs-5),
                     'LevelPathI': 5823.0, 'TotDASqKm': float(1000 + (1000-hs)*3),
                     'StreamOrde': 8.0, 'Divergence': 0.0,
                     'DivDASqKm': float(1000 + (1000-hs)*3)})
    fl_rows.append({'NHDPlusID': npid, 'WBArea_Permanent_Identifier': None}); npid += 1; hs -= 5
vaa_rows[-1]['DnHydroSeq'] = 0.0                                  # terminal below Wateree

# THE ROWS THAT CRASHED IT: unrouted flowlines carry NaN hydrosequences.
for i in range(400):
    vaa_rows.append({'NHDPlusID': npid, 'HydroSeq': nan, 'DnHydroSeq': nan,
                     'LevelPathI': nan, 'TotDASqKm': nan, 'StreamOrde': nan,
                     'Divergence': nan, 'DivDASqKm': nan})
    fl_rows.append({'NHDPlusID': npid, 'WBArea_Permanent_Identifier': None}); npid += 1
# one NaN flowline sitting INSIDE a matched lake -- the nastier case
vaa_rows.append({'NHDPlusID': npid, 'HydroSeq': nan, 'DnHydroSeq': nan, 'LevelPathI': nan,
                 'TotDASqKm': nan, 'StreamOrde': nan, 'Divergence': nan, 'DivDASqKm': nan})
fl_rows.append({'NHDPlusID': npid, 'WBArea_Permanent_Identifier': 'wb_1227425'}); npid += 1
# the two-Lake-Marion trap: same GNIS_Name, different polygons, neither in the registry
for nm in ('wb_marion_a', 'wb_marion_b'):
    wb_rows.append({'Permanent_Identifier': nm, 'GNIS_ID': '999999', 'GNIS_Name': 'Lake Marion',
                    'AreaSqKm': 324.0, 'FType': 466})

VAA = pd.DataFrame(vaa_rows); FL = pd.DataFrame(fl_rows); WB = pd.DataFrame(wb_rows)

# 0602 (vintage 20220418) failed with KeyError: 'DnHydroSeq'. pyogrio DROPS a requested column
# the layer does not have, silently, so the read succeeds and the failure lands later and blind.
# CASE is the fake's variable: this stand-in spells its fields differently on purpose.
CASE = os.environ.get('VPU_CASE', 'exact')
def _spell(c):
    if CASE == 'lower':  return c.lower()
    if CASE == 'upper':  return c.upper()
    if CASE == 'mixed':  return {'DnHydroSeq': 'DnHydroseq', 'LevelPathI': 'LevelPathi',
                                 'TotDASqKm': 'TotDASqKM'}.get(c, c)
    return c

fake = types.ModuleType('pyogrio')
def _frame(layer):
    return {'NHDPlusFlowlineVAA': VAA, 'NHDFlowline': FL, 'NHDWaterbody': WB}[layer]
def read_info(src, layer=None):
    # REAL pyogrio returns 'fields' as a NUMPY ARRAY, not a list. The previous fake returned a
    # list, so `info.get('fields') or []` worked here and raised ValueError on the real 0602:
    # "truth value of an array with more than one element is ambiguous". A fake that is easier
    # to satisfy than the real thing tests nothing.
    import numpy as _np
    cols = [c for c in _frame(layer).columns
            if not (CASE == 'missing' and layer == 'NHDPlusFlowlineVAA' and c == 'DnHydroSeq')]
    return {'fields': _np.array([_spell(c) for c in cols], dtype=object),
            'dtypes': _np.array(['object'] * len(cols), dtype=object),
            'features': len(_frame(layer))}
def read_dataframe(src, layer=None, read_geometry=None, columns=None):
    df = _frame(layer).rename(columns={c: _spell(c) for c in _frame(layer).columns})
    # pyogrio's real behaviour: a column that is not there is simply absent from the result
    return df[[c for c in columns if c in df.columns]].copy()
def list_layers(src):
    import numpy as _np
    return _np.array([['NHDPlusFlowlineVAA', 'Table'], ['NHDFlowline', 'MultiLineString'],
                      ['NHDWaterbody', 'MultiPolygon']], dtype=object)
fake.read_info = read_info
fake.read_dataframe = read_dataframe
fake.list_layers = list_layers
sys.modules['pyogrio'] = fake

spec = importlib.util.spec_from_file_location('bwc', HERE / 'build_water_chain.py')
bwc = importlib.util.module_from_spec(spec); spec.loader.exec_module(bwc)

want = {}
for slug, gnis in CHAIN:
    want.setdefault(bwc.normalize_gnis('gnis:' + gnis), []).append(slug)

rows, note = bwc.process_vpu('0305', 'fake.gdb', want, None)
print(f'[case={CASE}] note:', note)

if CASE == 'missing':
    # a vintage genuinely lacking the column must REFUSE and say what it does have,
    # not raise KeyError from somewhere downstream
    assert rows == {}, 'a VAA with no DnHydroSeq must place nothing'
    assert 'REFUSED' in note and 'DnHydroSeq' in note, note
    print('missing-column refusal is clean:', note)
    raise SystemExit(0)

order = [s for s,_ in CHAIN]
assert set(rows) == set(order), f'missing: {set(order) - set(rows)}'
got = sorted(rows, key=lambda s: -rows[s]['outlet_hydroseq'])
assert got == order, f'ORDER WRONG:\n  got  {got}\n  want {order}'
for i, s in enumerate(order):
    w = order[i+1] if i+1 < len(order) else None
    assert rows[s]['downstream'] == w, f'{s} -> {rows[s]["downstream"]}, want {w}'
assert rows['cedar_creek_reservoir_2']['downstream'] == 'wateree_lake', 'CEDAR CREEK = INFLOW'
assert rows['wateree_lake']['downstream'] is None, 'WATEREE = OUTFLOW'

# --- drainage must come from the OUTLET, not from the largest flowline in the polygon.
# Give Wateree an extra flowline belonging to a much bigger river that merely clips it.
_extra = pd.DataFrame([{'NHDPlusID': 9001, 'HydroSeq': 15001500000399.0,
                        'DnHydroSeq': 15001500000398.0, 'LevelPathI': 9999.0,
                        'TotDASqKm': 99999.0, 'StreamOrde': 9.0, 'Divergence': 0.0,
                        'DivDASqKm': 99999.0}])
_vaa2 = pd.concat([VAA, _extra], ignore_index=True)
_fl2 = pd.concat([FL, pd.DataFrame([{'NHDPlusID': 9001,
                  'WBArea_Permanent_Identifier': 'wb_1227425'}])], ignore_index=True)
_saveV, _saveF = VAA, FL
globals()['VAA'], globals()['FL'] = _vaa2, _fl2
_rows2, _ = bwc.process_vpu('0305', 'fake.gdb', want, None)
globals()['VAA'], globals()['FL'] = _saveV, _saveF
_w = _rows2['wateree_lake']
assert _w['drainage_km2'] < 50000, \
    f'OUTLET drainage must ignore the foreign flowline, got {_w["drainage_km2"]}'
assert _w['max_drainage_km2'] == 99999.0, 'the foreign flowline is still recorded'
assert _w['stream_order'] < 9, 'outlet order, not the foreign one'
assert _w['max_stream_order'] == 9, 'foreign order kept for comparison'
print('outlet-vs-max drainage assertions pass')

da = [rows[s]['drainage_km2'] for s in order]
assert all(b > a for a, b in zip(da, da[1:])), f'drainage must climb downstream: {da}'
assert rows['lake_norman']['flowlines'] == 2, 'both arm polygons fold into ONE lake'
assert rows['wateree_lake']['flowlines'] == 2, 'the NaN flowline inside Wateree is excluded'
for s, r in rows.items():
    for k in ('outlet_hydroseq','levelpath','stream_order','nhd_ftype','flowlines'):
        assert isinstance(r[k], int), f'{s}.{k} is {type(r[k]).__name__}, must be int'
    assert r['drainage_km2'] == r['drainage_km2'], f'{s} drainage is NaN'
assert '999999' not in str(rows), 'the unregistered Lake Marion must not appear'

print('process_vpu end-to-end assertions pass:', len(rows), 'waters, order correct')


# --- the dry-run report must show whatever basin actually placed, not a hard-coded sample.
#     0602 placed three waters and printed none of them, because the sample list was Catawba.
import argparse, io, contextlib, json as _json, tempfile as _tf
from pathlib import Path as _P
with _tf.TemporaryDirectory() as _t:
    _root = _P(_t); (_root/'registry').mkdir()
    _reg = {slug: {'gnis': 'gnis:' + g} for slug, g in CHAIN}
    (_root/'registry'/'lake_index.json').write_text(_json.dumps(_reg))
    _nhd = _root/'nhd'; _nhd.mkdir()
    (_nhd/'NHDPLUS_H_0305_HU4_GDB.zip').write_text('x')
    sys.argv = ['x', '--registry', str(_root/'registry'/'lake_index.json'),
                '--nhd', str(_nhd), '--only', '0305']
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = bwc.main()
    text = buf.getvalue()
assert rc == 0, text[-500:]
for slug, _ in CHAIN:
    assert slug in text, f'{slug} placed but never printed'
assert 'upstream to downstream' in text, 'no ordering header'
assert 'DRY RUN' in text and 'wrote' not in text, 'dry run must not write'
first = min(text.index(s) for s, _ in CHAIN if s in text)
assert text.index('lake_james') == first, 'the most upstream water must print first'
assert text.index('lake_james') < text.index('wateree_lake'), 'james above wateree'
assert 'fed directly by' in text, 'upstream links not shown'
print('dry-run report assertions pass')


# --- a side channel: low stream order carrying a big upstream basin ----------------------
# russ_lake came back as stream order 1 with 7,858 km2. TotDASqKm counts everything that
# passed upstream; DivDASqKm is what actually flows through a divergent path.
_side = pd.DataFrame([{'NHDPlusID': 9100, 'HydroSeq': 15001500000450.0,
                       'DnHydroSeq': 15001500000449.0, 'LevelPathI': 7777.0,
                       'TotDASqKm': 38671.5, 'StreamOrde': 1.0, 'Divergence': 2.0,
                       'DivDASqKm': 12.3}])
_wb = pd.DataFrame([{'Permanent_Identifier': 'wb_side', 'GNIS_ID': '424242',
                     'GNIS_Name': 'Wittee Lake', 'AreaSqKm': 0.46, 'FType': 390}])
_sv, _sf, _sw = VAA, FL, WB
globals()['VAA'] = pd.concat([VAA, _side], ignore_index=True)
globals()['FL'] = pd.concat([FL, pd.DataFrame([{'NHDPlusID': 9100,
                             'WBArea_Permanent_Identifier': 'wb_side'}])], ignore_index=True)
globals()['WB'] = pd.concat([WB, _wb], ignore_index=True)
_want = dict(want); _want['424242'] = ['wittee_lake']
_r3, _ = bwc.process_vpu('0305', 'fake.gdb', _want, None)
globals()['VAA'], globals()['FL'], globals()['WB'] = _sv, _sf, _sw
_wl = _r3['wittee_lake']
assert _wl['stream_order'] == 1, _wl['stream_order']
assert _wl['drainage_km2'] == 38671.5, 'TotDASqKm still reported as upstream total'
assert _wl['div_drainage_km2'] == 12.3, 'DivDASqKm is what flows THROUGH the side channel'
assert _wl['divergence'] == 2, 'divergence recorded'
assert _wl['side_channel'] is True, \
    'an oxbow: 38,671 km2 upstream but only 12.3 routed through it'
assert _wl['local_drainage_km2'] == 12.3, 'local inflow is DivDASqKm for a side channel'
assert _wl['on_divergent_path'] is True, 'Divergence recorded (2 in this fixture)'
assert _r3['wateree_lake']['side_channel'] is False, 'a main-stem reservoir is not an oxbow'
assert _r3['wateree_lake']['local_drainage_km2'] == _r3['wateree_lake']['drainage_km2'], \
    'a normal water reports its own drainage unchanged'
# the real data has Divergence=0 on all three oxbows, so the FLAG must not be the test
_flat = pd.DataFrame([{'NHDPlusID': 9200, 'HydroSeq': 15001500000440.0,
                       'DnHydroSeq': 15001500000439.0, 'LevelPathI': 6666.0,
                       'TotDASqKm': 21302.2, 'StreamOrde': 2.0, 'Divergence': 0.0,
                       'DivDASqKm': 25.2}])
_wb2 = pd.DataFrame([{'Permanent_Identifier': 'wb_ox', 'GNIS_ID': '515151',
                      'GNIS_Name': 'Lowthers Lake', 'AreaSqKm': 0.53, 'FType': 390}])
_sv, _sf, _sw = VAA, FL, WB
globals()['VAA'] = pd.concat([VAA, _flat], ignore_index=True)
globals()['FL'] = pd.concat([FL, pd.DataFrame([{'NHDPlusID': 9200,
                             'WBArea_Permanent_Identifier': 'wb_ox'}])], ignore_index=True)
globals()['WB'] = pd.concat([WB, _wb2], ignore_index=True)
_w4 = dict(want); _w4['515151'] = ['lowthers_lake']
_r4, _ = bwc.process_vpu('0305', 'fake.gdb', _w4, None)
globals()['VAA'], globals()['FL'], globals()['WB'] = _sv, _sf, _sw
_lo = _r4['lowthers_lake']
assert _lo['divergence'] == 0, 'the real oxbows all have Divergence 0'
assert _lo['on_divergent_path'] is False, 'so that flag cannot be what identifies them'
assert _lo['side_channel'] is True, 'THE RATIO identifies it: 21,302 upstream vs 25.2 through'
assert _lo['local_drainage_km2'] == 25.2, 'its own catchment'
assert _r3['wateree_lake']['on_divergent_path'] is False, 'and is not divergent'
print('divergent side-channel assertions pass')
