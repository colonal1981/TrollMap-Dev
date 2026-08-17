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


# ==========================================================================================
# THE GEOMETRIC BINDING PATH, added 2026-08-17.
#
# The GNIS join placed 283 of 450 waters. 149 of the 167 it gave up on said "no gnis id in
# registry" -- their registry id is a synthetic 'slug:<slug>'. blewett_falls_lake was one:
# Duke publishes it, it has a Duke dam, and releaseDirection() returned null for every release
# because the chain had no node. _nhd_bindings.json already held its Permanent_Identifier.
#
# THE RISK THIS SECTION EXISTS TO RULE OUT is not "does the new path work" -- it is "did the
# new path move a water that already worked". The 283 were validated against USACE surveyed
# drainage at a median disagreement of 0.2%; if a binding can steal a polygon from a
# GNIS-placed water, that validation stops meaning anything. So the FIRST test is equality.
# ==========================================================================================
import copy as _copy

_BASE, _ = bwc.process_vpu('0305', 'fake.gdb', want, None)
_BASE = _copy.deepcopy(_BASE)

# every water the GNIS join places must report how it was placed
for _s, _r in _BASE.items():
    assert _r['match_via'] == 'gnis', f'{_s} placed on GNIS but says {_r["match_via"]}'
    assert _r['gnis'], f'{_s} placed on GNIS but carries no id'

# --- three waters that GNIS cannot reach, each routing into lake_james -------------------
#  * blewett  -- a real NHDWaterbody row whose GNIS_ID is null, exactly like the real Blewett
#  * area_riv -- NO waterbody row at all, only a flowline. This is the NHDArea case: 47 of the
#                140 rescued waters are rivers bound to NHDArea, a layer this script never
#                reads, and NHDFlowline.WBArea_Permanent_Identifier references either layer.
#  * braced   -- the identifier is a GUID, braced, and the two sides DISAGREE ON CASE, which
#                _nhd_bindings.json genuinely does within one file.
_EXTRA_FL = [(1105.0, 'wb_blewett_nogniis'), (1110.0, 'area_120006810'),
             (1115.0, '{D7218688-637B-48BC-87E8-6485082D8569}')]
_bind_vaa, _bind_fl = [], []
_nid = 9500
for _hs, _pid in _EXTRA_FL:
    _bind_vaa.append({'NHDPlusID': _nid, 'HydroSeq': _hs, 'DnHydroSeq': 1000.0,
                      'LevelPathI': 5823.0, 'TotDASqKm': 42.0, 'StreamOrde': 3.0,
                      'Divergence': 0.0, 'DivDASqKm': 42.0})
    _bind_fl.append({'NHDPlusID': _nid, 'WBArea_Permanent_Identifier': _pid})
    _nid += 1
# the waterbody row for blewett only -- with a NULL GNIS id, which is why GNIS cannot see it
_bind_wb = [{'Permanent_Identifier': 'wb_blewett_nogniis', 'GNIS_ID': None,
             'GNIS_Name': None, 'AreaSqKm': 8.78, 'FType': 390}]
# a polygon that would drag lake_norman's outlet a long way downstream if a binding were ever
# allowed to claim a slug the GNIS join already placed
_bind_vaa.append({'NHDPlusID': _nid, 'HydroSeq': 800.0, 'DnHydroSeq': 795.0,
                  'LevelPathI': 1.0, 'TotDASqKm': 88888.0, 'StreamOrde': 9.0,
                  'Divergence': 0.0, 'DivDASqKm': 88888.0})
_bind_fl.append({'NHDPlusID': _nid, 'WBArea_Permanent_Identifier': 'wb_intruder'})

