#!/usr/bin/env python3
r"""install_registry_boundary.py - put an extracted boundary into the registry so a lake
can actually be built.

Personal use only, not for distribution or resale; not for navigation.

    py .\install_registry_boundary.py `
       --registry   "F:\TrollMapPipeline\registry" `
       --boundaries "F:\TrollMapPipeline\lake_boundaries" `
       --labels     "F:\TrollMapPipeline\extract\labels" `
       --lake high_rock_lake --lake blewett_falls_lake --state NC
    # ... reads back what it would change, changes nothing. Then:
    py .\install_registry_boundary.py ... --go

WHY THIS EXISTS

`trollmap_nhd_boundaries.py` writes `lake_boundaries/<slug>_nhd.geojson` and stops there.
Nothing downstream reads that folder. The chartpack builder reads three other things:

    registry/boundaries/<slug>.geojson   the polygon it clips against
    registry/lakes.json                  name, state, bounds, area
    registry/tile_lake_map.json          by_lake -> which GMP tiles to decode

and the third is a hard gate: `todo = {s for s in by_lake if s in meta}`. A lake missing
from `by_lake` is not skipped with a reason, it is never considered. So an extracted
boundary sitting in `lake_boundaries/` looks like progress and builds nothing.

That gap is why High Rock Lake and Blewett Falls Lake could be lost. They exist in the
registry only as part of the combined `yadkin_river_chain` R2 key, because 3DHP names Badin
and Tillery but not those two -- `lakes.json` has no record for either. When the chain key
was pruned on 2026-08-03 there was nothing left: no registry row, no boundary, no tile
mapping, and a 15,000-acre reservoir went from served to absent with no error anywhere.

WHAT IT DOES NOT DO

It does not touch `lake_index.json` or `charted.json`. `consolidate_lake_index.py` rebuilds
the index from `lakes.json` plus access, and `charted` is measured by the build, not
declared here. Writing either by hand would be inventing a number.

AREA

Areas are computed by the spherical excess formula rather than read from the source
attributes, because `lakes.json` areas came from 3DHP and NHD's `AreaSqKm` is computed on a
different footprint. Two areas from two authorities in one column is how a sort order stops
meaning anything. At these latitudes the formula is within ~0.05% of a geodesic area.
"""
import argparse, json, math, os, shutil, sys


# --------------------------------------------------------------------------- geometry

def _rings(geom):
    """Every ring in a Polygon or MultiPolygon, as (coords, is_hole) pairs."""
    if not geom:
        return
    t = geom.get('type')
    if t == 'Polygon':
        polys = [geom.get('coordinates') or []]
    elif t == 'MultiPolygon':
        polys = geom.get('coordinates') or []
    else:
        return
    for poly in polys:
        for i, ring in enumerate(poly or []):
            if ring and len(ring) >= 4:
                yield ring, (i > 0)


def _parts(geom):
    """Polygon parts, not rings -- a lake with 4 basins and 9 islands has 4 parts."""
    if not geom:
        return 0
    t = geom.get('type')
    if t == 'Polygon':
        return 1
    if t == 'MultiPolygon':
        return len(geom.get('coordinates') or [])
    return 0


def ring_area_km2(ring):
    """Spherical excess. Returns a signed-free (absolute) area in km^2."""
    R = 6371.0088
    total = 0.0
    for i in range(len(ring) - 1):
        lon1, lat1 = math.radians(ring[i][0]), math.radians(ring[i][1])
        lon2, lat2 = math.radians(ring[i + 1][0]), math.radians(ring[i + 1][1])
        total += (lon2 - lon1) * (2 + math.sin(lat1) + math.sin(lat2))
    return abs(total * R * R / 2.0)


