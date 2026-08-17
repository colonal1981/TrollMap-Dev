#!/usr/bin/env python3
"""
bind_dams_to_waters.py -- bind USACE dams to registry waters by WHERE THEY ARE, and make each
binding prove itself against a number neither side chose.

WHY POSITION AND NOT NAME
    registry/_duke_dams.json holds 24 rows assembled by hand from a Google summary, Duke's plant
    map and gauge strings. It works and it does not scale: Bridgewater impounds Lake James,
    Oxford impounds Lake Hickory, Cowans Ford impounds Lake Norman, and no amount of string
    comparison will ever discover that. A dam sits somewhere. So does a lake.

THE CHECK THAT MAKES IT TRUSTWORTHY
    USACE reports drainage area at each dam from field survey. water_chain.json reports drainage
    at each water's outlet, derived from NHDPlus HydroSeq. The two sources have no common
    ancestor, and on the ten Catawba dams they already agree to a median of 0.2%. So a binding
    is only CONFIRMED when the dam is close enough to the water AND the two drainage figures
    land within tolerance. Proximity alone is a proposal; proximity plus an independent number
    agreeing is evidence.

A DAM IS ON THE SHORELINE, NOT INSIDE THE LAKE
    It sits at the outlet, so the point falls on the boundary and often just outside it.
    Distance to the polygon is the measure, not containment. Containment would miss almost
    every dam in the file.

WHY THE NAME STILL MATTERS, AND HOW IT IS SPLIT
    Worker/conditions.js:releaseDirection() looks a dam up by the name DUKE publishes, which is
    not always the name USACE records. USACE writes "Rocky Creek-Cedar Creek" for the structure
    carrying both the Rocky Creek and Cedar Creek powerhouses; Duke posts a release as one or
    the other. So every bound dam contributes its full name AND each segment of it, split on the
    separators that encode multiple powerhouses. "Great Falls-Dearborn Dam" yields "great falls
    dearborn", "great falls" and "dearborn", and a release under any of them lands on the right
    water. That is the hand table's whole content, derived.

    Reads only. Writes registry/_dam_bindings.json when --json is given.
"""
import argparse
import json
import math
import re
import sys
from pathlib import Path

REGISTRY_REL = 'registry/lake_index.json'
SQ_MI_PER_SQ_KM = 1.0 / 2.589988
NOISE = {'dam', 'dams', 'hydro', 'powerhouse', 'project', 'lake', 'reservoir', 'development',
         'embankment', 'spillway', 'dike', 'saddle', 'diversion', 'main', 'headworks', 'and'}


def find_repo_root(explicit=None):
    if explicit:
        p = Path(explicit)
        return p.parent.parent if p.name.endswith('.json') else p
    here = Path.cwd().resolve()
    mine = Path(__file__).resolve().parent
    for cand in [here] + list(here.parents) + [mine] + list(mine.parents):
        if (cand / REGISTRY_REL).exists():
            return cand
    return here


def num(v):
    try:
        f = float(str(v).replace(',', '').strip())
    except (TypeError, ValueError):
        return None
    return None if f != f else f


def dam_key(v):
    """The spelling releaseDirection() looks up. Must agree with normalizeDamName() in
    Worker/conditions.js: lowercase, punctuation to spaces, generic words dropped."""
    toks = [t for t in re.split(r'[^a-z0-9]+', str(v or '').lower()) if t and t not in NOISE]
    return ' '.join(toks) or None


def name_aliases(name):
    """Every spelling a release might arrive under.

    USACE writes one structure name where Duke publishes per powerhouse: "Rocky Creek-Cedar
    Creek" is where Duke says "Cedar Creek" or "Rocky Creek". Splitting on the separators that
    join powerhouse names recovers both without a lookup table."""
    out, full = [], dam_key(name)
    if full:
        out.append(full)
    for part in re.split(r'\s*(?:-|/|\band\b|\+|&)\s*', str(name or '')):
        k = dam_key(part)
        if k and k not in out:
            out.append(k)
    return out


