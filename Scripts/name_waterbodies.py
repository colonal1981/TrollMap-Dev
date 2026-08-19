#!/usr/bin/env python3
"""
name_waterbodies.py — put names and real boundaries on the derived waterbodies.

derive_waterbodies.py finds where Garmin has contours but cannot name what it found.
The CONUS 3DHP GeoPackage can: hydro_3dhp_all_waterbody carries `gnisidlabel`,
`featuretypelabel` and an R-tree, so a bbox lookup is fast — IF you don't drag the
geometry blobs along for the ride.

    python name_waterbodies.py --waterbodies "...\\waterbodies\\waterbodies.json"
                               --gpkg "...\\3dhp_all_CONUS_...gpkg"
                               --out "...\\waterbodies_named" --jobs 15

Writes into --out:
  waterbodies_named.json     every derived body with its match, name and slug
  <slug>_3dhp.geojson        one boundary per lake, in the exact layout
                             trollmap_clip_lakes.py already reads

PERFORMANCE NOTES — this file got rewritten after a first version projected to ~5 days on
70,685 waterbodies:
  * the candidate query selects fid/name/type/area ONLY. Selecting `shape` for 40 candidate
    rows meant reading tens of MB of polygon blobs per lake just to choose a name; Wateree's
    blob alone is 458 KB.
  * the winning row's geometry is then fetched by fid, one blob, once.
  * geometry is only fetched at all for bodies >= --geom-min-km2 (default 0.25). Below that
    the derived bounding box is used, which is plenty for clipping a pond.
  * parallel, one read-only connection per worker.

Coordinates: the GeoPackage is EPSG:6350 (NAD83(2011) / Conus Albers, metres). 3DHP stores
MultiPolygonZ, so points are 3 doubles, not 2.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse, json, math, os, re, sqlite3, struct, sys, time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

_A = 6378137.0
_F = 1 / 298.257222101
_E2 = 2 * _F - _F * _F
_E = math.sqrt(_E2)
_LAT1, _LAT2, _LAT0, _LON0 = 29.5, 45.5, 23.0, -96.0


def _q(p):
    s = math.sin(p)
    return (1 - _E2) * (s / (1 - _E2 * s * s) - (1 / (2 * _E)) * math.log((1 - _E * s) / (1 + _E * s)))


def _m(p):
    s = math.sin(p)
    return math.cos(p) / math.sqrt(1 - _E2 * s * s)


_p1, _p2, _p0 = map(math.radians, (_LAT1, _LAT2, _LAT0))
_m1, _m2 = _m(_p1), _m(_p2)
_q1, _q2, _q0 = _q(_p1), _q(_p2), _q(_p0)
_N = (_m1 * _m1 - _m2 * _m2) / (_q2 - _q1)
_C = _m1 * _m1 + _N * _q1
_RHO0 = _A * math.sqrt(_C - _N * _q0) / _N


def fwd(lon, lat):
    p, l = math.radians(lat), math.radians(lon)
    rho = _A * math.sqrt(max(_C - _N * _q(p), 0.0)) / _N
    th = _N * (l - math.radians(_LON0))
    return rho * math.sin(th), _RHO0 - rho * math.cos(th)


def inv(x, y):
    yy = _RHO0 - y
    rho = math.hypot(x, yy)
    if rho == 0:
        return _LON0, _LAT0
    th = math.atan2(x, yy) if _N > 0 else math.atan2(-x, -yy)
    qv = (_C - (rho * rho * _N * _N) / (_A * _A)) / _N
    p = math.asin(max(-1.0, min(1.0, qv / 2)))
    for _ in range(12):
        s, c = math.sin(p), math.cos(p)
        d = (1 - _E2 * s * s) ** 2 / (2 * c) * (qv / (1 - _E2) - s / (1 - _E2 * s * s)
                                                + (1 / (2 * _E)) * math.log((1 - _E * s) / (1 + _E * s)))
        p += d
        if abs(d) < 1e-12:
            break
    return math.degrees(th / _N) + _LON0, math.degrees(p)


def gpkg_to_rings(blob):
    if not blob or blob[:2] != b"GP":
        return []
    env = (blob[3] >> 1) & 0x07
    p = 8 + {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}.get(env, 0)
    order = "<" if blob[p] == 1 else ">"
    raw = struct.unpack_from(order + "I", blob, p + 1)[0]
    band, gtype = raw // 1000, raw % 1000
    ndim = {0: 2, 1: 3, 2: 3, 3: 4}.get(band, 2)     # 3DHP is MultiPolygonZ -> 3
    p += 5
    rings = []

    def read_ring():
        nonlocal p
        npt = struct.unpack_from(order + "I", blob, p)[0]
        p += 4
        pts = struct.unpack_from(order + f"{ndim*npt}d", blob, p)
        p += 8 * ndim * npt
        return list(zip(pts[0::ndim], pts[1::ndim]))

    def read_poly():
        nonlocal p
        nr = struct.unpack_from(order + "I", blob, p)[0]
        p += 4
        out = []
        for i in range(nr):
            r = read_ring()
            if i == 0:
                out.append(r)
        return out

    if gtype == 3:
        rings += read_poly()
    elif gtype == 6:
        n = struct.unpack_from(order + "I", blob, p)[0]
        p += 4
        for _ in range(n):
            p += 5
            rings += read_poly()
    return rings


CAND_SQL = """
  select w.fid, w.gnisidlabel, w.featuretypelabel, w.areasqkm
  from rtree_hydro_3dhp_all_waterbody_shape r
  join hydro_3dhp_all_waterbody w on w.fid = r.id
  where r.maxx>=? and r.minx<=? and r.maxy>=? and r.miny<=?
  order by w.areasqkm desc limit 25