def measure(geoms):
    """area_km2 (holes subtracted), bounds_wsen, area-weighted centroid, part count."""
    area = 0.0
    w = s = float('inf')
    e = n = float('-inf')
    parts = 0
    cx = cy = 0.0
    # Separate from `area`, which has holes subtracted out of it. Dividing the outer-ring
    # moment sum by the holed area inflates the result -- on the test lake that put the
    # centroid a full degree northwest of the polygon's own bounding box, outside the water
    # and outside the state. The centroid feeds the county lookup that names the lake, so a
    # wrong one is a wrongly-named lake, not just a cosmetic slip.
    moment_area = 0.0
    ring_centroids = []
    for g in geoms:
        parts += _parts(g)
        for ring, is_hole in _rings(g):
            a = ring_area_km2(ring)
            area += (-a if is_hole else a)
            if is_hole:
                continue
            moment_area += a
            ring_centroids.append((sum(p[0] for p in ring) / len(ring),
                                   sum(p[1] for p in ring) / len(ring)))
            # Centroid of the ring's own bbox, weighted by ring area. A true polygon
            # centroid on a multipart lake can land on dry ground between two arms; this
            # is only used for display and for the county lookup, and it stays in-bounds.
            rw = min(p[0] for p in ring); re_ = max(p[0] for p in ring)
            rs = min(p[1] for p in ring); rn = max(p[1] for p in ring)
            cx += a * (rw + re_) / 2.0
            cy += a * (rs + rn) / 2.0
            w, e = min(w, rw), max(e, re_)
            s, n = min(s, rs), max(n, rn)
    if not parts or area <= 0 or moment_area <= 0 or w == float('inf'):
        return None

    # TWO LAKES WITH ONE NAME MUST NOT BECOME ONE LAKE.
    #
    # 2026-08-08. `evans_lake` held two polygons 289 km apart -- one near Tifton, one near
    # Athens. Two different Georgia waters sharing a GNIS name, merged into a single 33-acre row
    # claiming a 2,014,458-acre bounding box, mapped to five tiles, and cut into one pack from
    # both. Blair Pond (60 ac, 102 km) and Whiddons Millpond (50 ac, 95 km) are the same failure.
    #
    # A lake in several pieces is NORMAL -- 3DHP stores Kentucky Lake as 6 polygons spread over
    # 101 km. So the test is separation against the square root of the water's OWN area, which
    # asks "could this water plausibly span that far" rather than "is it in more than one piece".
    # Kentucky Lake scores 4.2x its own root and passes; Evans Lake scores 780x.
    #
    # Refused rather than trimmed, for the same reason the centroid assertion below refuses: the
    # right answer is two rows with county-distinct names, and only the caller can decide which
    # piece is which lake. Writing a plausible-looking wrong boundary is the failure mode this
    # whole function is built to avoid.
    if len(ring_centroids) >= 2:
        _lim = max(5.0, 25.0 * math.sqrt(area))
        _far = 0.0
        for _i, _a in enumerate(ring_centroids):
            for _b in ring_centroids[_i + 1:]:
                _d = math.hypot((_b[1] - _a[1]) * 110.574,
                                (_b[0] - _a[0]) * 111.320 * math.cos(math.radians((_a[1] + _b[1]) / 2)))
                _far = max(_far, _d)
        if _far > _lim:
            raise AssertionError(
                'boundary parts %.0f km apart but this water is only %.1f km2 (limit %.0f km) -- '
                'these are almost certainly two different waters sharing a name. Split them into '
                'separate slugs with county-distinct names rather than installing the merge.'
                % (_far, area, _lim))
    lon, lat = cx / moment_area, cy / moment_area
    # A weighted mean of in-bounds points cannot leave the bounds. If it has, the weights
    # and the divisor have come from different sets again -- fail loudly rather than write
    # a plausible-looking wrong coordinate into the registry.
    if not (w <= lon <= e and s <= lat <= n):
        raise AssertionError('centroid %r outside bounds %r' % ([lon, lat], [w, s, e, n]))
    return {
        'area_km2': round(area, 4),
        'bounds_wsen': [round(w, 6), round(s, 6), round(e, 6), round(n, 6)],
        'centroid': [round(lon, 6), round(lat, 6)],
        'parts': parts,
    }


# --------------------------------------------------------------------------- inputs

