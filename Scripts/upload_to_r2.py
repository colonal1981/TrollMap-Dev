#!/usr/bin/env python3
"""
upload_to_r2.py — Upload all TrollMap pipeline outputs to R2 in clean structure.

New R2 layout (flat per-slug):
  {slug}/contours.geojson
  {slug}/depth_areas.geojson
  {slug}/fishing_lines.geojson
  {slug}/fishing_points.geojson
  {slug}/pois.geojson
  {slug}/shoreline.geojson
  {slug}/osm-structures.geojson
  {slug}/boundary.geojson
  _all/pois.geojson

Usage:
    py upload_to_r2.py --all              # upload everything
    py upload_to_r2.py --contours         # contours only
    py upload_to_r2.py --supplemental     # supplemental layers only
    py upload_to_r2.py --boundaries       # boundary files only
    py upload_to_r2.py --lake lake_wateree_fishing_creek  # single lake
    py upload_to_r2.py --dry-run --all    # show what would upload
"""

import subprocess
import argparse
import sys
import json
from pathlib import Path

WRANGLER_JS   = r'C:\Users\Ryan\AppData\Roaming\npm\node_modules\wrangler\bin\wrangler.js'
BUCKET        = 'trollmap-chartpacks'
OUTPUT_DIR    = Path(r'F:\TrollMapPipeline\split_output3')
BOUNDARY_DIR  = Path(r'F:\TrollMapPipeline\lake_boundaries')

# Supplemental layers produced by trollmap_pipeline.py
SUPPLEMENTAL_LAYERS = [
    'depth_areas.geojson',
    'fishing_lines.geojson',
    'fishing_points.geojson',
    'pois.geojson',
    'shoreline.geojson',
]

SKIP_SLUGS = {'sc_ga_coastal', 'saluda_river_arm'}


def wrangler_put(local_path, r2_key, dry_run=False):
    size_kb = Path(local_path).stat().st_size // 1024
    if dry_run:
        print(f'  [DRY] {r2_key} ({size_kb} KB)')
        return True
    cmd = [
        'node', WRANGLER_JS, 'r2', 'object', 'put',
        f'{BUCKET}/{r2_key}',
        '--file', str(local_path),
        '--content-type', 'application/json',
        '--remote',
    ]
    r = subprocess.run(cmd, capture_output=True, timeout=120)
    out = (r.stdout + r.stderr).decode('utf-8', errors='replace')
    ok = r.returncode == 0 or 'success' in out.lower()
    status = '✅' if ok else '❌'
    print(f'  {status} {r2_key} ({size_kb} KB)')
    if not ok:
        print(f'     {out.strip()[:200]}')
    return ok


def best_boundary_file(slug):
    """Prefer _nhd over _3dhp."""
    nhd = BOUNDARY_DIR / f'{slug}_nhd.geojson'
    dhp = BOUNDARY_DIR / f'{slug}_3dhp.geojson'
    if nhd.exists(): return nhd
    if dhp.exists(): return dhp
    return None


def upload_contours(slug, dry_run=False):
    path = OUTPUT_DIR / f'{slug}.geojson'
    if not path.exists():
        return False, 'missing'
    ok = wrangler_put(path, f'{slug}/contours.geojson', dry_run)
    return ok, 'ok' if ok else 'failed'


def upload_supplemental(slug, dry_run=False):
    supp_dir = OUTPUT_DIR / 'supplemental' / slug
    if not supp_dir.exists():
        return 0, 0
    ok = fail = 0
    for layer in SUPPLEMENTAL_LAYERS:
        path = supp_dir / layer
        if not path.exists():
            continue
        if wrangler_put(path, f'{slug}/{layer}', dry_run):
            ok += 1
        else:
            fail += 1
    return ok, fail


def upload_boundary(slug, dry_run=False):
    path = best_boundary_file(slug)
    if not path:
        return False, 'missing'
    ok = wrangler_put(path, f'{slug}/boundary.geojson', dry_run)
    return ok, 'ok' if ok else 'failed'


def upload_all_pois(dry_run=False):
    path = OUTPUT_DIR / 'supplemental' / '_all' / 'pois.geojson'
    if not path.exists():
        print('  _all/pois.geojson not found — skipping')
        return
    wrangler_put(path, '_all/pois.geojson', dry_run)


def get_slugs(lake_arg=None):
    try:
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from lake_catalog import LAKE_CATALOG
        if lake_arg:
            return [lake_arg] if lake_arg in LAKE_CATALOG else []
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
    ap.add_argument('--lake',         help='Single slug')
    ap.add_argument('--dry-run',      action='store_true')
    args = ap.parse_args()

    if args.all:
        args.contours = args.supplemental = args.boundaries = True

    if not any([args.contours, args.supplemental, args.boundaries]):
        ap.print_help()
        print('\nSpecify at least one of: --all --contours --supplemental --boundaries')
        sys.exit(1)

    slugs = get_slugs(args.lake)
    mode = 'DRY RUN' if args.dry_run else 'UPLOAD'
    print(f'TrollMap R2 Upload — {mode}')
    print(f'Bucket: {BUCKET}')
    print(f'Slugs:  {len(slugs)}')
    print(f'{"─"*60}')

    c_ok = c_fail = c_skip = 0
    s_ok = s_fail = 0
    b_ok = b_fail = b_skip = 0

    for slug in slugs:
        print(f'\n{slug}:')

        if args.contours:
            ok, status = upload_contours(slug, args.dry_run)
            if status == 'missing': c_skip += 1
            elif ok: c_ok += 1
            else: c_fail += 1

        if args.supplemental:
            ok, fail = upload_supplemental(slug, args.dry_run)
            s_ok += ok; s_fail += fail

        if args.boundaries:
            ok, status = upload_boundary(slug, args.dry_run)
            if status == 'missing': b_skip += 1
            elif ok: b_ok += 1
            else: b_fail += 1

    if args.supplemental:
        print(f'\n_all/pois:')
        upload_all_pois(args.dry_run)

    print(f'\n{"─"*60}')
    if args.contours:
        print(f'Contours:     {c_ok} ok, {c_fail} failed, {c_skip} missing')
    if args.supplemental:
        print(f'Supplemental: {s_ok} ok, {s_fail} failed')
    if args.boundaries:
        print(f'Boundaries:   {b_ok} ok, {b_fail} failed, {b_skip} missing')


if __name__ == '__main__':
    main()
