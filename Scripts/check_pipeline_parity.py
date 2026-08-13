#!/usr/bin/env python3
"""
check_pipeline_parity.py — the lists that must agree, checked before a build.

    py scripts/check_pipeline_parity.py

Run this before the extraction and again before the upload. Exits 1 on any
disagreement.

Written 2026-08-04, after `coast_cape_romain_sc` was found sitting in
COASTAL_PRIMARY, in lake_index.json and in coastal-zones.js while being absent
from coastal_catalog.py — the one file that drives extraction and the slug list
this project's coastal uploader reads. The app offered the zone, the tier list
promised it every layer, and nothing built or shipped it. Nothing raised.

That is the shape of every expensive bug in this pipeline: two lists that are
supposed to be the same list, and no code that ever compares them. The lists are
cheap to compare; the rebuild after shipping without one is not.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

def _app_tree(root):
    """Find the app checkout instead of naming it.

    It was hardcoded to `TrollMap-Dev-main`, which was renamed to `TrollMap-Dev` on
    2026-08-06 with the old copy left beside it as `TrollMap-Dev-main-NO_LONGER_USED`.
    A hardcoded name does not just break — it can find the RETIRED tree and compare
    against a stale copy while reporting success.

    Newest candidate wins, and anything marked NO_LONGER_USED is refused outright.
    """
    import os
    cands = []
    for name in os.listdir(root):
        p = os.path.join(root, name)
        if not os.path.isdir(p) or not name.startswith('TrollMap-Dev'):
            continue
        if 'NO_LONGER_USED' in name.upper():
            continue
        if not os.path.isdir(os.path.join(p, 'js', 'data')):
            continue
        cands.append((os.path.getmtime(p), p))
    if not cands:
        raise SystemExit('FATAL: no app checkout under %s (looked for TrollMap-Dev*/js/data). '
                         'Refusing to run rather than compare against nothing.' % root)
    return max(cands)[1]


FAILURES = []


def check(label, detail=""):
    FAILURES.append(label + (("\n        " + detail) if detail else ""))


def fmt(s, limit=8):
    s = sorted(s)
    return ", ".join(s[:limit]) + (f" ... (+{len(s) - limit} more)" if len(s) > limit else "")


# ── load every list ──────────────────────────────────────────────────────────
from coastal_catalog import COASTAL_CATALOG            # noqa: E402
from upload_garmin_to_r2 import COASTAL_PRIMARY        # noqa: E402

index = json.loads((ROOT / "registry" / "lake_index.json").read_text(encoding="utf-8"))
idx_all = set(index)
idx_coastal = {k for k in idx_all if k.startswith("coast_")}
cat = set(COASTAL_CATALOG)

APP = Path(_app_tree(str(ROOT)))
print(f"app tree            {APP.name}")
js_path = APP / "js" / "data" / "coastal-zones.js"
js_src = js_path.read_text(encoding="utf-8")
import re                                              # noqa: E402
js_zones = set(re.findall(r'["\'](coast_[a-z0-9_]+)["\']\s*:', js_src))

keys_path = APP / "js" / "data" / "lake-keys.js"
keys_src = keys_path.read_text(encoding="utf-8")
body = keys_src[keys_src.index("LAKE_NAME_TO_R2_KEY = {"):]
body = body[:body.index("\n};")]
# Skip commented-out entries. A name deliberately unmapped is not a dead slug —
# reporting it as one turns the honest state into a permanent false failure.
live = "\n".join(l for l in body.split("\n") if not l.lstrip().startswith("//"))
name_to_slug = dict(re.findall(r"'([^']+)':\s*'([^']+)'", live))

print(f"coastal_catalog.py   {len(cat):>5} zones")
print(f"coastal-zones.js     {len(js_zones):>5} zones")
print(f"lake_index.json      {len(idx_all):>5} entries ({len(idx_coastal)} coastal)")
print(f"COASTAL_PRIMARY      {len(COASTAL_PRIMARY):>5} zones")
print(f"lake-keys.js         {len(name_to_slug):>5} names -> {len(set(name_to_slug.values()))} slugs")
print()

# ── 1. the coastal lists are one list ────────────────────────────────────────
if COASTAL_PRIMARY - cat:
    check("COASTAL_PRIMARY names a zone the catalog does not build",
          fmt(COASTAL_PRIMARY - cat) + "\n        -> promised all layers, extracted by nothing")
if idx_coastal - cat:
    check("lake_index.json has a coastal zone the catalog does not build", fmt(idx_coastal - cat))
if cat - idx_coastal:
    check("the catalog builds a zone the index does not carry", fmt(cat - idx_coastal))
if js_zones != idx_coastal:
    if js_zones - idx_coastal:
        check("coastal-zones.js offers a zone with no index entry", fmt(js_zones - idx_coastal))
    if idx_coastal - js_zones:
        check("the index has a coastal zone the app cannot offer", fmt(idx_coastal - js_zones))

# ── 2. every slug the app asks for exists ────────────────────────────────────
# This is the one that matters most. lake-keys.js is hand-maintained and
# lake_index.json is generated, so a regenerated index silently orphans display
# names. Measured 2026-08-04: 36 of 93 slugs were dead, including Lake Wateree.
dead = {}
for name, slug in name_to_slug.items():
    if slug not in idx_all:
        dead.setdefault(slug, []).append(name)
if dead:
    lines = []
    for slug, names in sorted(dead.items())[:20]:
        lines.append(f"{slug:<34} <- {'; '.join(names[:3])}")
    extra = f"\n        ... (+{len(dead) - 20} more slugs)" if len(dead) > 20 else ""
    check(f"lake-keys.js references {len(dead)} slug(s) that are not in lake_index.json",
          "\n        ".join(lines) + extra)

# ── 3. every index entry that CAN be built HAS been built ────────────────────
# Split deliberately into two questions the old reporting ran together:
#   * no boundary  -> there was never anything to build. Not a failure.
#   * boundary but no pack -> the build skipped it. That IS a failure, and it is
#     the one worth a targeted re-run (`build_all_chartpacks.py --only-lakes`).
pack_dir = ROOT / "chartpack"
if pack_dir.is_dir():
    built = {p.name for p in pack_dir.iterdir() if p.is_dir()}
    # registry/boundaries/, not lake_boundaries/. The latter was retired to _to_delete/ on
    # 2026-08-12, so this test was reading an empty set and calling every built pack
    # "boundary but no pack" -- or rather, never calling anything that, because has_boundary()
    # returned False for everything and the branch it guards never fired.
    bdir = ROOT / "registry" / "boundaries"
    bfiles = {p.name for p in bdir.iterdir()} if bdir.is_dir() else set()

    def has_boundary(slug):
        return any(f.startswith(slug + "_") or f == slug + ".geojson" for f in bfiles)

    charted_path = ROOT / "registry" / "charted.json"
    judged = {}
    if charted_path.exists():
        cj = json.loads(charted_path.read_text(encoding="utf-8"))
        judged = cj if isinstance(cj, dict) else {r.get("slug"): r for r in cj}

    def already_rejected(slug):
        r = judged.get(slug)
        return bool(r and r.get("skipped") and not (r.get("counts_core") or {}))

    unbuilt_coastal = {z for z in (idx_coastal - built) if not already_rejected(z)}
    rejected_coastal = (idx_coastal - built) - unbuilt_coastal
    if rejected_coastal:
        print(f"  note: {len(rejected_coastal)} coastal zone(s) have no Garmin data inside them — "
              f"correctly not built ({fmt(rejected_coastal)})")
    if unbuilt_coastal:
        check(f"{len(unbuilt_coastal)} coastal zone(s) in the index have no chartpack",
              fmt(unbuilt_coastal))

    # A boundary with no pack is NOT a build failure by itself. The builder measures
    # what falls INSIDE the boundary and records the verdict in charted.json; a lake
    # with counts_core == {} has no Garmin data in it and there is no pack to build.
    #
    # The first version of this check ignored that and reported all of them as skipped
    # builds. Ryan re-ran the builder against ten of them on 2026-08-04 and it was a
    # no-op: "1649 lakes examined, shipped 1502" — unchanged, because all ten were
    # already correctly rejected. A check that sends you to rebuild what cannot be
    # built is worse than no check.
    #
    # It looks at `counts_core` and not `counts`: `counts` is tile-level and includes
    # features NEAR the lake, so little_river reads 65 contours there and {} inside its
    # own boundary. Reading the wrong one is how the false alarm survived a second look.
    skipped = sorted(s for s in (idx_all - built - idx_coastal)
                     if has_boundary(s) and not already_rejected(s))
    rejected = sum(1 for s in (idx_all - built - idx_coastal)
                   if has_boundary(s) and already_rejected(s))
    if rejected:
        print(f"  note: {rejected} lake(s) have a boundary but no Garmin data inside it — "
              f"correctly not built")
    if skipped:
        sized = sorted(((index[s].get("area_acres") or 0, s) for s in skipped), reverse=True)
        check(f"{len(skipped)} lake(s) have a boundary and Garmin data but no chartpack",
              "\n        ".join(f"{a:>8.0f} ac  {s}" for a, s in sized[:12]))

    no_boundary = len(idx_all - built - idx_coastal) - len(skipped)
    print(f"  note: {no_boundary} index entries have no boundary to build from — not a build failure")

# ── 4. pointer files resolve, if they exist ──────────────────────────────────
for fname in ("_coastal_pointers.json", "_river_aliases.json"):
    # registry/ only; the lake_boundaries/ fallback went with the folder on 2026-08-13.
    p = ROOT / "registry" / fname
    if not p.exists():
        print(f"  note: {fname} not present — skipped")
        continue
    data = json.loads(p.read_text(encoding="utf-8"))
    # Both files map key -> record, where the record is a dict. _river_aliases.json
    # points via "alias_of"; _coastal_pointers.json via "zone"/"slug".
    def target(v):
        if isinstance(v, str):
            return v
        return v.get("alias_of") or v.get("zone") or v.get("slug")
    pairs = [((v.get("name") if isinstance(v, dict) else k) or k, target(v))
             for k, v in (data.items() if isinstance(data, dict) else enumerate(data))]
    pairs = [(n, t) for n, t in pairs if t]
    bad = {n: s for n, s in pairs if s not in idx_all}
    if bad:
        check(f"{fname}: {len(bad)} name(s) point at a slug that does not exist",
              fmt([f"{n} -> {s}" for n, s in bad.items()], 6))

# ── report ───────────────────────────────────────────────────────────────────
if FAILURES:
    print(f"{len(FAILURES)} disagreement(s):\n")
    for f in FAILURES:
        print("  FAIL  " + f)
    print()
    sys.exit(1)
print("  ok    every list agrees\n")
