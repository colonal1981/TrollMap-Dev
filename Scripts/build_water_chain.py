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

    AND ON THE GEOMETRIC BINDING, added 2026-08-17. The GNIS join alone placed 283 of 450
    waters and left 167 unmatched, 149 of them for the single reason "no gnis id in registry"
    -- their registry id is a synthetic 'slug:<slug>' placeholder, so there is nothing to join
    on. blewett_falls_lake is one of them: Duke publishes it in the current-level feed, it has
    a Duke dam, and releaseDirection() returned null for every release on it because the chain
    had no node. Meanwhile match_waters_to_nhd.py had ALREADY solved that water by measured
    polygon overlap and written registry/_nhd_bindings.json, which holds a
    Permanent_Identifier for 423 of the 450 -- including 140 of the 167 this script gave up
    on. Two matchers, and the stronger one's answer was sitting on disk unread. A capability
    that exists and is never reached is the same as no capability.

    Order is deliberate and one-directional: the GNIS join runs FIRST and claims its slugs,
    then binding pids fill in only slugs GNIS did not place. No water that placed before this
    change can move because of it -- the 283 were validated against USACE surveyed drainage
    (median disagreement 0.2%) and that validation must still mean something afterwards.

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
    py scripts\\build_water_chain.py --no-bindings            # GNIS join only, to diff against

    The binding table is picked up automatically from registry/_nhd_bindings.json. It is not
    required -- without it the run says so out loud and places the GNIS waters alone.
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


def norm_pid(v):
    """Normalise an NHD Permanent_Identifier so it can be used as a JOIN KEY.

    NHD writes this field two ways in the same vintage: as bare digits ('110970920') and as a
    braced GUID. The GUIDs come back in BOTH casings -- _nhd_bindings.json holds
    '{45FC7FCA-11AA-40B6-AA56-96D3F51400F0}' and '{d7218688-637b-48bc-87e8-6485082d8569}',
    read from the same geodatabases by the same code. A dict keyed on the raw string is one
    casing away from finding nothing and reporting that as "this lake has no flowlines",
    which is the Number('') family wearing a different hat: a key has to be normalised on BOTH
    sides of a join or it is not a key.

    Case-folding could in principle weld two distinct pids together. process_vpu counts that
    rather than assuming it cannot happen, and prints the count if it is ever non-zero.
    """
    s = '' if v is None else str(v).strip()
    if len(s) > 1 and s[0] == '{' and s[-1] == '}':
        s = s[1:-1]
    return s.lower() or None


def prefer_row(a, b):
    """One water, placed in two VPUs. Which row survives.

    A GNIS match BEATS a geometric one, always, even when the geometric side found more
    flowlines. process_vpu's "did the GNIS join already claim this slug" guard is per-VPU, so a
    water placed on its id in one basin can still be offered as a binding in the next. The 283
    waters placed before the binding table existed were validated against USACE surveyed
    drainage at a median disagreement of 0.2%; they have to win that tie every time or the
    validation stops describing what actually ships.

    Between two rows found the same way, more flowlines means more of the water is in that VPU.

    Returns (winner, reason) so the caller can say why rather than assert it.
    """
    va, vb = a.get('match_via'), b.get('match_via')
    if va != vb and 'gnis' in (va, vb):
        return (a, 'GNIS beats geometry') if va == 'gnis' else (b, 'GNIS beats geometry')
    return (a if a['flowlines'] >= b['flowlines'] else b), 'more flowlines'


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


def finite_int_map(keys, vals):
    """Build {int: int} from two float columns, skipping rows where either is not finite.
    Returns (mapping, dropped).

    NHDPlus HR stores HydroSeq, DnHydroSeq and LevelPathI as float64 and puts NaN on every
    flowline that is not in the routed network (InNetwork = 0). Casting the whole column with
    .astype('int64') raises IntCastingNaNError. The direction check upstream of this never saw
    the problem because NaN > 0 is False, so those rows were already excluded there -- which is
    exactly how this reached the graph build instead of failing somewhere obvious. A NaN here is
    not a number to coerce, it is a flowline that is not routed. Skip it and say how many."""
    import numpy as np
    k = np.asarray(keys, dtype='float64')
    v = np.asarray(vals, dtype='float64')
    ok = np.isfinite(k) & np.isfinite(v)
    dropped = int((~ok).sum())
    return dict(zip(k[ok].astype('int64').tolist(),
                    v[ok].astype('int64').tolist())), dropped


