#!/usr/bin/env python3
r"""build_gnis_historical.py -- the named places a reservoir drowned, from USGS GNIS.

Personal use only, not for distribution or resale; not for navigation.

    cd F:\TrollMapPipeline
    py .\scripts\build_gnis_historical.py

WHAT. GNIS keeps a HistoricalFeatures table: fords, ferries, shoals, islands, mill ponds, towns
and forts that existed and no longer do -- 26,296 of them nationally. The ones that sit inside one
of Ryan's waters are, almost by definition, under it: Peays Ferry, Mickles Ferry and Dukes Ford
on Wateree; Kempsons, Amicks, Wyses, Bauknight and Hollys Ferry on Murray; Fort Prince George
under Keowee. An old ford is a roadbed on the bottom and an old ferry is two landings facing each
other across the old channel, which is structure with a name on it.

Agreed valuable on 2026-09-22 and not started, and not on the register either, which is how Ryan
came to ask on 2026-09-23 why he could not see it on Wateree. Measured that evening: 538 features
inside a lake or river outline, on 64 waters -- 367 crossings, 73 islands, 52 towns (Loyston under
Norris; Chota, Toqua and Tuskeegee under Tellico), 17 creeks, 9 lakes, 8 swamps, and a handful of
shoals and canals.

THE RULE IS INSIDE THE OUTLINE, NOT NEAR IT. A bounding box around Wateree holds nine historical
features; its outline holds seven. The two that drop out are Biddle and Kingsbury, populated
places on the shore -- not drowned, and a label for them on the water would be a claim the data
does not make. No buffer: GNIS positions for historical features come off old topographic maps
and carry no stated accuracy, and there is no number here to widen the outline by.

TWO CLASSES ARE LEFT OUT, and by what they ARE rather than by count: `Civil` and `Census` are
administrative units -- a township, a census division -- with a point for a label. Nothing of
them is on the bottom.

NOT registry/gazetteer.jsonl. That file is Garmin chart labels keyed by tile id, written
2026-07-31, four weeks before the GNIS file reached the drive. See the register item
gnis-drowned-structures-not-in-app.

GNIS is a USGS product and in the public domain.
"""
import argparse
import datetime
import io
import json
import os
import sqlite3
import sys
import time

GNIS_GPKG = os.path.join("Gazetteer_National_GPKG", "Gazetteer_National_GPKG.gpkg")
NOT_ON_THE_BOTTOM = {"Civil", "Census"}
CITATION = ("U.S. Geological Survey, Geographic Names Information System (GNIS), "
            "HistoricalFeatures. Public domain.")


def clean_name(name):
    """'Peays Ferry (historical)' -> 'Peays Ferry'. The table says it; the map's style says it."""
    s = str(name or "").strip()
    return s[:-len(" (historical)")].rstrip() if s.lower().endswith(" (historical)") else s


def read_features(gpkg_path):
    c = sqlite3.connect(gpkg_path)
    try:
        rows = c.execute(
            "select feature_id, feature_name, feature_class, state_name, county_name, map_name, "
            "prim_lat_dec, prim_long_dec from HistoricalFeatures "
            "where prim_lat_dec is not null and prim_long_dec is not null").fetchall()
    finally:
        c.close()
    out = []
    for fid, name, cls, st, county, mapn, lat, lon in rows:
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        if lat == 0 and lon == 0:
            continue                                            # GNIS's "no position"
        out.append({"id": fid, "name": clean_name(name), "class": cls or None, "state": st or None,
                    "county": county or None, "map": mapn or None, "lat": lat, "lon": lon})
    return out


def inside(features, geom, bounds):
    """The features whose point lies inside `geom`. `bounds` (w, s, e, n) prefilters."""
    from shapely.geometry import Point
    from shapely.prepared import prep
    w, s, e, n = bounds
    pg = prep(geom)
    return [f for f in features
            if s <= f["lat"] <= n and w <= f["lon"] <= e and pg.contains(Point(f["lon"], f["lat"]))]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--root", default=".")
    a = ap.parse_args(argv)
    root = os.path.abspath(a.root)
    t0 = time.time()
    import geopandas as gpd

    gpkg = os.path.join(root, GNIS_GPKG)
    if not os.path.exists(gpkg):
        sys.exit(f"{gpkg} is missing")
    feats = read_features(gpkg)
    kept = [f for f in feats if f["class"] not in NOT_ON_THE_BOTTOM]
    print(f"{len(feats):,} historical features with a position; {len(feats) - len(kept):,} "
          f"administrative (Civil/Census) left out")

    with io.open(os.path.join(root, "registry", "lake_index.json"), encoding="utf-8") as fh:
        index = json.load(fh)
    bdir = os.path.join(root, "registry", "boundaries")
    waters, no_outline, n, read = {}, [], 0, 0
    for slug, row in sorted(index.items()):
        # LAKES AND RIVERS ONLY. A coastal zone's outline is a ZONE -- sound, marsh, barrier
        # island and all -- so "inside it" does not mean "under water". The first run took all
        # 352 rows and the 13 coastal zones added 114 features, 44 of them forts and batteries
        # (18 around Charleston alone) that stand on dry land. A lake or river outline is the
        # water itself, which is the only reason inside means drowned.
        if not isinstance(row, dict) or row.get("feature_type") not in ("lake", "river"):
            continue
        p = os.path.join(bdir, slug + ".geojson")
        if not os.path.exists(p):
            no_outline.append(slug)
            continue
        g = gpd.read_file(p)
        if g.crs is None:
            g = g.set_crs(4326)
        geom = g.to_crs(4326).geometry.union_all()
        read += 1
        hits = inside(kept, geom, geom.bounds)
        if hits:
            waters[slug] = sorted(({k: v for k, v in f.items() if v is not None} for f in hits),
                                  key=lambda f: (f["class"] or "", f["name"]))
            n += len(hits)
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = {"generated": now, "citation": CITATION,
           "note": ("GNIS historical features whose point lies INSIDE the water's own outline. "
                    "Positions come off old topographic maps and carry no stated accuracy. "
                    "Built by Scripts/build_gnis_historical.py; drawn by the map's chart-names "
                    "pass (js/modules/supplemental-layers.js)."),
           "excluded_classes": sorted(NOT_ON_THE_BOTTOM), "waters": waters}
    dst = os.path.join(root, "registry", "gnis_historical.json")
    with io.open(dst, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)
    classes = {}
    for lst in waters.values():
        for f in lst:
            classes[f["class"]] = classes.get(f["class"], 0) + 1
    print(f"{n} features inside an outline, on {len(waters)} waters "
          f"({read} lake and river outlines read, {len(no_outline)} without one)")
    print("by class: " + ", ".join(f"{k} {v}" for k, v in sorted(classes.items(), key=lambda kv: -kv[1])))
    for s in ("wateree_lake", "lake_murray", "lake_keowee"):
        print(f"  {s}: " + ", ".join(f"{f['name']} ({f['class']})" for f in waters.get(s, [])))
    print(f"-> {dst}  ({time.time() - t0:.0f} s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
