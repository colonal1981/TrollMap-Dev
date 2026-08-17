"""End-to-end test of process_vpu with a fake pyogrio, so the function that actually
crashed on 0305 is exercised, not just the helpers around it."""
import importlib.util, sys, types
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
                         'StreamOrde': 8.0})
        fl_rows.append({'NHDPlusID': npid, 'WBArea_Permanent_Identifier': pids[i % len(pids)]})
        npid += 1; hs -= 5
    # a connector flowline between lakes, in the network but in no waterbody
    vaa_rows.append({'NHDPlusID': npid, 'HydroSeq': float(hs), 'DnHydroSeq': float(hs-5),
                     'LevelPathI': 5823.0, 'TotDASqKm': float(1000 + (1000-hs)*3),
                     'StreamOrde': 8.0})
    fl_rows.append({'NHDPlusID': npid, 'WBArea_Permanent_Identifier': None}); npid += 1; hs -= 5
vaa_rows[-1]['DnHydroSeq'] = 0.0                                  # terminal below Wateree

# THE ROWS THAT CRASHED IT: unrouted flowlines carry NaN hydrosequences.
for i in range(400):
    vaa_rows.append({'NHDPlusID': npid, 'HydroSeq': nan, 'DnHydroSeq': nan,
                     'LevelPathI': nan, 'TotDASqKm': nan, 'StreamOrde': nan})
    fl_rows.append({'NHDPlusID': npid, 'WBArea_Permanent_Identifier': None}); npid += 1
# one NaN flowline sitting INSIDE a matched lake -- the nastier case
vaa_rows.append({'NHDPlusID': npid, 'HydroSeq': nan, 'DnHydroSeq': nan, 'LevelPathI': nan,
                 'TotDASqKm': nan, 'StreamOrde': nan})
fl_rows.append({'NHDPlusID': npid, 'WBArea_Permanent_Identifier': 'wb_1227425'}); npid += 1
# the two-Lake-Marion trap: same GNIS_Name, different polygons, neither in the registry
for nm in ('wb_marion_a', 'wb_marion_b'):
    wb_rows.append({'Permanent_Identifier': nm, 'GNIS_ID': '999999', 'GNIS_Name': 'Lake Marion',
                    'AreaSqKm': 324.0, 'FType': 466})

VAA = pd.DataFrame(vaa_rows); FL = pd.DataFrame(fl_rows); WB = pd.DataFrame(wb_rows)

fake = types.ModuleType('pyogrio')
def read_dataframe(src, layer=None, read_geometry=None, columns=None):
    df = {'NHDPlusFlowlineVAA': VAA, 'NHDFlowline': FL, 'NHDWaterbody': WB}[layer]
    return df[[c for c in columns if c in df.columns]].copy()
fake.read_dataframe = read_dataframe
sys.modules['pyogrio'] = fake

spec = importlib.util.spec_from_file_location('bwc', HERE / 'build_water_chain.py')
bwc = importlib.util.module_from_spec(spec); spec.loader.exec_module(bwc)

want = {}
for slug, gnis in CHAIN:
    want.setdefault(bwc.normalize_gnis('gnis:' + gnis), []).append(slug)

rows, note = bwc.process_vpu('0305', 'fake.gdb', want, None)
print('note:', note)

order = [s for s,_ in CHAIN]
assert set(rows) == set(order), f'missing: {set(order) - set(rows)}'
got = sorted(rows, key=lambda s: -rows[s]['outlet_hydroseq'])
assert got == order, f'ORDER WRONG:\n  got  {got}\n  want {order}'
for i, s in enumerate(order):
    w = order[i+1] if i+1 < len(order) else None
    assert rows[s]['downstream'] == w, f'{s} -> {rows[s]["downstream"]}, want {w}'
assert rows['cedar_creek_reservoir_2']['downstream'] == 'wateree_lake', 'CEDAR CREEK = INFLOW'
assert rows['wateree_lake']['downstream'] is None, 'WATEREE = OUTFLOW'

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
