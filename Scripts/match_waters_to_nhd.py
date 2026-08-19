#!/usr/bin/env python3
"""
match_waters_to_nhd.py -- bind registry waters to NHD waterbodies by the ground they cover,
not by an id they may not have or may have wrong.

WHY
    build_water_chain.py joins on GNIS id. 150 of the 454 registry waters carry a slug: fallback
    with no id at all, so a third of the registry can never place. hiwassee_lake is one of them.

    Worse, an id can be present and wrong. HU4 0602 placed a water called persimmon_lake that
    receives BOTH Chatuge and Nottely and drains 2,506 km2. Only Hiwassee Lake does that. NHD had
    attached GNIS 1016964 -- genuinely Persimmon Lake's id -- to the whole Hiwassee polygon, and
    the registry copied it faithfully: registry acres 5914.5, NHD acres 5914.5, in perfect
    agreement about the wrong thing. Comparing areas cannot catch that. Two registry slugs landing
    on ONE NHD waterbody can, and does.

WHAT IT DOES
    Reads each geodatabase's NHDWaterbody geometry, indexes it, and for every registry water with
    a boundary polygon finds the NHD waterbody it actually overlaps. Reports three things:

      1. bindings   -- slug -> NHD Permanent_Identifier, a discovered foreign key, the same kind
                       as the LID, the CWMS location and Duke's lakepondLocationId.
      2. CONFLICTS  -- one NHD waterbody claimed by more than one slug. That is a structural
                       contradiction: a real water has one outlet and one polygon. This is the
                       duplicate detector that does not care about names or ids.
      3. id disputes -- a water whose GNIS id says one waterbody and whose geometry says another.

    Reads only. Writes nothing unless --json is given, and never touches lake_index.json.

NEEDS
    pyogrio and shapely. Deliberately does NOT need geopandas: it reads WKB through
    pyogrio.raw.read and builds geometry with shapely directly, because geopandas may not be
    installed and pyogrio.read_dataframe(read_geometry=True) requires it.
"""
import argparse
import json
import sys
import time
from pathlib import Path

REGISTRY_REL = 'registry/lake_index.json'
BOUNDS_REL = 'registry/boundaries'
DEFAULT_NHD = Path(r'F:\TrollMapPipeline\NHD')


SQM_PER_ACRE = 4046.8564224
EARTH_R_M = 6371008.8


def _sphere_acres(geom):
    """Acres of a lon/lat shapely polygon, by spherical excess.

    Shapely's .area on lon/lat is degrees squared and means nothing. The same formula
    audit_boundary_rings.py uses, so the number this records and the number that audit measures
    are comparable -- which is the entire point of recording it.
    """
    import math
    def ring(coords):
        pts = list(coords)
        if len(pts) < 4:
            return 0.0
        t = 0.0
        for k in range(len(pts) - 1):
            x1, y1 = math.radians(pts[k][0]), math.radians(pts[k][1])
            x2, y2 = math.radians(pts[k + 1][0]), math.radians(pts[k + 1][1])
            t += (x2 - x1) * (2 + math.sin(y1) + math.sin(y2))
        return abs(t * EARTH_R_M * EARTH_R_M / 2.0)
    total = 0.0
    parts = list(geom.geoms) if hasattr(geom, 'geoms') else [geom]
    for part in parts:
        if not hasattr(part, 'exterior'):
            continue
        total += ring(part.exterior.coords)
        for h in part.interiors:
            total -= ring(h.coords)
    return round(total / SQM_PER_ACRE, 1)


def find_repo_root(explicit=None):
    if explicit:
        p = Path(explicit)
        return p.parent.parent if p.name.endswith('.json') else p
    here = Path.cwd().resolve()
    mine = Path(__file__).resolve().parent
    seen = set()
    for cand in [here] + list(here.parents) + [mine] + list(mine.parents):
        if cand in seen:
            continue
        seen.add(cand)
        if (cand / REGISTRY_REL).exists():
            return cand
    return here


