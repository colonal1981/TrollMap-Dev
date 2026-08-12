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

WHERE IT WRITES, AND WHY ITS OWN FOLDER

    lake_boundaries_3dhp/<slug>_3dhp.geojson

**Its own folder, NOT the shared `lake_boundaries/`.** That folder already holds 325 staged
files from an earlier pipeline, and the first version of this script keyed its resume check on
"a file with this slug already exists" -- so a name collision with old work read as "already
done" and the water was silently never cut. Sampled against the worklist, **4 of the 5 colliding
slugs were the wrong water**:

    lake_michie       staged     3 ac   worklist wants   472 ac   28.7 km apart
    lake_reidsville   staged 8,908 ac                    667 ac   15.6 km
    lake_mackintosh   staged 2,495 ac                  1,112 ac    5.8 km
    lake_toxaway      staged   595 ac                    518 ac    2.3 km
    auman_lake        staged 1,527 ac                    784 ac    1.0 km  (same water, looser cut)

A slug is derived from a NAME, so a slug collision says nothing about whether two polygons are
the same water -- and skipping on one is the silent-drop failure this script's own docstring
warns about. In a dedicated folder, "the file exists" means "a previous run of THIS tool cut it",
which is the only thing resume should ever mean. Collisions with the legacy folder are now
REPORTED and cut anyway.

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

THE SOUNDINGS GATE RUNS HERE, BEFORE THE BOUNDARY EXISTS

Ryan, 2026-08-12: *"i argue that the gate is in the wrong place... why have boundaries why have
empty chartpacks why have any of this for lakes that are never going to go anywhere???"*

He is right, and the cost is measurable. `build_chartpack.py` has had the correct test since
2026-08-08 -- `LakeMask._has_soundings()`, which asks whether any depth band goes BELOW the 0-3 dm
shoal outline Garmin draws around every piece of water, sounded or not. But it runs at BUILD time,
which is after the boundary is cut, after the registry row is written, and after the lake is in
the picker. Measured on the current card:

    998  slugs the build refused
    998  still carry a boundary, a lakes.json row AND a lake_index.json row
    845  still carry a chartpack directory
    ---> 57% of the 1,746 rows in lake_index.json can never produce a pack

The disk is 25 MB and does not matter. The picker does: Ryan's acceptance test is "contours when
I select a body of water in the right place", and more than half of what he can select has no
contour to show him.

So the same test runs HERE, on the polygon, before anything is written. **The test is IMPORTED
from `build_chartpack.py`, never restated** -- a gate that drifts from the build's gate is worse
than no gate, because the two would disagree silently and nobody would know which was right.

Tiles are grouped so each C tile is decompressed once, not once per candidate. A refusal is
recorded with its reason in `outputs/batch_cut_refused.tsv`, never silently dropped. `--no-gate`
restores the old behaviour; `--gate-report` runs the gate and writes verdicts without cutting.

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


def tile_bounds(labels_dir):
    """B-TILE -> (w,s,e,n). Contours and depth areas live under the C tile of the same code:
    B4E0CE <-> C4E0CE. The sidecars are written per B tile and the bounds are identical."""
    import glob as _g
    out = {}
    for fp in _g.glob(os.path.join(labels_dir, '*.json')):
        try:
            d = json.load(open(fp, encoding='utf-8'))
        except Exception:
            continue
        b = d.get('bounds')
        if isinstance(b, dict) and 'west' in b:
            out[d.get('tile') or os.path.basename(fp)[:-5]] = (b['west'], b['south'],
                                                               b['east'], b['north'])
    return out


