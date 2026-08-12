#!/usr/bin/env python3
r"""remeasure_boundaries.py -- re-derive area, bounds, centroid and part count from the
boundary files as they stand on disk, and write the ones that moved back into lakes.json.

    py .\scripts\remeasure_boundaries.py --registry "F:\TrollMapPipeline\registry"
    py .\scripts\remeasure_boundaries.py --registry "..." --go
    py .\scripts\remeasure_boundaries.py --registry "..." --lake hartwell_lake --lake norris_lake

Dry run by default, like `install_registry_boundary.py`. `--go` writes.

WHY THIS EXISTS

`attach_arms.py` rewrote 28 boundary files in place on 2026-08-12, attaching **45,959 acres**
of water that Garmin had surveyed and no boundary claimed. Nothing told `lakes.json`.

    hartwell_lake  boundary file   -83.2826, 34.3376, -82.6574, 34.7607
                   lakes.json      -83.2826, 34.3376, -82.8019, 34.6496     16 km short

Then `consolidate_lake_index.py` copied the stale numbers through into `lake_index.json` --
it does not derive them, it carries them (`'bounds_wsen': x.get('bounds_wsen')`) -- and every
consumer downstream inherited a lake that stops 16 km before its own shoreline.

THE MEASUREMENT ALREADY EXISTED. `install_registry_boundary.py.measure()` computes exactly
these four fields and is careful about the traps (holes subtracted from area but not from the
centroid moment; a centroid asserted to be inside its own bounds). It is imported here rather
than reimplemented, because two functions that measure the same polygon will eventually
disagree and the disagreement will be discovered by a lake in the wrong county.

What was missing is that `install_registry_boundary.py` only reads STAGING files -- it looks
for `<slug>_nhd.geojson`, `_lake`, `_3dhp`, `_river`, `_zone` in a folder you pass it. There
was no path at all from an ALREADY-INSTALLED `registry/boundaries/<slug>.geojson` back to the
numbers describing it. Cutting a boundary updated them; editing one did not.

WHAT IT COSTS TO BE WRONG HERE, WHICH IS MORE THAN IT LOOKS

`_registry/lakes.json` is published to R2 for one stated purpose. From the uploader:

    The state-DNR pull happens at request time in a Cloudflare worker, so it cannot do a
    spatial join against boundary files it has never seen. It queries the DNR ArcGIS
    endpoints BY EXTENT instead.

So a short `bounds_wsen` is not a cosmetic error, it is a worker asking the state of South
Carolina for ramps in a box that stops before the lake does. `area_acres` feeds the registry
shrink and the picker; `centroid` feeds the county lookup that names the lake.

WHY IT ONLY WRITES lakes.json

`lake_index.json` is built FROM `lakes.json` by `consolidate_lake_index.py`, which also folds
in access, ramps, charted and the rest. Writing both here would put two authorities on the same
four fields. Fix the source and re-run consolidate.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import sys

ACRES_PER_KM2 = 247.105


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def geoms_of(fp):
    """Every geometry in the file, whatever wrapper it arrived in."""
    with open(fp, encoding='utf-8') as fh:
        doc = json.load(fh)
    if doc.get('type') == 'FeatureCollection':
        return [(f or {}).get('geometry') for f in (doc.get('features') or []) if f]
    if doc.get('type') == 'Feature':
        return [doc.get('geometry')]
    return [doc]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--lake', action='append', default=[],
                    help='only these slugs (repeatable). Default: every boundary on disk.')
    ap.add_argument('--from-tsv',
                    help='a TSV whose first column is a slug -- e.g. outputs/arms_attached.tsv')
    ap.add_argument('--tolerance-deg', type=float, default=0.0005,
                    help='bounds movement below this is rounding, not drift (default 0.0005, '
                         'about 55 m)')
    ap.add_argument('--area-tolerance-pct', type=float, default=0.5)
    ap.add_argument('--go', action='store_true', help='actually write. Default is a dry run.')
    a = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    IRB = _load(os.path.join(here, 'install_registry_boundary.py'), 'irb')
    print('measure() imported from install_registry_boundary.py -- one measurement, not two')

    reg = a.registry
    bdir = os.path.join(reg, 'boundaries')
    lakes_fp = os.path.join(reg, 'lakes.json')
    if not os.path.isdir(bdir):
        sys.exit('no boundaries folder at %s' % bdir)

    with open(lakes_fp, encoding='utf-8') as fh:
        doc = json.load(fh)
    rows = doc if isinstance(doc, list) else doc.get('lakes')
    if rows is None:
        sys.exit('lakes.json has no "lakes" list and is not a list')
    by = {r.get('slug'): r for r in rows if isinstance(r, dict) and r.get('slug')}

    want = set(a.lake)
    if a.from_tsv:
        with open(a.from_tsv, encoding='utf-8') as fh:
            for i, line in enumerate(fh):
                if i == 0 or not line.strip():
                    continue
                want.add(line.split('\t')[0].strip())
        print('from %s: %d slug(s)' % (os.path.basename(a.from_tsv), len(want)))

    slugs = sorted(want) if want else sorted(
        f[:-8] for f in os.listdir(bdir) if f.endswith('.geojson'))

    moved, same, missing, failed, unknown = [], 0, [], [], []
    for slug in slugs:
        fp = os.path.join(bdir, slug + '.geojson')
        if not os.path.exists(fp):
            missing.append(slug)
            continue
        row = by.get(slug)
        if row is None:
            # A boundary with no lakes.json row is a different problem -- installing it is
            # install_registry_boundary.py's job, and guessing a name here would create a row
            # nothing else agrees with. Report and move on.
            unknown.append(slug)
            continue
        try:
            m = IRB.measure([g for g in geoms_of(fp) if g])
        except Exception as exc:
            failed.append((slug, '%s: %s' % (type(exc).__name__, exc)))
            continue

        ob = row.get('bounds_wsen') or [None] * 4
        oa = row.get('area_km2') or 0.0
        db = (max(abs((ob[i] or 0) - m['bounds_wsen'][i]) for i in range(4))
              if all(isinstance(x, (int, float)) for x in ob) else 999.0)
        da = abs(m['area_km2'] - oa) / oa * 100 if oa else (100.0 if m['area_km2'] else 0.0)
        if db <= a.tolerance_deg and da <= a.area_tolerance_pct:
            same += 1
            continue
        moved.append((db, da, slug, row, m, ob, oa))

    moved.sort(key=lambda x: -(x[4]['area_km2'] - x[6]))
    print('\n%d boundary file(s) checked: %d agree with lakes.json, %d MOVED'
          % (len(slugs) - len(missing) - len(unknown), same, len(moved)))
    if missing:
        print('   %d slug(s) named but with no boundary file: %s'
              % (len(missing), ', '.join(missing[:6])))
    if unknown:
        print('   %d boundary file(s) with no lakes.json row -- install_registry_boundary.py\'s '
              'job, not this one: %s' % (len(unknown), ', '.join(unknown[:6])))
    for slug, why in failed:
        print('   !! %s could not be measured: %s' % (slug, why))

    if moved:
        print('\n%-28s %12s %12s %10s %8s' % ('SLUG', 'ACRES WAS', 'ACRES NOW', 'GAINED', 'BOUNDS'))
        for db, da, slug, row, m, ob, oa in moved:
            print('%-28s %12s %12s %10s %7.3f deg'
                  % (slug[:28], format(int(oa * ACRES_PER_KM2), ','),
                     format(int(m['area_km2'] * ACRES_PER_KM2), ','),
                     format(int((m['area_km2'] - oa) * ACRES_PER_KM2), ','), db))
        # UP AND DOWN ARE DIFFERENT EVENTS AND MUST NOT BE NETTED. The first run of this
        # reported "net -463,726 acres" and looked like a catastrophe. It was two things at
        # once: 23 lakes gaining the arms attached to them, and 5 coastal zones being
        # corrected DOWN to the shape Ryan cut with his own line -- `lakes.json` had kept the
        # area of the rectangle those zones used to be. Both numbers are right; summing them
        # produces one that is not.
        up = [x for x in moved if x[4]['area_km2'] > x[6]]
        down = [x for x in moved if x[4]['area_km2'] <= x[6]]
        gain = sum(x[4]['area_km2'] - x[6] for x in up) * ACRES_PER_KM2
        loss = sum(x[6] - x[4]['area_km2'] for x in down) * ACRES_PER_KM2
        print('\n%d water(s) measure LARGER than lakes.json says:  +%s acres'
              % (len(up), format(int(gain), ',')))
        print('%d water(s) measure SMALLER:                       -%s acres'
              % (len(down), format(int(loss), ',')))
        if down:
            print('   A water that measures smaller is not damage -- it is lakes.json holding a')
            print('   number from before the boundary was re-cut. Check one against its')
            print('   boundaries/_before_arms/ copy if you want to see which it is.')

    if not a.go:
        print('\nDRY RUN -- nothing written. Re-run with --go, then run '
              'consolidate_lake_index.py so lake_index.json picks it up.')
        return 0
    if not moved:
        print('\nnothing to write.')
        return 0

    bak = lakes_fp + '.bak'
    shutil.copy2(lakes_fp, bak)
    for _, _, slug, row, m, _, _ in moved:
        row['area_km2'] = m['area_km2']
        row['bounds_wsen'] = m['bounds_wsen']
        row['centroid'] = m['centroid']
        row['parts'] = m['parts']
    with open(lakes_fp, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, indent=1)
    print('\nwrote %d row(s) -> %s   (previous copy at %s)'
          % (len(moved), lakes_fp, os.path.basename(bak)))
    print('NOW RUN consolidate_lake_index.py. lake_index.json carries these values, it does '
          'not derive them, so it is still holding the old ones until you do.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
