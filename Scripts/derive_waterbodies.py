#!/usr/bin/env python3
"""
derive_waterbodies.py — find the lakes from the CONTOURS, not from a boundary file.

Garmin charts far more water than there are 3DHP boundaries for, and 3DHP has nothing at
all for many small ponds. But the contours themselves say where the water is:

  1. rasterise contour presence onto a coarse grid (default 150 m)   [parallel]
  2. connected components over the occupied cells -> one per waterbody
  3. each component gives bbox, centroid, area and max depth, ready for naming

No boundary files, no state list, works on ponds, and stitches lakes that span tiles.

    python derive_waterbodies.py --tiles "F:\\TrollMapPipeline\\extract\\contours" ^
                                 --out   "F:\\TrollMapPipeline\\waterbodies" --jobs 15

Memory: cells are held sparse and keyed by a packed int, so usage scales with WATER AREA,
not with the bounding box of the card.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse, gzip, json, math, os, sys, time
from collections import deque
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

BIAS = 1 << 21          # keeps negative cell indices positive
SHIFT = 1 << 22


def _scan(job):
    """Worker: rasterise one tile. Returns {packed_cell: max_depth_ft} and the tile id."""
    path, cx, cy, per_feature = job
    try:
        # THE PIPELINE WRITES .geojson.gz NOW. trollmap_extract_all.py --gzip has been the
        # normal mode for the card extract since August; every tile in extract/contours and
        # extract_new_C/contours is gzipped. This read used a bare open() and the glob below
        # matched only *.geojson, so pointing this script at the pipeline's own output found
        # zero tiles -- 2026-08-20.
        opener = gzip.open if str(path).endswith(".gz") else open
        with opener(path, "rt", encoding="utf-8") as fh:
            fc = json.load(fh)
    except Exception:
        return None, {}, 0
    tile = (fc.get("properties") or {}).get("tile",
                                            Path(path).name.split(".")[0])
    cells = {}
    n = 0
    for f in fc.get("features") or []:
        c = f["geometry"]["coordinates"]
        if len(c) < 2:
            continue
        n += 1
        d = f["properties"].get("depth_ft") or 0
        step = max(1, len(c) // per_feature)
        for q in c[::step]:
            k = (int(q[0] / cx) + BIAS) * SHIFT + (int(q[1] / cy) + BIAS)
            if cells.get(k, -1) < d:
                cells[k] = d
    return tile, cells, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tiles", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cell-m", type=float, default=150.0,
                    help="grid cell size; two contours closer than this join into one lake")
    ap.add_argument("--min-cells", type=int, default=4)
    ap.add_argument("--per-feature", type=int, default=12,
                    help="max vertices sampled per feature")
    ap.add_argument("--lat-ref", type=float, default=39.0,
                    help="reference latitude for the grid (CONUS mid by default)")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--force", action="store_true",
                    help="allow an empty result to replace a non-empty waterbodies.json")
    args = ap.parse_args()

    tdir = Path(args.tiles)
    files = [str(p) for p in sorted(set(tdir.glob("*.geojson")) | set(tdir.glob("*.geojson.gz")))
             if not p.name.startswith("MERGED.geojson") and not p.name.startswith("_")]
    if args.limit:
        files = files[:args.limit]
    if not files:
        # "no tiles" on its own sent the last reader looking for a missing directory when the
        # directory was full and the SUFFIX had changed. Say which, and say where.
        sys.exit("no tiles matching *.geojson or *.geojson.gz in %s\n"
                 "  (the directory %s)"
                 % (tdir, "does not exist" if not tdir.is_dir()
                    else "exists and holds %d entries" % len(list(tdir.iterdir()))))

    cy = args.cell_m / 110540.0
    cx = args.cell_m / (111320.0 * math.cos(math.radians(args.lat_ref)))
    print(f"{len(files)} tiles, {args.jobs} workers, {args.cell_m:.0f} m cells\n", flush=True)

    cells = {}
    owner = {}
    nfeat = 0
    t0 = time.time()
    jobs = [(f, cx, cy, args.per_feature) for f in files]
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        futs = [ex.submit(_scan, j) for j in jobs]
        for i, fut in enumerate(as_completed(futs), 1):
            tile, part, n = fut.result()
            nfeat += n
            for k, d in part.items():
                if cells.get(k, -1) < d:
                    cells[k] = d
                if k not in owner:
                    owner[k] = tile
            if i % 250 == 0 or i == len(futs):
                el = time.time() - t0
                eta = (len(futs) - i) / max(i / max(el, 1e-9), 1e-9)
                print(f"  ...{i}/{len(futs)}  {len(cells):,} cells  {nfeat:,} features  "
                      f"{el/60:.1f} min elapsed, ~{eta/60:.1f} min left", flush=True)
    if not cells:
        sys.exit("no contour vertices found")
    print(f"\n{nfeat:,} features -> {len(cells):,} occupied cells\n", flush=True)

    NB = [-SHIFT - 1, -SHIFT, -SHIFT + 1, -1, 1, SHIFT - 1, SHIFT, SHIFT + 1]
    seen = set()
    out = []
    t0 = time.time()
    for start in cells:
        if start in seen:
            continue
        seen.add(start)
        q = deque([start])
        m = []
        while q:
            k = q.popleft()
            m.append(k)
            for off in NB:
                nk = k + off
                if nk in cells and nk not in seen:
                    seen.add(nk)
                    q.append(nk)
        if len(m) < args.min_cells:
            continue
        xs = [k // SHIFT - BIAS for k in m]
        ys = [k % SHIFT - BIAS for k in m]
        tiles = sorted({owner[k] for k in m})
        out.append(dict(
            n_cells=len(m),
            bbox=[round(min(xs) * cx, 6), round(min(ys) * cy, 6),
                  round((max(xs) + 1) * cx, 6), round((max(ys) + 1) * cy, 6)],
            centroid=[round((sum(xs) / len(xs) + 0.5) * cx, 6),
                      round((sum(ys) / len(ys) + 0.5) * cy, 6)],
            approx_area_km2=round(len(m) * (args.cell_m ** 2) / 1e6, 3),
            max_depth_ft=int(max(cells[k] for k in m)),
            tiles=tiles[:12], n_tiles=len(tiles)))
    print(f"components found in {time.time()-t0:.1f}s", flush=True)
    out.sort(key=lambda r: -r["approx_area_km2"])

    odir = Path(args.out)
    odir.mkdir(parents=True, exist_ok=True)

    # AN EMPTY RUN MUST NOT REPLACE A FULL FILE. Zero components is a legitimate answer for a
    # tile set with no water in it, and it is also what a decode change, a bad --cell-m or a
    # wrong --tiles produces. The two are indistinguishable from here, so the destructive one
    # is refused: a 18 MB waterbodies.json is not overwritten by [] without --force.
    prior = odir / "waterbodies.json"
    if not out and prior.exists() and prior.stat().st_size > 2 and not args.force:
        sys.exit("REFUSING to write 0 waterbodies over %s (%.1f MB).\n"
                 "  Zero components can mean no water OR a wrong --tiles / --cell-m, and this\n"
                 "  cannot tell which. Re-run with --force if the empty result is the answer."
                 % (prior, prior.stat().st_size / 1e6))

    json.dump(out, open(odir / "waterbodies.json", "w"), indent=1)
    json.dump({"type": "FeatureCollection", "features": [
        {"type": "Feature",
         "properties": {k: v for k, v in r.items() if k != "bbox"},
         "geometry": {"type": "Polygon", "coordinates": [[
             [r["bbox"][0], r["bbox"][1]], [r["bbox"][2], r["bbox"][1]],
             [r["bbox"][2], r["bbox"][3]], [r["bbox"][0], r["bbox"][3]],
             [r["bbox"][0], r["bbox"][1]]]]}} for r in out]},
        open(odir / "waterbodies_bbox.geojson", "w"))

    print("\nlargest 25 by area:")
    for r in out[:25]:
        print(f"  {r['approx_area_km2']:>9.2f} km2  max {str(r['max_depth_ft']):>4} ft  "
              f"{r['n_tiles']:>2} tiles  centroid {r['centroid']}")
    tot = sum(r["approx_area_km2"] for r in out)
    big = sum(1 for r in out if r["approx_area_km2"] >= 1.0)
    print(f"\n{len(out):,} waterbodies ({big:,} of them 1 km2 or larger), "
          f"{tot:,.0f} km2 total -> {odir}")


if __name__ == "__main__":
    main()