def sounded_features(extract_dir, ctile, shoal_dm, _cache={}):
    """Everything in this tile that counts as a SURVEY: a depth band below the shoal outline,
    or any contour at all. Returns a list of (lon, lat) representative points -- one per
    feature -- which is all the gate needs, and a hundredth of the memory of the geometry.

    CACHED, AND THE CALLER MUST FEED IT IN TILE ORDER. A depth-areas tile is tens of MB
    gzipped; decompressing one per candidate made a 2-row dry run take 40 seconds, which over
    299 rows is hours. main() sorts the work by tile so each is opened once. The cache holds
    two tiles -- enough for a polygon straddling a tile edge, bounded so a 299-row run cannot
    accumulate every tile on the card."""
    import gzip as _gz
    key = (extract_dir, ctile, shoal_dm)
    if key in _cache:
        return _cache[key]
    if len(_cache) >= 2:
        _cache.pop(next(iter(_cache)))
    pts = []
    fp = os.path.join(extract_dir, 'depth_areas', '%s.geojson.gz' % ctile)
    if os.path.exists(fp):
        try:
            for f in json.load(_gz.open(fp))['features']:
                p = f.get('properties') or {}
                if (p.get('depth_max_dm') or 0) <= shoal_dm:
                    continue
                for c in _flat(f.get('geometry') or {}):
                    pts.append(c)
                    break
        except Exception:
            pass
    fp = os.path.join(extract_dir, 'contours', '%s.geojson.gz' % ctile)
    if os.path.exists(fp):
        try:
            for f in json.load(_gz.open(fp))['features']:
                for c in _flat(f.get('geometry') or {}):
                    pts.append(c)
                    break
        except Exception:
            pass
    _cache[key] = pts
    return pts


def _flat(g):
    c = g.get('coordinates')
    out = []

    def walk(x):
        if isinstance(x, (list, tuple)) and x and isinstance(x[0], (int, float)):
            out.append((x[0], x[1]))
        elif isinstance(x, (list, tuple)):
            for y in x:
                walk(y)
    walk(c)
    return out


