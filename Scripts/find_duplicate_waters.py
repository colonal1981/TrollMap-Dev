#!/usr/bin/env python3
"""
find_duplicate_waters.py -- find registry waters that are the same water under two slugs.

WHY
    build_water_chain.py caught john_h_moss_lake / kings_mountain_reservoir because they share
    GNIS 988007. It was structurally blind to lake_lookout / lookout_shoals_lake, which Ryan
    settled with one search: Lookout Shoals Lake is the official name and "Lake Lookout" is the
    local nickname for the same reservoir, sitting exactly where the derived chain placed it,
    between Lake Hickory and Lake Norman.

    That pair had nothing to collide on, because lookout_shoals_lake carries a slug: fallback
    instead of an id -- and 150 of the 454 waters are in that state. An id check cannot see a
    third of the registry. Two slugs describing one water always describe overlapping ground.

SPEED
    The measurement lives in geomcore.py, which uses shapely when it is installed (exact polygon
    intersection in C) and falls back to grid sampling in numpy. registry/boundaries holds 275 MB
    of geojson and the largest single water is 8.3 MB, over 200,000 edges; the first version of
    this ray-cast that in pure Python and was unusable. Pass --engine numpy to force the fallback.

HOW TO READ THE OUTPUT
    a_in_b / b_in_a are percentages OF EACH POLYGON'S OWN AREA that the two share.
      both near 100                -> the same outline twice
      one near 100, the other low  -> the first is a PARTIAL trace of the second; keep the second
      both middling                -> neighbours sharing a shoreline, probably distinct

    Reads only. It never edits lake_index.json. --json saves the findings for the deletion tab.
"""
import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import geomcore  # noqa: E402

REGISTRY_REL = 'registry/lake_index.json'
BOUNDS_REL = 'registry/boundaries'


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
    """Same rule as build_water_chain.py: the registry holds gnis:988007 and gnis:988007.0."""
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


def boxes_overlap(a, b, pad=0.0):
    """bounds_wsen = [west, south, east, north]. Overlap as a fraction of the smaller box."""
    if not a or not b or len(a) != 4 or len(b) != 4:
        return 0.0
    aw, as_, ae, an = a[0] - pad, a[1] - pad, a[2] + pad, a[3] + pad
    bw, bs, be, bn = b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad
    ow, os_, oe, on = max(aw, bw), max(as_, bs), min(ae, be), min(an, bn)
    if oe <= ow or on <= os_:
        return 0.0
    small = min((ae - aw) * (an - as_), (be - bw) * (bn - bs))
    return 0.0 if small <= 0 else ((oe - ow) * (on - os_)) / small


