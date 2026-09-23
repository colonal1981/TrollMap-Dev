#!/usr/bin/env python3
r"""build_watershed_fish.py -- what fish each of Ryan's waters sits among, by 8-digit watershed.

Personal use only, not for distribution or resale; not for navigation.

    cd F:\TrollMapPipeline
    py .\scripts\build_watershed_fish.py                # fetch what is not cached, then build
    py .\scripts\build_watershed_fish.py --offline      # build from the cache only
    py .\scripts\build_watershed_fish.py --refresh      # re-fetch every watershed

WHY IT EXISTS. On 2026-09-23 four rivers had no species list anywhere -- Clinch, First Broad,
Nolichucky, Holston -- and discover mode can only admit a fish an agency document in hand names,
so they came back with 4, 2, 0 and never-run. The registry files (NC WRC, agency pages,
regulations, advisories) name fish per water where an agency wrote something; this is the layer
under them for everywhere else: which fish are recorded in the WATERSHED the water sits in.

TWO SOURCES, SPLIT THE WAY THE FIRST ONE SAYS TO SPLIT THEM.

  NatureServe. 2010. Digital Distribution Maps of the Freshwater Fishes in the Conterminous
  United States, v3.0 -- every NATIVE freshwater fish by 8-digit HUC, current or historic, with
  USGS's revision of the southeastern distributions. NatureServe's own download links 404 now
  (Ryan checked both, 2026-09-23); fishmap.org serves the same table one watershed per page and
  says so on its technology page. NatureServe's metadata: its exotic rows "are primarily derived
  from expert review of published records thought (falsely) to represent native occurrence ...
  recommend that this data be excluded" and points to USGS NAS. So:

  USGS Nonindigenous Aquatic Species -- the INTRODUCED fish, by the same HUC, from its public API,
  each record with a status (established, stocked, collected, failed ...), a year, a reference,
  and a coordinate. Stocked brown trout and established rainbows on the Nolichucky; blueback
  herring established in Keowee and Jocassee by name. The coordinate lets a record be tested
  against the water's own outline, which a watershed list cannot be.

A WATERSHED IS NOT A WATER, AND THE FILE SAYS SO. A HUC8 takes in its headwater creeks, so brook
trout are "in" the Nolichucky's watershed and not in its main stem. Every species carries where
its evidence is: the watershed, or an introduced-species record whose point is inside the water.
The Worker reads this as the LAST rung, under every registry and agency source.

TERMS. NatureServe grants non-commercial use with attribution and asks that the data not be
reposted on a website. The raw pages and the full per-watershed tables stay on this drive under
registry/_watershed_fish/. registry/watershed_fish.json -- the only file meant for R2 -- carries
each water's short derived lists and the citation, not the tables.
"""
import argparse
import datetime
import glob
import html
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

FISHMAP_URL = "https://www.fishmap.org/watershed.html?huc={huc}"
NAS_URL = "https://nas.er.usgs.gov/api/v2/occurrence/search?huc8={huc}&group=Fishes"
UA = {"User-Agent": "TrollMap personal research (non-commercial; one request per watershed)"}

CITATIONS = {
    "natureserve": ("NatureServe. 2010. Digital Distribution Maps of the Freshwater Fishes in the "
                    "Conterminous United States. Version 3.0. Arlington, VA. Served per watershed "
                    "by FishMap.org."),
    "nas": ("U.S. Geological Survey. Nonindigenous Aquatic Species Database. Gainesville, FL. "
            "https://nas.er.usgs.gov"),
}

# WHEN DOES A WATER COUNT AS BEING IN A WATERSHED. Not by an area share -- 118 water/watershed
# pairs measured 2026-09-23 run continuously from 0.0000% up, and the small ones are both kinds:
# Wateree Lake's 0.0000% of Lower Catawba is the dam line, Douglas Lake's 1.47% of the Nolichucky
# is the Nolichucky arm. Any share cut-off would be a number chosen to split them.
#
# The WBD's own positional accuracy is the number that already exists. The dataset is delineated
# on the USGS 1:24,000 base, and National Map Accuracy Standards at 1:24,000 put 90% of
# well-defined points within 1/50 inch at scale -- 40 ft, 12.2 m. A water that reaches into a
# watershed by less than that has touched the line the watershed was drawn with, not the
# watershed. A water counts as in it when it is still inside after the watershed is shrunk by
# that much.
WBD_POSITIONAL_ACCURACY_M = 12.2

