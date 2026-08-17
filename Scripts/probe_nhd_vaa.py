#!/usr/bin/env python3
"""
probe_nhd_vaa.py -- read-only look at one NHDPlus HR geodatabase.

WHY THIS EXISTS AND WHY IT IS NOT THE REAL SCRIPT.

Ryan, 2026-08-17: *"all i can find is this map... if you have some way of using nhd or 3dhp that
is on my drive go ahead"*. Duke publishes a picture of its power plants and no API for which dam
sits above which lake, so the chain order has to be derived. NHDPlus High Resolution carries it:
every flowline has a HYDROSEQUENCE, and the whole point of that number is that it orders a river.

I cannot run this myself. The GDBs are 167 MB to 487 MB and staging one into my sandbox timed
out; geopandas is not installed on the bridge VM and it has no network to install it. So rather
than write four hundred lines against a schema I am remembering, this prints the handful of
facts the real script depends on -- and one of them is a CONVENTION I must not get backwards.

WHAT I NEED OUT OF IT

  1. The layer names, because NHDPlus HR has renamed the VAA table before.
  2. The VAA columns, so the join is written against what is there.
  3. THE DIRECTION OF HydroSeq. NHDPlus assigns it so that everything upstream is processed
     first, which should make it DECREASE going downstream -- so a lake's outlet is its MINIMUM
     HydroSeq and sorting descending gives upstream-to-downstream. That is the claim. The Yadkin
     chain below settles it, because its order is not in dispute:

         High Rock -> Tuckertown -> Badin (Narrows) -> Falls -> Tillery -> Blewett Falls

     If HydroSeq comes out largest at High Rock and smallest at Blewett Falls, the convention is
     as stated and the real script can be written. If it is the other way round, it is written
     the other way round. Nothing else in this file matters as much as that one ordering.

Read-only. It opens the zip, reads three layers, prints, and writes nothing.

USAGE
    py scripts/probe_nhd_vaa.py
    py scripts/probe_nhd_vaa.py --gdb F:\\TrollMapPipeline\\NHD\\NHDPLUS_H_0305_HU4_GDB.zip
"""
import argparse
import sys
from pathlib import Path

DEFAULT_GDB = r'F:\TrollMapPipeline\NHD\NHDPLUS_H_0303_HU4_GDB.zip'

