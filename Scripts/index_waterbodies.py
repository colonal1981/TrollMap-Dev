#!/usr/bin/env python3
"""
index_waterbodies.py — reduce the 100 GB waterbodies_named/ folder to a ~10 MB index.

    py index_waterbodies.py --src F:\\TrollMapPipeline\\waterbodies_named ^
                            --out F:\\TrollMapPipeline\\waterbodies_index.jsonl

Then the 100 GB can be deleted.

WHY
`waterbodies_named/` is 70,685 derived polygons, ~100 GB, and it has been superseded as a
lake list by `build_lake_registry.py` (which reads 3DHP directly, keyed by gnisid). But it is
not worthless yet, because the two are built from DIFFERENT sources:

    registry            lakes that exist in 3DHP
    waterbodies_named   water where GARMIN actually put contours

Those sets are not identical. If Garmin surveyed water 3DHP has no polygon for — or types
outside the Lake/River filter — the registry misses it and this folder is the only record.

THE TEST THAT DECIDES IT
After the card-wide extract, assign the contours and look at `_unassigned/contours.geojson`.
Near zero means the registry covers everything Garmin has. Substantial means those contours
sit on water the registry does not know about, and this index tells you WHICH water, by
name, type, area and position.

Running that test needs a name, a type, an area and a location per waterbody. It does not
need the geometry, which is ~99.99% of the bytes. So: keep the index, delete the polygons.

Output is JSONL, one row per waterbody:
    {"slug","name","type","area_km2","max_depth_ft","lon","lat","bytes"}

Reads only the first ~3 KB of each file — properties and the first coordinate both live
there — so it is I/O-bound on file count, not file size. Threaded, resumable, and it never
loads a polygon.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse, json, os, re, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SUFFIX = "_3dhp.geojson"


def head_row(path, name, nbytes=3000):
    """properties + the first coordinate, from one short read."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(nbytes).decode("utf-8", "replace")
        size = os.path.getsize(path)
    except OSError:
        return None
    pr = None
    i = head.find('"properties"')
    if i >= 0:
        j = head.find("{", i)
        depth = 0
        for k in range(j, len(head)):
            if head[k] == "{":
                depth += 1
            elif head[k] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        pr = json.loads(head[j:k + 1])
                    except Exception:
                        pr = None
                    break
    pr = pr or {}
    m = re.search(r'"coordinates"\s*:\s*\[+\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)', head)
    return {"slug": name[:-len(SUFFIX)],
            "name": pr.get("name"),
            "type": pr.get("feature_type"),
            "area_km2": pr.get("approx_area_km2"),
            "max_depth_ft": pr.get("max_depth_ft"),
            "lon": round(float(m.group(1)), 6) if m else None,
            "lat": round(float(m.group(2)), 6) if m else None,
            "bytes": size}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--threads", type=int, default=64,
                    help="the bottleneck is per-file latency, not CPU")
    ap.add_argument("--resume", action="store_true",
                    help="skip slugs already present in --out")
    args = ap.parse_args()

    src, out = Path(args.src), Path(args.out)
    done = set()
    if args.resume and out.exists():
        with open(out, encoding="utf-8") as fh:
            for line in fh:
                try:
                    done.add(json.loads(line)["slug"])
                except Exception:
                    pass
        print(f"resuming: {len(done):,} already indexed", flush=True)

    names = [e.name for e in os.scandir(src)
             if e.is_file() and e.name.endswith(SUFFIX)
             and e.name[:-len(SUFFIX)] not in done]
    print(f"{len(names):,} files to index, {args.threads} threads", flush=True)

    t0 = time.time()
    total_bytes = 0
    n = 0
    with open(out, "a", encoding="utf-8") as fh, \
            ThreadPoolExecutor(max_workers=args.threads) as ex:
        for row in ex.map(lambda nm: head_row(str(src / nm), nm), names, chunksize=32):
            if not row:
                continue
            fh.write(json.dumps(row, separators=(",", ":")) + "\n")
            total_bytes += row["bytes"]
            n += 1
            if n % 5000 == 0:
                print(f"  ...{n:,}/{len(names):,}  ({time.time()-t0:.0f}s)", flush=True)

    idx = out.stat().st_size
    print(f"\n{n:,} rows -> {out}  ({idx/1e6:.1f} MB)")
    print(f"indexed {total_bytes/1e9:.1f} GB of source polygons")
    if total_bytes:
        print(f"reduction: {total_bytes/max(idx,1):,.0f}x")
    print("\nThe polygons can now be deleted. Keep this index and _progress.json.")
    print("Before deleting, run the coverage test: after the card-wide extract, assign")
    print("contours and check _unassigned/contours.geojson against this index.")


if __name__ == "__main__":
    main()