# NAS statuses that say the fish LIVES there now. The rest -- collected, failed, extirpated,
# eradicated, unknown, blank -- are kept in the file as reported and not promoted.
NAS_PRESENT = {"established", "stocked"}


# ── PARSING ───────────────────────────────────────────────────────────────────────────────────

_TR = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S | re.I)
_TD = re.compile(r"<td[^>]*>(.*?)</td>", re.S | re.I)
_TAG = re.compile(r"<[^>]+>")


def _text(cell):
    return re.sub(r"\s+", " ", html.unescape(_TAG.sub(" ", cell))).strip()


def parse_fishmap(page):
    """Rows of a fishmap watershed page: common, scientific, origin, occurrence, source.

    A data row is five cells whose second is an italic binomial. Anything else -- the spacer rows
    between species, the header -- is skipped by shape, not by position.
    """
    out = []
    for tr in _TR.findall(page or ""):
        tds = _TD.findall(tr)
        if len(tds) != 5 or "<i>" not in tds[1].lower():
            continue
        common, sci, origin, occ, src = (_text(t) for t in tds)
        if not re.match(r"^[A-Z][a-z]+ [a-z\-]+", sci):
            continue
        out.append({"common": common, "scientific": sci, "origin": origin.lower() or None,
                    "occurrence": occ.lower() or None, "source": src})
    return out


def parse_nas(doc):
    """NAS occurrence records, one per record, trimmed to what the build reads."""
    out = []
    for r in (doc or {}).get("results") or []:
        sci = str(r.get("scientificName") or "").strip()
        if not sci:
            continue
        lat, lon = r.get("decimalLatitude"), r.get("decimalLongitude")
        out.append({"common": str(r.get("commonName") or "").strip(), "scientific": sci,
                    "family": r.get("family") or None,
                    "status": str(r.get("status") or "").strip().lower(),
                    "year": r.get("year"), "locality": r.get("locality") or "",
                    "lat": lat if isinstance(lat, (int, float)) else None,
                    "lon": lon if isinstance(lon, (int, float)) else None,
                    "accuracy": r.get("latLongAccuracy") or None})
    return out


# ── FETCH, ONE WATERSHED AT A TIME, CACHED ON THE DRIVE ────────────────────────────────────────

def _get(url, timeout=90):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def cached_fetch(path, url, refresh, offline, delay):
    """(bytes or None, 'cache'|'fetched'|'missing'|error text). Never raises."""
    if os.path.exists(path) and not refresh:
        with open(path, "rb") as fh:
            return fh.read(), "cache"
    if offline:
        return None, "missing"
    try:
        body = _get(url)
    except Exception as e:                                     # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"
    # WRITTEN WHOLE OR NOT AT ALL. A page cut off mid-write parses to fewer rows with no error,
    # and the cache is read back without re-checking, so a short file would be a quietly short
    # species list for the life of the cache.
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    with open(tmp, "wb") as fh:
        fh.write(body)
    os.replace(tmp, path)
    time.sleep(delay)
    return body, "fetched"


# ── NAMES AND FAMILIES ─────────────────────────────────────────────────────────────────────────

def app_names(repo, traits_path, agency_path, pairs):
    """{(common, scientific): {name, by, role}} from Scripts/watershed_names.mjs -- the only
    translation into the app's names, owned by the app's own files. `role` is target, forage
    (a fish an agency page writes as prey) or non-game."""
    if not pairs:
        return {}
    script = os.path.join(repo, "Scripts", "watershed_names.mjs")
    if not os.path.exists(agency_path):
        # Without the agency pages nothing can be called prey, and a forage list built without
        # them would be the canon's "not a target" -- gar included -- dressed as forage.
        raise SystemExit(f"{agency_path} is missing -- forage cannot be told from non-game "
                         f"without it; build it with build_agency_lake_facts.py")
    res = subprocess.run(["node", script, traits_path, agency_path], input=json.dumps(pairs),
                         capture_output=True, text=True, encoding="utf-8", check=True)
    return {(r["common"], r["scientific"]): r for r in json.loads(res.stdout)}


