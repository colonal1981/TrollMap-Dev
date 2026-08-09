#!/usr/bin/env python3
r"""
split_merged_boundaries.py — one registry row per water, when two waters share a name.

Personal use only, not for distribution or resale; not for navigation.

WHAT THIS IS FOR
----------------
2026-08-08. `check_registry_invariants.py` found four rows whose polygons cannot be one water:

    Evans Lake         GA    288 km apart    33 ac    31x over
    Blair Pond         GA    102 km apart    60 ac     8x over
    Whiddons Millpond  GA     95 km apart    50 ac     8x over
    Collum Pond        SC     11 km apart    30 ac     1.2x over   <- borderline, decide by eye

The cause is upstream and is not a bug in our builder: 3DHP hangs both Evans Lakes off ONE GNIS
record, `gnis:337284`, and the registry build groups by that id. It did exactly what it was told.

The cost is not proportional to the acreage. A merged row claims the bounding box of BOTH waters
-- Evans Lake is 33 acres inside 2,014,458 -- so it maps to five tiles it has no business on, its
pack is cut from both places at once, and its centroid lands midway between them, which is open
farmland. That centroid is also what the county lookup names the lake from, so the name is right
only by luck.

WHAT IT DOES
------------
Clusters the boundary's polygon parts by how far apart they sit, splits the row into one child per
cluster, measures each cluster on its own, and names the children apart by the county each one
actually sits in -- which is what `CountyIndex` was built for, per its own docstring: "two Forest
Lakes both in SC, four Long Ponds all in GA".

It CLUSTERS rather than splitting every part into its own row, because being in several pieces is
normal -- 3DHP stores Kentucky Lake as 6 polygons over 101 km and it is one lake. Parts within the
row's own allowed spread join up and stay together; only the pieces that cannot be the same water
become separate rows. On today's four that is a distinction without a difference, since each has
exactly two parts, but it is the correct rule and it will be right the first time a nine-part
reservoir picks up a stray pond.

The GNIS id is carried onto every child, unchanged. Two waters really do share it upstream, and
inventing ids to paper over that would break the join back to 3DHP.

    py scripts\split_merged_boundaries.py --registry F:\TrollMapPipeline\registry
    py scripts\split_merged_boundaries.py --registry ... --only evans_lake --go

DRY RUN BY DEFAULT. Nothing is written without --go, and the original boundary is moved aside
rather than deleted, because `device_bash` cannot delete and because a merge is recoverable while
a deletion is not.

AFTER RUNNING: tile_lake_map.py, then consolidate_lake_index.py, then rebuild only the new slugs.
The old slug is gone, so anything referencing it -- a saved plan, an R2 pack -- needs the new name.
`--report` writes the old -> new mapping for exactly that.
"""
from __future__ import annotations
import argparse, json, math, os, shutil, sys

ACRES_PER_KM2 = 247.105381
SPREAD_FACTOR = 25.0         # same number check_registry_invariants.py judges by
SPREAD_FLOOR_KM = 5.0


def ring_area_km2(ring):
    """Spherical excess. The same formula install_registry_boundary.py measures with."""
    R = 6371.0088
    total = 0.0
    for i in range(len(ring) - 1):
        lon1, lat1 = math.radians(ring[i][0]), math.radians(ring[i][1])
        lon2, lat2 = math.radians(ring[i + 1][0]), math.radians(ring[i + 1][1])
        total += (lon2 - lon1) * (2 + math.sin(lat1) + math.sin(lat2))
    return abs(total * R * R / 2.0)


def km(a, b):
    """a and b are [lon, lat]."""
    return math.hypot((b[1] - a[1]) * 110.574,
                      (b[0] - a[0]) * 111.320 * math.cos(math.radians((a[1] + b[1]) / 2)))


