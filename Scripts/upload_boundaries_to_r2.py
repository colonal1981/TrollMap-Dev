#!/usr/bin/env python3
"""
upload_boundaries_to_r2.py — Uploads 3DHP lake boundary GeoJSONs to R2
at trollmap-chartpacks/boundaries/<slug>_3dhp.geojson via wrangler CLI.

Usage:
    python upload_boundaries_to_r2.py
    python upload_boundaries_to_r2.py --lake lake_wateree_fishing_creek
    python upload_boundaries_to_r2.py --lake catawba_river --lake duck_river,elk_river
    python upload_boundaries_to_r2.py --dry-run
    python upload_boundaries_to_r2.py --force        # ignore the manifest, push everything

Requires: wrangler installed and authenticated (wrangler whoami should work).
Re-running is safe — R2 PUT is idempotent, and a manifest means a re-run only
pushes what changed.
"""

import argparse
import json
import os
import subprocess
import sys
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
# What the app offers. The unbuildable filter and the region gate both land here,
# so reading it means this uploader inherits both without duplicating either.
INDEX_JSON     = Path(r'F:\TrollMapPipeline\registry\lake_index.json')
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


# ── The manifest ──────────────────────────────────────────────────────────────
#
# Without one, every full run re-pushed all ~1,563 boundaries and `--lake` existed only so a
# wrangler network error on three files did not cost a whole pass. The pack uploader has kept
# a manifest for months; this was the odd one out.
#
# It records what THIS SCRIPT uploaded. It is not a reading of the bucket, and the two are not
# the same thing -- verify_registry_r2.py exists because three sessions running confused a
# local manifest for the bucket's contents. If the bucket is emptied or rewritten behind its
# back, the manifest will happily skip everything: `--force` is the way back.
#
# It lives beside the other registry sidecars, not inside registry/boundaries/, so nothing that
# walks that folder ever has to special-case it.
MANIFEST_FP = Path(r'F:\TrollMapPipeline\registry\_r2_boundaries_manifest.json')


def load_manifest(mpath: Path, force: bool) -> dict:
    if force or not mpath.exists():
        return {}
    try:
        return json.load(open(mpath, encoding='utf-8'))
    except Exception as exc:
        # Do NOT fail silently. An unreadable manifest means every boundary is about to go
        # back up, which looks identical to a first run and costs a full pass.
        print(f"!! manifest {mpath} is unreadable ({type(exc).__name__}: {exc})")
        print("!! treating it as empty -- every boundary will be re-uploaded.")
        print(f"!! if that is not what you want, stop now and restore the manifest.")
        return {}