_WANT_PID = {
    'wb_blewett_nogniis': ('blewett_falls_lake', {
        'nhd_layer': 'NHDWaterbody', 'nhd_gnis_name': None, 'nhd_acres': 2170.6,
        'nhd_ftype': 390, 'permanent_identifier': 'wb_blewett_nogniis', 'vpu': '0305'}),
    'area_120006810': ('catawba_river', {
        'nhd_layer': 'NHDArea', 'nhd_gnis_name': 'Catawba River', 'nhd_acres': 2650.0,
        'nhd_ftype': 460, 'permanent_identifier': 'area_120006810', 'vpu': '0305'}),
    # the binding's casing is LOWER, the geodatabase's is UPPER. Same feature.
    '{d7218688-637b-48bc-87e8-6485082d8569}': ('catawba_river_2', {
        'nhd_layer': 'NHDArea', 'nhd_gnis_name': 'Catawba River', 'nhd_acres': 643.0,
        'nhd_ftype': 460, 'permanent_identifier': '{d7218688-637b-48bc-87e8-6485082d8569}',
        'vpu': '0305'}),
    # THE ONE THAT MUST BE REFUSED: lake_norman is already placed on its GNIS id.
    'wb_intruder': ('lake_norman', {
        'nhd_layer': 'NHDWaterbody', 'nhd_gnis_name': 'Impostor', 'nhd_acres': 1.0,
        'nhd_ftype': 390, 'permanent_identifier': 'wb_intruder', 'vpu': '0305'}),
}
# main() normalises the binding keys before handing them over; do the same here.
_WANT_PID = {bwc.norm_pid(k): v for k, v in _WANT_PID.items()}

_sv, _sf, _sw = VAA, FL, WB
globals()['VAA'] = pd.concat([VAA, pd.DataFrame(_bind_vaa)], ignore_index=True)
globals()['FL'] = pd.concat([FL, pd.DataFrame(_bind_fl)], ignore_index=True)
globals()['WB'] = pd.concat([WB, pd.DataFrame(_bind_wb)], ignore_index=True)
_RB, _note_b = bwc.process_vpu('0305', 'fake.gdb', want, None, _WANT_PID)
globals()['VAA'], globals()['FL'], globals()['WB'] = _sv, _sf, _sw
print('[bindings] note:', _note_b)

# --- 1. NOTHING THAT ALREADY PLACED MOVED ------------------------------------------------
for _s in _BASE:
    assert _s in _RB, f'{_s} placed without bindings and vanished with them'
    assert _RB[_s] == _BASE[_s], (
        f'{_s} CHANGED when the binding table was added:\n'
        f'  before {_BASE[_s]}\n  after  {_RB[_s]}')
print('the GNIS-placed waters are byte-identical with the binding table on:', len(_BASE))

# --- 2. a binding may NOT claim a slug the GNIS join already placed ----------------------
assert _RB['lake_norman']['drainage_km2'] < 80000, \
    'wb_intruder was allowed to claim lake_norman -- the slug guard is not holding'
assert _RB['lake_norman']['flowlines'] == 2, 'lake_norman kept only its own two polygons'
assert _RB['lake_norman']['match_via'] == 'gnis'

# --- 3. blewett: a real waterbody row whose GNIS_ID is null ------------------------------
_bl = _RB['blewett_falls_lake']
assert _bl['match_via'] == 'geometry', _bl['match_via']
assert _bl['gnis'] is None, 'a water placed geometrically has no GNIS id to report'
assert _bl['downstream'] == 'lake_james', _bl['downstream']
assert _bl['nhd_ftype'] == 390, _bl['nhd_ftype']
# meta comes off the BINDING RECORD, because a null GNIS_ID means the polygon never lands in
# `hit` -- which is the whole reason GNIS could not place it in the first place. The fixture's
# waterbody row says AreaSqKm 8.78 and the record says 2170.6 acres = 8.7841 km2, which round
# differently at four places ON PURPOSE, so this asserts WHICH SOURCE was read and not merely
# that some number arrived.
assert _bl['nhd_area_km2'] == round(2170.6 / 247.105, 4), _bl['nhd_area_km2']
assert _bl['nhd_area_km2'] != 8.78, 'that is the polygon column, not the binding record'

# --- 4. NHDArea: a pid with no waterbody row at all --------------------------------------
_cr = _RB['catawba_river']
assert _cr['match_via'] == 'geometry'
assert _cr['downstream'] == 'lake_james', _cr['downstream']
assert _cr['nhd_ftype'] == 460, 'the FType travels on the binding record, not the wb layer'
assert _cr['nhd_name'] == 'Catawba River', _cr['nhd_name']
assert _cr['nhd_area_km2'] == round(2650.0 / 247.105, 4), _cr['nhd_area_km2']

# --- 5. the identifier is a GUID and the two sides disagree on case ----------------------
assert 'catawba_river_2' in _RB, (
    'a braced GUID in UPPER case in the geodatabase did not join a binding written in lower '
    'case -- norm_pid is not being applied on both sides')
