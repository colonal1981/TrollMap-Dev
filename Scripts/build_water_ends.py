#!/usr/bin/env python3
"""build_water_ends.py -- where each lake lets its water out, and the point of it farthest from there.

Personal use only, not for distribution or resale; not for navigation.

    py Scripts\\build_water_ends.py                   # dry run: prints what it would write
    py Scripts\\build_water_ends.py --write           # writes registry\\water_ends.json
    py Scripts\\build_water_ends.py --only 0305 -v    # one VPU, each water printed

WHY

Ryan, 2026-09-24: *"i just thought it was already on all waters since i had already asked for
everything for one water to be on all of them"* -- about per-zone clarity, which six lakes have
because someone wrote their zones by hand, naming the ramps in each. Every other water gets two
generic zones, "Creeks/upper arms" and "Main lake/lower basin", and no zone names any launch, so a
plan on those waters is built on the lake-wide mean of the two.

What decides which of the two a launch is in is where it sits between the water's OUTLET and its
far end. Measured 2026-09-24 on the 30 lakes with three or more positioned Secchi stations and a
USACE dam bound to them: a station's distance from the dam against its own average Secchi is
negative on 25 of 30 (Spearman <= -0.5 on 24) -- Lake Murray -0.90 over 43 stations, Greenwood
-0.93, Wylie -0.86, Marion -0.73. Farther from the outlet is murkier water. That is the reservoir
gradient limnology names riverine / transitional / lacustrine, measured on these lakes rather than
assumed.

WHAT IT WRITES, AND FROM WHAT

    registry/water_ends.json  {"waters": {slug: {"outlet": [lat, lon], "far": [lat, lon],
                                                 "km": straight-line outlet->far}}}

  * OUTLET: the downstream end of the lake's outlet flowline -- the flowline inside its waterbody
    with the LOWEST HydroSeq, which build_water_chain.py already found and recorded as
    `outlet_hydroseq`. NHDPlus HR flowlines are digitised in the direction of flow, so the last
    vertex is where the water leaves. No dam table is needed, and the one there is picks the
    wrong structure on Hartwell (the Clemson Lower Diversion Dam, at the lake's upper end).
  * FAR: the vertex of the registry boundary -- the outline the app draws -- farthest from the
    outlet. On a dendritic reservoir that is the top of the longest arm.

Two anchors and no parameter: a launch goes to the zone whose anchor is nearer, the same rule
as the nearest measured station. The Worker does that; this file only says where the ends are.

Reads the extracted NHDPlus HR GDBs under F:\\TrollMapPipeline\\NHD (read-only), the FULL
registry/water_chain.json (the published one is slimmed and has no hydrosequence), and
registry/boundaries/<slug>.geojson. Writes nothing without --write.
"""
import argparse
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build_water_chain import find_gdbs, find_repo_root, DEFAULT_NHD  # noqa: E402

EARTH_KM = 6371.0088
OUT_REL = 'registry/water_ends.json'


def km(a, b):
    """Great-circle km between two (lat, lon) points."""
    p = math.pi / 180
    h = (math.sin((b[0] - a[0]) * p / 2) ** 2
         + math.cos(a[0] * p) * math.cos(b[0] * p) * math.sin((b[1] - a[1]) * p / 2) ** 2)
    return 2 * EARTH_KM * math.asin(min(1.0, math.sqrt(h)))


def ring_points(geo):
    """Every (lat, lon) vertex of every polygon in a GeoJSON object, holes included -- an
    island's shore is still the lake's edge."""
    out = []

    def walk(g):
        if not g:
            return
        t = g.get('type')
        if t == 'FeatureCollection':
            for f in g.get('features') or []:
                walk(f)
        elif t == 'Feature':
            walk(g.get('geometry'))
        elif t == 'GeometryCollection':
            for x in g.get('geometries') or []:
                walk(x)
        elif t == 'Polygon':
            for ring in g.get('coordinates') or []:
                out.extend((c[1], c[0]) for c in ring if len(c) >= 2)
        elif t == 'MultiPolygon':
            for poly in g.get('coordinates') or []:
                for ring in poly:
                    out.extend((c[1], c[0]) for c in ring if len(c) >= 2)
    walk(geo)
    return out


def farthest(points, origin):
    best, far = -1.0, None
    for p in points:
        d = km(origin, p)
        if d > best:
            best, far = d, p
    return far, best


