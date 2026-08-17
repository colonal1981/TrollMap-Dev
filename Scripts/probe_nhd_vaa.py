#!/usr/bin/env python3
"""
probe_nhd_vaa.py -- read-only look at one NHDPlus HR geodatabase.

WHAT THE FIRST RUN SETTLED, 2026-08-17: the schema is exactly as hoped.

    NHDPlusFlowlineVAA   NHDPlusID, HydroSeq, UpHydroSeq, DnHydroSeq, LevelPathI, TotDASqKm,
                         StreamOrde, ArbolateSu, TerminalPa, ...            87,078 rows in 0303
    NHDFlowline          NHDPlusID, WBArea_Permanent_Identifier, GNIS_Name   89,678
    NHDWaterbody         Permanent_Identifier, GNIS_Name, AreaSqKm, FType    29,668

WHAT IT ALSO SETTLED: I had the wrong basin. HU4 0303 is CAPE FEAR. The Yadkin-Pee Dee is 0304
and the Catawba-Wateree is 0305, so asking 0303 for High Rock and Tillery correctly found
nothing. My mistake, and the reason this version does not depend on me knowing which lake is in
which HUC.

THE DIRECTION OF HydroSeq IS STILL THE WHOLE QUESTION, and this version answers it without
naming a single lake, twice over:

  1. DnHydroSeq IS THE NEXT FLOWLINE DOWNSTREAM, BY DEFINITION. So comparing it to HydroSeq on
     every row in the table says which way the number runs. Nothing about any particular river
     is needed and there is nothing for me to remember wrong.

  2. DRAINAGE AREA ONLY INCREASES DOWNSTREAM. Water does not leave a river. So if the ordering
     from (1) is right, TotDASqKm must rise as you walk down a level path -- an independent
     check on the same claim, from a different column, with no outside knowledge at all.

Then it prints the largest reservoirs in whatever GDB it was given, in the derived order, with
their drainage areas beside them. Whether those are lakes I can name does not matter; whether
the drainage areas climb does.

Read-only. Opens the zip, reads three layers, prints, writes nothing.

USAGE
    py scripts\\probe_nhd_vaa.py                                  # 0303, Cape Fear, smallest zip
    py scripts\\probe_nhd_vaa.py --gdb F:\\TrollMapPipeline\\NHD\\NHDPLUS_H_0305_HU4_GDB.zip
"""
import argparse
import sys
from pathlib import Path

