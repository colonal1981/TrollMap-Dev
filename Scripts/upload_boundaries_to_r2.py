#!/usr/bin/env python3
"""
upload_boundaries_to_r2.py — Uploads 3DHP lake boundary GeoJSONs to R2
at trollmap-chartpacks/boundaries/<slug>_3dhp.geojson via wrangler CLI.

Usage:
    python upload_boundaries_to_r2.py
    python upload_boundaries_to_r2.py --lake lake_wateree_fishing_creek
    python upload_boundaries_to_r2.py --lake catawba_river --lake duck_river,elk_river
    python upload_boundaries_to_r2.py --dry-run

Requires: wrangler installed and authenticated (wrangler whoami should work).
Re-running is safe — R2 PUT is idempotent.
"""

import sys
import subprocess
import argparse
import time
from pathlib import Path

# Same bucket, same encoding as the pack and coastal uploaders. See r2_gzip.py.
from r2_gzip import prepared

# ── Config ────────────────────────────────────────────────────────────────────
# registry/boundaries/ is the source, not lake_boundaries/.
#
# The builder clips every pack against registry/boundaries/<slug>.geojson, so that
# directory is the one that matches what shipped. Measured 2026-08-04: it covers all
# 1,503 slugs that need an outline -- 1,502 built packs plus every river a water alias
# points at. lake_boundaries/ holds 171 slugs and covers 116 of the built packs, so
# reading it instead left 1,386 lakes with contours and no outline.
BOUNDARIES_DIR = Path(r'F:\TrollMapPipeline\registry\boundaries')
CHARTPACK_DIR  = Path(r'F:\TrollMapPipeline\chartpack')
# Resolved, not named. The app tree was `TrollMap-Dev-main` until 2026-08-06 and is
# `TrollMap-Dev` now, with the old one kept beside it as *-NO_LONGER_USED. Naming it
# risks silently reading the retired copy.
def _aliases_js():
    root = Path(r'F:\TrollMapPipeline')
    best = None
    for d in root.glob('TrollMap-Dev*'):
        if not d.is_dir() or 'NO_LONGER_USED' in d.name.upper():
            continue
        fp = d / 'js' / 'data' / 'water-aliases.js'
        if fp.exists() and (best is None or d.stat().st_mtime > best[0]):
            best = (d.stat().st_mtime, fp)
    return best[1] if best else None

ALIASES_JS     = _aliases_js()
R2_BUCKET      = 'trollmap-chartpacks'

# ── The key this writes MUST be the key the Worker reads ──────────────────────
#
# This script wrote `boundaries/{slug}_3dhp.geojson`. The Worker's
# /chartpacks/lake-boundary endpoint has never looked there. It tries exactly three
# candidates, all of the same shape (trollmap-worker.js:1663):
#
#     {sanitizeLakeId(lake)}/boundary.geojson
#     {lakeKeyFromName(lake)}/boundary.geojson
#     lake_{lakeKeyFromName(lake)}/boundary.geojson
#
# and the app passes a registry slug, because resolveBoundaryKey IS resolveR2Key.
# sanitizeLakeId() of an already-clean slug returns it unchanged, so the key the app
# ends up asking for is `{slug}/boundary.geojson`.
#
# Verified against the R2 manifest 2026-08-04: 2,501 keys, ZERO named
# boundary.geojson. Boundaries have never been served. Running this script as it was
# would have uploaded 94 files, reported success on every one, and changed nothing --
# the app would still 404 on each. The Worker comment even claims a `boundaries/`
# fallback that is not in its candidate list.
#
# The build does not produce boundary.geojson either: 0 of 1,502 packs contain one.
# lake_boundaries/ is the only source there is.
R2_KEY_FOR = lambda slug: f"{slug}/boundary.geojson"

# registry/boundaries/ is one file per slug, already the flavour the pack was clipped
# against, so no source precedence is needed here.
# ─────────────────────────────────────────────────────────────────────────────