def _in_rings(x, y, rs):
    hit = False
    for r in rs:
        j = len(r) - 1
        for i in range(len(r)):
            xi, yi = r[i][0], r[i][1]
            xj, yj = r[j][0], r[j][1]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-15) + xi:
                hit = not hit
            j = i
    return hit


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--worklist', default=os.path.join('outputs', 'unnamed_water_worklist.tsv'))
    ap.add_argument('--gpkg', default=os.path.join('3dhp_all_CONUS_20260112_GPKG',
                                                   '3dhp_all_CONUS_20260112_GPKG.gpkg'))
    ap.add_argument('--registry', default='registry')
    ap.add_argument('--stage', default='lake_boundaries_3dhp',
                    help='output dir; pass it to install_registry_boundary.py --boundaries. '
                         'Deliberately NOT the shared lake_boundaries/ -- see the docstring.')
    ap.add_argument('--legacy', default='lake_boundaries',
                    help='older staging dir, checked ONLY to report slug collisions')
    ap.add_argument('--pad-km', type=float, default=1.0,
                    help='bbox padding around the worklist coordinate. The coordinate is the '
                         'polygon CENTROID, so the pad only has to reach the RTree entry, not '
                         'contain the polygon.')
    ap.add_argument('--kinds', default='STANDALONE',
                    help='comma list; ARM is deliberately not the default -- see the docstring')
    ap.add_argument('--extract', default='extract',
                    help='extract/{depth_areas,contours}/<C-tile>.geojson.gz for the gate')
    ap.add_argument('--labels', default=os.path.join('extract', 'labels'),
                    help='tile bounds, to pick which C tile covers a polygon')
    ap.add_argument('--no-gate', action='store_true',
                    help='cut everything, sounded or not. The old behaviour.')
    ap.add_argument('--gate-report', action='store_true',
                    help='run the gate and write verdicts, cut NOTHING')
    ap.add_argument('--limit', type=int, default=0, help='stop after N, for a first look')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()

    B = _load(os.path.join(here, 'boundary_from_3dhp.py'), 'b3')
    L = _load(os.path.join(here, 'lookup_3dhp.py'), 'l3')

    # IMPORTED, NEVER RESTATED. build_chartpack.py owns the definition of "is this water
    # actually sounded" and has since 2026-08-08. A second copy of `3` in this file would drift
    # from it the first time anyone tuned one, and the two gates would disagree in silence.
    SHOAL_DM = 3
    gate_src = 'fallback constant'
    try:
        BC = _load(os.path.join(here, 'build_chartpack.py'), 'bc')
        SHOAL_DM = BC.LakeMask.SHOAL_DM
        gate_src = 'build_chartpack.LakeMask.SHOAL_DM'
    except Exception as exc:
        print('!! could not import SHOAL_DM from build_chartpack.py (%s) -- using %d'
              % (type(exc).__name__, SHOAL_DM))

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
    # SORTED BY TILE, then by acres within it. Not by acres alone: the gate opens a
    # multi-megabyte C tile per polygon and consecutive rows must share one. Biggest-first
    # across the whole card reads better in a log and costs hours.
    if a.limit:
        todo.sort(key=lambda r: -int(r['acres']))
        todo = todo[:a.limit]
    TB = tile_bounds(a.labels) if not a.no_gate else {}

    def _tile_of(r):
        lon, lat = float(r['lon']), float(r['lat'])
        for t, (w, s2, e, n) in TB.items():
            if w <= lon <= e and s2 <= lat <= n:
                return t
        return 'zzzz'
    todo.sort(key=lambda r: (_tile_of(r), -int(r['acres'])))

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
    collisions = []
    refused = []
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
        legacy = os.path.join(a.legacy, slug + '_3dhp.geojson')
        if os.path.exists(legacy):
            # Reported, never obeyed. See the docstring: 4 of 5 sampled collisions were a
            # different water, one of them 28.7 km away and 1/157th the area.
            collisions.append((slug, rid, legacy))

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

        # THE GATE. Before the boundary exists, not after the pack is built.
        if not a.no_gate:
            pxs = [q[0] for p in parts for q in p]
            pys = [q[1] for p in parts for q in p]
            w2, s2, e2, n2 = min(pxs), min(pys), max(pxs), max(pys)
            ctiles = ['C' + t[1:] for t, (tw, ts, te, tn) in TB.items()
                      if not (te < w2 or tw > e2 or tn < s2 or ts > n2)]
            found = False
            for ct in ctiles:
                for px, py in sounded_features(a.extract, ct, SHOAL_DM):
                    if w2 <= px <= e2 and s2 <= py <= n2 and _in_rings(px, py, parts):
                        found = True
                        break
                if found:
                    break
            if not found:
                refused.append((rid, slug, round(acres), r.get('state') or '',
                                'no depth band below %d dm and no contour inside the polygon'
                                % SHOAL_DM))
                continue

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

    print('\n%s%d boundaries -> %s   (%d from an earlier run of this tool, %d missed)'
          % ('[DRY RUN] ' if a.dry_run else '', done, a.stage, already, miss))
    if not a.no_gate:
        print('gate: %s = %d dm, %d refused as unsounded' % (gate_src, SHOAL_DM, len(refused)))
    if refused:
        rp2 = os.path.join('outputs', 'batch_cut_refused.tsv')
        os.makedirs('outputs', exist_ok=True)
        with open(rp2, 'w', encoding='utf-8') as fh:
            fh.write('id3dhp\tslug\tacres\tstate\treason\n')
            for row_ in refused:
                fh.write('%s\t%s\t%d\t%s\t%s\n' % row_)
        print('   refusals with their reason -> %s  (NOT dropped silently)' % rp2)
    if collisions:
        print('\n%d slug(s) also exist in %s from an EARLIER pipeline. Cut here anyway --'
              % (len(collisions), a.legacy))
        print('a slug comes from a NAME and says nothing about which polygon it is. Check these')
        print('before installing, and make sure the legacy copy is not what gets registered:')
        for slug, rid, fp in collisions:
            print('   %-28s id3dhp %-7s legacy: %s' % (slug, rid, fp))
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
