#!/usr/bin/env python3
"""
tile_store_diff.py — compare two Garmin tile stores and say what a re-extract would buy.

WHY THIS EXISTS
---------------
2026-08-08. Goodale State Park's pond (Adams Mill Pond, 25.5 ac) shipped with no contours, one
0 ft depth-area polygon, and `charted: 0.2842`. The pipeline was blamed twice — wrongly, both
times. What was actually true: our card is a generation behind.

    OLD C4E0F1 (card, May 10)      12,129 contours    0 in the pond    nearest 8.40 km
    NEW C4E0F1 (ActiveCaptain)     15,127 contours   22 in the pond    nearest 0.08 km

Same tile id, same extractor, unmodified. 3,000 more contour features, and eleven depths inside
a pond that previously had none.

988 of 1,556 shipped packs have no contours at all. Some unknown share of that is this.

THE CATCH, WHICH IS WHY THIS IS A DIFF AND NOT A SWAP
-----------------------------------------------------
Ryan: "the issue with active captain is that i have to zoom over an area for it to download the
new maps... that is why this was less than 1gb but the full pack is i think 15gb."

ActiveCaptain's cache holds only water that has been panned over. It is NEWER but SPARSE.
Extracting from it wholesale would trade stale coverage for missing coverage. So the answer is a
MERGE — prefer the newer tile where one exists, fall back to the card — and the first thing
anyone needs is an honest count of what each store actually holds.

Both stores use the same content-addressed layout, `<hh>/<hh>/<TILEID>/<LETTER><TILEID>.GMP`, so
the tile id is read off the filename rather than the path.

USAGE
-----
    py scripts/tile_store_diff.py --card  "F:/TrollMapPipeline/garmin/charts/Tiles" \\
                                  --new   "F:/TrollMapPipeline/Bluestacks_ActiveCaptain_Tiles" \\
                                  --out-tiles registry/_tiles_refresh.txt

Compares B, C and G in ONE walk by default. Ryan, 2026-08-08, on the first version, which took
`--letter` and therefore needed running once per letter: "did you check whether the B tiles are
newer or the G? you just like having me run this extraction a dozen times lol". He was right.

`--out-tiles` writes the ids that are newer or new, one per line, which is exactly what
`trollmap_extract_all.py --tiles @file` consumes. Extract those from the NEW store; everything
else still comes from the card.

Nothing is copied, moved or deleted. This reads and counts.
"""
from __future__ import annotations
import argparse, os, sys
from collections import defaultdict


def scan_many(root: str, letters: list[str]):
    """One walk, every letter. Returns (letter -> {tile id: (size, mtime, path)}, duplicates)."""
    out: dict[str, dict[str, tuple[int, float, str]]] = {c: {} for c in letters}
    dupes: dict[str, dict[str, list[str]]] = {c: {} for c in letters}
    want = set(letters)
    for dp, _dn, fn in os.walk(root):
        for f in fn:
            up = f.upper()
            if not (up.endswith(".GMP") or up.endswith(".MAR")):
                continue
            stem = f[:-4]
            if not stem or stem[0].upper() not in want:
                continue
            letter = stem[0].upper()
            # `C4E0F9-u7.GMP` is an update generation of C4E0F9. Compare on the bare id and let
            # the largest file win, so a base and its update do not read as two tiles.
            tile = stem[1:].split("-")[0].upper()
            p = os.path.join(dp, f)
            try:
                st = os.stat(p)
            except OSError:
                continue
            prev = out[letter].get(tile)
            if prev is not None:
                dupes[letter].setdefault(tile, [prev[2]]).append(p)
            if prev is None or st.st_size > prev[0]:
                out[letter][tile] = (st.st_size, st.st_mtime, p)
    return out, dupes