def rings_of(path):
    g = json.loads(Path(path).read_text(encoding='utf-8'))
    polys = []

    def take(geom):
        if not geom:
            return
        t = geom.get('type')
        c = geom.get('coordinates')
        if t == 'Polygon':
            polys.append(c)
        elif t == 'MultiPolygon':
            polys.extend(c)
        elif t == 'GeometryCollection':
            for sub in geom.get('geometries', []):
                take(sub)

    if g.get('type') == 'FeatureCollection':
        for f in g.get('features', []):
            take(f.get('geometry'))
    elif g.get('type') == 'Feature':
        take(g.get('geometry'))
    else:
        take(g)
    return polys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', default=None)
    ap.add_argument('--pad', type=float, default=0.0,
                    help='degrees to widen each bbox before pairing')
    ap.add_argument('--min-box', type=float, default=0.25,
                    help='bbox overlap fraction needed to bother loading geometry')
    ap.add_argument('--engine', choices=['shapely', 'numpy', 'python'], default=None)
    ap.add_argument('--json', default=None, help='write findings here')
    args = ap.parse_args()

    engine, _ = geomcore.pick_engine(args.engine)
    print(f'geometry engine: {engine}'
          + ('' if engine == 'shapely' else
             '   (install shapely for an exact, much faster run)'))

    root = find_repo_root(args.registry)
    reg_path = Path(args.registry) if args.registry else root / REGISTRY_REL
    if not reg_path.exists():
        print(f'registry not found: {reg_path}')
        return 2
    reg = json.loads(reg_path.read_text(encoding='utf-8'))
    bounds_dir = root / BOUNDS_REL
    print(f'registry: {reg_path}\nwaters: {len(reg)}')

    # ---- 1. GNIS collisions: the half an id check can see ---------------------------------
    by_gnis = {}
    for slug, row in reg.items():
        g = normalize_gnis(row.get('gnis'))
        if g:
            by_gnis.setdefault(g, []).append(slug)
    gnis_dupes = {g: s for g, s in by_gnis.items() if len(s) > 1}
    print(f'\n== 1. same GNIS id under more than one slug: {len(gnis_dupes)}')
    for g, slugs in sorted(gnis_dupes.items()):
        print(f'   gnis {g}: {", ".join(slugs)}')
    if not gnis_dupes:
        print('   none')

    # ---- 2. geometry: the half it cannot -------------------------------------------------
    slugs = [s for s in reg if reg[s].get('bounds_wsen')]
    total_pairs = len(slugs) * (len(slugs) - 1) // 2
    print(f'\n== 2. pairing {len(slugs)} waters with a bbox ({total_pairs} possible pairs)')
    cand = []
    for i in range(len(slugs)):
        bi = reg[slugs[i]]['bounds_wsen']
        for k in range(i + 1, len(slugs)):
            f = boxes_overlap(bi, reg[slugs[k]]['bounds_wsen'], args.pad)
            if f >= args.min_box:
                cand.append((f, slugs[i], slugs[k]))
    cand.sort(reverse=True)
    need = sorted({s for _, a, b in cand for s in (a, b)})
    mb = sum((bounds_dir / f'{s}.geojson').stat().st_size
             for s in need if (bounds_dir / f'{s}.geojson').exists()) / 1048576
    print(f'   bbox overlap >= {args.min_box}: {len(cand)} pairs, '
          f'{len(need)} distinct waters, {mb:.0f} MB of geometry to read')

    cache = {}

    def polys(slug):
        if slug not in cache:
            p = bounds_dir / f'{slug}.geojson'
            cache[slug] = rings_of(p) if p.exists() else []
        return cache[slug]

    findings = []
    t0 = time.time()
    for idx, (frac, a, b) in enumerate(cand, 1):
        if idx % 25 == 0 or idx == len(cand):
            el = time.time() - t0
            rate = idx / el if el > 0 else 0
            left = (len(cand) - idx) / rate if rate > 0 else 0
            print(f'   ...{idx}/{len(cand)} pairs, {el:.0f}s elapsed, ~{left:.0f}s left',
                  flush=True)
        pa, pb = polys(a), polys(b)
        if not pa or not pb:
            continue
        a_in_b, b_in_a, ratio, sep, ar_a, ar_b = geomcore.measure(engine, pa, pb)
        big = reg[a if ar_a >= ar_b else b].get('bounds_wsen') or [0, 0, 1, 1]
        diag = (((big[2] - big[0]) ** 2 + (big[3] - big[1]) ** 2) ** 0.5) or 1.0
        sep_frac = None if sep is None else sep / diag
        v = geomcore.verdict(a_in_b, b_in_a, ratio, sep_frac)
        if v == 'touching only, probably distinct':
            continue
        findings.append({
            'a': a, 'b': b, 'bbox_overlap': round(frac, 3),
            'a_in_b_pct': round(a_in_b, 1), 'b_in_a_pct': round(b_in_a, 1),
            'area_ratio': round(ratio, 4),
            'centroid_sep': None if sep_frac is None else round(sep_frac, 4),
            'a_acres': reg[a].get('area_acres'), 'b_acres': reg[b].get('area_acres'),
            'a_gnis': reg[a].get('gnis'), 'b_gnis': reg[b].get('gnis'),
            'a_charted': reg[a].get('charted'), 'b_charted': reg[b].get('charted'),
            'a_county': reg[a].get('county'), 'b_county': reg[b].get('county'),
            'a_type': reg[a].get('feature_type'), 'b_type': reg[b].get('feature_type'),
            'verdict': v,
        })

    findings.sort(key=lambda f: -(f['a_in_b_pct'] + f['b_in_a_pct']))
    print(f'\n== 3. {len(findings)} pair(s) worth your eye  '
          f'({time.time() - t0:.0f}s of measuring)\n')
    for f in findings:
        print(f'   {f["verdict"]}')
        print(f'     {f["a"]:<30} {str(f["a_acres"]):>10} ac  {str(f["a_gnis"]):<28}'
              f' charted {f["a_charted"]}  {f["a_county"]}  {f["a_type"]}')
        print(f'     {f["b"]:<30} {str(f["b_acres"]):>10} ac  {str(f["b_gnis"]):<28}'
              f' charted {f["b_charted"]}  {f["b_county"]}  {f["b_type"]}')
        print(f'     they share {f["a_in_b_pct"]}% of the first and {f["b_in_a_pct"]}%'
              f' of the second; areas agree {100 * f["area_ratio"]:.1f}%\n')
    if not findings:
        print('   none')

    if args.json:
        Path(args.json).write_text(json.dumps(
            {'engine': engine, 'gnis_collisions': gnis_dupes, 'geometry_overlaps': findings},
            indent=1), encoding='utf-8')
        print(f'wrote {args.json}')
    print('\nNothing was edited. Every call above is a read.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
