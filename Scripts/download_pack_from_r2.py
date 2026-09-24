#!/usr/bin/env python3
r"""
download_pack_from_r2.py -- put a pack on the drive back to what R2 is serving.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.

    py .\Scripts\download_pack_from_r2.py --root F:\TrollMapPipeline\chartpack --lake lake_marion
    py .\Scripts\download_pack_from_r2.py --root ... --lake lake_marion --write
    py .\Scripts\download_pack_from_r2.py --root ... --lake lake_marion --files depth_areas.geojson --write

Without --write it only reports, file by file: SAME, DIFFERS or NOT LIVE.

WHY THIS EXISTS

`A_RECTANGLE_HAS_NO_EDGE_TO_EXTEND_FROM_2026-09-21.md`: *"build_all_chartpacks.py overwrites packs
in place with no copy-aside, and there is no downloader in the repo -- only uploaders. A bad input
can destroy every pack on disk and R2 is acting as the backup by accident rather than by design."*

It came up for real on 2026-09-24. The 09-21 morning rebuild left Lake Marion's pack on the drive
617 acres smaller than the one R2 serves -- the annex from the Pack's Landing canal work, dropped
when the annex was quarantined card-wide -- and live is the one Ryan fishes from. Without a way
back, the next full upload would have quietly replaced it with the smaller one.

WHAT --write DOES, AND DOES NOT

  * A file that DIFFERS is moved aside first -- to `_to_delete\packs_replaced_<date>\<slug>\` beside
    the pack folder, never deleted -- then the live copy is written in its place.
  * The uploader's manifest entry for that key is set to the file now on the drive, with the live
    ETag, so the next upload does not push the same bytes back up.
  * A file that is SAME is left alone. A file that is NOT LIVE is left alone and reported: the
    bucket having nothing is not a reason to remove what is on the drive.

Reads through the public Worker route (`/chartpacks/<slug>/<file>`); no credentials.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import r2_live  # noqa: E402


def plan(root: Path, slug: str, files, worker: str, gz: bool = True, live_state=None):
    """[(file, status, detail)] for one pack. `live_state` is injectable for tests."""
    live_state = live_state or r2_live.live_state
    pack = root / slug
    names = list(files) if files else sorted(p.name for p in pack.glob("*.geojson"))
    out = []
    for name in names:
        p = pack / name
        key = f"{slug}/{name}"
        if not p.exists():
            out.append((name, "NOT ON DRIVE", key))
            continue
        etag = r2_live.upload_bytes_md5(p, gz)
        state = live_state(key, etag, worker)
        status = {"same": "SAME", "differs": "DIFFERS", "absent": "NOT LIVE"}.get(
            state, "UNKNOWN")
        out.append((name, status, etag if state else "the Worker could not be asked"))
    return out


def restore(root: Path, slug: str, name: str, manifest: dict, worker: str,
            stamp: str, gz: bool = True, fetch=None):
    """Move the drive's copy aside, write the live one, record it in the manifest. Returns the
    path it was moved to, or None when the bucket has no such object (nothing is touched)."""
    fetch = fetch or r2_live.fetch_live
    key = f"{slug}/{name}"
    body, etag = fetch(key, worker)
    if body is None:
        return None
    src = root / slug / name
    aside = root.parent / "_to_delete" / f"packs_replaced_{stamp}" / slug / name
    aside.parent.mkdir(parents=True, exist_ok=True)
    if src.exists():
        if aside.exists():
            aside = aside.with_name(f"{aside.stem}.{int(time.time())}{aside.suffix}")
        shutil.move(str(src), str(aside))
    tmp = src.with_suffix(src.suffix + ".download")
    with open(tmp, "wb") as fh:
        fh.write(body)
    os.replace(tmp, src)
    st = src.stat()
    manifest[key] = {"size": st.st_size, "mtime": int(st.st_mtime), "gzip": gz,
                     "etag": r2_live.upload_bytes_md5(src, gz),
                     "restored_from_r2": time.strftime("%Y-%m-%d %H:%M")}
    return aside


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", required=True, help="the chartpack folder")
    ap.add_argument("--lake", nargs="+", required=True, help="pack slug(s)")
    ap.add_argument("--files", nargs="*", default=None,
                    help="file names in the pack (default: every .geojson on the drive)")
    ap.add_argument("--worker", default=r2_live.WORKER)
    ap.add_argument("--manifest", default=None, help="default <root>/_r2_manifest.json")
    ap.add_argument("--write", action="store_true", help="actually replace what differs")
    a = ap.parse_args()

    root = Path(a.root)
    mpath = Path(a.manifest) if a.manifest else root / "_r2_manifest.json"
    manifest = json.load(open(mpath, encoding="utf-8")) if mpath.exists() else {}
    stamp = time.strftime("%Y-%m-%d")
    changed = 0
    for slug in a.lake:
        rows = plan(root, slug, a.files, a.worker)
        for name, status, detail in rows:
            print(f"  {slug}/{name:<28} {status}")
        if not a.write:
            continue
        for name, status, _ in rows:
            if status != "DIFFERS":
                continue
            aside = restore(root, slug, name, manifest, a.worker, stamp)
            if aside is None:
                print(f"  {slug}/{name}: the bucket had nothing to restore; left as it was")
                continue
            changed += 1
            print(f"  {slug}/{name}: restored from R2; the drive's copy is at {aside}")
    if a.write and changed:
        tmp = str(mpath) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh)
        os.replace(tmp, mpath)
        print(f"{changed} file(s) restored; manifest updated so the uploader does not push them back")
    elif not a.write:
        print("(report only -- pass --write to replace what DIFFERS)")


if __name__ == "__main__":
    main()