def save_manifest(manifest: dict, mpath: Path) -> None:
    """Atomic, so a Ctrl-C mid-run cannot leave a fragment behind.

    `json.dump(manifest, open(mpath, 'w'))` truncates first and writes second. Interrupt it in
    that window and what is left on disk is a fragment; load_manifest then reports it unreadable
    and the next run re-pushes all 1,563 boundaries. Write a sibling and os.replace() it in --
    replace is atomic on the same volume on Windows and POSIX both, so the file on disk is
    always either the previous checkpoint or the new one, never half of either.
    """
    tmp = str(mpath) + '.tmp'
    mpath.parent.mkdir(parents=True, exist_ok=True)
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, mpath)


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
                         '--lake a --lake b,c. With the manifest in place a bare run already '
                         'pushes only what changed, so this is for naming a specific lake -- '
                         'and it still honours the manifest, so add --force to re-push one '
                         'that has not changed.')
    ap.add_argument('--dry-run', action='store_true', help='Print what would be uploaded without uploading')
    ap.add_argument('--no-gzip', action='store_true',
                    help='upload raw -- only if the Worker predates r2Body()')
    ap.add_argument('--force', action='store_true',
                    help='ignore the manifest and push everything. Use after the bucket has '
                         'been emptied or rewritten by something other than this script.')
    ap.add_argument('--manifest', default=None,
                    help='override the manifest path (default registry/_r2_boundaries_manifest.json)')
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
        # Only what the app can actually ask for. That is lake_index.json, NOT "a chartpack
        # directory exists".
        #
        # Ryan, 2026-08-13: "the boundary files do not pay attention to the registry filters so
        # a hole bunch of boundary files for lakes that do not have chartpacks are sitting
        # hanging out in R2". Measured that day: 1,704 pack dirs against 864 index rows, so 846
        # packs were not offered by the app and 845 of them had a boundary file. Every one would
        # have shipped. The index is where the unbuildable filter and the region gate both land,
        # so reading it is how this uploader inherits BOTH without knowing about either.
        packs = {d.name for d in CHARTPACK_DIR.iterdir() if d.is_dir()} if CHARTPACK_DIR.is_dir() else set()
        index = set()
        if INDEX_JSON.exists():
            try:
                index = set(json.load(open(INDEX_JSON, encoding='utf-8')))
            except (OSError, ValueError) as exc:
                print(f"❌ {INDEX_JSON} is unreadable ({exc}). Refusing to fall back to 'every "
                      f"pack directory' -- that is how 845 unoffered boundaries ship.")
                sys.exit(1)
        else:
            print(f"❌ {INDEX_JSON} not found. Run consolidate_lake_index.py first -- without it "
                  f"there is no list of what the app offers.")
            sys.exit(1)
        wanted = index & packs
        # A river a water alias points at needs its outline even when it is not its own picker
        # row, but it still has to have been built.
        if ALIASES_JS and ALIASES_JS.exists():
            import re as _re
            alias = {t for t in _re.findall(r'"[^"]+":\s*"([^"]+)"',
                                            ALIASES_JS.read_text(encoding='utf-8'))
                     if not t.startswith('coast_')}
            wanted |= (alias & packs)
        print('index %d, packs %d -> %d in scope  (%d packs the app does not offer)'
              % (len(index), len(packs), len(wanted), len(packs - index)))
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

    gz = not args.no_gzip
    mpath = Path(args.manifest) if args.manifest else MANIFEST_FP
    manifest = load_manifest(mpath, args.force)

    # (size, mtime, gzip) -- the same triple the pack uploader keys on. gzip is in there
    # because flipping --no-gzip changes the bytes in the bucket while leaving the local file
    # untouched, and a size+mtime-only key would skip all 1,563 objects and report success.
    todo, skipped = [], 0
    for slug, bfp in files:
        st = bfp.stat()
        prev = manifest.get(R2_KEY_FOR(slug))
        if (prev
                and prev.get('size') == st.st_size
                and prev.get('mtime') == int(st.st_mtime)
                and bool(prev.get('gzip')) == gz):
            skipped += 1
            continue
        todo.append((slug, bfp))

    total_kb = sum(bfp.stat().st_size // 1024 for _, bfp in todo)

    print(f"TrollMap R2 Boundary Uploader")
    print(f"Bucket:    {R2_BUCKET}/  (keys: <slug>/boundary.geojson)")
    print(f"Source:    {BOUNDARIES_DIR}")
    print(f"Manifest:  {mpath}{'  (IGNORED, --force)' if args.force else ''}")
    print(f"Files:     {len(todo)} to upload, {skipped} unchanged, {len(files)} considered")
    print(f"Total:     {total_kb / 1024:.1f} MB")
    if args.dry_run:
        print(f"Mode:      DRY RUN")
    print(f"{'─'*60}")

    if not todo:
        print("nothing to do -- every boundary in scope is already up to date.")
        print("Add --force to push anyway.")
        return

    ok = fail = 0
    for i, (slug, bfp) in enumerate(todo, 1):
        if upload_file(slug, bfp, dry_run=args.dry_run, gz=gz):
            ok += 1
            if not args.dry_run:
                st = bfp.stat()
                manifest[R2_KEY_FOR(slug)] = {'size': st.st_size,
                                              'mtime': int(st.st_mtime),
                                              'gzip': gz}
                # Checkpoint. A run killed at object 900 of 1,563 keeps its first 900 rather
                # than starting over, which is the whole point of having a manifest.
                if i % 25 == 0:
                    save_manifest(manifest, mpath)
        else:
            fail += 1
        time.sleep(0.05)

    if not args.dry_run:
        save_manifest(manifest, mpath)

    print(f"\n{'─'*60}")
    # "Done: 1,563 uploaded" after a DRY RUN is a lie the old summary told, because
    # upload_file() returns True without sending anything in that mode.
    verb = 'would upload' if args.dry_run else 'uploaded'
    print(f"Done: {ok} {verb}, {fail} failed, {skipped} skipped as unchanged")
    if fail:
        # A failure never reaches the manifest, so a bare re-run retries exactly these.
        print(f"⚠  {fail} failed — re-run to retry just those (R2 PUT is idempotent)")
        sys.exit(1)


if __name__ == '__main__':
    main()