DEFAULT_GDB = r'F:\TrollMapPipeline\NHD\NHDPLUS_H_0303_HU4_GDB.zip'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--gdb', default=DEFAULT_GDB)
    ap.add_argument('--top', type=int, default=10, help='how many of the largest reservoirs')
    args = ap.parse_args()

    try:
        import pyogrio
    except ImportError:
        print('pyogrio is not installed. geopandas pulls it in.')
        return 2
    import pandas as pd
    import warnings
    warnings.filterwarnings('ignore', message='Measured .M. geometry types')

    src = args.gdb
    if not Path(src).exists():
        print(f'not found: {src}')
        return 2
    print(f'== {Path(src).name}\n')

    vaa = pyogrio.read_dataframe(
        src, layer='NHDPlusFlowlineVAA', read_geometry=False,
        columns=['NHDPlusID', 'HydroSeq', 'DnHydroSeq', 'UpHydroSeq', 'LevelPathI',
                 'TotDASqKm', 'StreamOrde'])
    print(f'VAA rows: {len(vaa)}')

    # ---- 1. WHICH WAY DOES HydroSeq RUN --------------------------------------------------
    #
    # DnHydroSeq is the hydrosequence of the flowline immediately downstream. 0 means "nothing
    # downstream in this VPU" and is not a comparison.
    d = vaa[(vaa['DnHydroSeq'] > 0) & (vaa['HydroSeq'] > 0)]
    lower = int((d['DnHydroSeq'] < d['HydroSeq']).sum())
    higher = int((d['DnHydroSeq'] > d['HydroSeq']).sum())
    print('\n== 1. direction, from DnHydroSeq')
    print(f'   rows with a downstream neighbour: {len(d)}')
    print(f'   DnHydroSeq  LOWER than HydroSeq: {lower}')
    print(f'   DnHydroSeq HIGHER than HydroSeq: {higher}')
    if lower and lower > higher * 100:
        decreasing = True
        print('   -> HydroSeq DECREASES downstream. A lake outlet is its MINIMUM HydroSeq and')
        print('      sorting DESCENDING gives upstream-to-downstream.')
    elif higher and higher > lower * 100:
        decreasing = False
        print('   -> HydroSeq INCREASES downstream. A lake outlet is its MAXIMUM HydroSeq and')
        print('      sorting ASCENDING gives upstream-to-downstream.')
    else:
        decreasing = None
        print('   -> NOT CLEAN EITHER WAY. Do not write the real script off this; paste it back.')

    # ---- 2. THE SAME CLAIM FROM A DIFFERENT COLUMN ---------------------------------------
    #
    # Water does not leave a river, so drainage area only grows going downstream. If (1) is
    # right, the downstream neighbour's TotDASqKm is never smaller than this one's.
    m = d.merge(vaa[['HydroSeq', 'TotDASqKm']].rename(
        columns={'HydroSeq': 'DnHydroSeq', 'TotDASqKm': 'dn_da'}), on='DnHydroSeq', how='inner')
    m = m[(m['TotDASqKm'] > 0) & (m['dn_da'] > 0)]
    grew = int((m['dn_da'] >= m['TotDASqKm']).sum())
    print('\n== 2. the same claim from drainage area')
    print(f'   pairs compared: {len(m)}')
    print(f'   downstream drainage >= upstream drainage: {grew} '
          f'({100.0 * grew / max(1, len(m)):.1f}%)')
    print('   Anything below about 95% means the join or the direction is wrong, not the river.')

    # ---- 3. the biggest waterbodies, in the derived order ---------------------------------
    #
    # NO FType FILTER. The first version filtered FType == 436 "Reservoir", which in NHD means
    # engineered water -- tailings ponds, farm ponds, treatment basins. Every big Duke
    # impoundment is FType 390 Lake/Pond, so that filter excluded every lake we care about and
    # then returned the largest of what was left, none over half a square kilometre. FType and
    # FCode are PRINTED here instead of filtered on, so the codes come from the data.
    wb = pyogrio.read_dataframe(
        src, layer='NHDWaterbody', read_geometry=False,
        columns=['Permanent_Identifier', 'GNIS_Name', 'AreaSqKm', 'FType', 'FCode'])
    res = wb[wb['GNIS_Name'].notna()].sort_values('AreaSqKm', ascending=False).head(args.top)
    print(f'\n== 3a. the {len(res)} largest NAMED waterbodies in this GDB, any FType')
    if res.empty:
        print('   none — nothing more to check here.')
        return 0
    print(res[['GNIS_Name', 'FType', 'FCode', 'AreaSqKm']].to_string(index=False))

    fl = pyogrio.read_dataframe(
        src, layer='NHDFlowline', read_geometry=False,
        columns=['NHDPlusID', 'WBArea_Permanent_Identifier'])
    linked = fl[fl['WBArea_Permanent_Identifier'].isin(set(res['Permanent_Identifier']))]
    j = linked.merge(vaa, on='NHDPlusID', how='inner').merge(
        res[['Permanent_Identifier', 'GNIS_Name', 'AreaSqKm', 'FType', 'FCode']],
        left_on='WBArea_Permanent_Identifier', right_on='Permanent_Identifier', how='left')
    print(f'\n== 3b. flowlines inside them: {len(linked)}   joined to VAA: {len(j)}')
    if j.empty:
        print('   the waterbody-to-flowline join produced nothing — paste this back.')
        return 1

    # HydroSeq DECREASES downstream (section 1), so the outlet is the MINIMUM and DESCENDING
    # order reads upstream-to-downstream. The first version sorted ascending, which printed the
    # chain backwards from what section 1 had just concluded.
    outlet = 'min' if decreasing is not False else 'max'
    g = (j.groupby('GNIS_Name')
           .agg(outlet_hydroseq=('HydroSeq', outlet),
                levelpath=('LevelPathI', lambda s: s.mode().iat[0] if len(s.mode()) else 0),
                drainage_km2=('TotDASqKm', 'max'),
                stream_order=('StreamOrde', 'max'),
                ftype=('FType', 'max'),
                flowlines=('NHDPlusID', 'count'),
                area_km2=('AreaSqKm', 'max'))
           .reset_index()
           .sort_values('outlet_hydroseq', ascending=(decreasing is False)))
    # HydroSeq and LevelPathI are 14-digit ids. As floats pandas prints them 1.500150e+13 and
    # every row looks identical, which is how the first version hid the ordering it got wrong.
    for c in ('outlet_hydroseq', 'levelpath'):
        g[c] = g[c].astype('int64')
    pd.set_option('display.width', 240)
    print()
    print(g.to_string(index=False))

    print('\n   Read DOWN the list: upstream to downstream. Where two rows share a LEVELPATH they')
    print('   are on the same river and DRAINAGE_KM2 must climb between them. Where the levelpath')
    print('   differs they are on different arms and are not above or below each other at all.')
    print('\n   Paste the whole block back.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