def finite_ints(values):
    """[int] from a float column, skipping non-finite. Returns (ints, dropped)."""
    import numpy as np
    a = np.asarray(values, dtype='float64')
    ok = np.isfinite(a)
    return a[ok].astype('int64').tolist(), int((~ok).sum())


def safe_int(v, default=0):
    """int() of something that may be NaN, None, inf or a numpy float."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f or f in (float('inf'), float('-inf')):
        return default
    return int(f)


def safe_float(v, default=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return default if (f != f or f in (float('inf'), float('-inf'))) else f


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


def read_layer(src, layer, wanted):
    """Read a layer by asking it what columns it HAS, instead of demanding exact spellings.

    0602 failed with KeyError: 'DnHydroSeq'. pyogrio silently drops any requested column a layer
    does not have, so the read succeeded and the failure surfaced later, blind, at the first use.
    The 0601/0602 products are an older vintage (20220418) than the 03xx ones and do not have to
    spell their fields the same way.

    Resolves case-insensitively, renames to the canonical spelling the rest of this file uses,
    and on a genuine miss returns what the layer actually holds so the next run is informed
    rather than another guess. Returns (dataframe, missing, available)."""
    import pyogrio
    info = pyogrio.read_info(src, layer=layer)
    # pyogrio returns 'fields' as a NUMPY ARRAY. `arr or []` asks for the truth value of a
    # multi-element array, which raises ValueError -- so never fall back with `or` here.
    fields = info.get('fields')
    available = [] if fields is None else [str(f) for f in fields]
    by_lower = {f.lower(): f for f in available}
    actual, missing = {}, []
    for w in wanted:
        f = by_lower.get(w.lower())
        if f is None:
            missing.append(w)
        else:
            actual[w] = f
    if missing:
        return None, missing, available
    df = pyogrio.read_dataframe(src, layer=layer, read_geometry=False,
                                columns=list(actual.values()))
    rename = {v: k for k, v in actual.items() if v != k}
    if rename:
        df = df.rename(columns=rename)
    return df, [], available


def process_vpu(vpu, src, want_gnis, args, want_pid=None):
    """Return (rows_by_slug, note). Reads three layers, writes nothing.

    want_pid, when given, is {normalised Permanent_Identifier: (slug, binding record)} for
    THIS VPU only, carrying waters the GNIS join cannot reach. Optional and keyword-defaulted
    so the GNIS-only behaviour, and every existing caller, is untouched.
    """
    import pyogrio
    import pandas as pd

    vaa, missing, have = read_layer(
        src, 'NHDPlusFlowlineVAA',
        ['NHDPlusID', 'HydroSeq', 'DnHydroSeq', 'LevelPathI', 'TotDASqKm', 'StreamOrde',
         'Divergence', 'DivDASqKm'])
    if missing:
        print(f'   NHDPlusFlowlineVAA in this vintage has no {", ".join(missing)}.')
        print(f'   It does have: {", ".join(have)}')
        return {}, f'{vpu}: REFUSED, VAA layer is missing {", ".join(missing)}'

    # --- re-measure the direction here rather than trusting 0305 -----------------------
    d = vaa[(vaa['DnHydroSeq'] > 0) & (vaa['HydroSeq'] > 0)]
    decreasing = direction_is_decreasing(
        zip(d['HydroSeq'].to_numpy(), d['DnHydroSeq'].to_numpy()))
    if decreasing is None:
        return {}, f'{vpu}: REFUSED, HydroSeq direction is not clean in this VPU'
    if not decreasing:
        return {}, f'{vpu}: REFUSED, HydroSeq increases downstream here but decreases in 0305'

    wb, missing, have = read_layer(
        src, 'NHDWaterbody',
        ['Permanent_Identifier', 'GNIS_ID', 'GNIS_Name', 'AreaSqKm', 'FType'])
    if missing:
        print(f'   NHDWaterbody has no {", ".join(missing)}. It does have: {", ".join(have)}')
        return {}, f'{vpu}: REFUSED, NHDWaterbody is missing {", ".join(missing)}'
    wb['gnis_n'] = wb['GNIS_ID'].map(normalize_gnis)
    hit = wb[wb['gnis_n'].isin(want_gnis)]

    # One GNIS id can carry several polygons (arms split into separate waterbodies).
    # Keep them all and let the flowline join union them -- that is one lake, not several.
    #
    # THE GNIS JOIN GOES FIRST AND KEEPS WHAT IT CLAIMS. Everything below only fills gaps.
    pid_to_slug, slug_via = {}, {}
    welded = 0
    for _, r in hit.iterrows():
        p = norm_pid(r['Permanent_Identifier'])
        if p is None:
            continue
        for slug in want_gnis[r['gnis_n']]:
            if p in pid_to_slug and pid_to_slug[p] != slug:
                welded += 1
            pid_to_slug.setdefault(p, slug)
            slug_via.setdefault(slug, 'gnis')
    if welded:
        print(f'   {welded} polygon(s) claimed by more than one slug after normalising the'
              f' identifier; the first claim was kept')

    # Waters with no usable GNIS id, placed by the polygon overlap match_waters_to_nhd.py
    # already measured. `slug in slug_via` is the guard that makes this strictly additive: a
    # water the GNIS join placed keeps exactly the polygons the GNIS join gave it, so its
    # outlet, drainage and downstream neighbour cannot shift underneath it.
    bind_meta, added = {}, 0
    for p, (slug, rec) in (want_pid or {}).items():
        if slug in slug_via or p in pid_to_slug:
            continue
        pid_to_slug[p] = slug
        slug_via[slug] = 'geometry'
        bind_meta[slug] = rec
        added += 1
    if added:
        print(f'   + {added} water(s) offered by the geometric binding table that have no'
              f' GNIS id to join on')

    if not pid_to_slug:
        return {}, f'{vpu}: no registry water matched, skipped'

    fl, missing, have = read_layer(
        src, 'NHDFlowline', ['NHDPlusID', 'WBArea_Permanent_Identifier'])
    if missing:
        print(f'   NHDFlowline has no {", ".join(missing)}. It does have: {", ".join(have)}')
        return {}, f'{vpu}: REFUSED, NHDFlowline is missing {", ".join(missing)}'
    fl = fl.assign(pid_n=fl['WBArea_Permanent_Identifier'].map(norm_pid))
    fl = fl[fl['pid_n'].isin(pid_to_slug)]
    if fl.empty:
        return {}, f'{vpu}: matched waterbodies but no flowlines inside them'
    fl = fl.assign(slug=fl['pid_n'].map(pid_to_slug))
    j = fl.merge(vaa, on='NHDPlusID', how='inner')
    if j.empty:
        return {}, f'{vpu}: flowlines found but none joined to VAA'

    dn_of, dropped = finite_int_map(vaa['HydroSeq'].to_numpy(),
                                    vaa['DnHydroSeq'].to_numpy())
    if dropped:
        print(f'   {dropped} of {len(vaa)} flowlines are not routed (NaN hydrosequence)'
              f' and take no part in the graph')

    j = j[j['HydroSeq'].notna()]
    if j.empty:
        return {}, f'{vpu}: matched waterbodies but none of their flowlines are routed'
    jhs, _ = finite_ints(j['HydroSeq'].to_numpy())
    water_of = dict(zip(jhs, j['slug'].tolist()))

    # KEYED BY SLUG, NOT BY GNIS ID. The old version keyed this on gnis_n and then, per row,
    # reverse-looked-up the id with next((k for k, v in want_gnis.items() if slug in v), None).
    # That returns None for any water placed WITHOUT a GNIS id -- which is every water the
    # binding table rescues -- so the row would have reported nhd_name null and
    # nhd_area_km2 0.0 while the polygon it was joined on knew all three. Grouping on the slug
    # that pid_to_slug actually assigned also sums the right polygons by construction instead
    # of by coincidence.
    meta = {}
    if not hit.empty:
        h = hit.assign(pid_n=hit['Permanent_Identifier'].map(norm_pid))
        h = h[h['pid_n'].isin(pid_to_slug)]
        if not h.empty:
            meta = h.assign(slug=h['pid_n'].map(pid_to_slug)).groupby('slug').agg(
                nhd_name=('GNIS_Name', 'first'),
                nhd_area_km2=('AreaSqKm', 'sum'),
                ftype=('FType', 'max')).to_dict('index')

    # 47 of the waters the binding table rescues are rivers bound to NHDArea, which this
    # script does not read -- it wants their flowlines, not their polygon, and NHDFlowline's
    # WBArea_Permanent_Identifier references either layer. Their name, area and FType travel
    # ON THE BINDING RECORD that made the match, so they are read from there rather than
    # looked up in a layer that does not hold them. Read the field that travels with the
    # value, never the field that describes it from somewhere else.
    for slug, rec in bind_meta.items():
        if slug in meta:
            continue
        meta[slug] = {'nhd_name': rec.get('nhd_gnis_name'),
                      'nhd_area_km2': safe_float(rec.get('nhd_acres')) / 247.105,
                      'ftype': safe_int(rec.get('nhd_ftype'))}

    slug_to_gnis = {s: g for g, ss in want_gnis.items() for s in ss}

    rows = {}
    for slug, grp in j.groupby('slug'):
        hss, _ = finite_ints(grp['HydroSeq'].to_numpy())
        out_hs = outlet_of(hss, True)
        if out_hs is None:
            continue
        nxt, steps = walk_downstream(out_hs, dn_of, water_of, exclude=slug)
        g = grp.loc[grp['HydroSeq'] == out_hs].iloc[0]
        gn = slug_to_gnis.get(slug)
        m = meta.get(slug, {})
        rows[slug] = {
            'slug': slug,
            'gnis': gn,
            # HOW this water was found, travelling with the row rather than inferred later
            # from whether `gnis` happens to be null. 'gnis' = joined on the registry's GNIS
            # id; 'geometry' = joined on the Permanent_Identifier that match_waters_to_nhd.py
            # measured by polygon overlap.
            'match_via': slug_via.get(slug, 'gnis'),
            'vpu': vpu,
            'nhd_name': m.get('nhd_name'),
            'nhd_area_km2': round(safe_float(m.get('nhd_area_km2')), 4),
            'nhd_ftype': safe_int(m.get('ftype')),
            'outlet_hydroseq': int(out_hs),
            'levelpath': safe_int(g['LevelPathI']),
            # Drainage is what accumulates AT THE OUTLET, not the largest number found anywhere
            # inside the polygon. Taking the max let a mainstem flowline that merely clips the
            # polygon donate its whole basin: russ_lake came back as stream order 3 -- a small
            # tributary -- carrying 7,858 km2, two numbers from one waterbody that cannot both
            # be true. max_drainage_km2 is kept alongside precisely so that gap stays visible.
            'drainage_km2': round(safe_float(g['TotDASqKm']), 4),
            'max_drainage_km2': round(safe_float(grp['TotDASqKm'].max()), 4),
            'stream_order': safe_int(g['StreamOrde']),
            'max_stream_order': safe_int(grp['StreamOrde'].max()),
            # TotDASqKm is everything that passed UPSTREAM of this flowline. On a divergent
            # side channel that is not what flows THROUGH it -- DivDASqKm is. russ_lake came
            # back as stream order 1 carrying 7,858 km2 and lowthers_lake as order 2 carrying
            # 21,302; an order-1 flowline is a headwater, so those two numbers describe
            # different things and only one of them answers "how much water arrives here".
            'divergence': safe_int(g['Divergence']),
            'div_drainage_km2': round(safe_float(g['DivDASqKm']), 4),
            'flowlines': int(len(grp)),
            'downstream': nxt,
            'downstream_steps': int(steps),
        }
        # Derived per row, here where the values live, rather than in main() -- calling
        # process_vpu directly must return the same row the full run does.
        _r = rows[slug]
        _own = _r['drainage_km2']
        _r['foreign_flowline_suspected'] = bool(
            _own > 1 and _r['max_drainage_km2'] > _own * 2)
        # An OXBOW is a cut-off river bend still tied to its river. Ryan confirmed both of the
        # big ones from having fished them: lowthers_lake is off the Big Pee Dee and
        # wittee_lake off the Santee. NHD routes a flowline through such a water carrying the
        # river's ENTIRE upstream basin in TotDASqKm, while DivDASqKm holds what is actually
        # routed down that path -- 21,302 km2 against 25.2 for Lowthers, 38,671 against 139.4
        # for Wittee. Divergence is 0 on all of them, so the flag is no use; the ratio is.
        #
        # An earlier version guessed at stream order <= 4 with a big basin, which happened to
        # catch these three and would have missed a large oxbow or flagged a genuine low-order
        # reservoir. This asks the data instead.
        #
        # Both numbers are real and answer different questions, which is why both are kept:
        # DivDASqKm is the water's own local inflow, TotDASqKm is the river it hangs off. For
        # Lowthers, Ryan watches the Great Pee Dee gauge UPSTREAM to know the lake level during
        # high water -- the river's stage sets the level, not the 25 km2 of local catchment. So
        # a side_channel water wants a river gauge, where a storage reservoir wants a pool
        # elevation. Getting that backwards shows the wrong reading entirely.
        _div = _r['div_drainage_km2']
        _r['side_channel'] = bool(_div > 0 and _own > _div * 10)
        _r['on_divergent_path'] = bool(_r['divergence'])
        _r['local_drainage_km2'] = _div if _r['side_channel'] else _own
    return rows, f'{vpu}: {len(rows)} waters placed'


def apply_chain_links(rows, links):
    """Add flow edges NHD cannot derive, and carry drainage across them.

    NHDPlus accumulates drainage TOPOGRAPHICALLY -- the land that drains to a point. That is
    correct, and it is why every other water in this chain is right. It is also why Lake
    Moultrie comes back as a headwater pond with 111 sq mi: the 14,600 sq mi that actually
    arrives there was dug a channel in the 1940s, and no terrain analysis will ever produce an
    edge for a canal.

    BOTH NUMBERS STAY. `drainage_km2` remains untouched and topographic; the routed figure is
    written to `routed_drainage_km2` beside it. That is the TotDASqKm/DivDASqKm lesson again --
    two real numbers answering different questions, and the bug is always using one to answer
    the other's.

    A WATER MAY HAVE MORE THAN ONE OUTLET. Moultrie has two: St Stephen to the Santee, which
    NHD routes, and Pinopolis to the Cooper, which it does not. `downstream` keeps the derived
    primary so nothing reading it changes; `outlets` lists all of them.

    Returns (applied, notes). Refuses any link whose ends are not both in the chain rather than
    inventing a node.
    """
    for r in rows.values():
        r.setdefault('outlets', [r['downstream']] if r.get('downstream') else [])
        r.setdefault('routed_drainage_km2', r.get('drainage_km2'))
    applied, notes = [], []
    for ln in links or []:
        a, b = (ln or {}).get('from'), (ln or {}).get('to')
        if not a or not b:
            notes.append('link with no from/to, skipped')
            continue
        if a not in rows or b not in rows:
            notes.append('%s -> %s REFUSED: %s is not in the chain'
                         % (a, b, a if a not in rows else b))
            continue
        if b in rows[a]['outlets']:
            notes.append('%s -> %s already derived, no link needed' % (a, b))
            continue
        rows[a]['outlets'].append(b)
        if a not in rows[b]['upstream']:
            rows[b]['upstream'].append(b if False else a)
            rows[b]['upstream'].sort()
        applied.append((a, b, ln.get('via')))
    # Drainage is carried AFTER every edge exists, and in outlet order, so a chain of transfers
    # (Marion -> Moultrie -> Cooper) accumulates rather than each hop seeing a stale figure.
    for _ in range(len(applied) + 1):
        for ln in links or []:
            a, b = (ln or {}).get('from'), (ln or {}).get('to')
            if not (a in rows and b in rows and ln.get('carries_drainage')):
                continue
            if b not in rows[a]['outlets']:
                continue
            want = round(rows[b]['drainage_km2'] + rows[a]['routed_drainage_km2'], 4)
            if want > rows[b]['routed_drainage_km2']:
                rows[b]['routed_drainage_km2'] = want
    return applied, notes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--nhd', default=str(DEFAULT_NHD))
    ap.add_argument('--registry', default=None, help='defaults to <repo>/' + REGISTRY_REL)
    ap.add_argument('--out', default=None, help='defaults to <repo>/' + OUT_REL)
    ap.add_argument('--bindings', default=None,
                    help='registry/_nhd_bindings.json from match_waters_to_nhd.py; defaults to'
                         ' the file beside the registry. Absent is not an error -- the run'
                         ' falls back to the GNIS join alone and says so.')
    ap.add_argument('--no-bindings', action='store_true',
                    help='ignore the binding table entirely (the pre-2026-08-17 behaviour)')
    ap.add_argument('--links', default=None,
                    help='registry/_chain_links.json -- flow NHD cannot derive (canals, '
                         'inter-basin transfers). Defaults to the file beside the registry.')
    ap.add_argument('--no-links', action='store_true',
                    help='derived edges only; ignore the asserted ones')
    ap.add_argument('--only', nargs='*', help='VPU codes, e.g. --only 0305 0304')
    ap.add_argument('--write', action='store_true', help='actually write the json')
    ap.add_argument('--show', type=int, default=40,
                    help='how many placed waters to print; 0 for all')
    ap.add_argument('--layers', action='store_true',
                    help='list each geodatabase\'s layers and fields, then stop')
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

    # --- the geometric binding table, for the waters GNIS cannot reach --------------------
    have_gnis = {s for ss in want_gnis.values() for s in ss}
    want_pid, bound_slugs = {}, {}
    bpath = Path(args.bindings) if args.bindings else reg_path.parent / '_nhd_bindings.json'
    if args.no_bindings:
        print('  --no-bindings: GNIS join only')
    elif not bpath.exists():
        # NOT fatal. Falling back is correct; falling back SILENTLY is how you end up with a
        # 283-water chain that reads as complete.
        print(f'  NO BINDING TABLE at {bpath} -- GNIS join only, so waters whose registry id'
              f' is a slug: placeholder cannot be placed at all.')
        print('  Build it with:  py .\\scripts\\match_waters_to_nhd.py --write')
    else:
        try:
            bnd = json.loads(bpath.read_text(encoding='utf-8')).get('bindings') or {}
        except Exception as exc:
            print(f'  binding table unreadable ({type(exc).__name__}: {exc}) -- GNIS join only')
            bnd = {}
        # NOT filtered by `slug in have_gnis`. An earlier version was, and it silently dropped
        # the 18 waters that DO carry a registry GNIS id which simply is not in any geodatabase
        # ("gnis 1303469 not found in any geodatabase read") but DO have a measured binding.
        # Having an id that resolves to nothing is not the same as being placed, and the guard
        # that matters is the precise one in process_vpu: skip a slug the GNIS join ACTUALLY
        # PLACED, not one that merely holds a number.
        skipped_pid = 0
        for slug, rec in bnd.items():
            if slug not in reg:
                continue
            p = norm_pid(rec.get('permanent_identifier'))
            v = str(rec.get('vpu') or '').strip()
            if not p or not v:
                skipped_pid += 1
                continue
            want_pid.setdefault(v, {})[p] = (slug, rec)
            bound_slugs[slug] = rec
        no_id_bound = sum(1 for s in bound_slugs if s not in have_gnis)
        print(f'  binding table: {len(bnd)} bound, {len(bound_slugs)} of them offered as a'
              f' fallback ({no_id_bound} have no GNIS id at all), across VPUs'
              f' {", ".join(sorted(want_pid))}')
        if skipped_pid:
            print(f'  {skipped_pid} binding(s) carry no usable identifier or VPU and were'
                  f' left out')

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

    if args.layers:
        import pyogrio
        for vpu, src in gdbs.items():
            print(f'\n== {vpu}  {Path(src).name}')
            for lyr in pyogrio.list_layers(str(src))[:, 0]:
                if 'VAA' in lyr or lyr in ('NHDFlowline', 'NHDWaterbody'):
                    info = pyogrio.read_info(str(src), layer=lyr)
                    fl_fields = info.get('fields')
                    fl_fields = [] if fl_fields is None else [str(f) for f in fl_fields]
                    print(f'   {lyr}: {", ".join(fl_fields)}')
        return 0

    rows, notes = {}, []
    for vpu, src in gdbs.items():
        print(f'\n-- {vpu}  {Path(src).name}')
        try:
            got, note = process_vpu(vpu, str(src), want_gnis, args, want_pid.get(vpu))
        except Exception as e:                      # a bad VPU must not lose the good ones
            got, note = {}, f'{vpu}: FAILED, {type(e).__name__}: {e}'
        notes.append(note)
        print('   ' + note)
        for slug, r in got.items():
            if slug in rows:                        # a water straddling two VPUs
                keep, why = prefer_row(rows[slug], r)
                note2 = (f'{slug} appears in {rows[slug]["vpu"]} and {r["vpu"]},'
                         f' kept {keep["vpu"]} ({why})')
                notes.append(note2)
                print('   ' + note2)
                rows[slug] = keep
            else:
                rows[slug] = r

    # A polygon holding flowlines that drain far more than its own outlet has almost certainly
    # clipped a river it is not on. Flag it rather than quietly reporting the bigger number.
    # upstream is the inverse of downstream -- derived, never walked twice
    for r in rows.values():
        r['upstream'] = []
    for slug, r in rows.items():
        d = r['downstream']
        if d and d in rows:
            rows[d]['upstream'].append(slug)
    for r in rows.values():
        r['upstream'].sort()

    # WHY A WATER DID NOT PLACE, distinguishing the three cases rather than collapsing them.
    # Before the binding table, 149 of 167 said "no gnis id in registry", which was true and
    # useless -- it named the join that failed, not the water's actual situation, and read the
    # same for a coastal composite that SHOULD never place as for blewett_falls_lake, which
    # had a perfectly good binding nobody looked at. The third reason below is the one that
    # earns its keep: it means the polygon was found and none of its flowlines are routed.
    # ── flow NHD cannot derive ──────────────────────────────────────────────────────────
    links_path = Path(args.links) if args.links else reg_path.parent / '_chain_links.json'
    linked, link_notes = [], []
    if args.no_links:
        print('\n--no-links: derived edges only')
    elif links_path.exists():
        try:
            doc = json.loads(links_path.read_text(encoding='utf-8'))
            links = doc.get('links') if isinstance(doc, dict) else doc
        except Exception as exc:
            links = []
            print('\n!! %s unreadable (%s: %s) -- man-made channels are NOT in the chain'
                  % (links_path, type(exc).__name__, exc))
        linked, link_notes = apply_chain_links(rows, links or [])
        if linked or link_notes:
            print('\n   ASSERTED FLOW -- canals and transfers NHD does not route:')
            for a, b, via in linked:
                print('     %-22s -> %-22s via %s' % (a, b, via))
                print('       %s routed drainage %.1f km2 (%.0f sq mi), topographic %.1f'
                      % (' ' * 22, rows[b]['routed_drainage_km2'],
                         rows[b]['routed_drainage_km2'] / 2.58999, rows[b]['drainage_km2']))
            for n in link_notes:
                print('     %s' % n)
            notes.extend('link %s -> %s via %s' % (a, b, via) for a, b, via in linked)
    else:
        # Not an error -- but silence here is how Lake Moultrie sat as a headwater pond.
        print('\n   no %s -- man-made channels are not in the chain' % links_path.name)

    unmatched = {}
    for slug in reg:
        if slug in rows:
            continue
        g = normalize_gnis(reg[slug].get('gnis'))
        if g is not None:
            unmatched[slug] = f'gnis {g} not found in any geodatabase read'
        elif slug in bound_slugs:
            b = bound_slugs[slug]
            unmatched[slug] = (
                f'no gnis id; bound geometrically to {b.get("nhd_layer")}'
                f' {b.get("permanent_identifier")} in {b.get("vpu")}, but no ROUTED flowline'
                f' references it')
        else:
            unmatched[slug] = 'no gnis id in registry and no geometric binding'

    odd = [s2 for s2, r in rows.items() if r.get('side_channel')]
    if odd:
        print('\n   OXBOWS AND SIDE CHANNELS -- a low stream order carrying a large basin. These')
        print('   are tied to a big river, so their level follows its gauge, not a pool level.')
        print('   TotDASqKm counts what passed upstream; DivDASqKm is what flows through:')
        for s2 in sorted(odd, key=lambda x: -rows[x]['drainage_km2']):
            r = rows[s2]
            print(f'     {s2:<30} river upstream {r["drainage_km2"]:>10.1f} km2,'
                  f' its own catchment {r["div_drainage_km2"]:>8.1f} km2'
                  f'  ({r["drainage_km2"] / max(r["div_drainage_km2"], 1e-9):.0f}x)'
                  f'  order {r["stream_order"]}')
    suspect = [s2 for s2, r in rows.items() if r.get('foreign_flowline_suspected')]
    via_geom = [s for s, r in rows.items() if r.get('match_via') == 'geometry']
    print(f'\n== placed {len(rows)} of {len(reg)} waters; {len(unmatched)} unplaced')
    print(f'   on the registry GNIS id:      {len(rows) - len(via_geom)}')
    print(f'   on the geometric binding:     {len(via_geom)}')
    # The gap between "offered" and "placed" is the whole answer to whether NHDFlowline's
    # WBArea_Permanent_Identifier reaches NHDArea features. Printed rather than assumed.
    #
    # SCOPED TO THE VPUs ACTUALLY READ. Under --only 0304 the unscoped version reported
    # "offered 122, of which 105 had no routed flowline", and 105 of those were simply filed
    # under basins this run never opened. A count that includes what was not looked at is not a
    # measurement, and reading it as one would have condemned the NHDArea join on no evidence.
    in_scope = {s: b for s, b in bound_slugs.items() if str(b.get('vpu') or '') in gdbs}
    if in_scope:
        stuck = [s for s in in_scope if s not in rows]
        print(f'   offered by the binding table: {len(in_scope)} in the VPU(s) read,'
              f' of which {len(stuck)} had no routed flowline')
        if len(bound_slugs) != len(in_scope):
            print(f'   ({len(bound_slugs) - len(in_scope)} more are filed under basins this run'
                  f' did not open and are NOT counted above)')
    if suspect:
        print(f'   {len(suspect)} polygon(s) contain flowlines draining more than twice what')
        print('   their own outlet does -- they have probably clipped a river they are not on:')
        for s2 in sorted(suspect, key=lambda x: -rows[x]['max_drainage_km2'])[:15]:
            r = rows[s2]
            print(f'     {s2:<30} outlet {r["drainage_km2"]:>10.1f} km2,'
                  f' largest inside {r["max_drainage_km2"]:>10.1f} km2,'
                  f' order {r["stream_order"]} vs {r["max_stream_order"]}')
    terminal = [s for s, r in rows.items() if not r['downstream']]
    print(f'   with a downstream neighbour: {len(rows) - len(terminal)}')
    print(f'   terminal within their VPU:   {len(terminal)}')

    out = {'_meta': {'source': 'NHDPlus HR', 'direction': 'HydroSeq decreases downstream',
                     'vpus': list(gdbs),
                     # So a consumer can tell a 283-water chain built without the binding
                     # table from a 283-water chain that is genuinely all there is.
                     'matched_on': ('gnis id, then geometric binding' if bound_slugs
                                    else 'gnis id only'),
                     'placed_via_gnis': len(rows) - len(via_geom),
                     'placed_via_geometry': len(via_geom),
                     'notes': notes},
           'waters': rows, 'unmatched': unmatched}

    if args.write:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(out, indent=1), encoding='utf-8')
        print(f'\nwrote {args.out}')
    else:
        print(f'\nDRY RUN -- nothing written. Add --write to write {args.out}.')

    # Show what was actually placed. The first version printed a hard-coded Catawba sample, so
    # every other basin printed a blank and you could not see your own result -- 0602 placed
    # three waters and showed none of them. Sorted by outlet hydrosequence DESCENDING, which is
    # upstream to downstream.
    if rows:
        shown = sorted(rows.values(), key=lambda r: -r['outlet_hydroseq'])
        cap = args.show if args.show > 0 else len(shown)
        print(f'\n== placed waters, upstream to downstream'
              + (f' (first {cap} of {len(shown)})' if cap < len(shown) else '') + '\n')
        print(f'   {"water":<30} {"outlet hydroseq":>16} {"drainage km2":>13} '
              f'{"nhd acres":>10}  -> next water down')
        for r in shown[:cap]:
            acres = r['nhd_area_km2'] * 247.105
            print(f'   {r["slug"]:<30} {r["outlet_hydroseq"]:>16} {r["drainage_km2"]:>13.1f} '
                  f'{acres:>10.1f}  -> {r["downstream"] or "(leaves these basins)"}')
        multi = [r for r in shown if r['upstream']]
        if multi:
            print('\n   fed directly by:')
            for r in multi:
                print(f'     {r["slug"]:<30} <- {", ".join(r["upstream"])}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
