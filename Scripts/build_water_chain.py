#!/usr/bin/env python3
"""
build_water_chain.py -- work out which of Ryan's waters sit above which, from NHDPlus HR,
and write registry/water_chain.json.

WHY THIS EXISTS
    Duke publishes dam releases without saying whether a release adds water to a lake or
    takes it away. Ryan's correction, verbatim: "for wateree if fishing north end then cedar
    creek dam release would flow down into the lake ... but it would not have an arrival
    because it is not a river." Cedar Creek is INFLOW to Wateree; Wateree's own dam is
    OUTFLOW. Nothing in the Duke API says so. The river network does.

THE ONE FACT THIS RESTS ON, measured not assumed
    On HU4 0305, 298,907 of 298,907 flowlines with a downstream neighbour have a LOWER
    DnHydroSeq than HydroSeq, and the independent drainage-area check agreed at 100.0%.
    HydroSeq DECREASES downstream, so a lake's outlet is its MINIMUM HydroSeq. This script
    re-measures that per VPU rather than trusting the 0305 result, and REFUSES a VPU whose
    answer is not clean.

HOW WATERS ARE MATCHED
    On GNIS id, not on name. Two different polygons in 0305 are both named "Lake Marion"
    (FType 390 at 324 km2 and FType 466 at 45 km2) and a name match silently welds them into
    one lake. NHD also says "Wateree Lake" where other sources say "Lake Wateree".
    Registry ids need normalising first: it holds both 'gnis:988007' and 'gnis:988007.0',
    and 'gnis:981723.0', where an id went through a float somewhere upstream.

WHAT IT WRITES
    registry/water_chain.json -- per water: outlet hydrosequence, level path, drainage area,
    the next registry water downstream, and the registry waters immediately upstream.
    Waters it could not place are listed under "unmatched" with the reason, never guessed at.

    Read-only against the GDBs. The only file written is water_chain.json (and only with
    --write; default is a dry run that prints what it would write).

USAGE
    py scripts\\build_water_chain.py                          # dry run, every NHDPLUS_H_* found
    py scripts\\build_water_chain.py --only 0305              # one VPU, fast
    py scripts\\build_water_chain.py --write                  # actually write the json
"""
import argparse
import json
import sys
from pathlib import Path

DEFAULT_NHD = Path(r'F:\TrollMapPipeline\NHD')
REGISTRY_REL = 'registry/lake_index.json'
OUT_REL = 'registry/water_chain.json'


def find_repo_root(explicit=None):
    """Locate the folder that holds registry/. Tries, in order: an explicit path, the current
    working directory, then each parent of THIS FILE. A bare relative default resolves against
    cwd, so running from scripts/ instead of the repo root looked for the registry one folder
    too high -- the same mistake this script's own test made."""
    if explicit:
        p = Path(explicit)
        return p.parent.parent if p.name.endswith('.json') else p
    here = Path.cwd().resolve()
    mine = Path(__file__).resolve().parent
    seen = set()
    for cand in ([here] + list(here.parents) + [mine] + list(mine.parents)):
        if cand in seen:
            continue
        seen.add(cand)
        if (cand / REGISTRY_REL).exists():
            return cand
    return here


# --------------------------------------------------------------------------------------
# pure logic -- no GDAL, unit tested separately
# --------------------------------------------------------------------------------------
def normalize_gnis(v):
    """Registry stores 'gnis:991183', and twice 'gnis:988007.0' where an id went through a
    float. NHD stores GNIS_ID as digits, sometimes zero padded. Return bare digits or None."""
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    low = s.lower()
    if low.startswith('gnis:'):
        s = s[5:].strip()
    elif low.startswith(('slug:', 'nhd:')):
        return None
    if not s:
        return None
    if s.endswith('.0') and s[:-2].isdigit():
        s = s[:-2]
    if not s.isdigit():
        return None
    s = s.lstrip('0') or '0'
    return s if s != '0' else None