assert _RB['catawba_river_2']['downstream'] == 'lake_james'

# --- 6. and with no binding table at all, the old behaviour is exactly the old behaviour --
_sv, _sf, _sw = VAA, FL, WB
globals()['VAA'] = pd.concat([VAA, pd.DataFrame(_bind_vaa)], ignore_index=True)
globals()['FL'] = pd.concat([FL, pd.DataFrame(_bind_fl)], ignore_index=True)
globals()['WB'] = pd.concat([WB, pd.DataFrame(_bind_wb)], ignore_index=True)
_RN, _ = bwc.process_vpu('0305', 'fake.gdb', want, None, None)
globals()['VAA'], globals()['FL'], globals()['WB'] = _sv, _sf, _sw
assert set(_RN) == set(_BASE), 'want_pid=None must place exactly the GNIS set'
for _s in _BASE:
    assert _RN[_s] == _BASE[_s], f'{_s} differs with want_pid=None'
print('want_pid=None reproduces the GNIS-only run exactly')

print('binding-path assertions pass:', len(_RB), 'waters,',
      sum(1 for r in _RB.values() if r['match_via'] == 'geometry'), 'of them geometric')


# --- main() with a binding table ON DISK, which is the path Ryan actually runs -------------
# Exercising process_vpu directly proves the join. It does NOT prove that main() finds
# _nhd_bindings.json, filters it to the right VPU, normalises the keys, or reports honestly --
# and the last command handed over untested blew up on a NameError in exactly that gap.
_REG = {slug: {'gnis': 'gnis:' + g} for slug, g in CHAIN}
_REG['blewett_falls_lake'] = {'gnis': 'slug:blewett_falls_lake'}
_REG['catawba_river'] = {'gnis': 'slug:catawba_river'}
_REG['catawba_river_2'] = {'gnis': 'slug:catawba_river_2'}
_REG['coast_savannah_ga'] = {'gnis': 'slug:coast_savannah_ga'}   # bound by nothing, by design
_BINDINGS = {'bindings': {
    'blewett_falls_lake': {'slug': 'blewett_falls_lake', 'vpu': '0305',
                           'permanent_identifier': 'wb_blewett_nogniis',
                           'nhd_layer': 'NHDWaterbody', 'nhd_gnis_name': None,
                           'nhd_acres': 2170.6, 'nhd_ftype': 390},
    'catawba_river': {'slug': 'catawba_river', 'vpu': '0305',
                      'permanent_identifier': 'area_120006810', 'nhd_layer': 'NHDArea',
                      'nhd_gnis_name': 'Catawba River', 'nhd_acres': 2650.0,
                      'nhd_ftype': 460},
    'catawba_river_2': {'slug': 'catawba_river_2', 'vpu': '0305',
                        'permanent_identifier': '{d7218688-637b-48bc-87e8-6485082d8569}',
                        'nhd_layer': 'NHDArea', 'nhd_gnis_name': 'Catawba River',
                        'nhd_acres': 643.0, 'nhd_ftype': 460},
    # a binding for a DIFFERENT VPU must not be offered to 0305
    'lake_somewhere_else': {'slug': 'lake_somewhere_else', 'vpu': '0601',
                            'permanent_identifier': 'wb_blewett_nogniis',
                            'nhd_layer': 'NHDWaterbody', 'nhd_acres': 5.0, 'nhd_ftype': 390},
    # a binding with no identifier at all must be counted and dropped, not crash
    'lake_no_pid': {'slug': 'lake_no_pid', 'vpu': '0305', 'permanent_identifier': None,
                    'nhd_layer': 'NHDWaterbody', 'nhd_acres': 5.0, 'nhd_ftype': 390},
    # a binding for a water that is not in the registry at all must be ignored
    'lake_not_in_registry': {'slug': 'lake_not_in_registry', 'vpu': '0305',
                             'permanent_identifier': 'wb_ghost',
                             'nhd_layer': 'NHDWaterbody', 'nhd_acres': 5.0, 'nhd_ftype': 390},
}}
_REG['lake_somewhere_else'] = {'gnis': 'slug:lake_somewhere_else'}
_REG['lake_no_pid'] = {'gnis': 'slug:lake_no_pid'}