def normalize_gnis(v):
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


def find_gdbs(nhd_dir, only=None):
    import re
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
        out = {k: v for k, v in out.items() if k in set(only)}
    return dict(sorted(out.items()))


def read_polys(src, layer, wanted, bbox=None):
    """Return (wkb_array, {canonical_column: values}, missing, available) for one polygon layer.

    Resolves column names case-insensitively because the 0601/0602 vintage need not spell fields
    like the 03xx one, and pyogrio SILENTLY DROPS a requested column the layer does not have --
    so asking blind fails later and blind."""
    import pyogrio
    from pyogrio.raw import read as rawread
    info = pyogrio.read_info(str(src), layer=layer)
    fields = info.get('fields')
    # pyogrio returns 'fields' as a numpy array; `arr or []` raises on a multi-element array.
    available = [] if fields is None else [str(f) for f in fields]
    by_lower = {f.lower(): f for f in available}
    actual, missing = {}, []
    for w in wanted:
        f = by_lower.get(w.lower())
        (missing.append(w) if f is None else actual.setdefault(w, f))
    if missing:
        return None, None, missing, available
    meta, _fids, geom, field_data = rawread(
        str(src), layer=layer, columns=list(actual.values()),
        read_geometry=True, bbox=bbox)
    # field_data is ordered to match meta['fields'], NOT the columns list that was requested.
    got = [str(f) for f in (meta.get('fields') if meta.get('fields') is not None else [])]
    back = {v: k for k, v in actual.items()}
    cols = {}
    for name, values in zip(got, field_data):
        cols[back.get(name, name)] = values
    return geom, cols, [], available


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', default=None)
    ap.add_argument('--nhd', default=str(DEFAULT_NHD))
    ap.add_argument('--only', nargs='*', help='VPU codes, e.g. --only 0602')
    ap.add_argument('--gdb', default=None,
                    help='point at ONE geodatabase directly, bypassing discovery')
    ap.add_argument('--min-overlap', type=float, default=30.0,
                    help='percent of the registry polygon that must fall in the NHD one')
    ap.add_argument('--min-area-ratio', type=float, default=0.25,
                    help='smaller area / larger; below this it is containment, not identity')
    ap.add_argument('--json', default=None, help='write bindings here')
    args = ap.parse_args()

    try:
        import shapely
        from shapely import STRtree, from_wkb
    except ImportError:
        print('shapely is required. py -m pip install shapely')
        return 2
    try:
        import pyogrio  # noqa: F401
    except ImportError:
        print('pyogrio is required.')
        return 2
    import numpy as np

    root = find_repo_root(args.registry)
    reg_path = Path(args.registry) if args.registry else root / REGISTRY_REL
    if not reg_path.exists():
        print(f'registry not found: {reg_path}')
        return 2
    reg = json.loads(reg_path.read_text(encoding='utf-8'))
    bounds_dir = root / BOUNDS_REL
    print(f'registry: {reg_path}\nwaters: {len(reg)}')

    # --- load every registry polygon we have -------------------------------------------------
    from find_duplicate_waters import rings_of
    from geomcore import _shapely_geom
    reg_geom, no_boundary = {}, []
    for slug in reg:
        p = bounds_dir / f'{slug}.geojson'
        if not p.exists():
            no_boundary.append(slug)
            continue
        g = _shapely_geom(rings_of(p))
        if g is None or g.is_empty or g.area <= 0:
            no_boundary.append(slug)
        else:
            reg_geom[slug] = g
    print(f'  with a usable boundary polygon: {len(reg_geom)}')
    print(f'  without one: {len(no_boundary)}')
    have_id = sum(1 for s in reg_geom if normalize_gnis(reg[s].get('gnis')))
    print(f'  of those, carrying a GNIS id: {have_id}; relying on geometry alone:'
          f' {len(reg_geom) - have_id}')

    if args.gdb:
        import re as _re
        m = _re.search(r'_H_(\d{4})_', Path(args.gdb).name)
        gdbs = {(m.group(1) if m else Path(args.gdb).stem): Path(args.gdb)}
    else:
        gdbs = find_gdbs(Path(args.nhd), args.only)
    if not gdbs:
        print(f'no NHDPLUS_H_* geodatabases under {args.nhd}')
        return 2
    print('\ngeodatabases: ' + ', '.join(
        k + (' (zip, slower)' if str(v).endswith('.zip') else '') for k, v in gdbs.items()))

    bounds = [reg[s].get('bounds_wsen') for s in reg_geom if reg[s].get('bounds_wsen')]
    world = None
    if bounds:
        world = (min(b[0] for b in bounds), min(b[1] for b in bounds),
                 max(b[2] for b in bounds), max(b[3] for b in bounds))

    bindings, notes = {}, []
    for vpu, src in gdbs.items():
        t0 = time.time()
        print(f'\n-- {vpu}  {Path(src).name}', flush=True)
        # A LAKE lives in NHDWaterbody. A large RIVER's open water lives in NHDArea, FType 460
        # StreamRiver, and estuaries live there too. Reading only NHDWaterbody bound 329 of 348
        # lakes and just 31 of 90 rivers, with all 16 coastal waters unbound -- not a threshold
        # problem, a layer problem.
        WANT = ['Permanent_Identifier', 'GNIS_ID', 'GNIS_Name', 'AreaSqKm', 'FType']
        parts, failed = [], False
        for layer in ('NHDWaterbody', 'NHDArea'):
            try:
                geom, cols, missing, have = read_polys(src, layer, WANT, bbox=world)
            except Exception as e:
                if layer == 'NHDWaterbody':
                    notes.append(f'{vpu}: FAILED on {layer}, {type(e).__name__}: {e}')
                    print('   ' + notes[-1])
                    failed = True
                else:
                    print(f'   {layer} not readable here ({type(e).__name__}) -- skipped')
                continue
            if missing:
                msg = (f'{vpu}: REFUSED, {layer} is missing {", ".join(missing)}'
                       if layer == 'NHDWaterbody'
                       else f'{vpu}: {layer} is missing {", ".join(missing)}, skipped')
                notes.append(msg)
                print('   ' + msg)
                print(f'   it does have: {", ".join(have)}')
                if layer == 'NHDWaterbody':
                    failed = True
                continue
            if geom is None or len(geom) == 0:
                continue
            parts.append((layer, geom, cols))
        if failed or not parts:
            if not failed:
                notes.append(f'{vpu}: nothing inside the registry extent')
                print('   ' + notes[-1])
            continue

        geoms, cols, layers = [], {k: [] for k in WANT}, []
        for layer, geom, c in parts:
            g = from_wkb(geom)
            keep = np.array([x is not None and not x.is_empty for x in g])
            g = g[keep]
            geoms.append(g)
            layers.extend([layer] * len(g))
            for k in WANT:
                cols[k].extend(list(np.asarray(c[k])[keep]))
        nhd = np.concatenate(geoms) if len(geoms) > 1 else geoms[0]
        cols = {k: np.asarray(v, dtype=object) for k, v in cols.items()}
        layers = np.asarray(layers, dtype=object)
        counts = {lay: int((layers == lay).sum()) for lay in set(layers.tolist())}
        print(f'   {len(nhd)} polygons in extent ({counts}), read in'
              f' {time.time() - t0:.0f}s', flush=True)

        # A river is split into many NHDArea pieces and a lake's arms can be separate polygons,
        # so one water is often several rows sharing a GNIS id. Dissolve those before matching:
        # otherwise the best single piece is compared against the whole registry outline and the
        # size gate throws away a correct match.
        groups = {}
        for i, gid in enumerate(cols['GNIS_ID']):
            key = normalize_gnis(gid)
            groups.setdefault(key if key else f'_row{i}', []).append(i)
        merged, midx = [], []
        for key, idxs in groups.items():
            if len(idxs) == 1:
                merged.append(nhd[idxs[0]])
            else:
                merged.append(shapely.union_all(nhd[idxs]))
            midx.append(idxs)
        dissolved = int(sum(1 for i in midx if len(i) > 1))
        if dissolved:
            print(f'   dissolved {dissolved} multi-polygon water(s) sharing a GNIS id')
        nhd = np.asarray(merged, dtype=object)
        tree = STRtree(nhd)

        placed = 0
        for slug, g in reg_geom.items():
            idx = tree.query(g, predicate='intersects')
            if len(idx) == 0:
                continue
            # Both gates matter, and only one of them is obvious. A 0.1-acre pond lying
            # wholly inside a 9,884-acre reservoir is 100% contained and is not that reservoir --
            # the same mistake find_duplicate_waters made when it called greenfield_lake a
            # partial trace of the Cape Fear coastal region. Containment implies identity only
            # when the two are COMPARABLE IN SIZE, so a candidate must clear both.
            best = None
            for i in idx:
                other = nhd[i]
                try:
                    inter = g.intersection(other).area
                except Exception:
                    inter = g.buffer(0).intersection(other.buffer(0)).area
                if inter <= 0 or other.area <= 0:
                    continue
                pct_reg = 100.0 * inter / g.area
                ratio = min(g.area, other.area) / max(g.area, other.area)
                if pct_reg < args.min_overlap or ratio < args.min_area_ratio:
                    continue
                pct_nhd = 100.0 * inter / other.area
                if best is None or inter > best[0]:
                    best = (inter, i, pct_reg, pct_nhd, ratio)
            if best is None:
                continue
            _inter, i, pct_reg, pct_nhd, ratio = best

            # NHD splits a big reservoir across several waterbody polygons, and the dissolve
            # above only merges the ones sharing a GNIS id -- arms with no id, or a different
            # one, stay separate. Binding to the single best group then UNDERSTATES the lake:
            # hartwell_lake measured 33,596 acres against a registry 54,072 and a real ~56,000,
            # so the registry was right and the measurement was wrong. Report the union of every
            # NHD polygon lying almost entirely inside the registry outline, as a SECOND number.
            #
            # Deliberately not used for the binding itself. cheoah_lake's outline covers
            # Calderwood completely, so unioning on containment alone would swallow the next
            # lake downstream -- the very confusion that took two runs to clear.
            # Summed from the SAME source as nhd_acres -- NHD's declared AreaSqKm -- not from
            # raw geometry. Mixing a declared area with a geometric one makes the two numbers
            # incomparable, which is how the first cut reported a union SMALLER than the single
            # group it contains. NHD polygons do not overlap, so summing is safe.
            # THE BEST-MATCHING POLYGON IS ALWAYS IN THE UNION. The first cut admitted a
            # polygon only if 90% of it lay inside the registry outline, which throws the main
            # body out whenever NHD's polygon is LARGER than the registry's -- exactly the
            # "registry is too small" case this is meant to find. lake_marion came back with a
            # union of 2,677 acres against a single best polygon of 91,472.
            union_pieces, union_acres = 0, None
            union_covers_reg = reg_covers_union = None
            try:
                inside_idx = [i] + [k for k in idx
                                    if k != i and nhd[k].area > 0
                                    and g.intersection(nhd[k]).area >= 0.9 * nhd[k].area]
                union_pieces = len(inside_idx)
                union_acres = round(sum(
                    float(cols['AreaSqKm'][j] or 0)
                    for k in inside_idx for j in midx[k]) * 247.105, 1)
                # Geometric, both sides, so no declared-area basis can creep in. Comparing NHD's
                # AreaSqKm against the registry's area_acres had fort_loudoun_lake fitting
                # 18,372 acres of NHD polygon inside a 13,770-acre outline.
                u = shapely.union_all([nhd[k] for k in inside_idx])
                inter_u = g.intersection(u).area
                if g.area > 0:
                    union_covers_reg = round(100.0 * inter_u / g.area, 1)
                if u.area > 0:
                    reg_covers_union = round(100.0 * inter_u / u.area, 1)
            except Exception:
                pass
            src_rows = midx[i]
            j0 = src_rows[0]

            def _first(col):
                for j in src_rows:
                    v = cols[col][j]
                    if v is not None and str(v).strip():
                        return str(v).strip()
                return None
            row = {
                'slug': slug, 'vpu': vpu,
                'permanent_identifier': str(cols['Permanent_Identifier'][j0]),
                'nhd_layer': str(layers[j0]),
                'nhd_pieces': len(src_rows),
                'nhd_gnis_id': _first('GNIS_ID'),
                'nhd_gnis_name': _first('GNIS_Name'),
                'nhd_acres': round(sum(float(cols['AreaSqKm'][j] or 0)
                                       for j in src_rows) * 247.105, 1),
                'nhd_ftype': int(cols['FType'][j0] or 0),
                # THE ACREAGE OF THE BOUNDARY THIS BINDING WAS COMPUTED AGAINST, measured
                # here, spherically, from the same polygon the percentages above came from.
                #
                # `registry_acres` below is lake_index.json's number and is NOT that. It goes
                # stale when the index is rebuilt and it does not move when the boundary
                # changes -- so it cannot answer "is this binding still about this polygon".
                # audit_boundary_rings.py asked it anyway on 2026-08-18 and reported
                # falls_lake's coverage to the acre after the boundary had grown 36%.
                'boundary_acres': _sphere_acres(g),
                'registry_acres': reg[slug].get('area_acres'),
                'registry_gnis': reg[slug].get('gnis'),
                'pct_of_registry_polygon': round(pct_reg, 1),
                'pct_of_nhd_polygon': round(pct_nhd, 1),
                'area_ratio': round(ratio, 4),
                'nhd_union_pieces': union_pieces,
                'nhd_union_acres': union_acres,
                'union_covers_pct_of_registry': union_covers_reg,
                'registry_covers_pct_of_union': reg_covers_union,
            }
            prev = bindings.get(slug)
            if prev is None or pct_reg > prev['pct_of_registry_polygon']:
                bindings[slug] = row
            placed += 1
        notes.append(f'{vpu}: matched {placed} registry waters in {time.time() - t0:.0f}s')
        print('   ' + notes[-1], flush=True)

    # --- 1. conflicts: one NHD waterbody, more than one slug ---------------------------------
    claimed = {}
    for slug, r in bindings.items():
        claimed.setdefault((r['vpu'], r['permanent_identifier']), []).append(slug)
    conflicts = {k: v for k, v in claimed.items() if len(v) > 1}

    print(f'\n== bound {len(bindings)} of {len(reg)} registry waters to an NHD waterbody')
    by_id = sum(1 for s in bindings if normalize_gnis(reg[s].get('gnis')))
    print(f'   {by_id} already had a GNIS id; {len(bindings) - by_id} had none and are now placed')

    print(f'\n== 1. {len(conflicts)} NHD waterbod(ies) claimed by more than one slug'
          ' -- one water, two registry entries\n')
    for (vpu, pid), slugs in sorted(conflicts.items()):
        r = bindings[slugs[0]]
        print(f'   {vpu} {pid}   NHD calls it "{r["nhd_gnis_name"]}"'
              f' (gnis {r["nhd_gnis_id"]}), {r["nhd_acres"]} acres')
        for s in slugs:
            b = bindings[s]
            print(f'     {s:<30} registry {str(b["registry_acres"]):>10} ac'
                  f'  {str(b["registry_gnis"]):<28}'
                  f'  covers {b["pct_of_nhd_polygon"]}% of the NHD polygon')
        print()
    if not conflicts:
        print('   none')

    # --- 2. the id says one thing, the ground says another ------------------------------------
    disputes = []
    for slug, r in bindings.items():
        want = normalize_gnis(reg[slug].get('gnis'))
        got = normalize_gnis(r['nhd_gnis_id'])
        if want and got and want != got:
            disputes.append(r)
    print(f'\n== 2. {len(disputes)} water(s) whose GNIS id names a different waterbody'
          ' than the one they sit on\n')
    for r in sorted(disputes, key=lambda x: x['slug']):
        print(f'   {r["slug"]:<30} registry says {r["registry_gnis"]},'
              f' the polygon it covers is gnis {r["nhd_gnis_id"]} "{r["nhd_gnis_name"]}"')
    if not disputes:
        print('   none')

    unbound = [s for s in reg if s not in bindings]
    print(f'\n== 3. {len(unbound)} registry water(s) not bound to any NHD waterbody')
    print(f'   ({len(no_boundary)} of those have no boundary polygon to match with)')

    if args.json:
        Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        out = {
            'bindings': bindings,
            'conflicts': {f'{v}/{p}': s for (v, p), s in conflicts.items()},
            'id_disputes': [r['slug'] for r in disputes],
            'unbound': unbound, 'notes': notes}

        # A PARTIAL RUN MUST NOT WRITE A WHOLE FILE.
        #
        # --only narrows which geodatabases are read, so `bindings` holds ONLY that VPU's waters.
        # Writing that dict straight out at the live path replaced 423 bindings with 62 and
        # reported "wrote ..." exactly as a full run does. Nothing failed; the other 361 simply
        # stopped existing, and the next reader would have found the registry two thirds unbound.
        #
        # This project has solved the same problem twice already and both fixes say why:
        # build_all_chartpacks.py loads its report and updates in place, because "a partial run
        # must not silently replace a full report with 30 lakes in it, and asking for a merge step
        # afterwards is a step someone forgets"; make_river_boundaries.py merge-writes its
        # sidecars on any --only run. This was the third instance and the only one still open.
        #
        # Merge only when the run WAS partial. A full run is authoritative and must be able to
        # drop a binding that no longer holds -- a merge there would make stale rows immortal.
        if args.only:
            prior = {}
            try:
                prior = json.loads(Path(args.json).read_text(encoding='utf-8'))
            except FileNotFoundError:
                pass
            except Exception as e:
                sys.exit(f'\n{args.json} exists and could not be read ({str(e)[:60]}).\n'
                         f'      REFUSING to write, because --only produced only '
                         f'{len(bindings)} binding(s) and overwriting would lose the rest.\n'
                         f'      Move that file aside and re-run, or run without --only.')
            kept = {k: v for k, v in (prior.get('bindings') or {}).items() if k not in bindings}
            print(f'\n--only run: merging {len(bindings)} freshly matched binding(s) into '
                  f'{len(kept)} kept from {args.json}')
            # A slug this run examined and did NOT bind has genuinely lost its binding; it is
            # absent from `bindings`, so leaving the old row would resurrect it. Only slugs this
            # run never looked at are carried forward, which is what `kept` is.
            out['bindings'] = {**kept, **bindings}
            for key in ('conflicts', 'id_disputes', 'unbound'):
                pv = prior.get(key)
                if isinstance(pv, dict):
                    out[key] = {**{k: v for k, v in pv.items() if k not in out[key]}, **out[key]}
                elif isinstance(pv, list):
                    fresh = set(out[key])
                    out[key] = sorted(set(x for x in pv if x not in bindings) | fresh)
            out['notes'] = (notes if isinstance(notes, str) else notes)

        Path(args.json).write_text(json.dumps(out, indent=1), encoding='utf-8')
        print(f'\nwrote {args.json}  ({len(out["bindings"])} binding(s))')
    print('\nNothing was edited. lake_index.json was read and not written.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
