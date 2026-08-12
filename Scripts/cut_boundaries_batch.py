#!/usr/bin/env python3
r"""cut_boundaries_batch.py -- cut every boundary on the worklist in ONE pass, off the RTree.

    py .\scripts\cut_boundaries_batch.py --dry-run      # what it would cut, changes nothing
    py .\scripts\cut_boundaries_batch.py                # cut them
    py .\scripts\cut_boundaries_batch.py                # run again -- it resumes, skips done

WHY THIS EXISTS

`boundary_from_3dhp.py` cuts one boundary per run and finds its row with a full table scan,
because `id3dhp` is not indexed. Its own docstring says "this takes a few minutes." That is a
fine trade for the handful of lakes Ryan clicked in the viewer. It is not a trade at all for the
**299 standalone waters** on `outputs/unnamed_water_worklist.tsv`:

    299 x one full scan of a 60 GB GeoPackage  =  days
    299 x one RTree bbox lookup                =  minutes

**The worklist already carries a lon/lat for every row**, which is the thing a bbox query needs
and the thing `boundary_from_3dhp.py` deliberately does not ask the caller for. So the fast path
that was unavailable for a single unknown id is available for all 299 at once. Same RTree fast
path `lookup_3dhp.py` uses; `boundary_gaps.py` uses the identical query shape.

WHERE IT WRITES, AND WHY NOT registry/boundaries/

    lake_boundaries/<slug>_3dhp.geojson

**NOT into `registry/boundaries/`.** `boundary_from_3dhp.py` writes there directly and then its
closing text tells you to hand-edit `lakes.json` and `tile_lake_map.json` -- which is exactly how
Lake Robinson Greer, Lake John D. Long and Lake Cherokee ended up with boundaries on disk for a
day and no pack: the boundary looked like progress and built nothing. `install_registry_boundary.py`
already does that job properly, dry-run by default, and it reads `<slug>_3dhp.geojson` out of a
staging folder. Staging here means **one writer touches the registry** and it is the one that
knows how to.

SLUGS

Built from the name on the worklist, deduped against every slug already in `registry/lakes.json`
AND against everything cut in this run. An unnamed water falls back to `water_<id3dhp>`, which is
honest -- `lakes.json` already carries 158 rows whose `lake_id` is `slug:<slug>` rather than
`gnis:<id>`, so unnamed water is an established shape here, not a special case.

WHAT IT SKIPS, AND SAYS SO

    out of region     92 of the 427 sit in FL/VA/AL/KY. The sweep's default bbox reaches into
                      Florida; that is not a bug in the sweep, it is a reason not to work the
                      file top to bottom.
    ARMS              36 in region. An arm belongs to a pack that already exists and wants a
                      boundary UNION, not a new row -- a different job with a different tool.
                      Cutting them here would create a duplicate lake beside Hartwell.
    already cut       resumable by design. A 299-row job that cannot resume is a 299-row job
                      that gets run once and abandoned halfway.

Every skip is COUNTED and PRINTED. A batch tool that silently drops rows reads as "covered
everything" when it did not.

READ-ONLY ON THE REGISTRY. It writes only into `--stage`. Nothing here touches `lakes.json`,
`tile_lake_map.json` or `registry/boundaries/`.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import os
import re
import sqlite3
import sys
import time

REGION = {'SC', 'NC', 'GA', 'TN'}


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def slugify(name, fallback):
    s = re.sub(r'[^a-z0-9]+', '_', str(name or '').lower()).strip('_')
    # A parenthetical is a note, not a name: "(unnamed - part of McMullen Bay)" must not become
    # a slug reading `unnamed_part_of_mcmullen_bay`.
    if not s or s.startswith('unnamed') or s.startswith('next_to'):
        return fallback
    return s


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--worklist', default=os.path.join('outputs', 'unnamed_water_worklist.tsv'))
    ap.add_argument('--gpkg', default=os.path.join('3dhp_all_CONUS_20260112_GPKG',
                                                   '3dhp_all_CONUS_20260112_GPKG.gpkg'))
    ap.add_argument('--registry', default='registry')
    ap.add_argument('--stage', default='lake_boundaries',
                    help='where install_registry_boundary.py reads <slug>_3dhp.geojson from')
    ap.add_argument('--pad-km', type=float, default=1.0,
                    help='bbox padding around the worklist coordinate. The coordinate is the '
                         'polygon CENTROID, so the pad only has to reach the RTree entry, not '
                         'contain the polygon.')
    ap.add_argument('--kinds', default='STANDALONE',
                    help='comma list; ARM is deliberately not the default -- see the docstring')
    ap.add_argument('--limit', type=int, default=0, help='stop after N, for a first look')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()

    B = _load(os.path.join(here, 'boundary_from_3dhp.py'), 'b3')
    L = _load(os.path.join(here, 'lookup_3dhp.py'), 'l3')

    rows = list(csv.DictReader(open(a.worklist, encoding='utf-8'), delimiter='\t'))
    want_kinds = {k.strip().upper() for k in a.kinds.split(',')}
    known = set()
    rp = os.path.join(a.registry, 'lakes.json')
    if os.path.exists(rp):
        reg = json.load(open(rp, encoding='utf-8'))
        known = {r.get('slug') for r in (reg if isinstance(reg, list) else reg.get('lakes', []))}

    todo, skip_region, skip_kind = [], 0, 0
    for r in rows:
        if r.get('state') not in REGION:
            skip_region += 1
            continue
        kind = (r.get('kind') or '').split()[0].upper()
        if kind not in want_kinds:
            skip_kind += 1
            continue
        todo.append(r)
    todo.sort(key=lambda r: -int(r['acres']))
    if a.limit:
        todo = todo[:a.limit]

    os.makedirs(a.stage, exist_ok=True)
    print('worklist %d rows -> %d to cut' % (len(rows), len(todo)))
    print('   skipped %d out of region (FL/VA/AL/KY), %d not in %s'
          % (skip_region, skip_kind, ','.join(sorted(want_kinds))))

    con = sqlite3.connect('file:%s?mode=ro&immutable=1' % a.gpkg.replace('\\', '/'), uri=True)
    cur = con.cursor()
    try:
        cur.execute('SELECT column_name FROM gpkg_geometry_columns WHERE table_name=?',
                    ('hydro_3dhp_all_waterbody',))
        row = cur.fetchone()
        geom = row[0] if row else 'shape'
    except sqlite3.Error:
        geom = 'shape'

    used = set(known)
    done = miss = already = 0
    t0 = time.time()
    manifest = []
    for i, r in enumerate(todo, 1):
        rid, lon, lat = r['id3dhp'], float(r['lon']), float(r['lat'])
        slug = slugify(r.get('name'), 'water_%s' % rid.lower())
        base = slug
        n = 2
        while slug in used:
            slug = '%s_%d' % (base, n)
            n += 1
        out = os.path.join(a.stage, slug + '_3dhp.geojson')
        if os.path.exists(out):
            already += 1
            used.add(slug)
            continue

        # RTree bbox, in Albers, around the centroid. `albers` lives in lookup_3dhp.py -- it is
        # the FORWARD projection and is not in boundary_from_3dhp, which only ever goes the
        # other way. Looking for it in the wrong module cost a session on 2026-08-11.
        d = a.pad_km / 111.32
        pts = [L.albers(lon + dx, lat + dy) for dx in (-d, d) for dy in (-d, d)]
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        cur.execute(
            'SELECT id3dhp, gnisid, gnisidlabel, areasqkm, %s FROM hydro_3dhp_all_waterbody '
            'WHERE fid IN (SELECT id FROM rtree_hydro_3dhp_all_waterbody_shape '
            '  WHERE maxx>=? AND minx<=? AND maxy>=? AND miny<=?)' % geom,
            (min(xs), max(xs), min(ys), max(ys)))
        hit = None
        for row in cur:
            if row[0] == rid:
                hit = row
                break
        if hit is None:
            print('   MISS %-7s %-30s no RTree hit at %.5f,%.5f (widen --pad-km)'
                  % (rid, slug[:30], lon, lat))
            miss += 1
            continue

        parts, _ = B.wkb_rings(B.gpkg_wkb(hit[4]))
        parts = [p for p in parts if len(p) >= 4]
        if not parts:
            print('   MISS %-7s no usable ring' % rid)
            miss += 1
            continue
        acres = (hit[3] or 0) * 247.105
        fc = {'type': 'FeatureCollection', 'features': [{
            'type': 'Feature',
            'properties': {
                'slug': slug,
                'name': r.get('name') or hit[2] or slug,
                'state': r.get('state'),
                'source': '3dhp:%s' % hit[0],
                'gnis': ('gnis:%s' % hit[1]) if hit[1] else None,
                'area_acres': round(acres, 1),
                'name_source': r.get('name_source') or '',
                'note': r.get('note') or '',
            },
            'geometry': {'type': 'MultiPolygon', 'coordinates': [[p] for p in parts]},
        }]}
        used.add(slug)
        manifest.append((slug, r.get('name') or '', r.get('state') or '', round(acres)))
        if not a.dry_run:
            json.dump(fc, open(out, 'w', encoding='utf-8'))
        done += 1
        if i % 25 == 0 or i == len(todo):
            print('   %d/%d  cut %d, already %d, missed %d, %.0fs'
                  % (i, len(todo), done, already, miss, time.time() - t0), flush=True)

    print('\n%s%d boundaries -> %s   (%d already there, %d missed)'
          % ('[DRY RUN] ' if a.dry_run else '', done, a.stage, already, miss))
    if manifest and not a.dry_run:
        mp = os.path.join('outputs', 'batch_cut_manifest.tsv')
        os.makedirs('outputs', exist_ok=True)
        with open(mp, 'w', encoding='utf-8') as fh:
            fh.write('slug\tname\tstate\tacres\n')
            for s, n_, st, ac in manifest:
                fh.write('%s\t%s\t%s\t%d\n' % (s, n_, st, ac))
        print('-> %s' % mp)
    if manifest:
        print('\nNEXT — register them. It is a DRY RUN without --go:\n')
        print('   py .\\scripts\\install_registry_boundary.py `')
        print('      --registry registry --boundaries %s --labels extract\\labels `' % a.stage)
        for s, n_, st, ac in manifest[:4]:
            print('      --lake %s --name "%s=%s" `' % (s, s, n_ or s))
        if len(manifest) > 4:
            print('      ... one --lake and one --name per row of %s'
                  % os.path.join('outputs', 'batch_cut_manifest.tsv'))
        print('\nTHEN, and only then, ONE build over everything new.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