def direction_is_decreasing(pairs):
    """pairs of (hydroseq, dnhydroseq), dn > 0. True/False/None -- never a guess."""
    lower = higher = 0
    for hs, dn in pairs:
        if dn > hs:
            higher += 1
        elif dn < hs:
            lower += 1
    if lower and lower > higher * 100:
        return True
    if higher and higher > lower * 100:
        return False
    return None


def outlet_of(hydroseqs, decreasing=True):
    if not hydroseqs:
        return None
    return min(hydroseqs) if decreasing else max(hydroseqs)


def walk_downstream(start_hs, dn_of, water_of, exclude, max_steps=200000):
    """Follow DnHydroSeq from a flowline until landing on one belonging to a water other
    than `exclude`. Returns (water_id_or_None, steps). Never assumes a direction; it only
    follows the pointer, so it stays correct even if a VPU disagrees."""
    hs = start_hs
    seen = set()
    for step in range(1, max_steps + 1):
        nxt = dn_of.get(hs)
        if not nxt:
            return None, step
        if nxt in seen:
            return None, step
        seen.add(nxt)
        w = water_of.get(nxt)
        if w is not None and w != exclude:
            return w, step
        hs = nxt
    return None, max_steps


# --------------------------------------------------------------------------------------
def find_gdbs(nhd_dir, only=None):
    """Extracted .gdb directories beat .zip -- GDAL seeks inside a File Geodatabase, and
    seeking inside a zip means decompressing forward every time it jumps back. Only the
    NHDPLUS_H_* products carry NHDPlusFlowlineVAA; the plain NHD_H_* ones do not."""
    import re
    # NHDPLUS_H_0305_HU4_GDB.gdb and NHDPLUS_H_0601_HU4_20220418_GDB.zip both have the VPU
    # in the same place but not the same field number, so match it rather than count fields.
    pat = re.compile(r'NHDPLUS_H_(\d{4})_HU4', re.I)
    out = {}
    for p in sorted(nhd_dir.glob('**/NHDPLUS_H_*_HU4*_GDB.gdb')):
        m = pat.search(p.name)
        if p.is_dir() and m:
            out.setdefault(m.group(1), p)
    for p in sorted(nhd_dir.glob('NHDPLUS_H_*_HU4*_GDB.zip')):
        m = pat.search(p.name)
        if m:
            out.setdefault(m.group(1), p)
    if only:
        want = set(only)
        out = {k: v for k, v in out.items() if k in want}
    return dict(sorted(out.items()))


