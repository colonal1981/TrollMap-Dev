#!/usr/bin/env python3
"""
build_lake_registry.py — the single lake list, built straight from 3DHP, keyed by GNIS id.

    python3 build_lake_registry.py --gpkg .../3dhp_all_CONUS_20260112_GPKG.gpkg \\
                                   --out  .../registry \\
                                   --bbox=-90.31,30.36,-75.24,36.68

Writes:
    <out>/lakes.json                 the registry — one row per lake, the join key for
                                     every other source
    <out>/boundaries/<slug>.geojson  one merged boundary per lake

PURE PYTHON. sqlite3 and the GeoPackage R-tree only — no geopandas, no shapely, no network.
It runs on the device VM where none of those exist.

WHY THIS REPLACES THE FRAGMENT MERGE
`derive_waterbodies.py` -> `name_waterbodies.py` -> `merge_lakes.py` derived polygons from
Garmin contours and then tried to recover lake identity by name-matching and regrouping
fragments. Three things went wrong and all three vanish here:

  * 32% came back UNNAMED, and that group was not junk — Lake Moultrie is in it. Anything
    built on the named 68% is missing major lakes.
  * `approx_area_km2` is unusable. Lake Marion's three biggest fragments are 1.5 MB of
    coordinates each and declare 1.688, 0.810 and 0.427 km2 against a real ~445.
  * Areas recomputed from the geometry still over-count, because fragments overlap and
    summing them double-counts — Guntersville measured 1,364 km2 against a true ~275.

3DHP already solves all of it. `gnisid` IS the stable lake identity, `gnisidlabel` IS the
name, `areasqkm` IS the authoritative area, and grouping by gnisid is exactly the fragment
merge — done by the people who built the dataset. No name matching, no proximity heuristic,
no guessed bounding box.

Adjacent impoundments separate correctly for free: Wateree and Fishing Creek have different
gnisids, so overlapping geometry cannot merge them. That was the fight worth avoiding.

THE REGISTRY IS THE JOIN KEY
Five sources have to land in one R2 folder per lake: 3DHP, i-Boating, Garmin, OSM and the
live state-DNR pull. They disagree about names, so nothing joins by name. Every source
resolves to a lake by GEOMETRY — a ramp belongs to the polygon that contains it — and the
registry carries the bounds each source needs to do that, including the DNR worker, which
runs live and queries by extent rather than reading files.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse, json, math, os, re, sqlite3, struct, sys, time
from pathlib import Path

TABLE = "hydro_3dhp_all_waterbody"
RTREE = f"rtree_{TABLE}_shape"
LAKE_TYPES = None          # set from --types; None = keep everything


# ---- EPSG:6350, NAD83(2011) / Conus Albers -----------------------------------------
# The 3DHP geometry and its R-tree are in Albers metres, not degrees, which is why a WGS84
# bbox query returns zero rows. pyproj is not available on the device VM, so both directions
# are implemented here. Standard Albers Equal Area Conic on GRS80.
_A = 6378137.0
_F = 1.0 / 298.257222101
_E2 = 2 * _F - _F * _F
_E = math.sqrt(_E2)
_LAT1, _LAT2, _LAT0, _LON0 = math.radians(29.5), math.radians(45.5), math.radians(23.0), math.radians(-96.0)


def _q(phi):
    sp = math.sin(phi)
    return (1 - _E2) * (sp / (1 - _E2 * sp * sp)
                        - (1 / (2 * _E)) * math.log((1 - _E * sp) / (1 + _E * sp)))


def _m(phi):
    sp = math.sin(phi)
    return math.cos(phi) / math.sqrt(1 - _E2 * sp * sp)


_M1, _M2 = _m(_LAT1), _m(_LAT2)
_Q1, _Q2, _Q0 = _q(_LAT1), _q(_LAT2), _q(_LAT0)
_N = (_M1 * _M1 - _M2 * _M2) / (_Q2 - _Q1)
_C = _M1 * _M1 + _N * _Q1
_RHO0 = _A * math.sqrt(_C - _N * _Q0) / _N


def to_albers(lon, lat):
    phi, lam = math.radians(lat), math.radians(lon)
    rho = _A * math.sqrt(max(_C - _N * _q(phi), 0.0)) / _N
    th = _N * (lam - _LON0)
    return rho * math.sin(th), _RHO0 - rho * math.cos(th)


def to_wgs84(x, y):
    dy = _RHO0 - y
    rho = math.hypot(x, dy)
    th = math.atan2(x, dy) if _N > 0 else math.atan2(-x, -dy)
    q = (_C - (rho * rho * _N * _N) / (_A * _A)) / _N
    # invert q -> phi by Newton iteration; converges in 3-4 steps at these latitudes
    phi = math.asin(max(-1.0, min(1.0, q / 2.0)))
    for _ in range(8):
        sp = math.sin(phi)
        t = 1 - _E2 * sp * sp
        dphi = (t * t / (2 * math.cos(phi))) * (
            q / (1 - _E2) - sp / t
            + (1 / (2 * _E)) * math.log((1 - _E * sp) / (1 + _E * sp)))
        phi += dphi
        if abs(dphi) < 1e-11:
            break
    return math.degrees(_LON0 + th / _N), math.degrees(phi)


def gpkg_wkb(blob):
    """GeoPackage BLOB -> (rings, bbox). Strips the GP header, then plain WKB.

    Handles Polygon/MultiPolygon in 2D, Z, M and ZM — 3DHP ships MultiPolygonZ (type 1006),
    three doubles per point, and reading it as 2D silently yields zero rings.
    """
    if not blob or blob[:2] != b"GP":
        return None
    flags = blob[3]
    env = (flags >> 1) & 0x07
    env_bytes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}.get(env)
    if env_bytes is None:
        return None
    p = 8 + env_bytes
    little = "<" if (flags & 0x01) else ">"

    def u32(off):
        return struct.unpack_from(little + "I", blob, off)[0]

    def read_poly(off, ndim):
        nring = u32(off)
        off += 4
        rings = []
        for _ in range(nring):
            npt = u32(off)
            off += 4
            pts = struct.unpack_from(little + "d" * (npt * ndim), blob, off)
            off += 8 * npt * ndim
            rings.append([to_wgs84(pts[i * ndim], pts[i * ndim + 1]) for i in range(npt)])
        return rings, off

    try:
        p += 1                                   # byte order of the WKB itself
        gtype = u32(p); p += 4
        base = gtype % 1000
        ndim = 2 + (1 if 1000 <= gtype < 2000 else 0) + (1 if 2000 <= gtype < 3000 else 0) \
               + (2 if gtype >= 3000 else 0)
        ndim = {0: 2, 1: 3, 2: 3, 3: 4}[gtype // 1000] if gtype // 1000 <= 3 else 2
        polys = []
        if base == 3:
            rings, p = read_poly(p, ndim)
            polys.append(rings)
        elif base == 6:
            n = u32(p); p += 4
            for _ in range(n):
                p += 1
                p += 4                            # each part restates its type
                rings, p = read_poly(p, ndim)
                polys.append(rings)
        else:
            return None
    except Exception:
        return None
    if not polys:
        return None
    xs = [pt[0] for pl in polys for r in pl for pt in r]
    ys = [pt[1] for pl in polys for r in pl for pt in r]
    if not xs:
        return None
    return polys, (min(xs), min(ys), max(xs), max(ys))


# FIPS -> USPS. The Census file carries STATE (FIPS) and NAME, not the abbreviation.
FIPS = {
 "01":"AL","02":"AK","04":"AZ","05":"AR","06":"CA","08":"CO","09":"CT","10":"DE","11":"DC",
 "12":"FL","13":"GA","15":"HI","16":"ID","17":"IL","18":"IN","19":"IA","20":"KS","21":"KY",
 "22":"LA","23":"ME","24":"MD","25":"MA","26":"MI","27":"MN","28":"MS","29":"MO","30":"MT",
 "31":"NE","32":"NV","33":"NH","34":"NJ","35":"NM","36":"NY","37":"NC","38":"ND","39":"OH",
 "40":"OK","41":"OR","42":"PA","44":"RI","45":"SC","46":"SD","47":"TN","48":"TX","49":"UT",
 "50":"VT","51":"VA","53":"WA","54":"WV","55":"WI","56":"WY","72":"PR"}


def _in_ring(x, y, ring):
    inside = False
    n = len(ring); j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-300) + xi:
            inside = not inside
        j = i
    return inside


class States:
    """Point-in-polygon against Census cartographic state boundaries.

    Border lakes are the whole reason this is not a bounding box. Hartwell, Thurmond,
    Wylie and Clarks Hill all sit ON state lines, and a rectangle test would either claim
    both states everywhere or pick one arbitrarily -- the same 'validated where the variant
    does not occur' error that has bitten this format four times in a day.
    """

    def __init__(self, path):
        doc = json.load(open(path))
        self.items = []          # (abbrev, bbox, [rings])
        for f in doc.get("features", []):
            pr = f.get("properties") or {}
            ab = FIPS.get(str(pr.get("STATE", "")).zfill(2))
            if not ab:
                continue
            g = f.get("geometry") or {}
            polys = [g["coordinates"]] if g.get("type") == "Polygon" else g.get("coordinates", [])
            for rings in polys:
                if not rings:
                    continue
                xs = [c[0] for c in rings[0]]; ys = [c[1] for c in rings[0]]
                self.items.append((ab, (min(xs), min(ys), max(xs), max(ys)), rings))
        print(f"state boundaries: {len({a for a,_,_ in self.items})} states, "
              f"{len(self.items)} polygons", flush=True)

    def at(self, x, y):
        for ab, (w, s, e, n), rings in self.items:
            if not (w <= x <= e and s <= y <= n):
                continue
            if _in_ring(x, y, rings[0]) and not any(_in_ring(x, y, h) for h in rings[1:]):
                return ab
        return None

    def touching(self, bb, centroid):
        """Every state the lake actually reaches -- centroid plus the bbox corners and edge
        midpoints. A lake spanning a border reports both, so the picker can say SC/GA."""
        w, s, e, n = bb
        pts = [centroid] + [(a, b) for a in (w, (w + e) / 2, e) for b in (s, (s + n) / 2, n)]
        seen = []
        for x, y in pts:
            ab = self.at(x, y)
            if ab and ab not in seen:
                seen.append(ab)
        return seen


def slugify(name):
    s = re.sub(r"[^a-z0-9]+", "_", (name or "").lower()).strip("_")
    return re.sub(r"_+", "_", s)


def round_coords(obj, nd):
    if nd is None:
        return obj
    if isinstance(obj, float):
        return round(obj, nd)
    if isinstance(obj, list):
        return [round_coords(v, nd) for v in obj]
    if isinstance(obj, tuple):
        return [round_coords(v, nd) for v in obj]
    return obj


def save_state(state, state_path):
    """Write the checkpoint via a temp file and replace.

    Two failures this avoids. A plain `json.dump(state, open(path,"w"))` truncates the old
    checkpoint the instant it opens, so an interruption mid-write leaves a corrupt file and
    the run restarts from nothing. And a raised exception here throws away a grouping pass
    that is sitting complete in memory -- so a write failure warns and continues instead."""
    try:
        tmp = Path(str(state_path) + ".tmp")
        tmp.parent.mkdir(parents=True, exist_ok=True)
        with open(tmp, "w") as fh:
            json.dump(state, fh)
        os.replace(tmp, state_path)
        return True
    except Exception as exc:
        print(f"!! could not write the checkpoint {state_path}: {exc}\n"
              f"   continuing -- this run will finish but will not be resumable",
              flush=True)
        return False


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gpkg", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--bbox", required=True, help="w,s,e,n")
    ap.add_argument("--min-area-km2", type=float, default=0.1)
    ap.add_argument("--types", nargs="*", default=None,
                    help="featuretypelabel values to keep (default: all)")
    ap.add_argument("--precision", type=int, default=6)
    ap.add_argument("--states-geojson", default=None,
                    help="Census state boundaries (e.g. gz_2010_us_040_00_500k.json). "
                         "Without it lakes carry no state and the picker cannot group.")
    ap.add_argument("--state-order", nargs="*", default=["SC", "NC", "GA", "TN"],
                    help="states listed first in the picker; the rest follow alphabetically")
    ap.add_argument("--time-budget", type=float, default=0,
                    help="checkpoint and exit after this many seconds, then run again")
    ap.add_argument("--state", default=None, help="checkpoint file; keep it on LOCAL disk")
    ap.add_argument("--restart", action="store_true")
    ap.add_argument("--list-types", action="store_true",
                    help="just report the featuretypelabel histogram in the bbox and exit")
    args = ap.parse_args()

    out = Path(args.out)
    (out / "boundaries").mkdir(parents=True, exist_ok=True)
    w, s, e, n = (float(x) for x in args.bbox.split(","))
    nd = args.precision if args.precision > 0 else None
    t0 = time.time()
    deadline = (t0 + args.time_budget) if args.time_budget else None
    state_path = Path(args.state) if args.state else out / "_registry_state.json"
    # Create the checkpoint's directory rather than discovering it is missing AFTER the
    # grouping pass. On CONUS that pass chews through 5.7 M rows before the first write, so a
    # bare FileNotFoundError there costs the whole run for the sake of one mkdir.
    try:
        state_path.parent.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        sys.exit(f"cannot create the checkpoint directory {state_path.parent}: {exc}")
    state = {}
    if state_path.exists() and not args.restart:
        try:
            state = json.load(open(state_path))
        except Exception:
            state = {}

    states = States(args.states_geojson) if args.states_geojson else None
    if states is None:
        print("!! no --states-geojson: lakes will have no state and cannot be grouped",
              flush=True)

    con = sqlite3.connect(f"file:{args.gpkg}?mode=ro", uri=True)
    con.execute("pragma mmap_size=268435456")
    cur = con.cursor()

    # The R-tree turns a 5.7 M row table into a bbox lookup. A LIKE scan over gnisidlabel
    # times out; this returns in under a second.
    # project the WGS84 bbox into Albers, taking all four corners plus edge midpoints so a
    # curved parallel cannot clip the box
    pts = [to_albers(a, b) for a in (w, (w + e) / 2, e) for b in (s, (s + n) / 2, n)]
    ax0, ay0 = min(p[0] for p in pts), min(p[1] for p in pts)
    ax1, ay1 = max(p[0] for p in pts), max(p[1] for p in pts)
    print(f"bbox in Albers: {ax0:.0f},{ay0:.0f} .. {ax1:.0f},{ay1:.0f}", flush=True)
    cur.execute(f"select id from {RTREE} where maxx>=? and minx<=? and maxy>=? and miny<=?",
                (ax0, ax1, ay0, ay1))
    ids = [r[0] for r in cur.fetchall()]
    print(f"{len(ids):,} waterbody rows in the bbox", flush=True)
    if not ids:
        sys.exit("nothing in --bbox")

    if args.list_types:
        hist = {}
        for i in range(0, len(ids), 900):
            chunk = ids[i:i + 900]
            q = ",".join("?" * len(chunk))
            cur.execute(f"select featuretypelabel,count(*) from {TABLE} "
                        f"where fid in ({q}) group by 1", chunk)
            for k, v in cur.fetchall():
                hist[k] = hist.get(k, 0) + v
        for k, v in sorted(hist.items(), key=lambda t: -t[1]):
            print(f"  {v:8,}  {k}")
        return

    keep_types = {t.lower() for t in args.types} if args.types else None

    # ---- group rows by gnisid. THIS is the fragment merge, done by the dataset. ---------
    groups = state.get("groups")
    if groups is None:
        groups = {}
        unnamed = 0
        for i in range(0, len(ids), 900):
            chunk = ids[i:i + 900]
            q = ",".join("?" * len(chunk))
            cur.execute(f"select fid,gnisid,gnisidlabel,featuretypelabel,areasqkm "
                        f"from {TABLE} where fid in ({q})", chunk)
            for fid, gnisid, label, ftype, area in cur.fetchall():
                if keep_types and (ftype or "").lower() not in keep_types:
                    continue
                if not gnisid:
                    unnamed += 1
                    continue
                g = groups.setdefault(str(gnisid),
                                      {"name": label, "type": ftype, "area": 0.0, "fids": []})
                g["fids"].append(fid)
                g["area"] += float(area or 0.0)
                if label and not g["name"]:
                    g["name"] = label
        state["groups"] = groups
        save_state(state, state_path)
        print(f"{len(groups):,} distinct GNIS ids ({unnamed:,} rows had no gnisid)\n",
              flush=True)

    keep = {k: v for k, v in groups.items()
            if v["area"] >= args.min_area_km2 and (v["name"] or "").strip()}
    print(f"{len(keep):,} lakes at >= {args.min_area_km2} km2 with a name", flush=True)

    # stable slugs: GNIS name, _2/_3 by descending area for genuine duplicates
    order = sorted(keep.items(), key=lambda kv: -kv[1]["area"])
    used, slug_of = {}, {}
    for gid, g in order:
        base = slugify(g["name"]) or f"gnis_{gid}"
        k = used.get(base, 0) + 1
        used[base] = k
        slug_of[gid] = base if k == 1 else f"{base}_{k}"

    done = set(state.get("written", []))
    rows = state.get("rows", [])
    todo = [(gid, g) for gid, g in order if gid not in done]
    print(f"writing boundaries: {len(todo):,} to go ({len(done):,} done)\n", flush=True)

    for gid, g in todo:
        if deadline and time.time() > deadline:
            state["written"] = sorted(done)
            state["rows"] = rows
            save_state(state, state_path)
            print(f"CHECKPOINT {len(done):,}/{len(order):,} — run again", flush=True)
            return
        feats, bb = [], None
        for i in range(0, len(g["fids"]), 400):
            chunk = g["fids"][i:i + 400]
            q = ",".join("?" * len(chunk))
            cur.execute(f"select shape from {TABLE} where fid in ({q})", chunk)
            for (blob,) in cur.fetchall():
                got = gpkg_wkb(blob)
                if not got:
                    continue
                polys, b = got
                bb = b if bb is None else (min(bb[0], b[0]), min(bb[1], b[1]),
                                           max(bb[2], b[2]), max(bb[3], b[3]))
                for rings in polys:
                    feats.append({"type": "Feature", "properties": {},
                                  "geometry": {"type": "Polygon",
                                               "coordinates": round_coords(rings, nd)}})
        done.add(gid)
        if not feats:
            continue
        slug = slug_of[gid]
        cen = [round((bb[0] + bb[2]) / 2, 6), round((bb[1] + bb[3]) / 2, 6)]
        rec = {"slug": slug, "lake_id": f"gnis:{gid}", "name": g["name"],
               "feature_type": g["type"], "area_km2": round(g["area"], 4),
               "parts": len(g["fids"]), "bounds_wsen": [round(v, 6) for v in bb],
               "centroid": cen}
        if states:
            touch = states.touching(bb, cen)
            rec["state"] = touch[0] if touch else None          # primary, from the centroid
            rec["states"] = touch                               # every state it reaches
            rec["display_name"] = (f"{g['name']}, {'/'.join(touch)}" if touch else g["name"])
        with open(out / "boundaries" / f"{slug}.geojson", "w") as fh:
            json.dump({"type": "FeatureCollection", "properties": rec, "features": feats}, fh)
        rows.append(rec)

    state["written"] = sorted(done)
    state["rows"] = rows
    save_state(state, state_path)
    rows.sort(key=lambda r: -r["area_km2"])
    order = [x.upper() for x in args.state_order]
    seen_states = sorted({r.get("state") for r in rows if r.get("state")})
    picker_order = order + [x for x in seen_states if x not in order]
    with open(out / "lakes.json", "w") as fh:
        json.dump({"generated_from": "USGS 3DHP, grouped by gnisid",
                   "bbox_wsen": [w, s, e, n], "count": len(rows),
                   "state_order": picker_order,
                   "by_state": {st: sorted([r["slug"] for r in rows if r.get("state") == st])
                                for st in picker_order},
                   "lakes": rows}, fh, indent=1)
    print(f"\n{len(rows):,} lakes -> {out}/lakes.json  in {(time.time()-t0)/60:.1f} min")
    if states:
        import collections as _c
        hist = _c.Counter(r.get("state") or "?" for r in rows)
        print("\nby state: " + "  ".join(f"{k}={v}" for k, v in
              sorted(hist.items(), key=lambda t: (picker_order.index(t[0])
                     if t[0] in picker_order else 99, t[0]))))
        multi = [r for r in rows if len(r.get("states") or []) > 1]
        print(f"{len(multi)} lakes span a state line, e.g. "
              + ", ".join(f"{r['slug']}({'/'.join(r['states'])})" for r in multi[:4]))
    print("\nlargest 15:")
    for r in rows[:15]:
        st = f"  {r.get('state') or '--'}" if states else ""
        print(f"  {r['slug']:34s} {r['area_km2']:9.2f} km2  {r['parts']:4d} parts{st}")
    print("DONE")


if __name__ == "__main__":
    main()