def read_source(bdir, slug):
    """<slug>_nhd.geojson preferred, then _lake, then _3dhp, then _river, then _zone.

    `_lake` is make_river_boundaries.py --lakes: the same ramp-ownership and connected-growth
    machinery the rivers use, pointed at featuretype 3 as well as 1/2. It ranks ABOVE `_3dhp`
    on purpose. A raw `_3dhp` dump for one of these lakes is not a boundary -- Reidsville's is
    1,357 polygons over 8,664 acres for a 750 acre lake -- while `_lake` is that same source
    after a surveyed ramp has decided which fragments are actually the lake. If the dump
    outranked the cut version, installing would quietly undo the work.

    `_river` is make_river_boundaries.py's output: a real 3DHP polygon, cut to the water one
    name's landings reach and clipped out of the coastal zones. It ranks with `_3dhp` because
    that is what it is made of. It was missing from this list entirely, so every one of the 76
    river boundaries reported NO SOURCE and the "next: install them" line the cutter prints
    could never have worked.

    `_zone` is a coastal REGION rectangle from make_coastal_boundaries.py, not a surveyed
    waterbody outline. It is last because a real polygon should always win, and it exists at
    all because the 21 coastal zones are selectable in the app with no registry row behind
    them -- 48,696 Garmin docks decoded and nothing clipping them.
    """
    for suffix, origin in (('_nhd', 'NHD'), ('_lake', '3DHP-LAKE'), ('_3dhp', '3DHP'),
                           ('_river', '3DHP-RIVER'), ('_zone', 'ZONE-BBOX')):
        fp = os.path.join(bdir, slug + suffix + '.geojson')
        if os.path.exists(fp):
            gj = json.load(open(fp, encoding='utf-8'))
            feats = (gj.get('features') or []) if gj.get('type') == 'FeatureCollection' else [gj]
            return fp, origin, feats
    return None, None, None


def lake_id_from(feats, slug):
    """Carry the source identifier through so the row can be traced back."""
    for f in feats:
        p = f.get('properties') or {}
        for k in ('GNIS_ID', 'gnis_id', 'GNISIDValue', 'gnisid'):
            v = p.get(k)
            if v not in (None, '', 0, '0'):
                return 'gnis:%s' % str(v).strip()
    for f in feats:
        p = f.get('properties') or {}
        for k in ('Permanent_Identifier', 'permanent_identifier', 'PermanentIdentifier'):
            v = p.get(k)
            if v:
                return 'nhd:%s' % str(v).strip()
    return 'slug:%s' % slug


def source_name(feats):
    for f in feats:
        p = f.get('properties') or {}
        for k in ('GNIS_Name', 'gnis_name', 'GNIS_NAME', 'name'):
            v = p.get(k)
            if v and str(v).strip():
                return str(v).strip()
    return None