class Counties:
    """Which county a point is in. Lifted from consolidate_lake_index.py's CountyIndex."""

    def __init__(self, path):
        self.items = []
        if not os.path.exists(path):
            return
        with open(path, encoding='utf-8') as fh:
            gj = json.load(fh)
        for f in gj.get('features') or []:
            g, p = f.get('geometry') or {}, f.get('properties') or {}
            polys = ([g['coordinates']] if g.get('type') == 'Polygon'
                     else g.get('coordinates') or [])
            if not polys:
                continue
            xs = [c[0] for poly in polys for ring in poly for c in ring]
            ys = [c[1] for poly in polys for ring in poly for c in ring]
            self.items.append((min(xs), min(ys), max(xs), max(ys),
                               p.get('county'), p.get('state'), polys))

    @staticmethod
    def _in(x, y, ring):
        hit = False
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i][0], ring[i][1]
            xj, yj = ring[j][0], ring[j][1]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-18) + xi:
                hit = not hit
            j = i
        return hit

    def lookup(self, lon, lat):
        for w, s, e, n, county, st, polys in self.items:
            if lon < w or lon > e or lat < s or lat > n:
                continue
            for poly in polys:
                if not self._in(lon, lat, poly[0]):
                    continue
                if any(self._in(lon, lat, poly[k]) for k in range(1, len(poly))):
                    continue
                return county, st
        return None, None

    def lookup_any(self, candidates):
        """First candidate point that lands in a county. A pond on a county line still gets a
        name, and a bbox centre that fell in the river next door is not the last word."""
        for lon, lat in candidates:
            c, s = self.lookup(lon, lat)
            if c:
                return c, s
        return None, None


def parts_of(path):
    """Every polygon PART with its rings. Islands are rings and stay with their part."""
    with open(path, encoding='utf-8') as fh:
        doc = json.load(fh)
    out = []
    for f in (doc.get('features') or [doc]):
        g = f.get('geometry') or {}
        t = g.get('type')
        if t == 'Polygon':
            out.append(g.get('coordinates') or [])
        elif t == 'MultiPolygon':
            out.extend(g.get('coordinates') or [])
    return [p for p in out if p and p[0]]


def part_area_km2(rings):
    """Outer ring minus its holes."""
    area = 0.0
    for i, ring in enumerate(rings):
        a = ring_area_km2(ring)
        area += a if i == 0 else -a
    return max(area, 0.0)


def part_centroid(rings):
    """Vertex mean of the outer ring. For a compact pond this is inside the water, which the
    bounding-box centre is not guaranteed to be -- and the bbox centre is precisely how Evans
    Lake ended up named from a point in open farmland."""
    ring = rings[0]
    return [sum(q[0] for q in ring) / len(ring), sum(q[1] for q in ring) / len(ring)]


def measure(parts):
    """area, bounds and centroid for a CLUSTER of parts, in lakes.json's own conventions."""
    area = sum(part_area_km2(p) for p in parts)
    xs = [q[0] for p in parts for q in p[0]]
    ys = [q[1] for p in parts for q in p[0]]
    return {'area_km2': round(area, 4),
            'bounds_wsen': [round(min(xs), 6), round(min(ys), 6),
                            round(max(xs), 6), round(max(ys), 6)],
            # lakes.json stores the box centre; keep the convention so nothing downstream is
            # surprised. Within one cluster the box is tight, so this is a real place.
            'centroid': [round((min(xs) + max(xs)) / 2, 6),
                         round((min(ys) + max(ys)) / 2, 6)],
            'parts': len(parts)}