def family_index(export_path):
    """{binomial lower: family} from a NatureServe Explorer export, synonyms included, fish only.

    Ryan's export of 2026-09-23 is the whole of NatureServe's taxonomy -- 89,754 elements, 2,346
    of them fish. It has no watersheds, which is why it could not answer the question it was
    pulled for, but it is a complete, current family for every fish name either source uses,
    including the 2010 names NatureServe has since changed (Stizostedion -> Sander).
    """
    if not export_path or not os.path.exists(export_path):
        return {}
    with io.open(export_path, encoding="utf-8") as fh:
        d = json.load(fh)
    out = {}
    for e in d:
        sg = e.get("speciesGlobal") or {}
        if sg.get("taxclass") not in ("Actinopterygii", "Cephalaspidomorphi", "Chondrichthyes"):
            continue
        fam = sg.get("family")
        if not fam:
            continue
        for n in [e.get("scientificName")] + list(sg.get("synonyms") or []):
            k = re.sub(r"\s+", " ", str(n or "")).strip().lower()
            if re.match(r"^[a-z]+ [a-z\-]+$", k):
                out.setdefault(k, fam)
    return out


# ── WHICH WATERSHEDS EACH WATER IS IN, FROM ITS OWN OUTLINE ────────────────────────────────────

def waters_in_watersheds(root):
    """({slug: {kind, geom}}, {slug: {"in": [...], "touched": [...]}}, report lines).

    Every freshwater row of the registry, against WBD HU8 on the drive. `in` is a watershed the
    water still reaches after it is shrunk by the WBD's own accuracy; `touched` is one it meets
    only within that line. Both carry the share of the water's area, so a reader can see it.

    THE REGISTRY, NOT THE GAUGE BINDINGS. The first run read water_bindings.json -- 191 lakes and
    rivers -- and lake_index.json holds 339, every one with an outline in registry/boundaries.
    registrySpeciesFor() resolves against lake_index, so that is the set that has to be covered;
    a water missing here would be the Worker asking for a slug this file never wrote.
    """
    import geopandas as gpd
    import pandas as pd

    with io.open(os.path.join(root, "registry", "lake_index.json"), encoding="utf-8") as fh:
        b = json.load(fh)
    fresh = {k: v for k, v in b.items()
             if isinstance(v, dict) and v.get("feature_type") in ("lake", "river")}
    bdir = os.path.join(root, "registry", "boundaries")
    rows, missing = [], []
    for slug, v in sorted(fresh.items()):
        p = os.path.join(bdir, slug + ".geojson")
        if not os.path.exists(p):
            missing.append(slug)
            continue
        g = gpd.read_file(p)
        if g.crs is None:
            g = g.set_crs(4326)
        rows.append({"slug": slug, "kind": v["feature_type"],
                     "geometry": g.to_crs(4326).geometry.union_all()})
    waters = gpd.GeoDataFrame(pd.DataFrame(rows), geometry="geometry", crs=4326)
    minx, miny, maxx, maxy = waters.total_bounds
    hu8 = gpd.read_file(os.path.join(root, "WBD_National_GPKG", "WBD_National_GPKG.gpkg"),
                        layer="WBDHU8", bbox=(minx, miny, maxx, maxy),
                        columns=["huc8", "name", "states"]).to_crs(4326)

    A = 5070                                                   # CONUS Albers, metres
    w5, h5 = waters.to_crs(A), hu8.to_crs(A)
    inter = gpd.overlay(w5[["slug", "geometry"]], h5[["huc8", "name", "geometry"]],
                        how="intersection", keep_geom_type=True)
    inter["a"] = inter.geometry.area
    inter["share"] = inter["a"] / inter.groupby("slug")["a"].transform("sum")
    shrunk = h5.copy()
    shrunk["geometry"] = h5.geometry.buffer(-WBD_POSITIONAL_ACCURACY_M)
    beyond = gpd.overlay(w5[["slug", "geometry"]], shrunk[["huc8", "geometry"]],
                         how="intersection", keep_geom_type=True)
    real = {(r.slug, r.huc8) for r in beyond.itertuples() if not r.geometry.is_empty}

    hucs = {}
    for r in inter.sort_values("share", ascending=False).itertuples():
        e = {"huc8": r.huc8, "name": r.name, "share": round(float(r.share), 4)}
        hucs.setdefault(r.slug, {"in": [], "touched": []})[
            "in" if (r.slug, r.huc8) in real else "touched"].append(e)
    geoms = {r.slug: {"kind": r.kind, "geom": r.geometry} for r in waters.itertuples()}
    rep = [f"{len(fresh)} freshwater registry rows, {len(geoms)} with an outline"
           + (f", {len(missing)} without: {', '.join(missing)}" if missing else "")]
    n_in = sum(len(v["in"]) for v in hucs.values())
    n_t = sum(len(v["touched"]) for v in hucs.values())
    rep.append(f"{n_in} water/watershed pairs count; {n_t} only touch a watershed's line "
               f"(within the WBD's {WBD_POSITIONAL_ACCURACY_M} m accuracy)")
    return geoms, hucs, rep


