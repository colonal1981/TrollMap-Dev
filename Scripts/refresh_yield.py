#!/usr/bin/env python3
"""
refresh_yield.py — how many lakes does a tile refresh actually put on the map?

THE QUESTION THIS ANSWERS
-------------------------
988 of 1,556 shipped packs have no `contours.geojson`, and every one of them reports
`charted > 0`. Sampled, they hold only 0 ft depth areas — New Lake reads 96% charted off four
zero-foot polygons.

Two explanations were on the table and I argued for the wrong one twice. First that the pipeline
asked for the wrong tile letter (it does not — B-only work lists exist, but the contour extraction
reads C). Then that `charted` is computed without checking the polygons carry a depth (still
possible, and still unmeasured). The third explanation is the one that survived contact with
evidence: **the card is a generation behind.** Adams Mill Pond went from nothing within 8.4 km to
22 contours at eleven depths on the same tile id from a newer store.

None of that says how MUCH. Bytes are the wrong unit — a 25-acre pond's whole bathymetry is a few
KB, so 25.9 MB of tile growth could be one big lake or a thousand ponds. The unit that matters is
LAKES, and this counts them.

WHAT IT DOES
------------
Reads the registry, and for each lake asks: is there a contour inside its bounds in the OLD
extraction, and is there one in the NEW? Four outcomes:

    GAINED      nothing before, something now      <- the number worth having
    IMPROVED    had contours, has more now
    UNCHANGED   same either way
    LOST        had contours, does not now         <- must be zero; if not, stop and look

`bounds_wsen` is present on all 3,194 registry records, so no lake is skipped for want of a box.

WHY BOUNDS AND NOT THE PACK
---------------------------
A pack is built by clipping to a boundary, and a boundary that is wrong produces an empty pack
from a full tile. Testing the tile output against the registry's own bbox measures the DATA, not
the build — so a lake that shows up here and still ships empty afterwards is a boundary bug, and
the two failures stay separable.

The bbox is generous by nature: a contour inside the box is not necessarily inside the lake. So
this is an upper bound on lakes gained, and it says so rather than pretending otherwise. It is the
right shape for "is a full rebuild worth it", which is the decision in front of us.

USAGE
-----
    py scripts/refresh_yield.py --registry registry/lake_index.json `
                                --old extract/contours --new extract_refresh/contours

Reads only.
"""
from __future__ import annotations
import argparse, gzip, json, os, sys
from collections import defaultdict

CELL = 0.01          # ~1.1 km. Small enough to keep a pond's cell list short, big enough that
                     # 2M vertices do not become 2M dict entries.


def load_features(path: str):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt", encoding="utf-8") as fh:
        return json.load(fh).get("features") or []


def tile_ids(root: str) -> set[str]:
    """Tile ids present in an extraction directory, letter stripped."""
    out = set()
    if not os.path.isdir(root):
        return out
    for name in os.listdir(root):
        if name.endswith(".geojson") or name.endswith(".geojson.gz"):
            out.add(name.split(".")[0][1:].upper())
    return out