def cluster(parts, link_km):
    """Single-linkage on part centroids. Parts closer than link_km are the same water."""
    cents = [part_centroid(p) for p in parts]
    parent = list(range(len(parts)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(parts)):
        for j in range(i + 1, len(parts)):
            if km(cents[i], cents[j]) <= link_km:
                a, b = find(i), find(j)
                if a != b:
                    parent[a] = b
    groups = {}
    for i in range(len(parts)):
        groups.setdefault(find(i), []).append(i)
    # Biggest water first, so the child that keeps the plain name is the main one.
    out = [[parts[i] for i in idx] for idx in groups.values()]
    out.sort(key=lambda g: -sum(part_area_km2(p) for p in g))
    return out


def slugify(s):
    out = [ch if ch.isalnum() else '_' for ch in str(s).lower()]
    return '_'.join(x for x in ''.join(out).split('_') if x)


def compass(pt, mean):
    """Which way this cluster lies from the middle of the colliding group."""
    dx = (pt[0] - mean[0]) * math.cos(math.radians(pt[1]))
    dy = pt[1] - mean[1]
    if abs(dy) >= abs(dx):
        return 'north' if dy >= 0 else 'south'
    return 'east' if dx >= 0 else 'west'


def name_children(kids, counties):
    """County first; compass if two clusters share a county; index if even that ties.

    Two waters 100 km apart are never in one county, so the fallbacks are for the borderline
    cases only -- but they must exist, because refusing to name is the same as leaving the
    boundary merged.
    """
    for k in kids:
        m = k['m']
        pts = [tuple(k['rep']), tuple(m['centroid'])] + [tuple(p[0][0]) for p in k['parts'][:3]]
        cty, st = counties.lookup_any(pts)
        k['county'], k['county_state'], k['dir'] = cty, st, None
        k['suffix'] = slugify(cty) if cty else None

    seen = {}
    for k in kids:
        seen.setdefault(k['suffix'], []).append(k)
    for suffix, group in seen.items():
        if len(group) < 2:
            continue
        mean = [sum(k['m']['centroid'][0] for k in group) / len(group),
                sum(k['m']['centroid'][1] for k in group) / len(group)]
        for k in group:
            k['dir'] = compass(k['m']['centroid'], mean)
            k['suffix'] = '%s_%s' % (suffix, k['dir']) if suffix else k['dir']
    seen = {}
    for k in kids:
        seen.setdefault(k['suffix'], []).append(k)
    for suffix, group in seen.items():
        if len(group) < 2:
            continue
        for n, k in enumerate(group, 1):
            k['suffix'] = '%s_%d' % (suffix or 'part', n)
    return kids


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--only', help='comma list of slugs; default is every violating row')
    ap.add_argument('--spread-factor', type=float, default=SPREAD_FACTOR)
    ap.add_argument('--report', help='write the old -> new slug mapping here')
    ap.add_argument('--go', action='store_true', help='write. Default is a dry run.')
    a = ap.parse_args()

    reg = a.registry
    lakes_fp = os.path.join(reg, 'lakes.json')
    with open(lakes_fp, encoding='utf-8') as fh:
        doc = json.load(fh)
    lakes = doc['lakes']
    by_slug = {x['slug']: x for x in lakes}
    bdir = os.path.join(reg, 'boundaries')

    counties = Counties(os.path.join(reg, 'counties_500k.geojson'))
    print('counties loaded: %d' % len(counties.items))
    if not counties.items:
        print('!! no county polygons -- children would be named by coordinate. Stopping.')
        return 2

    def link_km_for(row):
        return max(SPREAD_FLOOR_KM, a.spread_factor * math.sqrt(row.get('area_km2') or 1e-4))

    cache = {}

    def parts_for(slug):
        if slug not in cache:
            fp = os.path.join(bdir, '%s.geojson' % slug)
            try:
                cache[slug] = parts_of(fp) if os.path.exists(fp) else []
            except Exception:
                cache[slug] = []
        return cache[slug]

    if a.only:
        targets = [s.strip() for s in a.only.split(',') if s.strip()]
    else:
        targets, scanned = [], 0
        for x in lakes:
            # Trust the file, not the row's `parts` count -- the two are written by different
            # steps and drifting between them is one of the things being fixed here.
            ps = parts_for(x['slug'])
            if len(ps) < 2:
                continue
            scanned += 1
            if len(cluster(ps, link_km_for(x))) > 1:
                targets.append(x['slug'])
        print('multipart rows scanned: %d' % scanned)
        print('rows whose pieces cannot be one water: %d' % len(targets))

    mapping, pending = {}, []
    for slug in targets:
        x = by_slug.get(slug)
        if not x:
            print('  !! %s is not in lakes.json' % slug)
            continue
        ps = parts_for(slug)
        if len(ps) < 2:
            print('  !! %s: boundary has %d part(s), nothing to split' % (slug, len(ps)))
            continue
        groups = cluster(ps, link_km_for(x))
        print()
        print('%s  "%s"  %.1f ac, %d part(s) -> %d water(s)'
              % (slug, x.get('name'), (x.get('area_km2') or 0) * ACRES_PER_KM2,
                 len(ps), len(groups)))
        if len(groups) < 2:
            print('   its pieces are within %.1f km of each other; leaving it alone'
                  % link_km_for(x))
            continue

        kids = [{'parts': g, 'm': measure(g), 'rep': part_centroid(
            max(g, key=part_area_km2))} for g in groups]
        name_children(kids, counties)
        for k in kids:
            k['slug'] = '%s_%s' % (slug, k['suffix'])
        if len({k['slug'] for k in kids}) != len(kids):
            print('   !! could not name the pieces apart -- skipping, needs a hand')
            continue

        children = []
        for k in kids:
            m, cty, st = k['m'], k['county'], k['county_state']
            child = dict(x)
            child.update(m)
            child['slug'] = k['slug']
            child['state'] = st or x.get('state')
            child['states'] = [st] if st else x.get('states')
            # Two waters of the same name in the SAME county would otherwise arrive in the
            # dropdown with identical labels, which is the merge bug wearing a different hat.
            # The bearing is between the two children, so it says which is which and nothing more.
            where = ('%s %s Co' % (k['dir'][0].upper(), cty) if cty and k['dir']
                     else '%s Co' % cty if cty else None)
            child['display_name'] = ('%s (%s, %s)' % (x.get('name'), where, child['state'])
                                     if where else '%s, %s' % (x.get('name'), child['state']))
            child['split_from'] = slug
            children.append((child, k['parts']))
            print('   -> %-40s %7.1f ac  %-14s %s  at %.4f, %.4f'
                  % (child['slug'], m['area_km2'] * ACRES_PER_KM2,
                     (cty or '?') + ' Co,', st or '?',
                     m['centroid'][1], m['centroid'][0]))
        mapping[slug] = [c['slug'] for c, _ in children]
        pending.append((slug, children))

    if a.go:
        for slug, children in pending:
            for child, parts in children:
                # Match what every other boundary in registry/boundaries/ looks like: a
                # FeatureCollection carrying the lakes.json row as its top-level properties,
                # one Feature per polygon part, feature properties empty. A bare Feature reads
                # fine for the mask and then writes an EMPTY PACK, because the pack writer
                # walks doc['features'].
                out = {'type': 'FeatureCollection',
                       'properties': {k: v for k, v in child.items() if k != 'split_from'},
                       'features': [{'type': 'Feature', 'properties': {},
                                     'geometry': {'type': 'Polygon', 'coordinates': p}}
                                    for p in parts]}
                out['properties']['split_from'] = slug
                with open(os.path.join(bdir, '%s.geojson' % child['slug']),
                          'w', encoding='utf-8') as fh:
                    json.dump(out, fh)
            aside = os.path.join(reg, '_split_originals')
            os.makedirs(aside, exist_ok=True)
            # Aside, not away. A merge is recoverable; a deletion is not.
            shutil.move(os.path.join(bdir, '%s.geojson' % slug),
                        os.path.join(aside, '%s.geojson' % slug))
            lakes = [y for y in lakes if y['slug'] != slug] + [c for c, _ in children]

    if a.report and mapping:
        with open(a.report, 'w', encoding='utf-8') as fh:
            json.dump(mapping, fh, indent=1)
        print('\nold -> new slug mapping written to %s' % a.report)

    if a.go and pending:
        doc['lakes'] = sorted(lakes, key=lambda y: y['slug'])
        doc['count'] = len(doc['lakes'])
        with open(lakes_fp, 'w', encoding='utf-8') as fh:
            json.dump(doc, fh)
        print('\nlakes.json rewritten: %d rows' % doc['count'])
        print('originals moved to %s' % os.path.join(reg, '_split_originals'))
        print('NOW: tile_lake_map.py, then consolidate_lake_index.py, then rebuild the new slugs.')
        print('The old slugs are gone -- check saved plans and R2 for references.')
    elif pending:
        print('\nDRY RUN. %d row(s) would become %d. Re-run with --go.'
              % (len(pending), sum(len(v) for v in mapping.values())))
    else:
        print('\nnothing to split.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