def process_vpu(vpu, src, want_gnis, args):
    """Return (rows_by_slug, note). Reads three layers, writes nothing."""
    import pyogrio
    import pandas as pd

    vaa = pyogrio.read_dataframe(
        src, layer='NHDPlusFlowlineVAA', read_geometry=False,
        columns=['NHDPlusID', 'HydroSeq', 'DnHydroSeq', 'LevelPathI', 'TotDASqKm',
                 'StreamOrde'])

    # --- re-measure the direction here rather than trusting 0305 -----------------------
    d = vaa[(vaa['DnHydroSeq'] > 0) & (vaa['HydroSeq'] > 0)]
    decreasing = direction_is_decreasing(
        zip(d['HydroSeq'].to_numpy(), d['DnHydroSeq'].to_numpy()))
    if decreasing is None:
        return {}, f'{vpu}: REFUSED, HydroSeq direction is not clean in this VPU'
    if not decreasing:
        return {}, f'{vpu}: REFUSED, HydroSeq increases downstream here but decreases in 0305'

    wb = pyogrio.read_dataframe(
        src, layer='NHDWaterbody', read_geometry=False,
        columns=['Permanent_Identifier', 'GNIS_ID', 'GNIS_Name', 'AreaSqKm', 'FType'])
    wb['gnis_n'] = wb['GNIS_ID'].map(normalize_gnis)
    hit = wb[wb['gnis_n'].isin(want_gnis)]
    if hit.empty:
        return {}, f'{vpu}: no registry water matched, skipped'

    # One GNIS id can carry several polygons (arms split into separate waterbodies).
    # Keep them all and let the flowline join union them -- that is one lake, not several.
    pid_to_slug = {}
    for _, r in hit.iterrows():
        for slug in want_gnis[r['gnis_n']]:
            pid_to_slug.setdefault(r['Permanent_Identifier'], slug)

    fl = pyogrio.read_dataframe(
        src, layer='NHDFlowline', read_geometry=False,
        columns=['NHDPlusID', 'WBArea_Permanent_Identifier'])
    fl = fl[fl['WBArea_Permanent_Identifier'].isin(pid_to_slug)]
    if fl.empty:
        return {}, f'{vpu}: matched waterbodies but no flowlines inside them'
    fl = fl.assign(slug=fl['WBArea_Permanent_Identifier'].map(pid_to_slug))
    j = fl.merge(vaa, on='NHDPlusID', how='inner')
    if j.empty:
        return {}, f'{vpu}: flowlines found but none joined to VAA'

    dn_of = dict(zip(vaa['HydroSeq'].astype('int64').tolist(),
                     vaa['DnHydroSeq'].astype('int64').tolist()))
    water_of = dict(zip(j['HydroSeq'].astype('int64').tolist(), j['slug'].tolist()))

    meta = hit.groupby('gnis_n').agg(nhd_name=('GNIS_Name', 'first'),
                                     nhd_area_km2=('AreaSqKm', 'sum'),
                                     ftype=('FType', 'max')).to_dict('index')

    rows = {}
    for slug, grp in j.groupby('slug'):
        hss = grp['HydroSeq'].astype('int64').tolist()
        out_hs = outlet_of(hss, True)
        nxt, steps = walk_downstream(out_hs, dn_of, water_of, exclude=slug)
        g = grp.loc[grp['HydroSeq'].astype('int64') == out_hs].iloc[0]
        gn = next((k for k, v in want_gnis.items() if slug in v), None)
        m = meta.get(gn, {})
        rows[slug] = {
            'slug': slug,
            'gnis': gn,
            'vpu': vpu,
            'nhd_name': m.get('nhd_name'),
            'nhd_area_km2': round(float(m.get('nhd_area_km2') or 0), 4),
            'nhd_ftype': int(m.get('ftype') or 0),
            'outlet_hydroseq': int(out_hs),
            'levelpath': int(g['LevelPathI']),
            'drainage_km2': round(float(grp['TotDASqKm'].max()), 4),
            'stream_order': int(grp['StreamOrde'].max()),
            'flowlines': int(len(grp)),
            'downstream': nxt,
            'downstream_steps': int(steps),
        }
    return rows, f'{vpu}: {len(rows)} waters placed'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--nhd', default=str(DEFAULT_NHD))
    ap.add_argument('--registry', default=None, help='defaults to <repo>/' + REGISTRY_REL)
    ap.add_argument('--out', default=None, help='defaults to <repo>/' + OUT_REL)
    ap.add_argument('--only', nargs='*', help='VPU codes, e.g. --only 0305 0304')
    ap.add_argument('--write', action='store_true', help='actually write the json')
    args = ap.parse_args()

    try:
        import pyogrio  # noqa: F401
    except ImportError:
        print('pyogrio is not installed. geopandas pulls it in.')
        return 2

    root = find_repo_root(args.registry)
    reg_path = Path(args.registry) if args.registry else root / REGISTRY_REL
    args.out = args.out or str(root / OUT_REL)
    if not reg_path.exists():
        print(f'registry not found: {reg_path}')
        print(f'  (looked from cwd {Path.cwd()} and from {Path(__file__).resolve().parent})')
        print('  pass --registry <path to lake_index.json> if it lives somewhere else')
        return 2
    print(f'registry: {reg_path}')
    reg = json.loads(reg_path.read_text(encoding='utf-8'))
    print(f'registry waters: {len(reg)}')

    want_gnis = {}
    no_id = []
    for slug, row in reg.items():
        g = normalize_gnis(row.get('gnis'))
        if g is None:
            no_id.append(slug)
        else:
            want_gnis.setdefault(g, []).append(slug)
    dupes = {g: s for g, s in want_gnis.items() if len(s) > 1}
    print(f'  with a usable GNIS id: {sum(len(v) for v in want_gnis.values())}'
          f' across {len(want_gnis)} distinct ids')
    print(f'  without one (slug:/nhd:/empty): {len(no_id)}')
    if dupes:
        print(f'  SAME GNIS ID USED BY MORE THAN ONE SLUG -- these are the same water twice:')
        for g, s in sorted(dupes.items()):
            print(f'    {g}: {", ".join(s)}')

    nhd_dir = Path(args.nhd)
    if not nhd_dir.exists():
        print(f'nhd dir not found: {nhd_dir}')
        return 2
    gdbs = find_gdbs(nhd_dir, args.only)
    if not gdbs:
        print(f'no NHDPLUS_H_* geodatabases under {nhd_dir}')
        return 2
    listed = []
    for k, v in gdbs.items():
        listed.append(k + (' (zip, slower)' if str(v).endswith('.zip') else ''))
    print('\ngeodatabases: ' + ', '.join(listed))

    rows, notes = {}, []
    for vpu, src in gdbs.items():
        print(f'\n-- {vpu}  {Path(src).name}')
        try:
            got, note = process_vpu(vpu, str(src), want_gnis, args)
        except Exception as e:                      # a bad VPU must not lose the good ones
            got, note = {}, f'{vpu}: FAILED, {type(e).__name__}: {e}'
        notes.append(note)
        print('   ' + note)
        for slug, r in got.items():
            if slug in rows:                        # a water straddling two VPUs
                keep = max(rows[slug], r, key=lambda x: x['flowlines'])
                note2 = (f'{slug} appears in {rows[slug]["vpu"]} and {r["vpu"]},'
                         f' kept {keep["vpu"]} (more flowlines)')
                notes.append(note2)
                print('   ' + note2)
                rows[slug] = keep
            else:
                rows[slug] = r

    # upstream is the inverse of downstream -- derived, never walked twice
    for r in rows.values():
        r['upstream'] = []
    for slug, r in rows.items():
        d = r['downstream']
        if d and d in rows:
            rows[d]['upstream'].append(slug)
    for r in rows.values():
        r['upstream'].sort()

    unmatched = {}
    for slug in reg:
        if slug in rows:
            continue
        g = normalize_gnis(reg[slug].get('gnis'))
        unmatched[slug] = ('no gnis id in registry' if g is None
                           else f'gnis {g} not found in any geodatabase read')

    print(f'\n== placed {len(rows)} of {len(reg)} waters; {len(unmatched)} unplaced')
    terminal = [s for s, r in rows.items() if not r['downstream']]
    print(f'   with a downstream neighbour: {len(rows) - len(terminal)}')
    print(f'   terminal within their VPU:   {len(terminal)}')

    out = {'_meta': {'source': 'NHDPlus HR', 'direction': 'HydroSeq decreases downstream',
                     'vpus': list(gdbs), 'notes': notes},
           'waters': rows, 'unmatched': unmatched}

    if args.write:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(out, indent=1), encoding='utf-8')
        print(f'\nwrote {args.out}')
    else:
        print('\nDRY RUN -- nothing written. Add --write to write '
              f'{args.out}.')
        sample = [s for s in ('lake_james', 'rhodhiss_lake', 'lake_hickory',
                              'lookout_shoals_lake', 'lake_norman', 'mountain_island_lake',
                              'lake_wylie', 'fishing_creek_reservoir', 'great_falls_reservoir',
                              'cedar_creek_reservoir_2', 'wateree_lake') if s in rows]
        if sample:
            print('\n== the Catawba chain as derived (each line: water -> next water down)')
            for s in sorted(sample, key=lambda x: -rows[x]['outlet_hydroseq']):
                r = rows[s]
                print(f'   {s:<26} {r["outlet_hydroseq"]}  da {r["drainage_km2"]:>10.1f}'
                      f'  -> {r["downstream"] or "(leaves the VPU)"}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
