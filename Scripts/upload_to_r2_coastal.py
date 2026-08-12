#!/usr/bin/env python3
"""
upload_to_r2_coastal.py — Upload TrollMap coastal pipeline outputs to R2.

New R2 layout (flat per-slug):
  {zone_slug}/contours.geojson
  {zone_slug}/depth_areas.geojson
  {zone_slug}/depth_soundings.geojson
  {zone_slug}/fishing_lines.geojson
  {zone_slug}/fishing_points.geojson
  {zone_slug}/pois.geojson
  {zone_slug}/shoreline.geojson

Usage:
    py upload_to_r2_coastal.py --all
    py upload_to_r2_coastal.py --contours
    py upload_to_r2_coastal.py --supplemental
    py upload_to_r2_coastal.py --zone coast_charleston_sc
    py upload_to_r2_coastal.py --dry-run --all
"""

import subprocess
import argparse
import sys
import json
from pathlib import Path

# Same bucket as upload_garmin_to_r2.py, so the same encoding. A coastal zone stored raw next
# to a lake stored gzipped would still WORK -- r2Body() checks per object -- but it would put
# the bucket back over the free tier one zone at a time, which is what this whole change is
# about. See r2_gzip.py.
from r2_gzip import prepared

WRANGLER_JS   = r'C:\Users\Ryan\AppData\Roaming\npm\node_modules\wrangler\bin\wrangler.js'
BUCKET        = 'trollmap-chartpacks'
OUTPUT_DIR    = Path(r'F:\TrollMapPipeline\split_output3')
# registry/boundaries/ as of 2026-08-12. This pointed at lake_boundaries/, where ZERO of the
# 22 coastal zones have a copy -- so the lookup below could never succeed and the boundary was
# simply never uploaded. A dead read that looks like a live one.
BOUNDARY_DIR  = Path(r'F:\TrollMapPipeline\registry\boundaries')

# Supplemental layers produced by trollmap_pipeline.py
SUPPLEMENTAL_LAYERS = [
    'depth_areas.geojson',
    'fishing_lines.geojson',
    'fishing_points.geojson',
    'depth_soundings.geojson',
    'pois.geojson',
    'shoreline.geojson',
]

SKIP_SLUGS = set()

# ── Coastal tiers ─────────────────────────────────────────────────────────────
#
# This script had no tier filter at all. `upload_garmin_to_r2.py` has carried one
# since 2026-08-03 -- COASTAL_PRIMARY plus layers_for() -- but there are TWO roads
# to R2 and only that one was gated. Run this script with --contours or --all and
# it pushed contours and depth_areas for every zone in the catalog: roughly 124 MB
# each across the sixteen zones the filter exists to exclude.
#
# Ryan, 2026-08-03: "any saltwater from edisto beach to murrells inlet should be
# what we call primary... the other areas are perfectly fine with NOAA and the
# garmin poi/docks." Confirmed again 2026-08-04: six zones, not two.
#
# The list is IMPORTED rather than copied. A second copy of a set like this is how
# the 118-vs-116 lake-key drift happened, and a tier list that disagrees with
# itself between two uploaders would be invisible until the bill arrived.
try:
    from upload_garmin_to_r2 import COASTAL_PRIMARY
except ImportError as exc:      # never fall back to "no filter" -- that IS the bug
    print('FATAL: cannot import COASTAL_PRIMARY from upload_garmin_to_r2.py (%s).' % exc)
    print('Refusing to run unfiltered -- that would ship ~2 GB of contours for')
    print('secondary coastal zones. Fix the import rather than removing this guard.')
    sys.exit(2)

# The two scripts speak different layer vocabularies: the Garmin pack uses
# {docks, pois, garmin_shoreline}, this pipeline writes *.geojson filenames. These
# are the same tier expressed in this script's names -- structure yes, bathymetry no.
COASTAL_SECONDARY_LAYERS = {
    'pois.geojson', 'shoreline.geojson', 'fishing_points.geojson', 'fishing_lines.geojson',
}
HEAVY_LAYERS = {'contours.geojson', 'depth_areas.geojson', 'depth_soundings.geojson'}


def is_primary(slug):
    """A non-coastal slug is unaffected; a coastal one must be in the primary band."""
    return (not slug.startswith('coast_')) or slug in COASTAL_PRIMARY


def layers_for(slug):
    """Which supplemental layers of this zone actually go to R2."""
    if is_primary(slug):
        return list(SUPPLEMENTAL_LAYERS)
    return [l for l in SUPPLEMENTAL_LAYERS if l in COASTAL_SECONDARY_LAYERS]


def wrangler_put(local_path, r2_key, dry_run=False, gz=True):
    size_kb = Path(local_path).stat().st_size // 1024
    if dry_run:
        print(f'  [DRY] {r2_key} ({size_kb} KB raw)')
        return True
    with prepared(local_path, gz) as (src, extra):
        sent_kb = src.stat().st_size // 1024
        cmd = [
            'node', WRANGLER_JS, 'r2', 'object', 'put',
            f'{BUCKET}/{r2_key}',
            '--file', str(src),
            '--content-type', 'application/json',
            '--remote', *extra,
        ]
        r = subprocess.run(cmd, capture_output=True, timeout=600)
    out = (r.stdout + r.stderr).decode('utf-8', errors='replace')
    ok = r.returncode == 0 or 'success' in out.lower()
    status = '✅' if ok else '❌'
    shown = f'{size_kb} KB' if not gz else f'{sent_kb} KB gz, {size_kb} KB raw'
    print(f'  {status} {r2_key} ({shown})')
    if not ok:
        print(f'     {out.strip()[:200]}')
    return ok