def upload_file(slug: str, filepath: Path, dry_run: bool = False, gz: bool = True) -> bool:
    r2_key = R2_KEY_FOR(slug)
    size_kb = filepath.stat().st_size // 1024
    print(f"  → {r2_key}  ({size_kb:,} KB) ...", end=' ', flush=True)

    if dry_run:
        print("DRY RUN")
        return True

    try:
        # BYTES, not text=True. wrangler writes UTF-8 with box-drawing and spinner glyphs;
        # text=True makes subprocess decode with the LOCALE codepage, cp1252 on this machine,
        # and byte 0x8f has no cp1252 mapping. The decode happens on a READER THREAD, so it
        # raises there and prints a full traceback per upload while the upload itself succeeds
        # -- 1,517 tracebacks interleaved with 1,517 green ticks. The output is merely lost,
        # but it looks exactly like a failing run. Decode here, explicitly, and never crash on
        # a glyph.
        with prepared(filepath, gz) as (src, extra):
            cmd = [
                'node', r'C:\Users\Ryan\AppData\Roaming\npm\node_modules\wrangler\bin\wrangler.js',
                'r2', 'object', 'put',
                f"{R2_BUCKET}/{r2_key}",
                '--file', str(src),
                '--content-type', 'application/json',
                '--remote', *extra,
            ]
            result = subprocess.run(cmd, capture_output=True, timeout=120)
        stdout = result.stdout.decode('utf-8', errors='replace')
        stderr = result.stderr.decode('utf-8', errors='replace')
        if result.returncode == 0:
            print("✅")
            return True
        else:
            # wrangler sometimes prints success to stderr
            if 'success' in (stdout + stderr).lower():
                print("✅")
                return True
            print(f"❌  (exit {result.returncode})")
            err = (stderr or stdout).strip()
            if err:
                print(f"     {err[:200]}")
            return False
    except subprocess.TimeoutExpired:
        print("❌  timeout")
        return False
    except FileNotFoundError:
        print("❌  npx/wrangler not found — ensure Node.js is on PATH")
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description='Upload 3DHP boundaries to R2')
    ap.add_argument('--lake', action='append', default=[],
                    help='Upload these slugs only. Repeatable, and accepts a comma list: '
                         '--lake a --lake b,c. This script keeps NO manifest -- every full run '
                         're-pushes all ~1,563 boundaries -- so retrying the handful that hit a '
                         'wrangler network error should not cost a whole pass.')
    ap.add_argument('--dry-run', action='store_true', help='Print what would be uploaded without uploading')
    ap.add_argument('--no-gzip', action='store_true',
                    help='upload raw -- only if the Worker predates r2Body()')
    args = ap.parse_args()

    if not BOUNDARIES_DIR.exists():
        print(f"❌ Directory not found: {BOUNDARIES_DIR}")
        sys.exit(1)

    if args.lake:
        slugs, missing, files = [], [], []
        for raw in args.lake:
            for part in str(raw).split(','):
                part = part.strip().replace('.geojson', '')
                if part and part not in slugs:
                    slugs.append(part)
        for slug in slugs:
            fp = BOUNDARIES_DIR / f"{slug}.geojson"
            (files.append((slug, fp)) if fp.exists() else missing.append(slug))
        if missing:
            # Every named slug or none. A partial retry that silently skipped two of the five
            # you asked for would look exactly like a successful retry.
            print(f"❌ No boundary in {BOUNDARIES_DIR} for: {', '.join(missing)}")
            sys.exit(1)
    else:
        # Only what the app can actually ask for: a built pack, or a river a water
        # alias points at. registry/boundaries/ holds 3,194 files, more than twice
        # what shipped, and uploading the rest is 1,700 objects nothing will fetch.
        wanted = {d.name for d in CHARTPACK_DIR.iterdir() if d.is_dir()} if CHARTPACK_DIR.is_dir() else set()
        if ALIASES_JS and ALIASES_JS.exists():
            import re as _re
            for tgt in _re.findall(r'"[^"]+":\s*"([^"]+)"', ALIASES_JS.read_text(encoding='utf-8')):
                if not tgt.startswith('coast_'):
                    wanted.add(tgt)
        files = sorted((fp.name[:-len('.geojson')], fp)
                       for fp in BOUNDARIES_DIR.glob('*.geojson')
                       if fp.name[:-len('.geojson')] in wanted)
        missing = sorted(wanted - {slug for slug, _ in files})
        print('needed %d, found %d' % (len(wanted), len(files)))
        if missing:
            print('NO BOUNDARY FILE for %d slug(s): %s%s'
                  % (len(missing), ', '.join(missing[:8]), ' ...' if len(missing) > 8 else ''))

    if not files:
        print(f"No boundary files found in {BOUNDARIES_DIR}")
        sys.exit(1)

    total_kb = sum(fp.stat().st_size // 1024 for _, fp in files)

    print(f"TrollMap R2 Boundary Uploader")
    print(f"Bucket:    {R2_BUCKET}/  (keys: <slug>/boundary.geojson)")
    print(f"Source:    {BOUNDARIES_DIR}")
    print(f"Files:     {len(files)}")
    print(f"Total:     {total_kb / 1024:.1f} MB")
    if args.dry_run:
        print(f"Mode:      DRY RUN")
    print(f"{'─'*60}")

    ok = fail = 0
    for slug, fp in files:
        if upload_file(slug, fp, dry_run=args.dry_run, gz=not args.no_gzip):
            ok += 1
        else:
            fail += 1
        time.sleep(0.05)

    print(f"\n{'─'*60}")
    print(f"Done: {ok} uploaded, {fail} failed")
    if fail:
        print(f"⚠  {fail} failed — re-run to retry (R2 PUT is idempotent)")
        sys.exit(1)


if __name__ == '__main__':
    main()
