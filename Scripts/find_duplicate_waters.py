#!/usr/bin/env python3
"""
find_duplicate_waters.py -- find registry waters that are the same water under two slugs.

WHY
    build_water_chain.py caught john_h_moss_lake / kings_mountain_reservoir because they share
    a GNIS id. It completely missed lake_lookout / lookout_shoals_lake, which Ryan settled with
    one search: Lookout Shoals Lake is the official name and "Lake Lookout" is what locals call
    it. That pair had nothing to collide on, because one of them carries a slug: fallback
    instead of an id -- and 150 of the 454 waters are in that state.

    So a GNIS collision check finds only the easy half. Geometry finds both, because two slugs
    describing one water necessarily describe overlapping ground.

HOW
    1. Pre-filter on bounds_wsen straight out of lake_index.json -- cheap, no file reads, and it
       throws away almost all of the 102,831 possible pairs.
    2. For survivors, load the two boundary polygons and measure containment BOTH WAYS by
       ray-casting each ring's vertices against the other. Direction matters: a partial trace
       sits mostly inside the full one while the full one sits mostly outside it, which is
       exactly the lake_lookout signature and tells you WHICH ENTRY TO KEEP.
    3. Report. Never edit. This writes no registry change and deletes nothing.

WHAT THE NUMBERS MEAN
    a_in_b near 100 and b_in_a near 100  -> the same polygon twice
    a_in_b high, b_in_a low              -> a is a PARTIAL trace of b; keep b, move a's gnis id
    both middling                        -> neighbours sharing a shoreline, probably NOT dupes
    Reads only. Add --json <path> to save the findings for the deletion tab.
"""
import argparse
import json
import sys
from pathlib import Path

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
    """bounds_wsen = [west, south, east, north]. Returns overlap area as a fraction of the
    smaller box, or 0.0. pad widens both boxes to catch traces that just miss touching."""
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
    """Outer rings and holes from a geojson of any shape. Returns [[outer, *holes], ...]."""
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


def point_in_ring(x, y, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y):
            dy = yj - yi
            if dy and x < (xj - xi) * (y - yi) / dy + xi:
                inside = not inside
        j = i
    return inside


def point_in_polys(x, y, polys):
    for p in polys:
        if not p:
            continue
        if point_in_ring(x, y, p[0]) and not any(point_in_ring(x, y, h) for h in p[1:]):
            return True
    return False