# The Yadkin-Pee Dee chain, top to bottom, entirely inside HU4 0303. Duke runs Tillery and
# publishes it as basin 3. The order is not in dispute, which is what makes it a test.
YADKIN = ['High Rock', 'Tuckertown', 'Badin', 'Falls', 'Tillery', 'Blewett Falls']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--gdb', default=DEFAULT_GDB)
    ap.add_argument('--names', default=','.join(YADKIN),
                    help='comma-separated GNIS_Name fragments to look up')
    args = ap.parse_args()

    try:
        import pyogrio
    except ImportError:
        print('pyogrio is not installed. geopandas pulls it in; trollmap_nhd_boundaries.py '
              'already needs geopandas, so it should be there.')
        return 2
    import pandas as pd

    src = args.gdb
    if not Path(src).exists():
        print(f'not found: {src}')
        return 2

    print(f'== {Path(src).name}')
    layers = [row[0] for row in pyogrio.list_layers(src)]
    print(f'\n-- layers ({len(layers)})')
    for name in sorted(layers):
        print(f'   {name}')

    def pick(*candidates):
        for c in candidates:
            for name in layers:
                if name.lower() == c.lower():
                    return name
        return None

    vaa_layer = pick('NHDPlusFlowlineVAA', 'NHDPlusFlowlineVAA_HR', 'PlusFlowlineVAA')
    fl_layer = pick('NHDFlowline')
    wb_layer = pick('NHDWaterbody')
    print(f'\n-- using: VAA={vaa_layer}  flowline={fl_layer}  waterbody={wb_layer}')
    if not (vaa_layer and fl_layer and wb_layer):
        print('   one of the three is missing -- the layer names above are what the real script '
              'has to be written against.')
        return 1

    for layer in (vaa_layer, fl_layer, wb_layer):
        info = pyogrio.read_info(src, layer=layer)
        print(f'\n-- {layer}: {info["features"]} features')
        print('   columns: ' + ', '.join(list(info['fields'])))

    # ---- the waterbodies, by name -------------------------------------------------------
    wanted = [n.strip().lower() for n in args.names.split(',') if n.strip()]
    wb = pyogrio.read_dataframe(src, layer=wb_layer, read_geometry=False,
                                columns=['Permanent_Identifier', 'GNIS_Name', 'AreaSqKm', 'FType'])
    wb['_n'] = wb['GNIS_Name'].fillna('').str.lower()
    hits = wb[wb['_n'].apply(lambda s: any(w in s for w in wanted))]
    print(f'\n-- waterbodies matching {wanted}: {len(hits)}')
    if hits.empty:
        print('   none -- try --names with something in this GDB, or a different HU4.')
        return 1

    # ---- their flowlines, and the VAA rows for those ------------------------------------
    fl_cols = ['NHDPlusID', 'GNIS_Name', 'WBArea_Permanent_Identifier']
    fl = pyogrio.read_dataframe(src, layer=fl_layer, read_geometry=False, columns=fl_cols)
    linked = fl[fl['WBArea_Permanent_Identifier'].isin(set(hits['Permanent_Identifier']))]
    print(f'-- flowlines inside them: {len(linked)}')
    if linked.empty:
        print('   the waterbody-to-flowline link is not WBArea_Permanent_Identifier in this GDB. '
              'The flowline columns printed above are what to join on instead.')
        return 1

    vaa_cols = ['NHDPlusID', 'HydroSeq', 'UpHydroSeq', 'DnHydroSeq', 'LevelPathI', 'TotDASqKm',
                'StreamOrde']
    info = pyogrio.read_info(src, layer=vaa_layer)
    have = [c for c in vaa_cols if c in set(info['fields'])]
    print(f'-- reading VAA columns: {have}')
    vaa = pyogrio.read_dataframe(src, layer=vaa_layer, read_geometry=False, columns=have)

    j = linked.merge(vaa, on='NHDPlusID', how='inner')
    j = j.merge(hits[['Permanent_Identifier', 'GNIS_Name', 'AreaSqKm']],
                left_on='WBArea_Permanent_Identifier', right_on='Permanent_Identifier',
                how='left', suffixes=('_fl', '_wb'))
    print(f'-- joined rows: {len(j)}')
    if j.empty:
        print('   NHDPlusID does not join VAA to flowline in this GDB.')
        return 1

    # THE ONE THING THAT MATTERS: the outlet of each lake, and the order they come out in.
    g = (j.groupby('GNIS_Name_wb')
           .agg(outlet_hydroseq=('HydroSeq', 'min'),
                head_hydroseq=('HydroSeq', 'max'),
                levelpaths=('LevelPathI', lambda s: sorted(set(s))[:3]),
                drainage_km2=('TotDASqKm', 'max'),
                flowlines=('NHDPlusID', 'count'),
                area_km2=('AreaSqKm', 'max'))
           .reset_index())
    g = g.sort_values('outlet_hydroseq', ascending=False)

    print('\n== ordered by outlet HydroSeq, DESCENDING')
    print('   If the convention holds, this reads upstream to downstream:')
    print('   ' + ' -> '.join(YADKIN))
    print()
    pd.set_option('display.width', 200)
    pd.set_option('display.max_colwidth', 40)
    print(g.to_string(index=False))

    order = [str(n) for n in g['GNIS_Name_wb'].tolist()]
    print('\n   derived order: ' + ' -> '.join(order))
    print('\n   Paste this whole block back. The derived order against the known one is the '
          'only thing that decides how the real script sorts.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
