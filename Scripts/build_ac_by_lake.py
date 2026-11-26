#!/usr/bin/env python3
r"""build_ac_by_lake.py -- the ActiveCaptain markers for every water, in ONE file the app joins.

Personal use only, not for distribution or resale; not for navigation.

    py .\Scripts\build_ac_by_lake.py --registry F:\TrollMapPipeline\registry `
       --db "F:\TrollMapPipeline\2.5.20260210.1-1794774142-1794765071_active_captain.db"

writes <registry>\activecaptain_by_lake.json, and the next

    py .\Scripts\upload_garmin_to_r2.py --root ... --registry F:\TrollMapPipeline\registry

ships it as `_registry/activecaptain_by_lake.json` beside lake_index.json. Nothing else is
needed: the app reads it through the same /chartpacks/<key>/<file> route the registry already
comes back through.

WHY NOT THE PACKS ANY MORE

merge_ac_pois.py wrote the markers INTO each pack's pois.geojson. The chartpack build owns that
file and writes it fresh on every rebuild, so every rebuild quietly took them back out: on
2026-11-26 three of the 1,074 packs on the F: drive still had an ActiveCaptain record in them.
Two writers, one file. This script owns this file, the pack build owns the pack, and the browser
joins the two (js/data/activecaptain.js) with merge_pois()'s rule -- same name within 50 m is one
feature. A pack rebuild cannot touch this file, and a new database cannot touch a pack.

WHAT IS IN IT

Per registry slug, every named marker inside the lake's box plus 250 m, classed by
merge_ac_pois.ac_features() and judged on or off the water by the same ray cast and the same
one-cell allowance, imported rather than restated. Markers outside the 250 m collar are dropped,
exactly as before. Slim rows, not GeoJSON: the browser builds the features.

`markers_as_of` is read off the database's filename, `<base>-<markerLastUpdate>-<reviewLastUpdate>`,
because the `versions` table inside is only the base snapshot and says nothing about how fresh the
markers are.
"""
from __future__ import annotations
import argparse, json, os, re, sqlite3, sys, time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_chartpack import _rings                                          # noqa: E402
from merge_ac_pois import (ac_features, _ray_index, _inside, _near,         # noqa: E402
                           load_json, BUFFER_M, DEG, CELL_M)

OUT_NAME = 'activecaptain_by_lake.json'
NOTE = 'Personal use only, not for distribution or resale; not for navigation.'


def markers_as_of(db_path):
    """The marker timestamp in the filename, as a UTC date, or None."""
    m = re.search(r'-(\d{9,11})-(\d{9,11})_active_captain\.db$', os.path.basename(db_path))
    if not m:
        return None
    return datetime.fromtimestamp(int(m.group(1)), tz=timezone.utc).strftime('%Y-%m-%d')


def lake_rows(cur, box, rings):
    """The markers for one water: (rows, dropped outside the collar)."""
    w, s, e, n = box
    cand = ac_features(cur, (w - DEG, s - DEG, e + DEG, n + DEG))
    if not cand:
        return [], 0
    ix = _ray_index(rings)
    rows, dropped = [], 0
    for f in cand:
        x, y = f['geometry']['coordinates']
        # The same test merge_ac_pois.py makes, and its comment is why the cell is there: a ramp
        # sits ON THE SHORE, strictly outside the water polygon.
        on = _inside(ix, x, y) or _near(ix, x, y, CELL_M)
        if not on and not _near(ix, x, y, BUFFER_M):
            dropped += 1
            continue
        p = f['properties']
        rows.append({'ac_id': p['ac_id'], 'name': p['name'], 'poi_type': p['poi_type'],
                     'ac_poi_type': p['ac_poi_type'], 'on_water': bool(on),
                     'lon': x, 'lat': y})
    rows.sort(key=lambda r: r['ac_id'])
    return rows, dropped


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True, help='holds lake_index.json and boundaries/')
    ap.add_argument('--db', required=True, help='active_captain.db')
    ap.add_argument('--out', default=None, help='default <registry>/' + OUT_NAME)
    ap.add_argument('--dry-run', action='store_true', help='measure and print, write nothing')
    a = ap.parse_args()

    if not os.path.exists(a.db):
        sys.exit('no ActiveCaptain database at %s' % a.db)
    idx = load_json(os.path.join(a.registry, 'lake_index.json'))
    con = sqlite3.connect('file:%s?mode=ro' % a.db, uri=True)
    cur = con.cursor()
    t0 = time.time()

    lakes, n_rows, n_on, n_drop, no_boundary = {}, 0, 0, 0, 0
    for slug in sorted(idx):
        box = idx[slug].get('bounds_wsen') or []
        if len(box) != 4 or None in box:
            continue
        bpath = os.path.join(a.registry, 'boundaries', slug + '.geojson')
        if not os.path.exists(bpath):
            no_boundary += 1
            continue
        gj = load_json(bpath)
        geoms = [f.get('geometry') for f in (gj.get('features') or [])] or [gj.get('geometry') or gj]
        rings = [r for g in geoms if g for r in _rings(g)]
        if not rings:
            continue
        rows, dropped = lake_rows(cur, box, rings)
        n_drop += dropped
        if not rows:
            continue
        lakes[slug] = rows
        n_rows += len(rows)
        n_on += sum(1 for r in rows if r['on_water'])

    ramps = sum(1 for rs in lakes.values() for r in rs if r['poi_type'] == 'boat_ramp')
    print('%d waters carry a marker, %d markers, %d on the water, %d boat ramps   (%.1f s)'
          % (len(lakes), n_rows, n_on, ramps, time.time() - t0))
    print('%d markers in a box but outside the 250 m collar, dropped' % n_drop)
    if no_boundary:
        print('%d slugs have no boundary file and were skipped' % no_boundary)

    doc = {'note': NOTE, 'version': 1, 'db': os.path.basename(a.db),
           'markers_as_of': markers_as_of(a.db), 'built': time.strftime('%Y-%m-%d'),
           'lakes': lakes}
    if a.dry_run:
        print('--dry-run: nothing written.')
        return 0
    out = a.out or os.path.join(a.registry, OUT_NAME)
    tmp = out + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, out)
    print('-> %s  (%.0f KB before gzip)' % (out, os.path.getsize(out) / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