def containment(a_polys, b_polys, sample=1200):
    """Percentage of a's outer vertices lying inside b. Sampled evenly when a ring is huge --
    Lake Marion has tens of thousands of vertices and every one is a full ray cast."""
    pts = [pt for p in a_polys for pt in p[0]]
    if not pts:
        return 0.0, 0
    # len // sample gives step 1 for anything under twice the cap, which is no sampling at all.
    # Pick exactly `sample` evenly spaced indices instead.
    n = len(pts)
    use = pts if n <= sample else [pts[i * n // sample] for i in range(sample)]
    hits = sum(1 for x, y, *_ in use if point_in_polys(x, y, b_polys))
    return 100.0 * hits / len(use), len(use)


def area_centroid(polys):
    """Shoelace area and area-weighted centroid, holes subtracted. Degrees squared -- fine for
    ratios and for a centroid, which is all this is used for."""
    total = 0.0
    cx = cy = 0.0
    for poly in polys:
        for k, ring in enumerate(poly):
            a2 = 0.0
            rx = ry = 0.0
            n = len(ring)
            for i in range(n):
                x1, y1 = ring[i][0], ring[i][1]
                x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
                cross = x1 * y2 - x2 * y1
                a2 += cross
                rx += (x1 + x2) * cross
                ry += (y1 + y2) * cross
            a = a2 / 2.0
            if a == 0:
                continue
            sign = -1.0 if k else 1.0        # ring 0 is the outer boundary, the rest are holes
            total += sign * abs(a)
            cx += sign * abs(a) * (rx / (3.0 * a2))
            cy += sign * abs(a) * (ry / (3.0 * a2))
    if total == 0:
        return 0.0, None, None
    return abs(total), cx / total, cy / total


def verdict(a_in_b, b_in_a, area_ratio=None, centroid_sep=None):
    """area_ratio: smaller polygon area / larger, from the geometry itself, 1.0 when equal.
    centroid_sep: distance between centroids as a fraction of the larger polygon's diameter.

    Containment alone CANNOT recognise two copies of the same outline. Every vertex of one lies
    exactly on the other's boundary, where a ray cast is a coin toss, so identical polygons score
    near 50/50 rather than 100/100 -- which is what the real john_h_moss / kings_mountain pair
    scored (48.7 and 50.5) and why an earlier threshold called a certain duplicate 'distinct'.
    Area and centroid are unambiguous there, so they decide that case and containment decides the
    partial-trace case, where the two shapes genuinely differ."""
    same_size = area_ratio is not None and area_ratio >= 0.97
    same_place = centroid_sep is not None and centroid_sep <= 0.02
    if same_size and same_place:
        return 'SAME POLYGON TWICE'
    if a_in_b >= 70 and b_in_a < 40:
        return 'A IS A PARTIAL TRACE OF B -- keep B'
    if b_in_a >= 70 and a_in_b < 40:
        return 'B IS A PARTIAL TRACE OF A -- keep A'
    if a_in_b >= 40 and b_in_a >= 40:
        return 'heavy overlap, look at it'
    return 'touching only, probably distinct'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', default=None)
    ap.add_argument('--pad', type=float, default=0.0,
                    help='degrees to widen each bbox before pairing (default 0)')
    ap.add_argument('--min-box', type=float, default=0.25,
                    help='bbox overlap fraction needed to bother loading geometry')
    ap.add_argument('--json', default=None, help='write findings here')
    args = ap.parse_args()

    root = find_repo_root(args.registry)
    reg_path = Path(args.registry) if args.registry else root / REGISTRY_REL
    if not reg_path.exists():
        print(f'registry not found: {reg_path}')
        return 2
    reg = json.loads(reg_path.read_text(encoding='utf-8'))
    bounds_dir = root / BOUNDS_REL
    print(f'registry: {reg_path}')
    print(f'waters: {len(reg)}')

    # ---- 1. GNIS collisions: the easy half, the half build_water_chain already found -------
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

    # ---- 2. geometry: the half a GNIS check cannot see ------------------------------------
    slugs = [s for s in reg if reg[s].get('bounds_wsen')]
    print(f'\n== 2. pairing {len(slugs)} waters that have a bbox '
          f'({len(slugs) * (len(slugs) - 1) // 2} possible pairs)')
    cand = []
    for i in range(len(slugs)):
        bi = reg[slugs[i]]['bounds_wsen']
        for k in range(i + 1, len(slugs)):
            f = boxes_overlap(bi, reg[slugs[k]]['bounds_wsen'], args.pad)
            if f >= args.min_box:
                cand.append((f, slugs[i], slugs[k]))
    cand.sort(reverse=True)
    print(f'   bbox overlap >= {args.min_box}: {len(cand)} pairs to measure')

    cache = {}

    def polys(slug):
        if slug not in cache:
            p = bounds_dir / f'{slug}.geojson'
            cache[slug] = rings_of(p) if p.exists() else []
        return cache[slug]

    findings = []
    for frac, a, b in cand:
        pa, pb = polys(a), polys(b)
        if not pa or not pb:
            continue
        a_in_b, na = containment(pa, pb)
        b_in_a, nb = containment(pb, pa)
        ar_a, ax, ay = area_centroid(pa)
        ar_b, bx, by = area_centroid(pb)
        ratio = (min(ar_a, ar_b) / max(ar_a, ar_b)) if max(ar_a, ar_b) > 0 else 0.0
        sep = None
        if None not in (ax, ay, bx, by):
            big = reg[a if ar_a >= ar_b else b].get('bounds_wsen') or [0, 0, 1, 1]
            diag = (((big[2] - big[0]) ** 2 + (big[3] - big[1]) ** 2) ** 0.5) or 1.0
            sep = (((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5) / diag
        v = verdict(a_in_b, b_in_a, ratio, sep)
        if v == 'touching only, probably distinct' and max(a_in_b, b_in_a) < 40:
            continue
        findings.append({
            'a': a, 'b': b, 'bbox_overlap': round(frac, 3),
            'a_in_b_pct': round(a_in_b, 1), 'b_in_a_pct': round(b_in_a, 1),
            'a_acres': reg[a].get('area_acres'), 'b_acres': reg[b].get('area_acres'),
            'a_gnis': reg[a].get('gnis'), 'b_gnis': reg[b].get('gnis'),
            'a_charted': reg[a].get('charted'), 'b_charted': reg[b].get('charted'),
            'a_county': reg[a].get('county'), 'b_county': reg[b].get('county'),
            'area_ratio': round(ratio, 4),
            'centroid_sep': None if sep is None else round(sep, 4),
            'verdict': v,
        })

    findings.sort(key=lambda f: -(f['a_in_b_pct'] + f['b_in_a_pct']))
    print(f'\n== 3. {len(findings)} pair(s) overlap enough to be worth your eye\n')
    for f in findings:
        print(f'   {f["verdict"]}')
        print(f'     {f["a"]:<30} {str(f["a_acres"]):>10} ac  {str(f["a_gnis"]):<28}'
              f' charted {f["a_charted"]}  {f["a_county"]}')
        print(f'     {f["b"]:<30} {str(f["b_acres"]):>10} ac  {str(f["b_gnis"]):<28}'
              f' charted {f["b_charted"]}  {f["b_county"]}')
        print(f'     {f["a_in_b_pct"]}% of the first sits inside the second;'
              f' {f["b_in_a_pct"]}% the other way')
        print(f'     areas agree {100 * f["area_ratio"]:.1f}%; centroids'
              f' {"n/a" if f["centroid_sep"] is None else format(100 * f["centroid_sep"], ".2f") + "% of the span apart"}\n')
    if not findings:
        print('   none')

    if args.json:
        Path(args.json).write_text(json.dumps(
            {'gnis_collisions': gnis_dupes, 'geometry_overlaps': findings}, indent=1),
            encoding='utf-8')
        print(f'wrote {args.json}')
    print('\nNothing was edited. Every call above is a read.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