# ── ONE WATERSHED'S FISH ───────────────────────────────────────────────────────────────────────

def watershed_table(ns_rows, nas_rows, names, families):
    """{binomial: entry} for one HUC8, both sources merged on the binomial."""
    out = {}

    def entry(common, sci):
        k = re.sub(r"\s+", " ", sci).strip()
        e = out.get(k)
        if e is None:
            n = names.get((common, sci)) or {}
            e = out[k] = {"scientific": k, "common": common, "name": n.get("name"),
                          "role": n.get("role"), "family": families.get(k.lower()),
                          "native": None, "introduced": None}
        return e

    for r in ns_rows:
        e = entry(r["common"], r["scientific"])
        # Origin as NatureServe states it. Its non-native rows are the ones its own metadata says
        # to exclude, so only a Native row is taken from this source.
        if r["origin"] == "native":
            e["native"] = {"occurrence": r["occurrence"]}
    for r in nas_rows:
        e = entry(r["common"], r["scientific"])
        if not e["family"] and r["family"]:
            e["family"] = r["family"]
        i = e["introduced"] or {"statuses": [], "records": 0, "last_year": None, "_pts": []}
        if r["status"] and r["status"] not in i["statuses"]:
            i["statuses"].append(r["status"])
        i["records"] += 1
        if isinstance(r["year"], int):
            i["last_year"] = max(i["last_year"] or r["year"], r["year"])
        if r["lat"] is not None and r["lon"] is not None:
            i["_pts"].append((r["lon"], r["lat"], r["status"]))
        e["introduced"] = i
    return out


def present(e):
    """Does this watershed's evidence say the fish lives there now? (bool, basis)."""
    if e.get("native") and e["native"].get("occurrence") == "current":
        return True, "native"
    i = e.get("introduced") or {}
    if set(i.get("statuses") or []) & NAS_PRESENT:
        return True, "introduced"
    return False, None


# ── ONE WATER, FROM THE WATERSHEDS IT IS IN ────────────────────────────────────────────────────

def derive_water(geom, huc_list, tables):
    """The short lists the app reads for one water.

    targets / forage   app-named fish whose evidence says they live in at least one of the
                       water's watersheds now; each says which source (native / introduced),
                       which watersheds, and how many present-status NAS points fall INSIDE the
                       water's own outline -- the one piece of evidence that is about the water.
    historic_only      app-named natives recorded in the watershed only historically.
    reported           app-named introductions NAS records here without an established or
                       stocked status (collected once, failed, unknown).
    families           every fish living in the watershed(s) now, counted by family, named or
                       not -- the shiners, darters and sculpins a river's forage is made of,
                       which the app has no names for yet.
    """
    from shapely.geometry import Point
    from shapely.prepared import prep
    pg = prep(geom)
    lists = {"target": {}, "forage": {}}
    historic, reported, fam = {}, {}, {}
    for h in huc_list:
        for sci, e in (tables.get(h["huc8"]) or {}).items():
            live, basis = present(e)
            if live and e.get("family"):
                fam.setdefault(e["family"], set()).add(sci)
            name, role = e.get("name"), e.get("role")
            if not name:
                continue
            if live and role in lists:
                it = lists[role].setdefault(name, {"name": name, "basis": [], "hucs": [],
                                                   "in_water": 0, "scientific": []})
                if basis not in it["basis"]:
                    it["basis"].append(basis)
                if h["huc8"] not in it["hucs"]:
                    it["hucs"].append(h["huc8"])
                if sci not in it["scientific"]:
                    it["scientific"].append(sci)
                for lon, lat, st in (e.get("introduced") or {}).get("_pts") or []:
                    if st in NAS_PRESENT and pg.contains(Point(lon, lat)):
                        it["in_water"] += 1
            elif e.get("native") and e["native"].get("occurrence") == "historic":
                historic.setdefault(name, set()).add(h["huc8"])
            elif e.get("introduced"):
                reported.setdefault(name, set()).update(e["introduced"]["statuses"] or ["(blank)"])
    live_names = set(lists["target"]) | set(lists["forage"])
    return {
        "targets": sorted(lists["target"].values(), key=lambda x: x["name"]),
        "forage": sorted(lists["forage"].values(), key=lambda x: x["name"]),
        "historic_only": sorted(n for n in historic if n not in live_names),
        "reported": {n: sorted(s) for n, s in sorted(reported.items()) if n not in live_names},
        "families": {f: len(s) for f, s in sorted(fam.items(), key=lambda kv: (-len(kv[1]), kv[0]))},
    }


