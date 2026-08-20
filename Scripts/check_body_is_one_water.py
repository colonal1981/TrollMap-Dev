#!/usr/bin/env python3
r"""check_body_is_one_water.py -- is a derived body one water, or several welded together?

    py .\scripts\check_body_is_one_water.py --slug-file worklist.txt --out split.json --resume

WHY

Ryan, 2026-08-20, working down the map by eye:

    035855  "sitting on land between lake patrick, duck pond, lake bobben"
    038270  "land but dogwood lake is nearby and so is canoochee creek"
    041295  "land"
    043950  "land next to a label that says Big Lake Dam"
    022221  "sitting on a dam that says williams lake dam"
    028920  "Dearing Number 11 lake or number 12 ... it sits on the dam between them"

Seven of the fifty-eight land on dry ground, and two more on a dam. That is not Garmin charting
a field. `derive_waterbodies.py` rasterises contour presence onto a 150 m grid and takes
connected components -- its own docstring says "two contours closer than this join into one
lake". Two ponds 150 m apart become ONE body whose centroid falls on the land between them, and
whose area is the sum of both.

So the centroid of a derived body is not a location of water, and the area is not the area of
a lake. This re-runs the same connected-component logic at a FINER cell and reports how many
pieces the body actually holds, with the size and centre of each.

    slug            pieces  largest   centres
    garmin_035855        3     41%    -83.3612,31.4108 | -83.3583,31.4136 | -83.3641,31.4092
    garmin_020305        1    100%    -83.8955,33.5852

One piece means one water and the centroid means something. Several means the 150 m grid welded
neighbours, and each piece has to be judged on its own -- which is also why "nearest registry
water" measured from a welded centroid is worth little.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse, glob, gzip, json, math, os, sys
from collections import defaultdict, deque

BIAS = 1 << 21
SHIFT = 1 << 22


def vertices(c):
    st = [c]
    while st:
        x = st.pop()
        if not x:
            continue
        if isinstance(x[0], (int, float)):
            yield x
        else:
            st.extend(x)


def footprint(path):
    """Extent of the derived polygon, or None."""
    try:
        g = json.load(open(path, encoding="utf-8"))
    except Exception:
        return None
    xs, ys = [], []
    st = [(f.get("geometry") or {}).get("coordinates") for f in g.get("features", [g])]
    while st:
        c = st.pop()
        if not c:
            continue
        if isinstance(c[0], (int, float)):
            xs.append(c[0]); ys.append(c[1])
        else:
            st.extend(c)
    return [min(xs), min(ys), max(xs), max(ys)] if xs else None


def search_box(rec, stub):
    """Union of the derived polygon's extent and a circle of the body's area at its centroid.

    NEITHER ALONE IS RIGHT, which cost a whole wrong run on 2026-08-20.

      * The circle assumes a round lake. garmin_020305 is the Yellow River: 0.562 km2 spread
        over a ribbon roughly 20 km by 53 km. Its equivalent-area circle is 423 m across and
        lands in a gap between contours -- zero vertices, and a confident "0 pieces".
      * The polygon is sometimes a fragment. garmin_013922 is 0.945 km2 and its file's extent is
        69 m by 125 m, which is the multipart bug showing up in the derived layer too.

    So: both, union'd. Too big is recoverable -- a neighbouring water shows up as an extra piece
    and gets judged. Too small is not: it reports nothing and nothing looks like an answer.
    """
    r_km = math.sqrt(max(rec.get("area_km2") or 0.0, 1e-6) / math.pi)
    dlat = r_km / 110.54
    dlon = r_km / (111.32 * max(0.05, math.cos(math.radians(rec["lat"]))))
    b = [rec["lon"] - dlon, rec["lat"] - dlat, rec["lon"] + dlon, rec["lat"] + dlat]
    if stub:
        b = [min(b[0], stub[0]), min(b[1], stub[1]), max(b[2], stub[2]), max(b[3], stub[3])]
    return b


def components(cells, cx, cy):
    """Connected components over occupied cells, 8-neighbour -- same shape as derive_waterbodies."""
    NB = [dx * SHIFT + dy for dx in (-1, 0, 1) for dy in (-1, 0, 1) if dx or dy]
    seen, out = set(), []
    for k in cells:
        if k in seen:
            continue
        seen.add(k)
        q, m = deque([k]), [k]
        while q:
            j = q.popleft()
            for off in NB:
                n = j + off
                if n in cells and n not in seen:
                    seen.add(n); q.append(n); m.append(n)
        xs = [(v // SHIFT - BIAS + 0.5) * cx for v in m]
        ys = [(v % SHIFT - BIAS + 0.5) * cy for v in m]
        out.append((len(m), sum(xs) / len(xs), sum(ys) / len(ys)))
    out.sort(key=lambda t: -t[0])
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--extract", default="extract")
    ap.add_argument("--index", default=os.path.join(
        "registry", "_reference", "waterbodies_index_3dhp_nationwide.jsonl"))
    ap.add_argument("--bodies", default=os.path.join(
        "_to_delete", "sweep_2026-08-19", "waterbodies_named"),
        help="folder of <slug>_3dhp.geojson derived polygons")
    ap.add_argument("--slug-file", required=True)
    ap.add_argument("--out", default="body_split.json")
    ap.add_argument("--cell-m", type=float, default=40.0,
                    help="finer than derive_waterbodies' 150 m; that coarseness is the thing "
                         "being tested, so it cannot also be the test")
    ap.add_argument("--lat-ref", type=float, default=34.0)
    ap.add_argument("--min-cells", type=int, default=2,
                    help="ignore specks; a single stray vertex is not a piece of water")
    ap.add_argument("--max-tiles", type=int, default=0)
    ap.add_argument("--resume", action="store_true")
    a = ap.parse_args()

    want = {l.strip() for l in open(a.slug_file, encoding="utf-8-sig")
            if l.strip() and not l.startswith("#")}
    recs = {}
    with open(a.index, encoding="utf-8") as fh:
        for line in fh:
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("slug") in want and r.get("lon") is not None:
                recs[r["slug"]] = r
    boxes = {s: search_box(r, footprint(os.path.join(a.bodies, s + "_3dhp.geojson")))
             for s, r in recs.items()}

    cy = a.cell_m / 110540.0
    cx = a.cell_m / (111320.0 * math.cos(math.radians(a.lat_ref)))

    tb = {}
    for f in glob.glob(os.path.join(a.extract, "_tile_bbox_*.json")):
        for k, v in json.load(open(f, encoding="utf-8")).items():
            b = (v or {}).get("b")
            if isinstance(b, list) and len(b) == 4:
                tb[k.split(".")[0][1:]] = b
    have = {os.path.basename(p).split(".")[0][1:]
            for p in glob.glob(os.path.join(a.extract, "contours", "*.gz"))}
    need = defaultdict(list)
    for s, b in boxes.items():
        for tid, t in tb.items():
            if tid in have and not (b[2] < t[0] or b[0] > t[1] or b[3] < t[2] or b[1] > t[3]):
                need[tid].append((s, b))

    state = {"tiles": [], "cells": {}}
    if a.resume and os.path.exists(a.out):
        state = json.load(open(a.out, encoding="utf-8"))
    todo = [t for t in sorted(need) if t not in state["tiles"]]
    if a.max_tiles:
        todo = todo[:a.max_tiles]

    for i, tid in enumerate(todo, 1):
        p = os.path.join(a.extract, "contours", "C%s.geojson.gz" % tid)
        if os.path.exists(p):
            try:
                with gzip.open(p, "rt", encoding="utf-8") as fh:
                    fc = json.load(fh)
            except Exception:
                fc = {"features": []}
            for f in fc.get("features") or []:
                for x, y in vertices((f.get("geometry") or {}).get("coordinates")):
                    for slug, b in need[tid]:
                        if b[0] <= x <= b[2] and b[1] <= y <= b[3]:
                            k = (int(x / cx) + BIAS) * SHIFT + (int(y / cy) + BIAS)
                            state["cells"].setdefault(slug, []).append(k)
            del fc
        for slug in state["cells"]:
            state["cells"][slug] = sorted(set(state["cells"][slug]))
        state["tiles"].append(tid)
        json.dump(state, open(a.out, "w"), separators=(",", ":"))
        print("  [%d/%d] %s" % (i, len(todo), tid), flush=True)

    remaining = [t for t in sorted(need) if t not in state["tiles"]]
    if remaining:
        print("\n%d tile(s) left. Re-run with --resume." % len(remaining))
        return 2

    # PIECE COUNT ALONE IS SENSITIVE TO --cell-m, so it is reported next to something that is
    # not: how far apart the pieces actually are, against the size the body claims to be.
    # A 0.562 km2 body is a circle 846 m across. garmin_020305 claims that and its contour
    # clusters span 38 km. That is not a lake with a measurement problem, it is a river.
    print("\n%-16s %6s %8s %9s %9s  %s"
          % ("slug", "pieces", "largest", "spread", "if round", "centre of the biggest pieces"))
    rows = []
    for s in sorted(boxes):
        cs = set(state["cells"].get(s, []))
        comps = [c for c in components(cs, cx, cy) if c[0] >= a.min_cells]
        tot = sum(c[0] for c in comps) or 1
        share = comps[0][0] / tot if comps else 0.0
        if comps:
            xs = [c[1] for c in comps]; ys = [c[2] for c in comps]
            mlat = sum(ys) / len(ys)
            span = math.hypot((max(xs) - min(xs)) * 111.32 * math.cos(math.radians(mlat)),
                              (max(ys) - min(ys)) * 110.54)
        else:
            span = 0.0
        r_km = 2 * math.sqrt(max(recs[s].get("area_km2") or 0.0, 1e-9) / math.pi)
        cents = " | ".join("%.4f,%.4f" % (c[1], c[2]) for c in comps[:3])
        print("%-16s %6d %7.0f%% %8.2fkm %8.2fkm  %s"
              % (s, len(comps), share * 100, span, r_km, cents))
        rows.append({"slug": s, "pieces": len(comps),
                     "largest_share": round(share, 3),
                     "spread_km": round(span, 3),
                     "diameter_if_round_km": round(r_km, 3),
                     "sizes": [c[0] for c in comps[:8]],
                     "centres": [[round(c[1], 5), round(c[2], 5)] for c in comps[:8]]})
    json.dump({"tiles": state["tiles"], "cell_m": a.cell_m, "report": rows},
              open(a.out, "w"), separators=(",", ":"))
    multi = sum(1 for r in rows if r["pieces"] > 1)
    print("\n%d of %d bodies are MORE THAN ONE piece of water at %.0f m."
          % (multi, len(rows), a.cell_m))
    print("-> %s" % a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