def index_contours(root: str, only: set[str] | None = None) -> tuple[dict[tuple[int, int], int], int, int]:
    """
    Grid of occupied cells -> count of contour vertices, plus totals.

    Vertices rather than features, because "how much bathymetry is in this box" is the question
    and a single stitched contour can span a whole lake.
    """
    grid: dict[tuple[int, int], int] = defaultdict(int)
    files = 0
    verts = 0
    if not os.path.isdir(root):
        return grid, files, verts
    for name in sorted(os.listdir(root)):
        if not (name.endswith(".geojson") or name.endswith(".geojson.gz")):
            continue
        if only is not None and name.split(".")[0][1:].upper() not in only:
            continue
        try:
            feats = load_features(os.path.join(root, name))
        except Exception as e:                                  # a truncated file from a
            print(f"  !! {name}: {e}", file=sys.stderr)         # cancelled run looks like this
            continue
        files += 1
        for f in feats:
            g = f.get("geometry") or {}
            cs = g.get("coordinates") or []
            lines = [cs] if g.get("type") == "LineString" else cs
            for line in lines:
                for p in line:
                    try:
                        grid[(int(p[0] // CELL), int(p[1] // CELL))] += 1
                        verts += 1
                    except (TypeError, IndexError):
                        pass
    return grid, files, verts


def count_in_box(grid, bounds) -> int:
    w, s, e, n = bounds
    total = 0
    for x in range(int(w // CELL), int(e // CELL) + 1):
        for y in range(int(s // CELL), int(n // CELL) + 1):
            total += grid.get((x, y), 0)
    return total


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--registry", default="registry/lake_index.json")
    ap.add_argument("--old", default="extract/contours", help="the card's contour output")
    # NO DEFAULT. This compares one extract run against another, so the run being judged has to
    # be named; a default quietly pointed every invocation at extract_new_C/contours long after
    # that tray stopped being anybody's refresh output, and it is deleted now. A stale default
    # is a dependency in exactly the way a command in a docstring is.
    ap.add_argument("--new", required=True,
                    help="the refresh output to judge, e.g. extract_refresh/contours")
    ap.add_argument("--shipped-only", action="store_true",
                    help="only count lakes already marked shipped")
    ap.add_argument("--top", type=int, default=25, help="how many gained lakes to name")
    ap.add_argument("--all-tiles", action="store_true",
                    help="compare every tile in each directory rather than only the ones both "
                         "have. Answers 'what is in the new directory', NOT 'what did the "
                         "refresh buy'.")
    ap.add_argument("--min-vertices", type=int, default=200,
                    help="ignore a lake that gains fewer than this many vertices (default 200). "
                         "A generous bbox catches contours from the water next door: Dodsons "
                         "Lake 'gained' 7 vertices and Nesmith Pond 8, which is a corner clip, "
                         "not a survey.")
    a = ap.parse_args()

    with open(a.registry, encoding="utf-8") as fh:
        raw = json.load(fh)
    # The rows already carry `slug`, so dict(slug=k, **v) collides on it. Let the row's own slug
    # win and fall back to the map key only when it is absent.
    rows = raw if isinstance(raw, list) else [{**v, "slug": v.get("slug", k)} for k, v in raw.items()]

    # COMPARE THE SAME TILES OR MEASURE NOTHING.
    #
    # 2026-08-08, first run: old held 143 tiles and new held 189, and the report claimed 33 lakes
    # GAINED bathymetry. Most of those sat in the 46 tiles the old extraction never had, so the
    # "gain" was our own coverage changing, not Garmin's data. The totals said it too and I read
    # them the wrong way round: 196.8M vertices over 143 tiles against 273.2M over 189 is +39% in
    # aggregate and +5% PER TILE, and only the second number is about the refresh.
    #
    # So the default is the intersection. --all-tiles gives the raw comparison back for anyone who
    # genuinely wants "what does the new directory contain", which is a different question.
    old_ids, new_ids = tile_ids(a.old), tile_ids(a.new)
    shared = old_ids & new_ids
    scope = None if a.all_tiles else shared
    if not a.all_tiles and (old_ids - shared or new_ids - shared):
        print(f"comparing the {len(shared)} tiles present in BOTH extractions")
        print(f"  ignoring {len(old_ids - shared)} old-only and {len(new_ids - shared)} new-only "
              f"tiles — a tile only one side has cannot say anything about a refresh")
        print(f"  (--all-tiles to include them anyway)")

    print(f"indexing old contours from {a.old} ...")
    old, of, ov = index_contours(a.old, scope)
    print(f"  {of} tiles, {ov:,} vertices")
    print(f"indexing new contours from {a.new} ...")
    new, nf, nv = index_contours(a.new, scope)
    print(f"  {nf} tiles, {nv:,} vertices")
    if of and nf:
        print(f"  per tile: {ov / of:,.0f} -> {nv / nf:,.0f} vertices "
              f"({(nv / nf) / (ov / of) * 100 - 100:+.1f}%)")

    # The refresh is a SUBSET of tiles. A lake outside every refreshed tile is not "lost", it is
    # untouched -- so old is the baseline and new is only ever additive where it has coverage.
    gained, improved, unchanged, lost = [], [], [], []
    skipped = 0
    trivial = 0
    for r in rows:
        b = r.get("bounds_wsen")
        if not (isinstance(b, list) and len(b) == 4):
            skipped += 1
            continue
        if a.shipped_only and not r.get("shipped"):
            continue
        o = count_in_box(old, b)
        n = count_in_box(new, b)
        if n == 0:
            if o:
                unchanged.append(r)          # not refreshed; the card still has it
            continue
        if o == 0:
            if n < a.min_vertices:
                trivial += 1
                continue
            gained.append((r, n))
        elif n > o:
            improved.append((r, o, n))
        else:
            unchanged.append(r)

    print()
    print(f"lakes with a bbox: {len(rows) - skipped}"
          + (f"  ({skipped} skipped, no bounds)" if skipped else ""))
    print(f"  GAINED   bathymetry where there was none : {len(gained)}")
    print(f"  IMPROVED more than before                : {len(improved)}")
    if trivial:
        print(f"  (excluded {trivial} lakes that gained under {a.min_vertices} vertices — "
              f"a bbox corner clip, not a survey)")
    print(f"  (lakes outside the refreshed tiles are untouched, not counted either way)")

    if gained:
        gained.sort(key=lambda t: -(t[0].get("area_acres") or 0))
        print(f"\nlargest lakes that gain contours (bbox test — an upper bound):")
        for r, n in gained[:a.top]:
            acres = r.get("area_acres") or 0
            print(f"  {str(r.get('name'))[:38]:<38} {acres:>9,.0f} ac  "
                  f"{r.get('state','--')}  {n:>7,} vertices  "
                  f"charted={r.get('charted')}  shipped={r.get('shipped')}")

    # The honest caveat, printed rather than left in a docstring nobody opens.
    print("\nThe bbox is generous: a contour inside a lake's box is not proof it is inside the")
    print("lake. Treat GAINED as an upper bound and confirm a couple by eye before rebuilding.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
