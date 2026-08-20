#!/usr/bin/env python3
r"""check_garmin_bathymetry.py -- does a garmin_* body have real soundings, or a shell?

    py .\scripts\check_garmin_bathymetry.py --slugs garmin_013922 garmin_014735
    py .\scripts\check_garmin_bathymetry.py --slug-file worklist.txt --out report.json --resume

WHY

Ryan, 2026-08-20: *"do these garmin waters actually have usable bathymetry in them... meaning a
depth area that is not 0,3 or actual contours... garmin names waters they do not sound"*.

`derive_waterbodies.py` finds a waterbody wherever contour features cluster, and reports one
number for it, `max_depth_ft`. That number cannot tell a sounded lake from a shoreline shell:
Garmin draws a 0 ft and a 3 ft ring around a great deal of water it never surveyed, and a body
whose only levels are 0 and 3 has a max_depth_ft of 3 and no bathymetry at all.

So this reports the LADDER, not the maximum. A lake you can fish has a run of distinct levels
with real spacing. A shell has one or two, all shallow, and usually only in depth_areas with no
contours behind them.

    slug            contours  levels  ladder (ft)              areas  verdict
    garmin_013922        412      9   1,3,6,9,12,15,18,21,24     38   SOUNDED
    garmin_0xxxxx          0      1   3                           6   SHELL

WHAT IT READS

  <extract>/contours/C<tile>.geojson.gz     contour lines, depth_ft per feature
  <extract>/depth_areas/C<tile>.geojson.gz  filled bands, depth_min_ft / depth_max_ft / band
  <extract>/_tile_bbox_*.json               tile -> bbox. B and C tiles share the id after the
                                            first character, which is how a C tile is located
                                            from a B tile's box.
  <index>                                   waterbodies_index_*.jsonl -- centroid and area

THREE THINGS THE FIRST VERSION GOT WRONG, all of which produced a confident SHELL

  * It took the search box from <slug>_3dhp.geojson. For a garmin_* body that file is a STUB:
    garmin_013922 is 0.945 km2 -- an equivalent radius of 548 m -- and its file's box is
    69 m by 125 m. The box now comes from the index centroid and area, and the stub is only
    used when it is LARGER.
  * It tested each feature's FIRST vertex. A contour is a line that wanders; its first vertex
    lands outside a small box more often than not. garmin_013922 matched 17 contours by first
    vertex and 32 by any vertex.
  * It read depth_ft from depth_areas, which do not have one -- they carry depth_min_ft,
    depth_max_ft and band. Every depth-area count came back zero.

  All three failed the same way: silently, toward "no bathymetry here". A measurement whose
  error direction is always the same answer is not a measurement.

MEMORY

One tile at a time, and each tile is dropped before the next is opened. A first attempt held
several open at once and was OOM-killed on this hardware. `--resume` skips tiles already in the
output, so a kill costs one tile rather than the run.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse, glob, gzip, json, math, os, sys
from collections import defaultdict


def footprint(path):
    """(w, s, e, n) of a derived body, from its own geometry."""
    try:
        g = json.load(open(path, encoding="utf-8"))
    except Exception:
        return None
    xs, ys = [], []
    stack = [(f.get("geometry") or {}).get("coordinates") for f in g.get("features", [g])]
    while stack:
        c = stack.pop()
        if not c:
            continue
        if isinstance(c[0], (int, float)):
            xs.append(c[0]); ys.append(c[1])
        else:
            stack.extend(c)
    return [min(xs), min(ys), max(xs), max(ys)] if xs else None


def tile_boxes(extract):
    """tile id (without the leading B/C) -> [w, e, s, n]."""
    out = {}
    for f in glob.glob(os.path.join(extract, "_tile_bbox_*.json")):
        try:
            d = json.load(open(f, encoding="utf-8"))
        except Exception:
            continue
        for k, v in d.items():
            b = (v or {}).get("b")
            if isinstance(b, list) and len(b) == 4 and all(isinstance(x, (int, float)) for x in b):
                out[k.split(".")[0][1:]] = b
    return out


def first_point(c):
    while c and not isinstance(c[0], (int, float)):
        c = c[0]
    return c


def vertices(c):
    """Every coordinate pair in a geometry, however nested."""
    st = [c]
    while st:
        x = st.pop()
        if not x:
            continue
        if isinstance(x[0], (int, float)):
            yield x
        else:
            st.extend(x)


def scan_tile(path, targets, keys):
    """{slug: [value, ...]} for one tile. Opens, scans, drops.

    ANY vertex inside the box counts. A contour that starts outside the box and runs through
    it is a contour on that water.
    """
    hits = defaultdict(list)
    try:
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            fc = json.load(fh)
    except Exception:
        return hits
    for f in fc.get("features") or []:
        vs = list(vertices((f.get("geometry") or {}).get("coordinates")))
        if not vs:
            continue
        xs = [v[0] for v in vs]; ys = [v[1] for v in vs]
        fw, fe, fs_, fn = min(xs), max(xs), min(ys), max(ys)
        pr = f.get("properties") or {}
        val = next((pr[k] for k in keys if pr.get(k) is not None), None)
        if val is None:
            continue
        for slug, b in targets:
            if fe < b[0] or fw > b[2] or fn < b[1] or fs_ > b[3]:
                continue                      # feature bbox misses the body bbox entirely
            if any(b[0] <= x <= b[2] and b[1] <= y <= b[3] for x, y in vs):
                hits[slug].append(val)
    del fc
    return hits


def search_box(rec, stub):
    """Centroid +/- the radius of a circle with the body's area, union'd with the stub box."""
    r_km = math.sqrt(max(rec.get("area_km2") or 0.0, 1e-6) / math.pi)
    dlat = r_km / 110.54
    dlon = r_km / (111.32 * max(0.05, math.cos(math.radians(rec["lat"]))))
    b = [rec["lon"] - dlon, rec["lat"] - dlat, rec["lon"] + dlon, rec["lat"] + dlat]
    if stub:
        b = [min(b[0], stub[0]), min(b[1], stub[1]), max(b[2], stub[2]), max(b[3], stub[3])]
    return b


def verdict(levels, n_contours, n_areas, bands):
    """Named by what was measured, never by a threshold pulled out of the air.

    The only line drawn here is 'more than the 0/3 shell Garmin draws around unsurveyed water',
    which is Ryan's own description of the thing to exclude, not a tuned number.
    """
    deep = [d for d in levels if d and d > 3]
    if n_contours == 0 and n_areas == 0:
        return "NO DATA"        # nothing was read here at all -- not the same as a shell
    if n_contours == 0 and not deep:
        return "SHELL"          # only the 0/3 bands Garmin draws around unsurveyed water
    if len(levels) <= 2 and not deep:
        return "SHELL"
    if n_contours == 0:
        return "AREAS-ONLY"     # filled bands, no contour lines behind them
    if len(levels) <= 3:
        return "THIN"
    return "SOUNDED"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--extract", default="extract")
    ap.add_argument("--bodies", default=os.path.join(
        "_to_delete", "sweep_2026-08-19", "waterbodies_named"),
        help="folder of <slug>_3dhp.geojson derived footprints")
    ap.add_argument("--index", default=os.path.join(
        "registry", "_reference", "waterbodies_index_3dhp_nationwide.jsonl"),
        help="the jsonl the search box comes from -- centroid and area per slug")
    ap.add_argument("--slugs", nargs="*", default=[])
    ap.add_argument("--slug-file")
    ap.add_argument("--out", default="garmin_bathymetry.json")
    ap.add_argument("--max-tiles", type=int, default=0,
                    help="stop after N tiles this run; pair with --resume")
    ap.add_argument("--resume", action="store_true",
                    help="skip tiles already recorded in --out")
    a = ap.parse_args()

    slugs = list(a.slugs)
    if a.slug_file:
        slugs += [l.strip() for l in open(a.slug_file, encoding="utf-8-sig")
                  if l.strip() and not l.startswith("#")]
    if not slugs:
        sys.exit("no slugs given -- use --slugs or --slug-file")

    want = set(slugs)
    recs = {}
    with open(a.index, encoding="utf-8") as fh:
        for line in fh:
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("slug") in want and r.get("lon") is not None:
                recs[r["slug"]] = r
    if not recs:
        sys.exit("none of those slugs are in %s" % a.index)
    if len(recs) < len(want):
        print("!! %d slug(s) are not in the index and cannot be placed: %s"
              % (len(want) - len(recs), ", ".join(sorted(want - set(recs)))[:200]))

    boxes = {s: search_box(recs[s], footprint(os.path.join(a.bodies, s + "_3dhp.geojson")))
             for s in recs}

    tb = tile_boxes(a.extract)
    have = {os.path.basename(p).split(".")[0][1:]
            for p in glob.glob(os.path.join(a.extract, "contours", "*.gz"))}
    need = defaultdict(list)
    for s, b in boxes.items():
        for tid, t in tb.items():
            if tid in have and not (b[2] < t[0] or b[0] > t[1] or b[3] < t[2] or b[1] > t[3]):
                need[tid].append((s, b))
    covered = {s for v in need.values() for s, _ in v}
    print("%d bodies, %d tiles to read" % (len(boxes), len(need)))
    if len(covered) < len(boxes):
        print("!! %d body(ies) fall on no contour tile the card holds: %s"
              % (len(boxes) - len(covered), ", ".join(sorted(set(boxes) - covered))))

    state = {"tiles": [], "contours": {}, "areas": {}, "bands": {}}
    if a.resume and os.path.exists(a.out):
        state = json.load(open(a.out, encoding="utf-8"))

    todo = [t for t in sorted(need) if t not in state["tiles"]]
    if a.max_tiles:
        todo = todo[:a.max_tiles]

    for i, tid in enumerate(todo, 1):
        for layer, bucket, keys in (("contours", "contours", ("depth_ft",)),
                                    ("depth_areas", "areas", ("depth_max_ft",)),
                                    ("depth_areas", "bands", ("band",))):
            p = os.path.join(a.extract, layer, "C%s.geojson.gz" % tid)
            if not os.path.exists(p):
                continue
            for slug, vals in scan_tile(p, need[tid], keys).items():
                state.setdefault(bucket, {}).setdefault(slug, []).extend(
                    v for v in vals if v is not None)
        state["tiles"].append(tid)
        json.dump(state, open(a.out, "w"), separators=(",", ":"))
        print("  [%d/%d] %s" % (i, len(todo), tid), flush=True)

    remaining = [t for t in sorted(need) if t not in state["tiles"]]
    if remaining:
        print("\n%d tile(s) left. Re-run with --resume." % len(remaining))
        return 2

    print("\n%-16s %8s %6s %6s  %-30s  %s"
          % ("slug", "contours", "areas", "levels", "deepest levels (ft)", "verdict"))
    rows = []
    for s in sorted(boxes):
        c = state["contours"].get(s, [])
        ar = state["areas"].get(s, [])
        bands = sorted(set(state.get("bands", {}).get(s, [])))
        levels = sorted({round(float(d), 1) for d in list(c) + list(ar) if d is not None})
        v = verdict(levels, len(c), len(ar), bands)
        show = ("... " if len(levels) > 6 else "") + ",".join("%g" % d for d in levels[-6:])
        print("%-16s %8d %6d %6d  %-30s  %s" % (s, len(c), len(ar), len(levels), show, v))
        rows.append({"slug": s, "n_contours": len(c), "n_areas": len(ar),
                     "levels": levels, "bands": bands, "verdict": v,
                     "max_ft": levels[-1] if levels else None})
    json.dump({"tiles": state["tiles"], "report": rows}, open(a.out, "w"),
              separators=(",", ":"))
    print("\n-> %s" % a.out)
    from collections import Counter
    print(dict(Counter(r["verdict"] for r in rows)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