def newest_export(root):
    c = sorted(glob.glob(os.path.join(root, "nsExplorer-Export-*.json")), key=os.path.getmtime)
    return c[-1] if c else None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--root", default=".")
    ap.add_argument("--repo", default="TrollMap-Dev")
    ap.add_argument("--offline", action="store_true", help="build from the cache only")
    ap.add_argument("--refresh", action="store_true", help="re-fetch every watershed")
    ap.add_argument("--delay", type=float, default=1.0,
                    help="seconds between requests to each site (courtesy, not a data rule)")
    ap.add_argument("--ns-export", default=None,
                    help="NatureServe Explorer export for families (default: newest in --root)")
    a = ap.parse_args(argv)
    root = os.path.abspath(a.root)
    repo = os.path.join(root, a.repo)
    cache = os.path.join(root, "registry", "_watershed_fish")
    t0 = time.time()

    geoms, hucs, rep = waters_in_watersheds(root)
    for line in rep:
        print(line)
    wanted = sorted({h["huc8"] for v in hucs.values() for h in v["in"]})
    print(f"{len(wanted)} watersheds to read")

    ns, nas, fetch_log = {}, {}, {"fishmap": {}, "nas": {}}
    for i, huc in enumerate(wanted, 1):
        body, how = cached_fetch(os.path.join(cache, "fishmap", huc + ".html"),
                                 FISHMAP_URL.format(huc=huc), a.refresh, a.offline, a.delay)
        fetch_log["fishmap"][huc] = how
        ns[huc] = parse_fishmap(body.decode("utf-8", "replace")) if body else None
        body, how = cached_fetch(os.path.join(cache, "nas", huc + ".json"),
                                 NAS_URL.format(huc=huc), a.refresh, a.offline, a.delay)
        fetch_log["nas"][huc] = how
        nas[huc] = parse_nas(json.loads(body)) if body else None
        if i % 10 == 0 or i == len(wanted):
            print(f"   {i}/{len(wanted)} watersheds read  ({time.time() - t0:.0f} s)")

    pairs = sorted({(r["common"], r["scientific"]) for rows in list(ns.values()) + list(nas.values())
                    for r in (rows or [])})
    traits = os.path.join(root, "registry", "species_traits.json")
    agency = os.path.join(root, "registry", "agency_lake_facts.json")
    names = app_names(repo, traits, agency, [{"common": c, "scientific": s} for c, s in pairs])
    export = a.ns_export or newest_export(root)
    families = family_index(export)
    tables = {h: watershed_table(ns[h] or [], nas[h] or [], names, families) for h in wanted}

    waters = {}
    for slug in sorted(geoms):
        hin = (hucs.get(slug) or {}).get("in") or []
        d = derive_water(geoms[slug]["geom"], hin, tables)
        d = {"kind": geoms[slug]["kind"], "hucs": hin,
             "hucs_touched_only": (hucs.get(slug) or {}).get("touched") or [], **d}
        unread = [h["huc8"] for h in hin if not ns.get(h["huc8"])]
        if unread:
            # A WATERSHED WITH NO TABLE IS UNKNOWN, NOT EMPTY. NatureServe 2010 used the 2000-era
            # HUC codes and a few have been renumbered since; a code fishmap has no page for
            # says nothing about the fish.
            d["natives_unread_for"] = unread
        waters[slug] = d

    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    full = {"generated": now, "citations": CITATIONS, "fetch": fetch_log,
            "hucs": {h: {sci: {k: v for k, v in e.items() if k != "introduced"}
                         | ({"introduced": {k: v for k, v in e["introduced"].items() if k != "_pts"}}
                            if e.get("introduced") else {})
                         for sci, e in tables[h].items()} for h in wanted}}
    os.makedirs(cache, exist_ok=True)
    with io.open(os.path.join(cache, "huc_species.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(full, fh, indent=1, ensure_ascii=False)
    out = {"generated": now,
           "note": ("What fish each water sits among, by 8-digit watershed. The LAST rung under "
                    "every registry and agency roster: a watershed takes in its headwater creeks, "
                    "so presence here is 'recorded in this watershed', not 'in this water' -- "
                    "except in_water, which counts introduced-species records whose point is "
                    "inside the water's own outline. Built by Scripts/build_watershed_fish.py."),
           "citations": CITATIONS, "rule": {
               "watershed_membership": f"inside the watershed by more than the WBD's "
                                       f"{WBD_POSITIONAL_ACCURACY_M} m positional accuracy",
               "native": "NatureServe row with origin Native and occurrence Current",
               "introduced": f"USGS NAS record with status in {sorted(NAS_PRESENT)}"},
           "waters": waters}
    with io.open(os.path.join(root, "registry", "watershed_fish.json"), "w", encoding="utf-8",
                 newline="\n") as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)
    report(out, full, fetch_log, names, time.time() - t0)
    return 0


def report(out, full, fetch_log, names, secs):
    waters = out["waters"]
    errs = {s: {h: v for h, v in d.items() if v not in ("cache", "fetched")}
            for s, d in fetch_log.items()}
    for s, bad in errs.items():
        if bad:
            print(f"!! {s}: {len(bad)} watershed(s) not read: "
                  + ", ".join(f"{h} ({v})" for h, v in sorted(bad.items())))
    empty = sorted(h for h, v in fetch_log["fishmap"].items()
                   if v in ("cache", "fetched") and not any(
                       e.get("native") for e in full["hucs"].get(h, {}).values()))
    if empty:
        print(f"!! fishmap has no native table for {len(empty)} code(s): {', '.join(empty)} "
              f"-- unknown, not empty")
    n_t = [len(w["targets"]) for w in waters.values()]
    print(f"\n{len(waters)} waters written; targets per water: min {min(n_t)}, "
          f"median {sorted(n_t)[len(n_t) // 2]}, max {max(n_t)}")
    print(f"waters with a forage fish named: {sum(1 for w in waters.values() if w['forage'])}")
    unnamed = {}
    for h in full["hucs"].values():
        for sci, e in h.items():
            if not e.get("name"):
                unnamed.setdefault(e.get("family") or "?", set()).add(e.get("common") or sci)
    print(f"fish with no app name, by family (the app has no word for these yet): "
          + ", ".join(f"{f} {len(s)}" for f, s in sorted(unnamed.items(), key=lambda kv: -len(kv[1]))[:10]))
    # The four rivers that had no roster anywhere on 2026-09-23, printed every run so the effect is
    # the first thing on screen.
    for slug in ("nolichucky_river", "nolichucky_river_2", "clinch_river", "first_broad_river",
                 "holston_river"):
        w = waters.get(slug)
        if not w:
            m = [s for s in waters if slug.split("_")[0] in s]
            print(f"\n{slug}: not a binding slug; near: {', '.join(m[:6])}")
            continue
        print(f"\n{slug} ({', '.join(h['huc8'] + ' ' + h['name'] for h in w['hucs'])})")
        print("   targets: " + ", ".join(
            t["name"] + ("*" if "introduced" in t["basis"] else "") + (f" [{t['in_water']} in water]"
                                                                       if t["in_water"] else "")
            for t in w["targets"]))
        print("   forage:  " + (", ".join(f["name"] for f in w["forage"]) or "-"))
        print("   families: " + ", ".join(f"{k} {v}" for k, v in list(w["families"].items())[:8]))
    print(f"\n* introduced (USGS NAS). done in {secs:.0f} s")


if __name__ == "__main__":
    sys.exit(main())