def best_boundary_file(slug):
    """Prefer _nhd over _3dhp."""
    # registry/boundaries/ files carry no suffix; the suffixed names are the staging
    # convention. Both are tried so this works either way.
    plain = BOUNDARY_DIR / f'{slug}.geojson'
    nhd = plain if plain.exists() else BOUNDARY_DIR / f'{slug}_nhd.geojson'
    dhp = plain if plain.exists() else BOUNDARY_DIR / f'{slug}_3dhp.geojson'
    if nhd.exists(): return nhd
    if dhp.exists(): return dhp
    return None


def upload_contours(slug, dry_run=False, gz=True):
    if not is_primary(slug):
        print('  contours skipped — %s is a secondary coastal zone' % slug)
        return True, 'skipped-tier'
    path = OUTPUT_DIR / f'{slug}.geojson'
    if not path.exists():
        return False, 'missing'
    ok = wrangler_put(path, f'{slug}/contours.geojson', dry_run, gz)
    return ok, 'ok' if ok else 'failed'


def upload_supplemental(slug, dry_run=False, gz=True):
    supp_dir = OUTPUT_DIR / 'supplemental' / slug
    if not supp_dir.exists():
        return 0, 0
    ok = fail = 0
    want = layers_for(slug)
    dropped = [l for l in SUPPLEMENTAL_LAYERS if l not in want]
    if dropped:
        print('  tier: shipping %d of %d layers (holding back %s)'
              % (len(want), len(SUPPLEMENTAL_LAYERS), ', '.join(sorted(dropped))))
    for layer in want:
        path = supp_dir / layer
        if not path.exists():
            continue
        if wrangler_put(path, f'{slug}/{layer}', dry_run, gz):
            ok += 1
        else:
            fail += 1
    return ok, fail


def upload_boundary(slug, dry_run=False, gz=True):
    path = best_boundary_file(slug)
    if not path:
        return False, 'missing'
    ok = wrangler_put(path, f'{slug}/boundary.geojson', dry_run, gz)
    return ok, 'ok' if ok else 'failed'


def upload_all_pois(dry_run=False, gz=True):
    path = OUTPUT_DIR / 'supplemental' / '_all' / 'pois.geojson'
    if not path.exists():
        print('  _all/pois.geojson not found — skipping')
        return
    wrangler_put(path, '_all/pois.geojson', dry_run, gz)


def get_slugs(zone_arg=None):
    try:
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from coastal_catalog import COASTAL_CATALOG as LAKE_CATALOG
        if zone_arg:
            return [zone_arg] if zone_arg in LAKE_CATALOG else []
        return [s for s in LAKE_CATALOG if s not in SKIP_SLUGS]
    except ImportError:
        print('ERROR: lake_catalog.py not found')
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--all',          action='store_true')
    ap.add_argument('--contours',     action='store_true')
    ap.add_argument('--supplemental', action='store_true')
    ap.add_argument('--boundaries',   action='store_true')
    ap.add_argument('--lake', '--zone', help='Single coastal zone slug')
    ap.add_argument('--dry-run',      action='store_true')
    ap.add_argument('--no-gzip',      action='store_true',
                    help='upload raw -- only if the Worker predates r2Body()')
    args = ap.parse_args()

    if args.all:
        args.contours = args.supplemental = args.boundaries = True

    if not any([args.contours, args.supplemental, args.boundaries]):
        ap.print_help()
        print('\nSpecify at least one of: --all --contours --supplemental --boundaries')
        sys.exit(1)

    gz = not args.no_gzip
    slugs = get_slugs(args.lake if hasattr(args, 'lake') else None)
    mode = 'DRY RUN' if args.dry_run else 'UPLOAD'
    print(f'TrollMap R2 Upload — {mode}')
    print(f'Bucket: {BUCKET}')
    print(f'Slugs:  {len(slugs)}')
    prim = sorted(s for s in slugs if s.startswith('coast_') and s in COASTAL_PRIMARY)
    sec  = sorted(s for s in slugs if s.startswith('coast_') and s not in COASTAL_PRIMARY)
    print(f'Coastal primary   ({len(prim)}, all layers): ' + ', '.join(prim))
    print(f'Coastal secondary ({len(sec)}, structure only): ' + ', '.join(sec))
    print(f'{"─"*60}')

    c_ok = c_fail = c_skip = 0
    s_ok = s_fail = 0
    b_ok = b_fail = b_skip = 0

    for slug in slugs:
        print(f'\n{slug}:')

        if args.contours:
            ok, status = upload_contours(slug, args.dry_run, gz)
            if status == 'missing': c_skip += 1
            elif ok: c_ok += 1
            else: c_fail += 1

        if args.supplemental:
            ok, fail = upload_supplemental(slug, args.dry_run, gz)
            s_ok += ok; s_fail += fail

        if args.boundaries:
            ok, status = upload_boundary(slug, args.dry_run, gz)
            if status == 'missing': b_skip += 1
            elif ok: b_ok += 1
            else: b_fail += 1

    if args.supplemental:
        print(f'\n_all/pois:')
        upload_all_pois(args.dry_run, gz)

    print(f'\n{"─"*60}')
    if args.contours:
        print(f'Contours:     {c_ok} ok, {c_fail} failed, {c_skip} missing')
    if args.supplemental:
        print(f'Supplemental: {s_ok} ok, {s_fail} failed')
    if args.boundaries:
        print(f'Boundaries:   {b_ok} ok, {b_fail} failed, {b_skip} missing')


if __name__ == '__main__':
    main()
