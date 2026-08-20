#!/usr/bin/env python3
"""
r2_audit.py — what is actually in the R2 bucket, and what of it can go.

    py .\\r2_audit.py                                   # audit the live bucket
    py .\\r2_audit.py --save F:\\TrollMapPipeline\\registry\\_r2_listing.json
    py .\\r2_audit.py --from F:\\TrollMapPipeline\\registry\\_r2_listing.json
    py .\\r2_audit.py --delete-list F:\\TrollMapPipeline\\registry\\_r2_delete.txt

WHY THIS EXISTS

On 2026-08-04 the bucket was 11.49 GB against a 10 GB free tier and the question "what is in
there?" had no answer that did not involve clicking through a dashboard. The answer mattered,
because the plan on the table was deleting Tennessee -- 225 waters -- to get back under, and
nobody had checked whether the bytes were even in the lakes.

They were not, entirely. 9.17 GB of the 11.49 was chartpack GeoJSON uploaded uncompressed
because of a Worker header bug (see upload_garmin_to_r2.py), and a further 0.7 GB was layers
nothing reads.

THIS SCRIPT NEVER DELETES ANYTHING. It reads the bucket and, with --delete-list, writes a file
of exact object keys. prune_r2_objects.py --list does the deleting, and only after you have
read the file. Two steps on purpose: a script that both decides and destroys is one bad glob
away from taking a state with it.

WHAT GOES ON THE DELETE LIST, AND WHY EACH RULE IS SAFE

  pipeline-only layers   waterbody.geojson, hydrography.geojson on any slug. These are BUILD
                         inputs -- waterbody carries the mode 6/20 lake_id that attributes a
                         pack to a lake, and that happens on disk, before upload. Verified
                         2026-08-03 across the whole tree: zero client references, zero Worker
                         references. The rule is imported from upload_garmin_to_r2.py rather
                         than restated, so it cannot drift from what the uploader believes.

  coastal secondary      A coastal zone outside the Edisto-to-Murrells band ships docks, POIs
                         and shoreline only -- Ryan, 2026-08-03: "the other areas are perfectly
                         fine with NOAA and the garmin poi/docks." Contours and depth_areas on
                         those zones predate the rule. Same import, same reason.

  skip slugs             sc_ga_coastal and saluda_river_arm, which the uploader already refuses
                         to push and which exist in R2 only from before it did.

ORPHANS ARE REPORTED, NOT LISTED. A slug in R2 with no registry entry is usually stale, but 23
of the 39 found on 2026-08-04 were still named in js/ -- deleting those removes a lake from the
app. They need a decision per slug, so they get printed with their size and left alone.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

# The rules live in the uploader. Importing them means "what R2 should hold" has exactly one
# definition; a copy here would be correct today and wrong the first time either file moved.
from upload_garmin_to_r2 import (
    LAYERS, PIPELINE_ONLY, SKIP_SLUGS,
)

# LAYERS A RETIRED PIPELINE PUT IN THE BUCKET, and the reason this is a literal set rather than
# an import.
#
# These four names were reached by importing upload_to_r2_coastal.py, which was retired
# 2026-08-19: upload_garmin_to_r2.py covers every coastal zone, and its own comment called it
# an ungated second road to R2. The third reason given that day -- that its OUTPUT_DIR named
# split_output3, "a directory gone for weeks" -- was wrong. Ryan renamed that directory to
# "I-Boating Contours and supplemental data"; it is on the drive, and SOURCE_MAP below names
# it as the local home of the very four layers listed here. The path went stale, the data did
# not move, and the retirement stands on the two reasons that survive. The header above says rules are imported so they cannot drift from
# what the uploader believes -- but once the uploader is gone there is nothing left to drift
# from, and these stop being a rule about what to WRITE and become a fact about what the bucket
# already HOLDS. That fact belongs here, where the bucket is judged.
#
# They are not optional. Without them these objects fall out of KNOWN_PACK_FILES, and an object
# with no rule is invisible twice over: never proposed, and its absence reads like there being
# none. Measured on the live listing: shoreline 81 objects, depth_soundings 20,
# fishing_lines 15, fishing_points 15.
RETIRED_PIPELINE_FILES = {
    "shoreline.geojson",
    "depth_soundings.geojson",
    "fishing_lines.geojson",
    "fishing_points.geojson",
}

WORKER = "https://trollmap-worker.colonal1981.workers.dev"
FILE_TO_LAYER = {fname: layer for layer, fname in LAYERS.items()}

# Everything this script is willing to have an opinion about. index.json, meta.json and
# vectors/contours.geojson are not in here and are never proposed for deletion -- an audit that
# guesses at files it does not recognise is how a delete list eats something load-bearing.
# LAYERS THAT REACH R2 WITHOUT PASSING THROUGH upload_garmin_to_r2.LAYERS.
#
# Written by their own scripts -- fetch_osm_structures.py and extract_coastal_habitat.py -- so
# they are in no uploader's layer table, and KNOWN_PACK_FILES is built from those tables. The
# effect was that a pack could be proposed for deletion and STILL LEAVE THESE BEHIND: the first
# real proposal emptied 78 prefixes and left 1,188 holding an orphaned osm-structures.geojson.
#
# Ryan, 2026-08-19: "why would i continue when we are leaving unused and unneeded objects
# behind... this is how stuff gets missed."
#
# The unjudged-kinds report at the end of main() exists so the NEXT one of these announces
# itself instead of waiting for someone to read a listing by hand.
# THESE ARE SC COASTAL HABITAT AND THEY STAY. Ryan, 2026-08-19: "they need to stay."
#
# Being here does not put them at risk and that is worth spelling out, because the instinct is
# that a name on a KNOWN list is a name that can be deleted. It is the opposite: an object with
# no rule can never be proposed AND can never be cleaned up after, so it is orphaned by any
# prune of its own pack. Measured the same day: all 37 marsh_edges/oyster_beds objects sit on
# coastal zones, and every SC zone holding them is OFFERED by lake_index.json --
# coast_beaufort_sc, st_helena, hilton_head, charleston, winyah_bay, santee_delta, ace_basin,
# murrells_inlet. The `not-offered` rule cannot reach an offered pack. The only ones it can
# reach are the twelve on the six NC/GA zones the deletion tab already says go whole.
SIDECAR_PACK_FILES = {
    "osm-structures.geojson",     # fetch_osm_structures.py
    "marsh_edges.geojson",        # extract_coastal_habitat.py -- SC coastal habitat
    "oyster_beds.geojson",        # extract_coastal_habitat.py -- SC coastal habitat
}

# DEAD BY NAME, NOT BY WHICH PACK THEY SIT ON.
#
# Everything else in this file judges an object by the pack around it: an unoffered slug, a
# secondary coastal zone, a pipeline-only layer. These two are garbage wherever they appear,
# because the script that wrote them is archived and nothing has ever read them back.
#
# That difference is the whole reason this set exists instead of another entry in
# NON_PACK_PREFIXES. `lake_wateree_fishing_creek` is a LIVE lake -- it is still named in js/, so
# the app veto adds it straight back into `offered` and the not-offered rule can never reach
# inside it. Without a by-name rule these 7.7 MB are unreachable by design.
#
# Provenance, checked 2026-08-19: both are written by
# scripts/_archive_2026-08-04/build_wateree_zones.py, which was archived the day it ran. No live
# script writes either name, nothing under js/ or Worker/ fetches them, and neither has a local
# copy anywhere on the pipeline. Ryan: "these are garbage zones.json and zones_spines.json".
#
# A name added here is proposed for deletion on EVERY pack, including offered ones. That is the
# point and it is also the risk, so the bar is a named dead producer plus a measured absence of
# readers -- not "I could not find a use for it".
RETIRED_PACK_FILES = {
    "zones.json",           # 4.4 MB, lake_wateree_fishing_creek
    "zones_spines.json",    # 3.3 MB, lake_wateree_fishing_creek
    # 616 B across lake_marion, lake_moultrie, lake_murray, lake_monticello_parr -- the four
    # COMBINED packs, and a per-pack manifest from that era. The combined keys were pruned
    # 2026-08-03 (16 keys, 192 objects); this is what the prune did not know to look for.
    #
    # Ryan, 2026-08-19: "we already declared them dead... why do we keep having the same
    # conversations". They had been read and judged in an earlier session and the answer lived
    # only in prose, so the report went on asking and the next session went on re-deriving it.
    # THAT is why the name is here rather than in a document: the question is asked by this
    # file, so the answer has to be in this file.
    "chartpack.json",
}

KNOWN_PACK_FILES = (set(LAYERS.values()) | RETIRED_PIPELINE_FILES | SIDECAR_PACK_FILES)

# Top-level prefixes that are not lake/coastal packs. Sized and reported, never proposed for
# deletion: research is 1,616 documents that cost real API calls to fetch.
# The second half of the same omission. These are top-level prefixes holding state-keyed feed
# caches and one stray, and is_pack() called every one of them a lake -- so their objects reached
# deletable() and were only spared by not matching a known layer name. Named here so they are
# spared on purpose rather than by accident.
NON_PACK_PREFIXES = ("research", "lake_packages", "lakes", "regulations", "boundaries",
                     "supplemental", "_registry", "_all", "_duke",
                     "attractors", "ramps", "bankpier", "paddle", "clarity-cache",
                     "garmin")


def fetch_listing(worker: str) -> dict:
    """Read the whole bucket listing off the Worker.

    THE USER-AGENT IS LOAD-BEARING. Python's default is `Python-urllib/3.x`, and Cloudflare's
    edge answers that with a bare 403 before the request ever reaches the Worker -- which reads
    as "the route is broken" or "you need a token", and is neither. curl.exe on the identical URL
    works, because curl sends a UA the edge does not treat as a bot. Measured 2026-08-05.
    """
    url = f"{worker.rstrip('/')}/chartpacks/list?detail=1"
    print(f"reading {url}", file=sys.stderr)
    req = urllib.request.Request(url, headers={
        "User-Agent": "trollmap-r2-audit/1.0 (+personal use; https://github.com/colonal1981/TrollMap-Dev)",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 403:
            raise SystemExit(
                "403 from the edge, not from the Worker -- Cloudflare rejected the request "
                "before it got there.\n"
                "If this recurs, fetch it with curl and read the file instead:\n"
                '  curl.exe -s "%s" -o _r2_listing.json\n'
                "  py .\\r2_audit.py --from _r2_listing.json" % url)
        raise SystemExit("%s returned HTTP %d: %s" % (url, exc.code, exc.reason))


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024 or unit == "GB":
            return f"{n:,.1f} {unit}" if unit != "B" else f"{n:,.0f} B"
        n /= 1024
    return f"{n:.1f} GB"


def is_pack(name: str) -> bool:
    """`name` is already the whole first path segment, so this is an EXACT match, not a prefix.

    It was `startswith(NON_PACK_PREFIXES)`, which quietly swallowed any slug beginning with one
    of those words -- `lakeside_reservoir` starts with `lakes`, so it was reported as its own
    top-level prefix and, worse, excluded from the deletion analysis, because every rule sits
    behind `if is_pack(name)`. Found in Ryan's first live run, 2026-08-05.
    """
    return name not in NON_PACK_PREFIXES


def deletable(name: str, fname: str, offered: set | None = None,
              backed_up: set | None = None) -> str | None:
    """Reason this exact object should not be in R2, or None to keep it.

    `offered` is the set of slugs lake_index.json serves, or None to skip that rule entirely.
    NONE AND EMPTY MUST BEHAVE THE SAME WAY HERE. An index that failed to parse yields an empty
    set, and an empty set makes every slug in the bucket unoffered -- which is a 12,000-object
    delete proposal built out of a read error. The caller guards it too; this is the second
    lock on the same door.
    """
    if name in SKIP_SLUGS:
        return "skip-slug"
    # BEFORE the offered rule and therefore before the app veto -- see RETIRED_PACK_FILES.
    # Also before the backup gate below, deliberately: these three filenames were condemned by
    # name rather than by the water they sit on, and two of the three have no local copy. That
    # is the one place this function proposes something with no way back, and the run prints
    # them separately so the exception is read rather than assumed.
    if fname in RETIRED_PACK_FILES:
        return "retired-layer"
    # THE SECOND HALF OF THE RULE, and it used to live in another program.
    #
    # Ryan, 2026-08-19: "if it belongs to water that is in the app or it doesn't have a copy on
    # my drive it can stay in r2... if the water is no longer offered in the app and we have a
    # backup for it then it can be removed from r2... the end".
    #
    # Not offered is only half a reason. An object with no local copy cannot be put back by any
    # upload, so being unoffered does not make it disposable -- it makes it the only copy of
    # something the app happens not to serve today. r2_vs_local.py has always known which those
    # are; this script wrote the delete list without asking it.
    #
    # None means the caller did not supply a drive index, and it must behave like "no opinion"
    # rather than "nothing is backed up" -- the same shape as `offered` above, for the same
    # reason: a failed read must not turn into a proposal.
    # REGENERABLE COUNTS AS BACKED UP, and leaving it out was this gate's first bug.
    #
    # "On the drive" is not the same question as "on the drive as this exact file". Ryan settled
    # that on 2026-08-13 for osm-structures -- "as long as the OSM script and the OSM pbfs are on
    # my drive that is all that actually matters" -- and r2_vs_local has carried a REGENERABLE
    # table ever since saying so. The gate consulted only the file index, so it held back 59
    # osm-structures objects against a ruling that already existed, plus every marsh and oyster
    # bed whose 1.86 GB of NOAA/SCDNR inputs sit in oyster_marsh/.
    #
    # Imported rather than restated, for the reason the header gives about every other rule in
    # this file: a copy here would be correct today and wrong the first time that table moved.
    if backed_up is not None and "%s/%s" % (name, fname) not in backed_up:
        from r2_vs_local import REGENERABLE
        if fname not in REGENERABLE:
            return None
    if offered and name not in offered:
        # Only for files this script already recognises -- the check below still applies, so an
        # index.json or a vectors/ object inside an unoffered pack is still not ours to judge.
        if fname in KNOWN_PACK_FILES:
            return "not-offered"
    if fname not in KNOWN_PACK_FILES:
        return None                      # index.json, meta.json, vectors/... -- not ours to judge
    if FILE_TO_LAYER.get(fname) in PIPELINE_ONLY:
        return "pipeline-only"
    # THE COASTAL PRIMARY/SECONDARY TIER IS GONE, 2026-08-19, and the branch that read it with it.
    #
    # Ryan, 2026-08-14: "there is no coastal zones primary anymore... and i will be pruning the
    # coastal zones along with the lakes that are now outside my zone." The tier existed to hold
    # heavy layers back from zones that shipped but were not worth full weight. The region polygon
    # now removes a zone entirely or keeps it entirely -- 16 zones on disk, 16 in the index, every
    # one in his water -- so there is no secondary band left for a tier to describe.
    #
    # It was already unreachable: COASTAL_PRIMARY has been an empty set by default, and the guard
    # read `if COASTAL_PRIMARY and ...`, so the branch could not fire. Deleting an if that never
    # runs changes no behaviour, and the delete proposal was byte-identical before and after --
    # checked, not assumed.
    #
    # WHAT IT COST WHILE IT DID RUN is why the removal is written down rather than done quietly.
    # Measured against the live bucket 2026-08-16, minutes after an upload that printed "coastal
    # tier OFF": the delete list held 127 objects, 338.6 MB, across 16 coastal zones the app was
    # serving that same minute -- boundary.geojson among them, the file the map draws. Only 45 of
    # 172 keys were genuinely orphaned. The constant had been imported so it could not drift; the
    # CONDITION had been restated, and the restatement is what inverted.
    #
    # The lesson outlives the code: importing a constant is not importing a rule.
    return None



def read_offered(path: str):
    """(slugs lake_index.json offers, note). An empty set means DO NOT USE IT.

    Lifted out of the orphan report so the delete loop can see it too. The two shapes are both
    handled for the reason the old inline copy gave: lake_index.json is a dict keyed by slug,
    lakes.json is {"lakes": [...]}, and reading one as the other yields an empty set -- which
    would make every slug in the bucket look unoffered.
    """
    try:
        idx = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception as exc:
        return set(), f"could not read {path}: {type(exc).__name__}: {exc}"
    if isinstance(idx, dict) and "lakes" not in idx:
        known = {k for k in idx if isinstance(k, str)}
    else:
        rows = idx if isinstance(idx, list) else idx.get("lakes", [])
        known = {r.get("slug") or r.get("key") for r in rows if isinstance(r, dict)}
    known.discard(None)
    if not known:
        return set(), f"{path} parsed but yielded no slugs"
    return known, None


def named_in_app(js_dir: str, slugs):
    """Slugs whose name appears anywhere under `js_dir`. Empty set if the tree is not there.

    23 of the 39 orphan slugs known on 2026-08-14 were still named in js/, and deleting one of
    those removes the lake from the app. A grep is cheap and the alternative is asking a person
    to hand-audit a thousand-line list.
    """
    root = Path(js_dir)
    if not root.is_dir():
        return set(), f"{js_dir} is not a directory -- the app was NOT checked"
    blob = []
    for fp in root.rglob("*"):
        if fp.suffix.lower() in (".js", ".mjs", ".json", ".html") and fp.is_file():
            try:
                blob.append(fp.read_text(encoding="utf-8", errors="ignore"))
            except Exception:
                pass
    text = "\n".join(blob)
    # A WHOLE TOKEN, NOT A SUBSTRING.
    #
    # `slug in text` is the bidirectional-substring failure this repo already carries five
    # instances of: a short name claims any longer one containing it. `lake_hartwell` was held
    # back by `'lake_hartwell_sc_ga': 'lake_hartwell_sc'` in research-ids.js -- two identifiers
    # that are not that slug. It errs safe, which is the right direction for a delete guard, but
    # it inflates the hold-back list with names the app does not use, and an inflated list is
    # one a person stops reading.
    hits = set()
    for sl in slugs:
        if sl and re.search(r"(?<![A-Za-z0-9_])" + re.escape(sl) + r"(?![A-Za-z0-9_])", text):
            hits.add(sl)
    return hits, None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--worker", default=WORKER)
    ap.add_argument("--from", dest="src", help="read a saved listing instead of the live bucket")
    ap.add_argument("--save", help="write the raw listing here (re-run offline with --from)")
    ap.add_argument("--delete-list", help="write the proposed delete keys here, one per line")
    ap.add_argument("--registry", help="registry/lake_index.json, to name orphan slugs")
    ap.add_argument("--propose-unoffered", action="store_true",
                    help="ALSO propose every pack prefix the registry does not offer. Off by "
                         "default: it is the largest rule this script has and the one most "
                         "able to remove a lake the app still shows. Needs --registry.")
    ap.add_argument("--packs", help="the local chartpack root. With --propose-unoffered, an "
                    "object with no copy on the drive is never proposed -- it cannot be put "
                    "back by an upload, so unoffered does not make it disposable. Without this "
                    "the run says out loud that the backup half of the rule was NOT checked.")
    ap.add_argument("--js", help="the app js/ tree. With --propose-unoffered, any slug still "
                                 "NAMED under it is held back from the proposal and listed "
                                 "separately. Without it the app is not checked and the run "
                                 "says so.")
    a = ap.parse_args()

    # THE INDEX IS READ BEFORE THE LOOP NOW, because the loop needs it. Everything below is a
    # refusal: the rule does not fire unless it was asked for, the registry was given, and the
    # registry actually yielded slugs. Any one of those missing and `offered` stays None, which
    # deletable() treats exactly like empty.
    offered = None
    held_back = set()
    js_note = None
    if a.propose_unoffered:
        if not a.registry:
            raise SystemExit("--propose-unoffered needs --registry; without the index there is "
                             "nothing to compare the bucket against, and proposing on no "
                             "evidence is how a delete list eats a lake")
        offered, why = read_offered(a.registry)
        if why:
            raise SystemExit(f"!! {why} -- refusing to propose anything on that basis")

    data = json.loads(Path(a.src).read_text(encoding="utf-8")) if a.src else fetch_listing(a.worker)
    if a.save:
        Path(a.save).write_text(json.dumps(data), encoding="utf-8")
        print(f"saved listing -> {a.save}")

    packs = data.get("chartpacks", [])
    if packs and isinstance(packs[0].get("files", [None])[0], str):
        raise SystemExit("that listing has no per-object sizes -- fetch it with ?detail=1 "
                         "(the Worker must be at worker-2026-08-05a or later)")

    # None, not an empty set: "was not checked" and "nothing is backed up" must not be the
    # same value, or a run without --packs proposes the whole bucket.
    backed_up = None

    # THE APP GETS A VETO, and it needs the slug list, which only exists now.
    #
    # 23 of the 39 orphan slugs known on 2026-08-14 were still named in js/, and deleting one of
    # those removes the lake from the app. So a slug the app still mentions is held back from
    # the proposal and reported on its own. Without --js nothing is held back, and the run says
    # that out loud rather than letting silence read as "checked, none found".
    if offered is not None:
        candidates = {p["name"] for p in packs
                      if is_pack(p["name"]) and p["name"] not in offered}
        if a.packs:
            from r2_vs_local import local_index
            # This module has no `os` -- it is pathlib throughout. The drive root is the
            # chartpack folder's parent, which is what r2_vs_local resolves SOURCE_MAP against.
            packs_dir = Path(a.packs).resolve()
            backed_up = set(local_index(str(packs_dir.parent), str(packs_dir), quiet=True))
            print("drive     %s local object(s) under %s and its named sources"
                  % (format(len(backed_up), ","), a.packs))
        else:
            print("!! no --packs given -- the BACKUP half of the rule was NOT checked. Every "
                  "proposal below\n   assumes a local copy exists. Ryan's rule needs both halves: "
                  "unoffered AND backed up.")
        if a.js:
            held_back, js_note = named_in_app(a.js, candidates)
            if js_note:
                print(f"!! {js_note}")
        else:
            js_note = "no --js given -- the app was NOT checked for these slugs"
            print(f"!! {js_note}")
        if held_back:
            offered = set(offered) | held_back

    total_bytes = total_objs = 0
    gz_bytes = raw_bytes = gz_objs = raw_objs = 0
    by_prefix: dict[str, list[int]] = defaultdict(lambda: [0, 0])   # bytes, objects
    by_layer: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    delete: list[tuple[str, int, str]] = []                          # key, bytes, reason
    unjudged: dict[str, list[int]] = defaultdict(lambda: [0, 0])     # bytes, objects
    unjudged_where: dict[str, set] = defaultdict(set)
    by_reason: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    no_backup: dict[str, list[int]] = defaultdict(lambda: [0, 0])   # bytes, objects

    for pack in packs:
        name = pack["name"]
        group = name if not is_pack(name) else "«packs»"
        for f in pack["files"]:
            fname, nbytes = f["name"], f.get("bytes", 0)
            total_bytes += nbytes
            total_objs += 1
            by_prefix[group][0] += nbytes
            by_prefix[group][1] += 1
            if f.get("gzip"):
                gz_bytes += nbytes
                gz_objs += 1
            else:
                raw_bytes += nbytes
                raw_objs += 1
            if is_pack(name):
                layer = FILE_TO_LAYER.get(fname, fname)
                by_layer[layer][0] += nbytes
                by_layer[layer][1] += 1
                if fname not in KNOWN_PACK_FILES and fname not in RETIRED_PACK_FILES:
                    unjudged[fname][0] += nbytes
                    unjudged[fname][1] += 1
                    unjudged_where[fname].add(name)
                why = deletable(name, fname, offered, backed_up)
                # NO SILENT HOLD-BACKS. Asking the same function twice, once without the drive
                # index, is what makes this count exact instead of a second copy of the rule --
                # if the gate ever changes, this changes with it. Silence here would read as
                # "nothing was held back", which is the same failure the --js note exists for.
                if backed_up is not None and not why and deletable(name, fname, offered):
                    no_backup[fname][0] += nbytes
                    no_backup[fname][1] += 1
                if why:
                    delete.append((f"{name}/{fname}", nbytes, why))
                    by_reason[why][0] += nbytes
                    by_reason[why][1] += 1

    print(f"\nR2 bucket: {human(total_bytes)} in {total_objs:,} objects, "
          f"{len(packs):,} top-level prefixes")
    print(f"  stored gzipped: {human(gz_bytes)} in {gz_objs:,} objects")
    print(f"  stored raw:     {human(raw_bytes)} in {raw_objs:,} objects")
    if raw_objs and gz_objs:
        print("  -- MIXED. A re-upload is part way through, or one of the three uploaders "
              "still has --no-gzip.")
    elif raw_objs:
        print("  -- nothing is compressed. Deploy the Worker, then re-run upload_garmin_to_r2.py.")

    print("\nby prefix")
    for k, (b, n) in sorted(by_prefix.items(), key=lambda kv: -kv[1][0]):
        print(f"  {human(b):>10}  {n:>6,} obj  {k}")

    print("\npack layers")
    for k, (b, n) in sorted(by_layer.items(), key=lambda kv: -kv[1][0]):
        print(f"  {human(b):>10}  {n:>6,} obj  {k}")

    print("\nproposed deletions")
    if not delete:
        print("  nothing -- every rule this script knows about is already satisfied")
    for k, (b, n) in sorted(by_reason.items(), key=lambda kv: -kv[1][0]):
        print(f"  {human(b):>10}  {n:>6,} obj  {k}")
    if delete:
        db = sum(b for _, b, _ in delete)
        print(f"  {human(db):>10}  {len(delete):>6,} obj  TOTAL "
              f"({100 * db / max(total_bytes, 1):.1f}% of the bucket)")

    if a.registry:
        known = set()
        try:
            idx = json.loads(Path(a.registry).read_text(encoding="utf-8"))
            # lake_index.json is a DICT KEYED BY SLUG -- 1,726 entries, verified 2026-08-05.
            # Reading it as a list of rows (or as {"lakes": [...]}, which is the OTHER registry
            # file, lakes.json) yields an empty set, and an empty set of known slugs makes every
            # slug in R2 look like an orphan. The `if known:` guard below is what stops that
            # from becoming a 1,562-line delete proposal, so both shapes are handled here.
            if isinstance(idx, dict) and "lakes" not in idx:
                known = {k for k in idx if isinstance(k, str)}
            else:
                rows = idx if isinstance(idx, list) else idx.get("lakes", [])
                known = {r.get("slug") or r.get("key") for r in rows if isinstance(r, dict)}
        except Exception as exc:
            print(f"\n!! could not read {a.registry}: {type(exc).__name__}: {exc}")
        if not known:
            print(f"\n!! {a.registry} parsed but yielded no slugs -- skipping the orphan report "
                  "rather than calling everything an orphan")
        if known:
            orphans = [(p["name"], p["bytes"]) for p in packs
                       if is_pack(p["name"]) and p["name"] not in known
                       and p["name"] not in SKIP_SLUGS]
            ob = sum(b for _, b in orphans)
            print(f"\norphan slugs (in R2, not in the registry): {len(orphans)}, {human(ob)}")
            if a.propose_unoffered:
                print("  ON the delete list, under `not-offered`, EXCEPT any held back below.")
            else:
                print("  NOT on the delete list -- pass --propose-unoffered to include them.")
            print("  Some of these are still named in js/, and deleting one of those removes")
            print("  the lake from the app. Decide per slug.")
            if held_back:
                print(f"\n  held back because the app still names them: {len(held_back)}")
                for n in sorted(held_back)[:40]:
                    print(f"    {n}")
                if len(held_back) > 40:
                    print(f"    ... and {len(held_back) - 40} more")
            elif a.propose_unoffered and js_note:
                print(f"\n  !! {js_note}")
            for n, b in sorted(orphans, key=lambda x: -x[1])[:40]:
                print(f"  {human(b):>10}  {n}")
            if len(orphans) > 40:
                print(f"  ... and {len(orphans) - 40} more")

    # EVERY OBJECT KIND THIS SCRIPT HAS NO RULE FOR, ALWAYS PRINTED.
    #
    # A pack layer missing from KNOWN_PACK_FILES is invisible twice over: it is never proposed,
    # and its absence looks identical to there being none of it. That is how 1,602 orphaned
    # osm-structures.geojson objects survived a prune that emptied their packs of everything
    # else. Silence is not the same as nothing, so the silence is now printed.
    if unjudged:
        ub = sum(b for b, _ in unjudged.values())
        un = sum(n for _, n in unjudged.values())
        print(f"\nobject kinds inside pack prefixes with NO RULE: "
              f"{len(unjudged)} kind(s), {un:,} obj, {human(ub)}")
        print("  never proposed, never spared on purpose. Three places a decision can go, and it")
        print("  belongs in ONE OF THEM RATHER THAN IN A NOTE -- this report is what asks, so this")
        print("  file is where the answer has to live or the next run asks again:")
        print("     KNOWN_PACK_FILES     a pack layer the app fetches -- spared on every pack")
        print("     NON_PACK_PREFIXES    not a pack at all -- sized and reported, never proposed")
        print("     RETIRED_PACK_FILES   dead by name -- proposed on EVERY pack, offered or not")
        for k, (b, n) in sorted(unjudged.items(), key=lambda kv: -kv[1][0]):
            where = sorted(unjudged_where[k])
            tail = f"{where[0]}" if len(where) == 1 else f"{len(where)} prefixes"
            print(f"  {human(b):>10}  {n:>6,} obj  {k}   ({tail})")
    else:
        print("\nevery object kind inside a pack prefix has a rule")

    if no_backup:
        nb = sum(v[1] for v in no_backup.values())
        nbb = sum(v[0] for v in no_backup.values())
        print("\nheld back -- unoffered, but NO LOCAL COPY and no way to rebuild: %s obj, %s"
              % (format(nb, ","), human(nbb)))
        print("  Ryan's rule, 2026-08-19: \"if it belongs to water that is in the app or it does not")
        print("  have a copy on my drive it can stay in r2\". Unoffered is only half a reason -- no")
        print("  upload can put back a file that is not on the drive, so each of these is the only")
        print("  copy of something the app happens not to serve today.")
        for k, (b, n) in sorted(no_backup.items(), key=lambda kv: -kv[1][0]):
            print("  %10s  %6s obj  %s" % (human(b), format(n, ","), k))
        print("  To release any of them, put the file on the drive -- or if it already IS on the")
        print("  drive somewhere this does not look, add a SOURCE_MAP row in r2_vs_local.py.")

    if a.delete_list:
        out = Path(a.delete_list)
        lines = ["# Written by r2_audit.py. Read this before running prune_r2_objects.py --go.",
                 "# Every line is one exact R2 object key. Delete a line to spare that object.",
                 ""]
        for reason in sorted(by_reason):
            b, n = by_reason[reason]
            plural = "" if n == 1 else "s"
            lines.append(f"# ---- {reason}: {n:,} object{plural}, {human(b)} ----")
            lines += [k for k, _, why in sorted(delete) if why == reason]
            lines.append("")
        out.write_text("\n".join(lines), encoding="utf-8")
        print(f"\nwrote {len(delete):,} keys -> {out}")
        print("review it, then:  py .\\prune_r2_objects.py --list "
              f'"{out}"        (add --go to actually delete)')
    elif delete:
        print("\nre-run with --delete-list <path> to write these keys out for review")
    return 0


if __name__ == "__main__":
    sys.exit(main())