def flatten2d(geom):
    """Drop Z from every coordinate.

    NHDPlus HR geometry is 3D -- NHDWaterbody carries an elevation on every vertex -- and
    geopandas writes it straight through, so `trollmap_nhd_boundaries.py` output has
    [lon, lat, z] rings. Every boundary that reached the registry before 2026-08-04 came from
    the 3DHP cutter, which is 2D, so nothing downstream had ever seen a third ordinate.
    `build_chartpack.build_mask` unpacks `for px, py in ring` and dies with
    "too many values to unpack (expected 2, got 3)" -- at mask-build time, after the run has
    already merged the report, so it takes the whole build down rather than one lake.

    Stripping here rather than tolerating it downstream: the registry boundary is also what
    the app fetches as {slug}/boundary.geojson, and a Z it can never use is bytes over the
    wire on every lake selection.
    """
    if not geom:
        return geom

    def walk(c):
        if not c:
            return c
        if isinstance(c[0], (int, float)):
            return [c[0], c[1]]
        return [walk(x) for x in c]

    g = dict(geom)
    g['coordinates'] = walk(geom.get('coordinates') or [])
    return g


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--boundaries', required=True, help='folder holding <slug>_nhd.geojson')
    ap.add_argument('--labels', help='extract/labels, for _bounds_cache.json. Without it '
                                     'tile_lake_map.json is left alone and the lake will not '
                                     'build until you re-run tile_lake_map.py.')
    ap.add_argument('--lake', action='append', default=[],
                    help='slug, repeatable. `slug=NC` overrides --state for that one.')
    ap.add_argument('--from-tsv',
                    help='a TSV with slug/name/state/acres columns -- e.g. '
                         'outputs/batch_cut_manifest.tsv. Equivalent to one --lake and one '
                         '--name per row, and the only practical route past a few dozen: '
                         'cut_boundaries_batch.py produced 127 in one run, which is 254 flags '
                         'on a single command line. Combines with --lake.')
    ap.add_argument('--state', help='two-letter state for lakes that do not carry their own')
    ap.add_argument('--name', action='append', default=[],
                    help='slug=Display Name, if the source GNIS name is wrong or absent')
    ap.add_argument('--go', action='store_true', help='actually write. Default is a dry run.')
    a = ap.parse_args()

    # --from-tsv folds into the same two lists the flags fill, so every downstream code path
    # stays identical whether the caller typed the lakes or handed over a file. A parallel
    # branch for the bulk case is how the bulk case ends up behaving differently from the one
    # everybody tested.
    if a.from_tsv:
        if not os.path.exists(a.from_tsv):
            sys.exit('--from-tsv %s not found' % a.from_tsv)
        import csv as _csv
        n = 0
        with open(a.from_tsv, encoding='utf-8') as fh:
            for row in _csv.DictReader(fh, delimiter='\t'):
                slug = (row.get('slug') or '').strip()
                if not slug:
                    continue
                st = (row.get('state') or '').strip()
                a.lake.append('%s=%s' % (slug, st) if st else slug)
                nm = (row.get('name') or '').strip()
                # A name equal to the slug carries nothing -- that is what
                # cut_boundaries_batch.py writes for water nobody named. Let the source's own
                # GNIS name (or the slug) stand rather than overriding it with itself.
                if nm and nm != slug:
                    a.name.append('%s=%s' % (slug, nm))
                n += 1
        print('--from-tsv %s: %d lakes' % (a.from_tsv, n))
    if not a.lake:
        sys.exit('nothing to do: pass --lake and/or --from-tsv')

    reg = a.registry
    lakes_fp = os.path.join(reg, 'lakes.json')
    names_fp = os.path.join(reg, 'slug_names.json')
    map_fp = os.path.join(reg, 'tile_lake_map.json')
    bdir_out = os.path.join(reg, 'boundaries')

    for fp in (lakes_fp, names_fp):
        if not os.path.exists(fp):
            sys.exit('missing %s' % fp)

    lakes_doc = json.load(open(lakes_fp, encoding='utf-8'))
    names_doc = json.load(open(names_fp, encoding='utf-8'))
    map_doc = json.load(open(map_fp, encoding='utf-8')) if os.path.exists(map_fp) else None

    overrides = {}
    for spec in a.name:
        if '=' in spec:
            k, v = spec.split('=', 1)
            overrides[k.strip()] = v.strip()

    # tile bounds, for the by_lake patch
    B = None
    if a.labels:
        cache = os.path.join(a.labels, '_bounds_cache.json')
        if os.path.exists(cache):
            B = {k: tuple(v) for k, v in json.load(open(cache, encoding='utf-8')).items()}
            print('bounds cache: %d tiles' % len(B))
        else:
            print('!! no _bounds_cache.json in %s -- run tile_lake_map.py once to build it'
                  % a.labels)

    by_slug = {x['slug']: x for x in lakes_doc['lakes']}
    plan = []

    for spec in a.lake:
        slug, _, st = spec.partition('=')
        slug = slug.strip()
        state = (st or a.state or '').strip().upper()

        fp, origin, feats = read_source(a.boundaries, slug)
        if not feats:
            print('  %-24s NO SOURCE -- looked for %s_{nhd,lake,3dhp,river,zone}.geojson in %s'
                  % (slug, slug, a.boundaries))
            continue

        m = measure([f.get('geometry') for f in feats])
        if not m:
            print('  %-24s source has no usable polygon (%d features)' % (slug, len(feats)))
            continue

        existing = by_slug.get(slug)
        if not state:
            state = (existing or {}).get('state') or ''
        if not state:
            print('  %-24s no state -- pass --state XX or %s=XX' % (slug, slug))
            continue

        name = (overrides.get(slug) or (existing or {}).get('name')
                or source_name(feats) or slug.replace('_', ' ').title())

        # A zone rectangle is not a reservoir, and neither is a river. Both say so in their
        # own properties; read it for either rather than defaulting 76 rivers to "Reservoir".
        kind = (feats[0].get('properties') or {}).get('kind')
        row = {
            'slug': slug,
            'lake_id': (existing or {}).get('lake_id') or lake_id_from(feats, slug),
            'name': name,
            'feature_type': ('Coastal Zone' if kind == 'coastal_zone'
                             else 'River' if kind == 'river'
                             else (existing or {}).get('feature_type') or 'Reservoir'),
            'area_km2': m['area_km2'],
            'parts': m['parts'],
            'bounds_wsen': m['bounds_wsen'],
            'centroid': m['centroid'],
            'state': state,
            'states': [state],
            # Coastal zone names already carry their state -- "Santee River Delta / North
            # Inlet, SC" -- and appending it again gives "..., SC, SC" in the picker.
            'display_name': (name if name.rstrip().upper().endswith(', ' + state)
                             else '%s, %s' % (name, state)),
        }

        tiles = None
        if B is not None:
            w, s, e, n = m['bounds_wsen']
            tiles = sorted(t for t, (tw, ts, te, tn) in B.items()
                           if not (e < tw or w > te or n < ts or s > tn))

        acres = m['area_km2'] * 247.105381
        verb = 'UPDATE' if existing else 'ADD   '
        print('  %s %-24s %-30s %s  %8.1f ac  %d part(s)  %s'
              % (verb, slug, name, state, acres, m['parts'], origin))
        print('         bounds %s' % (m['bounds_wsen'],))
        if tiles is not None:
            print('         tiles  %d: %s%s' % (len(tiles), ', '.join(tiles[:8]),
                                                ' ...' if len(tiles) > 8 else ''))
            if not tiles:
                print('         !! no tile covers this lake -- it would land in orphans '
                      'and still not build')
        plan.append((slug, row, fp, feats, tiles, acres))

    if not plan:
        sys.exit('\nnothing to install')

    if not a.go:
        print('\nDRY RUN -- nothing written. Add --go.')
        return

    os.makedirs(bdir_out, exist_ok=True)
    for fp in (lakes_fp, names_fp, map_fp):
        if fp and os.path.exists(fp) and not os.path.exists(fp + '.bak'):
            shutil.copy2(fp, fp + '.bak')
            print('backup -> %s.bak' % os.path.basename(fp))

    for slug, row, src, feats, tiles, acres in plan:
        # boundary: every part, as a FeatureCollection. load_boundary() takes all features.
        out = {'type': 'FeatureCollection',
               'features': [{'type': 'Feature',
                             'properties': {'slug': slug, 'source': os.path.basename(src)},
                             'geometry': flatten2d(f.get('geometry'))}
                            for f in feats if f.get('geometry')]}
        dst = os.path.join(bdir_out, slug + '.geojson')
        json.dump(out, open(dst, 'w', encoding='utf-8'))
        print('boundary -> %s (%d features)' % (dst, len(out['features'])))

        if slug in by_slug:
            by_slug[slug].update(row)
        else:
            lakes_doc['lakes'].append(row)
            by_slug[slug] = row

        names_doc[slug] = {'n': row['name'], 's': row['state'],
                           'c': row['centroid'], 'a': round(acres, 1)}

        if map_doc is not None and tiles is not None:
            map_doc['by_lake'][slug] = tiles
            for t, lst in map_doc.get('by_tile', {}).items():
                if slug in lst and t not in tiles:
                    lst.remove(slug)
            for t in tiles:
                lst = map_doc.setdefault('by_tile', {}).setdefault(t, [])
                if slug not in lst:
                    lst.append(slug)
                    lst.sort()
            orph = map_doc.setdefault('orphans', [])
            if not tiles and slug not in orph:
                orph.append(slug)
            elif tiles and slug in orph:
                orph.remove(slug)

    # lakes.json is ordered by area, largest first. Re-sort so an appended row lands where
    # a reader expects it rather than at the bottom.
    lakes_doc['lakes'].sort(key=lambda x: (-(x.get('area_km2') or 0), x['slug']))
    lakes_doc['count'] = len(lakes_doc['lakes'])

    bs = {}
    for x in lakes_doc['lakes']:
        bs.setdefault(x.get('state') or '??', []).append(x['slug'])
    order = list(lakes_doc.get('state_order') or [])
    for st_ in bs:
        if st_ not in order:
            order.append(st_)
    lakes_doc['state_order'] = [st_ for st_ in order if st_ in bs]
    lakes_doc['by_state'] = {st_: sorted(bs[st_]) for st_ in lakes_doc['state_order']}

    json.dump(lakes_doc, open(lakes_fp, 'w', encoding='utf-8'), indent=1)
    json.dump(names_doc, open(names_fp, 'w', encoding='utf-8'), indent=1)
    print('lakes.json  -> %d lakes' % lakes_doc['count'])
    print('slug_names.json -> %d' % len(names_doc))
    if map_doc is not None:
        json.dump(map_doc, open(map_fp, 'w', encoding='utf-8'), indent=1)
        print('tile_lake_map.json -> by_lake %d' % len(map_doc['by_lake']))
    else:
        print('!! tile_lake_map.json NOT updated -- these lakes will not build until you '
              're-run tile_lake_map.py')

    print('\nnext: build just these lakes\n'
          '  py .\\build_all_chartpacks.py ... --only-lakes "%s"'
          % ','.join(s for s, *_ in plan))


if __name__ == '__main__':
    main()
