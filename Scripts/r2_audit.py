#!/usr/bin/env python3
"""
r2_audit.py — what is actually in the R2 bucket, and what of it can go.

    py .\\r2_audit.py                                   # audit the live bucket
    py .\\r2_audit.py --save F:\\TrollMapPipeline\\registry\\_r2_listing.json
    py .\\r2_audit.py --from F:\\TrollMapPipeline\\registry\\_r2_listing.json
    py .\\r2_audit.py --delete-list F:\\TrollMapPipeline\\registry\\_r2_delete.txt

WHY THIS EXISTS

On 2026-08-04 the bucket was 11.49 GB against a 10 GB free tier and the question "what is in
there?" had no answer that did not involve clicking through a dashboard. The answer mattered,
because the plan on the table was deleting Tennessee -- 225 waters -- to get back under, and
nobody had checked whether the bytes were even in the lakes.

They were not, entirely. 9.17 GB of the 11.49 was chartpack GeoJSON uploaded uncompressed
because of a Worker header bug (see upload_garmin_to_r2.py), and a further 0.7 GB was layers
nothing reads.

THIS SCRIPT NEVER DELETES ANYTHING. It reads the bucket and, with --delete-list, writes a file
of exact object keys. prune_r2_objects.py --list does the deleting, and only after you have
read the file. Two steps on purpose: a script that both decides and destroys is one bad glob
away from taking a state with it.

WHAT GOES ON THE DELETE LIST, AND WHY EACH RULE IS SAFE

  pipeline-only layers   waterbody.geojson, hydrography.geojson on any slug. These are BUILD
                         inputs -- waterbody carries the mode 6/20 lake_id that attributes a
                         pack to a lake, and that happens on disk, before upload. Verified
                         2026-08-03 across the whole tree: zero client references, zero Worker
                         references. The rule is imported from upload_garmin_to_r2.py rather
                         than restated, so it cannot drift from what the uploader believes.

  coastal secondary      A coastal zone outside the Edisto-to-Murrells band ships docks, POIs
                         and shoreline only -- Ryan, 2026-08-03: "the other areas are perfectly
                         fine with NOAA and the garmin poi/docks." Contours and depth_areas on
                         those zones predate the rule. Same import, same reason.

  skip slugs             sc_ga_coastal and saluda_river_arm, which the uploader already refuses
                         to push and which exist in R2 only from before it did.

ORPHANS ARE REPORTED, NOT LISTED. A slug in R2 with no registry entry is usually stale, but 23
of the 39 found on 2026-08-04 were still named in js/ -- deleting those removes a lake from the
app. They need a decision per slug, so they get printed with their size and left alone.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

# The rules live in the uploader. Importing them means "what R2 should hold" has exactly one
# definition; a copy here would be correct today and wrong the first time either file moved.
from upload_garmin_to_r2 import (
    LAYERS, PIPELINE_ONLY, COASTAL_PRIMARY, COASTAL_SECONDARY_LAYERS, SKIP_SLUGS,
)
# The coastal pipeline writes *.geojson filenames where the Garmin uploader names layers, so
# it keeps its own spelling of the same tier. Both are imported: a secondary zone is allowed
# whatever EITHER uploader would legitimately ship it, and nothing else.
from upload_to_r2_coastal import (
    COASTAL_SECONDARY_LAYERS as COASTAL_SECONDARY_FILES,
    HEAVY_LAYERS as COASTAL_HEAVY_FILES,
)

WORKER = "https://trollmap-worker.colonal1981.workers.dev"
FILE_TO_LAYER = {fname: layer for layer, fname in LAYERS.items()}

# Everything this script is willing to have an opinion about. index.json, meta.json and
# vectors/contours.geojson are not in here and are never proposed for deletion -- an audit that
# guesses at files it does not recognise is how a delete list eats something load-bearing.
KNOWN_PACK_FILES = set(LAYERS.values()) | set(COASTAL_SECONDARY_FILES) | set(COASTAL_HEAVY_FILES)

# What a coastal zone outside the Edisto-to-Murrells band is allowed to keep: structure from
# either uploader's vocabulary, bathymetry from neither.
KEEP_ON_SECONDARY_COAST = (
    {LAYERS[l] for l in COASTAL_SECONDARY_LAYERS if l in LAYERS} | set(COASTAL_SECONDARY_FILES)
)

# Top-level prefixes that are not lake/coastal packs. Sized and reported, never proposed for
# deletion: research is 1,616 documents that cost real API calls to fetch.
NON_PACK_PREFIXES = ("research", "lake_packages", "lakes", "regulations", "boundaries",
                     "supplemental", "_registry", "_all")


def fetch_listing(worker: str) -> dict:
    url = f"{worker.rstrip('/')}/chartpacks/list?detail=1"
    print(f"reading {url}", file=sys.stderr)
    with urllib.request.urlopen(url, timeout=300) as r:
        return json.loads(r.read().decode("utf-8"))


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024 or unit == "GB":
            return f"{n:,.1f} {unit}" if unit != "B" else f"{n:,.0f} B"
        n /= 1024
    return f"{n:.1f} GB"


def is_pack(name: str) -> bool:
    return not name.startswith(NON_PACK_PREFIXES)


def deletable(name: str, fname: str) -> str | None:
    """Reason this exact object should not be in R2, or None to keep it."""
    if name in SKIP_SLUGS:
        return "skip-slug"
    if fname not in KNOWN_PACK_FILES:
        return None                      # index.json, meta.json, vectors/... -- not ours to judge
    if FILE_TO_LAYER.get(fname) in PIPELINE_ONLY:
        return "pipeline-only"
    if name.startswith("coast_") and name not in COASTAL_PRIMARY:
        if fname not in KEEP_ON_SECONDARY_COAST:
            return "coastal-secondary"
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--worker", default=WORKER)
    ap.add_argument("--from", dest="src", help="read a saved listing instead of the live bucket")
    ap.add_argument("--save", help="write the raw listing here (re-run offline with --from)")
    ap.add_argument("--delete-list", help="write the proposed delete keys here, one per line")
    ap.add_argument("--registry", help="registry/lake_index.json, to name orphan slugs")
    a = ap.parse_args()

    data = json.loads(Path(a.src).read_text(encoding="utf-8")) if a.src else fetch_listing(a.worker)
    if a.save:
        Path(a.save).write_text(json.dumps(data), encoding="utf-8")
        print(f"saved listing -> {a.save}")

    packs = data.get("chartpacks", [])
    if packs and isinstance(packs[0].get("files", [None])[0], str):
        raise SystemExit("that listing has no per-object sizes -- fetch it with ?detail=1 "
                         "(the Worker must be at worker-2026-08-05a or later)")

    total_bytes = total_objs = 0
    gz_bytes = raw_bytes = gz_objs = raw_objs = 0
    by_prefix: dict[str, list[int]] = defaultdict(lambda: [0, 0])   # bytes, objects
    by_layer: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    delete: list[tuple[str, int, str]] = []                          # key, bytes, reason
    by_reason: dict[str, list[int]] = defaultdict(lambda: [0, 0])

    for pack in packs:
        name = pack["name"]
        group = name if not is_pack(name) else "«packs»"
        for f in pack["files"]:
            fname, nbytes = f["name"], f.get("bytes", 0)
            total_bytes += nbytes
            total_objs += 1
            by_prefix[group][0] += nbytes
            by_prefix[group][1] += 1
            if f.get("gzip"):
                gz_bytes += nbytes
                gz_objs += 1
            else:
                raw_bytes += nbytes
                raw_objs += 1
            if is_pack(name):
                layer = FILE_TO_LAYER.get(fname, fname)
                by_layer[layer][0] += nbytes
                by_layer[layer][1] += 1
                why = deletable(name, fname)
                if why:
                    delete.append((f"{name}/{fname}", nbytes, why))
                    by_reason[why][0] += nbytes
                    by_reason[why][1] += 1

    print(f"\nR2 bucket: {human(total_bytes)} in {total_objs:,} objects, "
          f"{len(packs):,} top-level prefixes")
    print(f"  stored gzipped: {human(gz_bytes)} in {gz_objs:,} objects")
    print(f"  stored raw:     {human(raw_bytes)} in {raw_objs:,} objects")
    if raw_objs and gz_objs:
        print("  -- MIXED. A re-upload is part way through, or one of the three uploaders "
              "still has --no-gzip.")
    elif raw_objs:
        print("  -- nothing is compressed. Deploy the Worker, then re-run upload_garmin_to_r2.py.")

    print("\nby prefix")
    for k, (b, n) in sorted(by_prefix.items(), key=lambda kv: -kv[1][0]):
        print(f"  {human(b):>10}  {n:>6,} obj  {k}")

    print("\npack layers")
    for k, (b, n) in sorted(by_layer.items(), key=lambda kv: -kv[1][0]):
        print(f"  {human(b):>10}  {n:>6,} obj  {k}")

    print("\nproposed deletions")
    if not delete:
        print("  nothing -- every rule this script knows about is already satisfied")
    for k, (b, n) in sorted(by_reason.items(), key=lambda kv: -kv[1][0]):
        print(f"  {human(b):>10}  {n:>6,} obj  {k}")
    if delete:
        db = sum(b for _, b, _ in delete)
        print(f"  {human(db):>10}  {len(delete):>6,} obj  TOTAL "
              f"({100 * db / max(total_bytes, 1):.1f}% of the bucket)")

    if a.registry:
        known = set()
        try:
            idx = json.loads(Path(a.registry).read_text(encoding="utf-8"))
            # lake_index.json is a DICT KEYED BY SLUG -- 1,726 entries, verified 2026-08-05.
            # Reading it as a list of rows (or as {"lakes": [...]}, which is the OTHER registry
            # file, lakes.json) yields an empty set, and an empty set of known slugs makes every
            # slug in R2 look like an orphan. The `if known:` guard below is what stops that
            # from becoming a 1,562-line delete proposal, so both shapes are handled here.
            if isinstance(idx, dict) and "lakes" not in idx:
                known = {k for k in idx if isinstance(k, str)}
            else:
                rows = idx if isinstance(idx, list) else idx.get("lakes", [])
                known = {r.get("slug") or r.get("key") for r in rows if isinstance(r, dict)}
        except Exception as exc:
            print(f"\n!! could not read {a.registry}: {type(exc).__name__}: {exc}")
        if not known:
            print(f"\n!! {a.registry} parsed but yielded no slugs -- skipping the orphan report "
                  "rather than calling everything an orphan")
        if known:
            orphans = [(p["name"], p["bytes"]) for p in packs
                       if is_pack(p["name"]) and p["name"] not in known
                       and p["name"] not in SKIP_SLUGS]
            ob = sum(b for _, b in orphans)
            print(f"\norphan slugs (in R2, not in the registry): {len(orphans)}, {human(ob)}")
            print("  NOT on the delete list. Some of these are still named in js/, and deleting")
            print("  one of those removes the lake from the app. Decide per slug.")
            for n, b in sorted(orphans, key=lambda x: -x[1])[:40]:
                print(f"  {human(b):>10}  {n}")
            if len(orphans) > 40:
                print(f"  ... and {len(orphans) - 40} more")

    if a.delete_list:
        out = Path(a.delete_list)
        lines = ["# Written by r2_audit.py. Read this before running prune_r2_objects.py --go.",
                 "# Every line is one exact R2 object key. Delete a line to spare that object.",
                 ""]
        for reason in sorted(by_reason):
            b, n = by_reason[reason]
            plural = "" if n == 1 else "s"
            lines.append(f"# ---- {reason}: {n:,} object{plural}, {human(b)} ----")
            lines += [k for k, _, why in sorted(delete) if why == reason]
            lines.append("")
        out.write_text("\n".join(lines), encoding="utf-8")
        print(f"\nwrote {len(delete):,} keys -> {out}")
        print("review it, then:  py .\\prune_r2_objects.py --list "
              f'"{out}"        (add --go to actually delete)')
    elif delete:
        print("\nre-run with --delete-list <path> to write these keys out for review")
    return 0


if __name__ == "__main__":
    sys.exit(main())