"""
GEOM_SQL = "select shape from hydro_3dhp_all_waterbody where fid=?"

_CON = None
_GEOM_MIN = 0.25
_SCRATCH = None


def _init(gpkg, geom_min, scratch):
    global _CON, _GEOM_MIN, _SCRATCH
    _CON = sqlite3.connect(f"file:{gpkg}?mode=ro", uri=True, check_same_thread=False)
    # modest pragmas on purpose: 15 workers x 1 GB mmap on a 60 GB file is how you get
    # WinError 1450 (insufficient system resources).
    _CON.execute("pragma mmap_size=134217728")
    _CON.execute("pragma cache_size=-32768")
    _GEOM_MIN = geom_min
    _SCRATCH = scratch


def _match(job):
    idx, bbox, area = job
    W, S, E, N = bbox
    cs = [fwd(x, y) for x, y in ((W, S), (E, S), (E, N), (W, N))]
    xs = [c[0] for c in cs]
    ys = [c[1] for c in cs]
    try:
        rows = _CON.execute(CAND_SQL, (min(xs), max(xs), min(ys), max(ys))).fetchall()
    except Exception:
        rows = []
    pick = None
    for fid, nm, ft, ar in rows:
        if nm and (ft or "").lower() in ("lake", "reservoir", "pond", "swamp/marsh"):
            pick = (fid, nm, ft, ar)
            break
    if pick is None:
        for fid, nm, ft, ar in rows:
            if nm:
                pick = (fid, nm, ft, ar)
                break
    if pick is None and rows:
        pick = rows[0]
    has_geom = False
    if pick and area >= _GEOM_MIN:
        try:
            r = _CON.execute(GEOM_SQL, (pick[0],)).fetchone()
            if r:
                rings = [[list(inv(x, y)) for x, y in ring] for ring in gpkg_to_rings(r[0])]
                if rings:
                    # WRITE IT HERE. Returning 17k-point polygons through the process pipe
                    # is what exhausted Windows handles on the first attempt.
                    with open(os.path.join(_SCRATCH, f"{idx}.json"), "w") as fh:
                        json.dump(rings, fh)
                    has_geom = True
        except Exception:
            has_geom = False
    return idx, (pick[1] if pick else None), (pick[2] if pick else None), \
        (pick[3] if pick else None), has_geom


def slugify(name, used):
    s = re.sub(r"[^a-z0-9]+", "_", (name or "").lower()).strip("_") or "unnamed"
    base, i = s, 2
    while s in used:
        s = f"{base}_{i}"
        i += 1
    used.add(s)
    return s


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--waterbodies", required=True)
    ap.add_argument("--gpkg", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-area-km2", type=float, default=0.05)
    ap.add_argument("--geom-min-km2", type=float, default=0.25,
                    help="fetch the real 3DHP polygon only above this size; smaller bodies "
                         "use their derived bounding box (default 0.25)")
    ap.add_argument("--jobs", type=int, default=min(8, max(1, (os.cpu_count() or 2) - 1)),
                    help="workers; capped at 8 by default -- more connections to a 60 GB "
                         "GeoPackage exhausts Windows handles before it helps")
    ap.add_argument("--batch", type=int, default=2000,
                    help="jobs submitted per pool; the first version queued all 70,685 at "
                         "once and hit WinError 1450")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--named-only", action="store_true")
    args = ap.parse_args()

    wb = [w for w in json.load(open(args.waterbodies))
          if w.get("approx_area_km2", 0) >= args.min_area_km2]
    if args.limit:
        wb = wb[:args.limit]
    odir = Path(args.out)
    odir.mkdir(parents=True, exist_ok=True)
    print(f"{len(wb):,} waterbodies >= {args.min_area_km2} km2; "
          f"real geometry above {args.geom_min_km2} km2; {args.jobs} workers\n", flush=True)

    scratch = odir / "_geom"
    scratch.mkdir(parents=True, exist_ok=True)

    # Resumable: anything already written is skipped, so a crash costs only the batch
    # that was in flight.
    done_path = odir / "_progress.json"
    done = {}
    if done_path.exists():
        try:
            done = {int(k): v for k, v in json.load(open(done_path)).items()}
            print(f"resuming: {len(done):,} already matched\n", flush=True)
        except Exception:
            done = {}

    jobs = [(i, w["bbox"], w["approx_area_km2"])
            for i, w in enumerate(wb) if i not in done]
    print(f"{len(jobs):,} to do\n", flush=True)

    BATCH = args.batch
    t0 = time.time()
    completed = 0
    for b0 in range(0, len(jobs), BATCH):
        chunk = jobs[b0:b0 + BATCH]
        with ProcessPoolExecutor(max_workers=args.jobs, initializer=_init,
                                 initargs=(args.gpkg, args.geom_min_km2, str(scratch))) as ex:
            futs = [ex.submit(_match, j) for j in chunk]
            for fut in as_completed(futs):
                idx, nm, ft, ar, hg = fut.result()
                done[idx] = [nm, ft, ar, hg]
                completed += 1
                if completed % 500 == 0:
                    el = time.time() - t0
                    eta = (len(jobs) - completed) / max(completed / max(el, 1e-9), 1e-9)
                    print(f"  ...{completed:,}/{len(jobs):,}  {el/60:.1f} min elapsed, "
                          f"~{eta/60:.1f} min left", flush=True)
        json.dump({str(k): v for k, v in done.items()}, open(done_path, "w"))

    print("\nwriting boundary files...", flush=True)
    used, out, named = set(), [], 0
    for i, w in enumerate(wb):
        nm, ft, ar, hg = done.get(i, [None, None, None, False])
        rec = dict(w)
        rec["name"] = nm
        rec["feature_type"] = ft
        rec["matched_area_km2"] = ar
        if nm:
            named += 1
        slug = slugify(nm if nm else f"garmin_{i:06d}", used)
        rec["slug"] = slug
        out.append(rec)
        if args.named_only and not nm:
            continue
        W, S, E, N = w["bbox"]
        rings = None
        if hg:
            gp = scratch / f"{i}.json"
            if gp.exists():
                try:
                    rings = json.load(open(gp))
                except Exception:
                    rings = None
        if rings:
            polys = [[r] for r in rings]
            geom = ({"type": "Polygon", "coordinates": polys[0]} if len(polys) == 1
                    else {"type": "MultiPolygon", "coordinates": polys})
        else:
            geom = {"type": "Polygon",
                    "coordinates": [[[W, S], [E, S], [E, N], [W, N], [W, S]]]}
            rec["boundary_source"] = "derived bbox"
        json.dump({"type": "FeatureCollection", "features": [
            {"type": "Feature",
             "properties": {"name": nm or slug, "slug": slug, "feature_type": ft,
                            "approx_area_km2": w["approx_area_km2"],
                            "max_depth_ft": w.get("max_depth_ft")},
             "geometry": geom}]}, open(odir / f"{slug}_3dhp.geojson", "w"))

    json.dump(out, open(odir / "waterbodies_named.json", "w"), indent=1)
    print(f"\n{named:,} named, {len(out)-named:,} unnamed -> {odir}")
    print("\ntop 25 by derived area:")
    for r in out[:25]:
        print(f"  {r['approx_area_km2']:>9.2f} km2  max {str(r.get('max_depth_ft')):>4} ft  "
              f"{r['name'] or '(unnamed)'}")


if __name__ == "__main__":
    main()