def outlet_points(src, hydroseqs):
    """{HydroSeq: (lat, lon)} -- the downstream end of each named flowline, read from the GDB."""
    import pyogrio
    import shapely
    from build_water_chain import read_layer
    vaa, missing, _have = read_layer(src, 'NHDPlusFlowlineVAA', ['NHDPlusID', 'HydroSeq'])
    if missing:
        raise RuntimeError(f'NHDPlusFlowlineVAA is missing {missing}')
    want = set(int(h) for h in hydroseqs)
    vaa = vaa[vaa['HydroSeq'].notna()]
    hs_int = vaa['HydroSeq'].astype('int64')
    sel = vaa[hs_int.isin(want)]
    id_to_hs = {int(i): int(h) for i, h in zip(sel['NHDPlusID'], sel['HydroSeq'])}
    if not id_to_hs:
        return {}
    out = {}
    ids = sorted(id_to_hs)
    # THE COLUMN'S OWN SPELLING. pyogrio drops a requested column the layer does not have, without
    # a word -- the 0601/0602 vintage is older than the 03xx one and need not spell it the same, the
    # lesson build_water_chain.read_layer() already carries. Ask the layer.
    info = pyogrio.read_info(src, layer='NHDFlowline')
    names = [] if info.get('fields') is None else [str(f) for f in info.get('fields')]
    col = next((f for f in names if f.lower() == 'nhdplusid'), None)
    if col is None:
        raise RuntimeError(f'NHDFlowline has no NHDPlusID; it has {names}')
    # In chunks: an IN list of a few hundred ids is well inside what OGR SQL takes.
    for k in range(0, len(ids), 200):
        chunk = ids[k:k + 200]
        where = '%s IN (%s)' % (col, ','.join(str(i) for i in chunk))
        meta, _fids, geoms, fields = pyogrio.raw.read(src, layer='NHDFlowline',
                                                      columns=[col], where=where)
        if not len(fields):
            raise RuntimeError(f'NHDFlowline returned no {col} column for {src}')
        for gid, wkb in zip(fields[0], geoms):
            if wkb is None:
                continue
            g = shapely.from_wkb(wkb)
            lines = list(g.geoms) if hasattr(g, 'geoms') else [g]
            coords = list(lines[-1].coords)
            if not coords:
                continue
            x, y = coords[-1][0], coords[-1][1]
            out[id_to_hs[int(gid)]] = (round(y, 6), round(x, 6))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--nhd', default=str(DEFAULT_NHD))
    ap.add_argument('--root', default=None, help='folder holding registry/ (found if omitted)')
    ap.add_argument('--only', nargs='*', default=None, help='VPUs, e.g. 0305')
    ap.add_argument('--write', action='store_true')
    ap.add_argument('-v', '--verbose', action='store_true')
    a = ap.parse_args()

    root = find_repo_root(a.root)
    reg = root / 'registry'
    chain = json.load(open(reg / 'water_chain.json', encoding='utf-8'))['waters']
    idx = json.load(open(reg / 'lake_index.json', encoding='utf-8'))
    idx = idx.get('lakes', idx)
    lakes = {s: r for s, r in chain.items()
             if (idx.get(s) or {}).get('feature_type') == 'lake' and r.get('outlet_hydroseq')}
    by_vpu = {}
    for s, r in lakes.items():
        by_vpu.setdefault(r.get('vpu'), {})[s] = int(r['outlet_hydroseq'])
    gdbs = find_gdbs(Path(a.nhd), a.only)
    print('%d registry lakes in the chain with an outlet hydrosequence, in %d VPUs; GDBs found: %s'
          % (len(lakes), len(by_vpu), ', '.join(gdbs)))

    rows, notes = {}, []
    for vpu, want in sorted(by_vpu.items()):
        if a.only and vpu not in a.only:
            continue
        src = gdbs.get(vpu)
        if not src:
            notes.append(f'{vpu}: no GDB, {len(want)} lakes not placed')
            continue
        pts = outlet_points(str(src), want.values())
        got = 0
        for slug, hs in sorted(want.items()):
            o = pts.get(hs)
            if not o:
                notes.append(f'{slug}: outlet flowline {hs} not found in {vpu}')
                continue
            bp = reg / 'boundaries' / f'{slug}.geojson'
            if not bp.exists():
                notes.append(f'{slug}: no registry boundary')
                continue
            ring = ring_points(json.load(open(bp, encoding='utf-8')))
            if len(ring) < 3:
                notes.append(f'{slug}: boundary has no ring')
                continue
            far, d = farthest(ring, o)
            # How far the outlet sits from the outline. The outlet flowline's end is ON the drawn
            # shore for 271 of 273 lakes (median 0.00 km). An outlet OUTSIDE the outline's own box
            # is not this water's outlet -- lake_johnson's lands 19 km away, in Raleigh's Neuse,
            # because the chain matched another water -- so it is refused and named, with no
            # distance tolerance to pick: the box is the water's own.
            off = min(km(o, p) for p in ring)
            lats = [p[0] for p in ring]
            lons = [p[1] for p in ring]
            if not (min(lats) <= o[0] <= max(lats) and min(lons) <= o[1] <= max(lons)):
                notes.append(f'{slug}: REFUSED, outlet {o[0]},{o[1]} is outside its own outline '
                             f'({off:.2f} km off) -- the chain placed another water')
                continue
            rows[slug] = {'outlet': [o[0], o[1]], 'far': [round(far[0], 6), round(far[1], 6)],
                          'km': round(d, 2), 'outlet_off_outline_km': round(off, 2)}
            got += 1
            if a.verbose:
                print('   %-30s outlet %9.5f,%10.5f  far %9.5f,%10.5f  %6.1f km  off %.2f'
                      % (slug, o[0], o[1], far[0], far[1], d, off))
        print('  %s: %d of %d lakes placed' % (vpu, got, len(want)))

    offs = sorted(r['outlet_off_outline_km'] for r in rows.values())
    if offs:
        print('\n%d lakes placed. Outlet distance from the drawn outline: median %.2f km, '
              'p90 %.2f, max %.2f' % (len(rows), offs[len(offs) // 2], offs[int(len(offs) * .9)], offs[-1]))
    for n in notes:
        print('   note: ' + n)
    out = {'_note': 'Outlet = downstream end of the lowest-HydroSeq flowline in the lake '
                    '(NHDPlus HR); far = the registry boundary vertex farthest from it. '
                    'Built by Scripts/build_water_ends.py. Personal use only, not for '
                    'distribution or resale; not for navigation.',
           'waters': dict(sorted(rows.items()))}
    if a.write:
        p = root / OUT_REL
        with open(p, 'w', encoding='utf-8') as fh:
            json.dump(out, fh, indent=1)
        print('-> %s' % p)
    else:
        print('(dry run -- pass --write to write %s)' % OUT_REL)


if __name__ == '__main__':
    main()