def report_dupes(label: str, root: str, dupes: dict[str, dict[str, list[str]]]) -> int:
    """
    THE SAME TILE ID UNDER TWO PATHS IS A TRAP, BECAUSE THIS SCRIPT SURVIVES IT AND THE
    EXTRACTOR DOES NOT.

    2026-08-08. `Bluestacks_ActiveCaptain_Tiles` turned out to contain a nested copy of itself —
    an older partial pull at the top level and the complete one under `Tiles/`. 281 C files, 219
    distinct ids. This script collapses by id and keeps the largest, so its numbers were right.
    `trollmap_extract_all.py` walks FILES with no dedup, so a 190-id list queued 243 tiles and
    whichever copy finished last would have overwritten the other. Non-deterministic, and silent.

    Ryan spotted it because the tile count did not match the list he had just been handed. He
    should not have had to. So: say it here, before anything is extracted.
    """
    total = sum(len(v) for v in dupes.values())
    if not total:
        return 0
    print(f"!! {label} ({root}) holds the same tile id at more than one path.")
    print("   This script keeps the largest copy. trollmap_extract_all.py does NOT dedup — it")
    print("   would decode every copy and let the last one written win. Point --new at the ONE")
    print("   complete subdirectory before extracting.")
    for letter, ids in dupes.items():
        if not ids:
            continue
        print(f"   {letter}: {len(ids)} duplicated ids. Example:")
        tile, paths = next(iter(ids.items()))
        for p in paths[:3]:
            try:
                print(f"     {os.stat(p).st_size / 1e6:8.2f} MB  {p}")
            except OSError:
                print(f"     {'?':>8}     {p}")
    # Name the common shape rather than making the reader infer it.
    roots = {p.split(os.sep)[len(root.rstrip(os.sep).split(os.sep))] if os.sep in p else p
             for ids in dupes.values() for paths in ids.values() for p in paths}
    if len(roots) > 1:
        print(f"   The copies diverge at: {', '.join(sorted(r for r in roots if r)[:6])}")
    print()
    return total


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024 or unit == "GB":
            return f"{n:,.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} GB"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--card", required=True, help="the full, older store")
    ap.add_argument("--new", required=True, help="the ActiveCaptain cache")
    ap.add_argument("--letters", default="BCG",
                    help="which tile letters to compare. C is bathymetry (contours, depth areas),"
                         " B is structure, labels, POIs, docks and shoreline, G is the MAR "
                         "auto-guidance navmesh. Default BCG — all of them, in ONE walk of the "
                         "stores, because walking 2,589 tile directories three times to answer "
                         "one question is how a refresh turns into a weekend.")
    ap.add_argument("--out-tiles", help="write the ids worth re-extracting, one per line")
    ap.add_argument("--min-growth", type=float, default=0.0,
                    help="only count a tile as improved if it grew by at least this fraction "
                         "(0.02 = 2%%). Guards against a re-extract triggered by noise.")
    a = ap.parse_args()

    for label, root in (("card", a.card), ("new", a.new)):
        if not os.path.isdir(root):
            print(f"error: --{label} is not a directory: {root}", file=sys.stderr)
            return 2

    letters = [c for c in a.letters.upper() if c.isalnum()]
    # ONE walk per store, all letters collected at once. The first version took --letter and had
    # to be re-run per letter; Ryan, 2026-08-08: "did you check whether the B tiles are newer or
    # the G? you just like having me run this extraction a dozen times lol". Fair.
    card_all, card_dupes = scan_many(a.card, letters)
    new_all, new_dupes = scan_many(a.new, letters)
    dup_total = (report_dupes("the new store", a.new, new_dupes)
                 + report_dupes("the card", a.card, card_dupes))

    WHAT = {"C": "bathymetry — contours and depth areas",
            "B": "structure — labels, POIs, docks, shoreline",
            "G": "MAR — the auto-guidance navmesh"}
    refresh_ids: set[str] = set()
    by_letter: dict[str, list[str]] = {}
    any_only_card = 0

    for letter in letters:
        card = card_all.get(letter, {})
        new = new_all.get(letter, {})
        if not card and not new:
            continue

        grew, shrank, same, only_new, only_card = [], [], [], [], []
        for tile, (sz, mt, p) in sorted(new.items()):
            if tile not in card:
                only_new.append((tile, sz, p))
                continue
            osz = card[tile][0]
            if sz > osz * (1 + a.min_growth):
                grew.append((tile, osz, sz, p))
            elif sz < osz:
                shrank.append((tile, osz, sz))
            else:
                same.append(tile)
        for tile in sorted(card):
            if tile not in new:
                only_card.append(tile)
        any_only_card = max(any_only_card, len(only_card))

        print(f"=== {letter}  {WHAT.get(letter, '')}")
        print(f"  card {len(card):5d} tiles   {human(sum(v[0] for v in card.values()))}")
        print(f"  new  {len(new):5d} tiles   {human(sum(v[0] for v in new.values()))}")
        print(f"  bigger {len(grew)}   identical {len(same)}   SMALLER {len(shrank)}"
              f"   only-new {len(only_new)}   only-card {len(only_card)}")

        if grew:
            gain = sum(s - o for _, o, s, _ in grew)
            print(f"  gained on overlapping tiles: {human(gain)}")
            for tile, osz, sz, _ in sorted(grew, key=lambda r: r[1] - r[2])[:5]:
                pct = (sz - osz) / osz * 100 if osz else float("inf")
                print(f"    {tile:<8} {human(osz):>10} -> {human(sz):>10}  (+{pct:.0f}%)")
        if shrank:
            # Sub-1% is re-compression, not a truncated download. Both are excluded from the
            # refresh list on the same rule: bigger is more complete.
            worst = min((sz - osz) / osz for _, osz, sz in shrank) * 100
            print(f"  smaller: {len(shrank)}, worst {worst:.1f}% — kept from the card")
        print()

        by_letter[letter] = sorted({t for t, *_ in grew} | {t for t, *_ in only_new})
        refresh_ids.update(by_letter[letter])

    if a.out_tiles:
        # ONE LIST PER LETTER, NOT A UNION.
        #
        # The first version wrote a single union file and told you to run `--letters BC` against
        # it. That is wrong and it would have cost data: the extractor takes the tile id, strips
        # the letter, and pulls EVERY requested letter from the new store. So a tile whose C grew
        # but whose B shrank 15% would have had its good card-derived B output overwritten by the
        # worse one. Measured on Ryan's stores: C is a clean win (190 up, 29 down and all within
        # 1%), while B is 119 up against 100 DOWN and G is 106 up against 77 down, one of them by
        # 84.7%. Those are not the same product, and they must not travel together.
        base, ext = os.path.splitext(os.path.abspath(a.out_tiles))
        os.makedirs(os.path.dirname(base) or ".", exist_ok=True)
        print("wrote one list per letter — extract each SEPARATELY:")
        for letter in letters:
            ids = by_letter.get(letter) or []
            if not ids:
                continue
            p = f"{base}_{letter}{ext or '.txt'}"
            with open(p, "w", encoding="utf-8") as fh:
                fh.write("\n".join(ids) + "\n")
            print(f"  {letter}: {len(ids):4d} ids -> {p}")
            if letter in "BC":
                print(f"       py scripts/trollmap_extract_all.py \"{a.new}\" "
                      f"--out extract_new_{letter} \\")
                print(f"          --letters {letter} --tiles @{p} --gzip --jobs 4")
            else:
                print("       G/MAR has its own reader, gmapmf_mar_v1.py — "
                      "trollmap_extract_all.py does not read it.")
        print("\n  Merge each letter's output OVER the card's, never instead of it. Tiles absent")
        print("  from a list keep whatever the card produced, which is the point.")

    if any_only_card:
        print(f"\nDO NOT point the extractor at the new store alone: up to {any_only_card} tiles "
              "exist only on the card and would silently vanish.")
    if dup_total:
        print("\nRESOLVE THE DUPLICATE PATHS ABOVE FIRST. The counts here are deduplicated; the "
              "extractor's are not, so they will not match and the mismatch is the good case.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