def _run_main(with_bindings=True, extra_argv=()):
    _sv2, _sf2, _sw2 = VAA, FL, WB
    globals()['VAA'] = pd.concat([VAA, pd.DataFrame(_bind_vaa)], ignore_index=True)
    globals()['FL'] = pd.concat([FL, pd.DataFrame(_bind_fl)], ignore_index=True)
    globals()['WB'] = pd.concat([WB, pd.DataFrame(_bind_wb)], ignore_index=True)
    try:
        with _tf.TemporaryDirectory() as t:
            root = _P(t); (root / 'registry').mkdir()
            (root / 'registry' / 'lake_index.json').write_text(_json.dumps(_REG))
            if with_bindings:
                (root / 'registry' / '_nhd_bindings.json').write_text(_json.dumps(_BINDINGS))
            nhd = root / 'nhd'; nhd.mkdir()
            (nhd / 'NHDPLUS_H_0305_HU4_GDB.zip').write_text('x')
            out = root / 'registry' / 'water_chain.json'
            sys.argv = ['x', '--registry', str(root / 'registry' / 'lake_index.json'),
                        '--nhd', str(nhd), '--only', '0305', '--write', '--out', str(out),
                        *extra_argv]
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = bwc.main()
            return rc, buf.getvalue(), _json.loads(out.read_text())
    finally:
        globals()['VAA'], globals()['FL'], globals()['WB'] = _sv2, _sf2, _sw2


_rc, _txt, _doc = _run_main()
assert _rc == 0, _txt[-800:]
_w = _doc['waters']
assert 'blewett_falls_lake' in _w, 'main() did not reach the binding table\n' + _txt[-800:]
assert _w['blewett_falls_lake']['downstream'] == 'lake_james'
assert _w['blewett_falls_lake']['match_via'] == 'geometry'
assert _w['catawba_river']['match_via'] == 'geometry'
assert _w['catawba_river_2']['match_via'] == 'geometry', 'the braced GUID did not survive main()'
for _s, _g in CHAIN:
    assert _w[_s]['match_via'] == 'gnis', _s
assert 'blewett_falls_lake' in _w['lake_james']['upstream'], _w['lake_james']['upstream']

# a binding filed under 0601 must not be handed to the 0305 reader even though its identifier
# would have matched -- a pid is only unique within its own VPU
assert 'lake_somewhere_else' not in _w, 'a 0601 binding leaked into the 0305 run'
assert 'lake_somewhere_else' in _doc['unmatched']

# the three kinds of "did not place" must read differently
_u = _doc['unmatched']
assert _u['coast_savannah_ga'] == 'no gnis id in registry and no geometric binding', \
    _u['coast_savannah_ga']
assert _u['lake_no_pid'] == 'no gnis id in registry and no geometric binding', _u['lake_no_pid']
assert 'lake_not_in_registry' not in _u and 'lake_not_in_registry' not in _w

assert _doc['_meta']['matched_on'] == 'gnis id, then geometric binding', _doc['_meta']
assert _doc['_meta']['placed_via_gnis'] == len(CHAIN), _doc['_meta']
assert _doc['_meta']['placed_via_geometry'] == 3, _doc['_meta']
assert 'carry no usable identifier' in _txt, 'the dropped binding was not reported'
print('main() with a binding table on disk: assertions pass')

# --- and the two fallbacks, which must be loud rather than silent --------------------------
_rc2, _txt2, _doc2 = _run_main(with_bindings=False)
assert _rc2 == 0, _txt2[-500:]
assert set(_doc2['waters']) == {s for s, _ in CHAIN}, 'no binding file must mean GNIS only'
assert 'NO BINDING TABLE' in _txt2, 'a missing binding table must say so'
assert _doc2['_meta']['matched_on'] == 'gnis id only', _doc2['_meta']
assert _doc2['unmatched']['blewett_falls_lake'] == \
    'no gnis id in registry and no geometric binding'

_rc3, _txt3, _doc3 = _run_main(extra_argv=('--no-bindings',))
assert _rc3 == 0, _txt3[-500:]
assert set(_doc3['waters']) == {s for s, _ in CHAIN}, '--no-bindings must mean GNIS only'
assert _doc3['waters'] == _doc2['waters'], '--no-bindings and no file must agree exactly'
print('both fallbacks assertions pass')