def km_between(lon1, lat1, lon2, lat2):
    """Equirectangular, which is exact enough at these distances and cheap at 12,745 dams."""
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = math.radians(lat2 - lat1)
    return 6371.0088 * math.hypot(x, y)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', default=None)
    ap.add_argument('--dams', default=None, help='default <repo>/Dams/dams.geojson')
    ap.add_argument('--max-km', type=float, default=1.5,
                    help='how far a dam may sit from its water (default 1.5)')
    ap.add_argument('--tolerance', type=float, default=0.15,
                    help='fractional drainage disagreement still called confirmed')
    ap.add_argument('--owner', default=None, help='only dams whose ownerNames contains this')
    ap.add_argument('--json', default=None)
    args = ap.parse_args()

    try:
        from shapely import STRtree
        from shapely.geometry import Point
        from shapely.ops import nearest_points
    except ImportError:
        print('shapely is required. py -m pip install shapely')
        return 2

    root = find_repo_root(args.registry)
    reg = json.loads((root / REGISTRY_REL).read_text(encoding='utf-8'))
    chain = {}
    cp = root / 'registry' / 'water_chain.json'
    if cp.exists():
        chain = json.loads(cp.read_text(encoding='utf-8')).get('waters', {})
    dp = Path(args.dams) if args.dams else root / 'Dams' / 'dams.geojson'
    if not dp.exists():
        print(f'{dp} not found -- download the NID for your states as GeoJSON')
        return 2
    dams = json.loads(dp.read_text(encoding='utf-8')).get('features', [])
    print(f'registry: {len(reg)} waters, {len(chain)} in the chain')
    print(f'dams:     {len(dams)} from {dp.name}')

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from find_duplicate_waters import rings_of
    from geomcore import _shapely_geom

    bounds_dir = root / 'registry' / 'boundaries'
    slugs, geoms = [], []
    for slug in reg:
        p = bounds_dir / f'{slug}.geojson'
        if not p.exists():
            continue
        g = _shapely_geom(rings_of(p))
        if g is not None and not g.is_empty and g.area > 0:
            slugs.append(slug)
            geoms.append(g)
    print(f'          {len(geoms)} waters have a boundary polygon\n')
    tree = STRtree(geoms)

    rows, counts = [], {}
    for f in dams:
        pr = f.get('properties') or {}
        if args.owner and args.owner.lower() not in str(pr.get('ownerNames') or '').lower():
            continue
        geom = f.get('geometry') or {}
        c = geom.get('coordinates')
        if geom.get('type') != 'Point' or not c or len(c) < 2:
            continue
        lon, lat = float(c[0]), float(c[1])
        pt = Point(lon, lat)
        # A degree of longitude shrinks with latitude; pad generously and measure properly after.
        deg = args.max_km / (111.32 * max(0.2, math.cos(math.radians(lat))))
        idx = tree.query(pt.buffer(deg))
        nid_sqmi = num(pr.get('drainageArea'))

        best = None
        for i in idx:
            g = geoms[i]
            slug = slugs[i]
            # Distance in DEGREES is meaningless as a length, so the nearest point on the
            # polygon is found geometrically and the gap measured in km after.
            if g.contains(pt):
                km = 0.0
            else:
                np_ = nearest_points(g, pt)[0]
                km = km_between(np_.x, np_.y, lon, lat)
            if km > args.max_km:
                continue
            ch = chain.get(slug, {}).get('drainage_km2')
            ch_sqmi = (ch * SQ_MI_PER_SQ_KM) if ch else None
            if nid_sqmi and ch_sqmi and nid_sqmi > 0:
                diff = abs(ch_sqmi - nid_sqmi) / nid_sqmi
                score = (0, diff, km)          # a drainage match outranks any distance
            else:
                diff = None
                score = (1, km, 0)
            if best is None or score < best[0]:
                best = (score, slug, km, ch_sqmi, diff)

        if best is None:
            counts['unbound'] = counts.get('unbound', 0) + 1
            continue
        _s, slug, km, ch_sqmi, diff = best
        if diff is None:
            verdict = 'position only (no drainage on one side)'
        elif diff <= args.tolerance:
            verdict = 'CONFIRMED (position + drainage)'
        else:
            verdict = 'REFUSED (drainage disagrees)'
        counts[verdict] = counts.get(verdict, 0) + 1
        rows.append({
            'nid_id': pr.get('nidId'), 'dam': pr.get('name'),
            'owner': pr.get('ownerNames'), 'river': pr.get('riverName'),
            'lat': lat, 'lon': lon, 'slug': slug, 'km_from_water': round(km, 3),
            'nid_sq_mi': nid_sqmi, 'chain_sq_mi': None if ch_sqmi is None else round(ch_sqmi, 1),
            'drainage_diff_pct': None if diff is None else round(100 * diff, 1),
            'year': pr.get('yearCompleted'), 'verdict': verdict,
            'aliases': name_aliases(pr.get('name')),
        })

    print('== verdicts')
    for k in sorted(counts, key=lambda x: -counts[x]):
        print(f'   {counts[k]:>5}  {k}')

    ok = [r for r in rows if r['verdict'].startswith('CONFIRMED')]
    bad = [r for r in rows if r['verdict'].startswith('REFUSED')]
    print(f'\n== {len(ok)} confirmed binding(s), worst 12 by drainage disagreement')
    for r in sorted(ok, key=lambda r: -(r['drainage_diff_pct'] or 0))[:12]:
        print(f"   {str(r['dam'])[:30]:<31}{r['slug']:<28}{r['km_from_water']:>6.2f} km"
              f"{str(r['nid_sq_mi']):>8}{str(r['chain_sq_mi']):>9}{r['drainage_diff_pct']:>6.1f}%")
    if bad:
        print(f'\n== {len(bad)} refused -- close by, but the drainage figures disagree')
        for r in sorted(bad, key=lambda r: -(r['drainage_diff_pct'] or 0))[:12]:
            print(f"   {str(r['dam'])[:30]:<31}{r['slug']:<28}{r['km_from_water']:>6.2f} km"
                  f"{str(r['nid_sq_mi']):>8}{str(r['chain_sq_mi']):>9}{r['drainage_diff_pct']:>6.1f}%")

    # dam name -> slug, in the shape releaseDirection() reads. Confirmed bindings only, and a
    # name claimed by two different waters is dropped rather than resolved by whichever came
    # first out of the file.
    table, clash = {}, {}
    for r in ok:
        for a in r['aliases']:
            if table.get(a) not in (None, r['slug']):
                clash.setdefault(a, {table[a]}).add(r['slug'])
            else:
                table[a] = r['slug']
    for a in clash:
        table.pop(a, None)
    print(f'\n== {len(table)} dam name(s) resolve to a water; {len(clash)} dropped for claiming two')
    for a, s in sorted(clash.items()):
        print(f'   {a}: {", ".join(sorted(s))}')

    if args.json:
        Path(args.json).write_text(json.dumps(
            {'_note': 'USACE NID dams bound to registry waters by position, confirmed against '
                      'water_chain.json drainage. dams{} is keyed for '
                      'Worker/conditions.js:normalizeDamName().',
             'dams': table, 'bindings': rows, 'dropped_ambiguous': {k: sorted(v) for k, v in clash.items()}},
            indent=1), encoding='utf-8')
        print(f'\nwrote {args.json}')
    else:
        print('\nno --json given, nothing written')
    return 0


if __name__ == '__main__':
    sys.exit(main())
