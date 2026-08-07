#!/usr/bin/env python3
"""
upload_garmin_to_r2.py — push the Garmin-derived layers to R2, fast and resumably.

    py upload_garmin_to_r2.py --root F:\\TrollMapPipeline\\split_output_garmin --all
    py upload_garmin_to_r2.py --root ... --layers contours depth_regions
    py upload_garmin_to_r2.py --root ... --lake lake_wateree --dry-run

Same bucket, same flat per-slug key layout as `upload_to_r2.py`:

    {slug}/contours.geojson
    {slug}/depth_areas.geojson
    {slug}/depth_regions.geojson
    {slug}/waterbodies.geojson
    {slug}/pois.geojson

WHY NOT JUST USE upload_to_r2.py
That one walks slugs serially and shells out to wrangler once per object. Each wrangler call
is a fresh node start, ~1-2 s before it does any work. At 135 lakes that is a coffee break;
at the thousands of lakes the Garmin card covers it is hours of node startup. This does three
things differently:

  * PARALLEL -- N wrangler processes at once (default 6). Node startup overlaps.
  * SKIP UNCHANGED -- a local manifest keyed by (r2_key -> sha256, size) means a re-run after
    a partial failure only pushes what actually changed. Re-running is cheap, so run it again
    rather than trying to work out where it stopped.
  * GZIP -- ON BY DEFAULT since 2026-08-05. See below.

GZIP: WHAT WAS ACTUALLY BROKEN, AND WHAT WAS ASSUMED

Until 2026-08-05 this script uploaded raw, and the docstring said so at length. The measurement
behind that was real. The conclusion drawn from it was not.

What was measured on 2026-08-01: uploading with `--content-encoding gzip` produced a body that
arrived at the browser DOUBLE-COMPRESSED, and every piece of the chain looked correct --

    R2 holds exactly one gzip layer, with the right contentEncoding metadata
    the Worker echoed it: `Content-Encoding: gzip` present in the response headers
    ...and Cloudflare's edge then compressed the Worker's output AGAIN on the way out

One Content-Encoding header, two layers, so the client unwrapped one and was left holding a gzip
stream. `r.json()` threw. (The tell, if this ever recurs: `curl --compressed` prints binary
containing `r2up_<pid>_<hash>` -- THIS SCRIPT's temp filename, written into the inner gzip header
as its FNAME field, visible only because the outer layer is already stripped.)

What was ASSUMED from it: "so storage is the only cost, and storage is cheap." Nobody who pays
the bill was asked. It was not cheap -- raw chartpacks were 9.17 GB of an 11.49 GB bucket against
a 10 GB free tier, and the fix for that was going to be dropping a whole state.

What the measurement actually proved is that PASSTHROUGH breaks. Unwrapping in the Worker was
never tried. It works: `r2Body()` / `r2Text()` in Worker/worker-core.js strip the stored layer
before the response leaves the Worker, the edge compresses once as it always did, and the browser
sees plain JSON. Storage drops, wire size is unchanged, and there is no ambiguity left to hedge
against. Measured on real pack files, gzip -6 lands between 13% and 24% of raw, the biggest files
compressing best: 42.6 MB -> 6.0 MB, 113.8 MB -> 15.0 MB.

`--no-gzip` still uploads raw. THE WORKER MUST BE DEPLOYED FIRST -- a gzipped object served by a
Worker that predates r2Body() is the 2026-08-01 failure again, this time on live data.

The manifest tracks the gzip state per key, so flipping this flag re-uploads what was stored the
other way WITHOUT --force. That is deliberate: the manifest keys off (size, mtime) of the LOCAL
file, which does not change when the encoding does, so without that check turning gzip on would
have silently skipped all 12,972 objects already in the bucket and appeared to succeed.

Nothing here is Garmin-specific except the default layer list, so it works for the i-Boating
outputs too.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse, hashlib, json, os, re, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# Sibling module, so this resolves from any cwd: Python puts the script's own directory on
# sys.path[0]. Compression lives there because upload_to_r2_coastal.py and
# upload_boundaries_to_r2.py write to the same bucket and must encode the same way.
from r2_gzip import prepared

WRANGLER_JS = os.environ.get(
    "WRANGLER_JS",
    r"C:\Users\Ryan\AppData\Roaming\npm\node_modules\wrangler\bin\wrangler.js")
BUCKET = os.environ.get("TROLLMAP_BUCKET", "trollmap-chartpacks")

# A layer absent from this dict is SILENTLY SKIPPED -- main() iterates `want`, which is derived
# from these keys, so a chartpack file with an unlisted name is never even looked for. That is
# how `waterbody`, `docks`, `hydrography` and `garmin_shoreline` would have gone missing from a
# Garmin pack that contained all four.
#
# `garmin_shoreline` is deliberately NOT `shoreline`: the bucket already holds a `shoreline.geojson`
# from a different source and this must not overwrite it. Same reason `boundary` stays out of the
# default set below -- the existing boundary.geojson is NHD/3DHP and nothing here should replace it.
LAYERS = {
    "contours":         "contours.geojson",
    "depth_areas":      "depth_areas.geojson",
    "depth_regions":    "depth_regions.geojson",
    "waterbodies":      "waterbodies.geojson",
    "waterbody":        "waterbody.geojson",
    "docks":            "docks.geojson",
    "hydrography":      "hydrography.geojson",
    "garmin_shoreline": "garmin_shoreline.geojson",
    "pois":             "pois.geojson",
    # The MAR routing graph. BINARY, not JSON -- see the content type below and
    # build_water_graphs.py for the format. Opt-in, because it is built by a separate
    # pass and a routine pack upload should not silently expect it to exist.
    "water_graph":      "water_graph.bin",
    # Humps, ledges and slope, computed by build_structure.py from the contours in
    # this same pack. Opt-in for the same reason: a separate pass builds it.
    "structure":        "structure.geojson",
    # Contour fragments stitched into runs a boat can follow, each annotated with what
    # it passes and whether it is reachable. build_trolling_runs.py.
    "trolling_runs":    "trolling_runs.geojson",
    # Points, coves and named creek mouths. build_water_features.py.
    "water_features":   "water_features.geojson",
    "areas":            "areas.geojson",
    "boundary":         "boundary.geojson",
}
# Not uploaded unless named explicitly with --layers. `boundary` would replace the NHD/3DHP
# polygon the app renders as the lake outline.
LAYERS_OPT_IN = {"boundary", "areas", "water_graph", "structure", "trolling_runs", "water_features"}

# ── What R2 does not need ─────────────────────────────────────────────────────────────
#
# NOTHING READS THESE. Verified 2026-08-03 across the whole tree:
#   - the client: `waterbody` is explicitly NOT in GARMIN_LAYERS, and supplemental-layers.js
#     says why -- its union is 70.18 km2 against depth_areas' 71.11 km2, and the water it
#     covers that depth shading does not is 0.024 km2. 2.4 hectares out of 70.
#   - `hydrography` has no client reference at all.
#   - the Worker: every "waterbody" hit is the WORD in another context -- a regulations CSV
#     column, an LLM prompt, the SCDNR ramp grouping key, a ?waterbody= alias for ?lake=.
#     Zero hits for "hydrography" anywhere in Worker/.
#
# `waterbody` is not useless -- it is where the mode 6/20 lake_id lives, which is how a
# chartpack gets attributed to a lake at all. That happens at BUILD time, on disk. It has
# never needed to travel to R2.
#
# Measured against the live bucket: 310 MB across 879 objects, 4.1% of 7.59 GB, that has
# been uploaded on every pack since the beginning and read by nothing.
#
# --with-pipeline-layers ships them anyway.
PIPELINE_ONLY = {"waterbody", "hydrography"}

# ── Coastal tiers ─────────────────────────────────────────────────────────────────────
#
# Ryan, 2026-08-03: "looking on the map any saltwater from edisto beach to murrells inlet
# should be what we call primary... those can get all data... the other areas are perfectly
# fine with NOAA and the garmin poi/docks."
#
# NOAA ENC may beat Garmin on soundings, but it has no dock structure at all -- so outside
# the primary band the useful half of a Garmin coastal pack is docks, POIs and shoreline.
# Those three are 0.9 MB per zone. contours + depth_areas are the other 124 MB.
#
# EXTRACT EVERYTHING, SHIP SELECTIVELY. The full pack stays on disk, so promoting a zone
# later is an upload and not a rebuild.
# THE TIER IS OFF BY DEFAULT AS OF 2026-08-07. Every coastal zone ships every layer.
#
# It existed to save R2 storage, and storage stopped being the constraint: the bucket holds
# 1.38 GB against a 10 GB free tier, and giving all sixteen secondary zones their heavy layers
# costs about 122 MB gzipped -- 14% used goes to 15%. Measured, not estimated: this upload
# compressed to 7% of raw, not the 13-24% the docstring assumes.
#
# Meanwhile the tier cost something real. THE CLIENT DOES NOT KNOW THE TIER EXISTS. A secondary
# zone 404s its boundary and its depth data, so Pamlico Sound loses its outline entirely and
# reads as broken rather than as "no bathymetry here". Ryan, 2026-08-07: "with r2 storage now a
# 0 issue is there any reason to hold back the coastal for the non primary?" There is not.
#
# The mechanism is KEPT, not deleted, because it is three lines and the day storage matters
# again it should not have to be rediscovered. It is now opt-IN: pass --coastal-primary to
# restrict, and nothing is restricted unless you ask.
COASTAL_PRIMARY = set()          # empty = every coastal zone is primary
COASTAL_SECONDARY_LAYERS = {"docks", "pois", "garmin_shoreline"}


def layers_for(slug, want, primary, secondary_layers, with_pipeline):
    """Which layers of this pack actually go to R2."""
    keep = set(want)
    if not with_pipeline:
        keep -= PIPELINE_ONLY
    # A coastal zone outside the primary band ships the secondary set only. An EMPTY primary
    # set means the tier is off and every zone ships everything -- which is the default now.
    # Written as an explicit guard rather than relying on `not in set()` being False, because
    # the old behaviour was one absent name away from silently stripping a zone.
    if primary and slug.startswith("coast_") and slug not in primary:
        keep &= secondary_layers
    return keep
SKIP_SLUGS = {"sc_ga_coastal", "saluda_river_arm"}


def sha256(path, buf=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(buf), b""):
            h.update(chunk)
    return h.hexdigest()


def save_manifest(manifest, mpath):
    """Write the manifest so a Ctrl-C can never leave a half-written one.

    This used to be `json.dump(manifest, open(mpath, "w"))`, which truncates the file first
    and then writes. Interrupt it in that window and the manifest is left truncated -- and the
    loader in main() swallows a parse error and carries on with an EMPTY manifest, so the next
    run silently re-uploads all 2,437 objects instead of skipping the ones already in R2.

    That is the one way stopping a long run can genuinely cost you the whole run, and it is
    silent when it happens. Write to a sibling temp file and os.replace() it in: replace is
    atomic on the same volume on Windows and POSIX both, so the manifest on disk is always
    either the previous checkpoint or the new one, never a fragment.
    """
    tmp = str(mpath) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, mpath)


_WRANGLER_NOISE = re.compile(
    r"^\s*$"                            # blank
    r"|^[─-╿\-_=]+\s*$"      # the box-drawing rule
    r"|wrangler \d+\.\d+"               # the version banner + update nag
    r"|^Resource location:"
    r"|^Creating object "
    r"|^Upload complete"
    r"|^If you think this is a bug",
    re.I,
)


def wrangler_error(out):
    """The part of wrangler's output that says what actually went wrong.

    `out.strip()[:220]` used to be the whole error report, and wrangler spends its first four
    lines on a version banner, a horizontal rule, `Resource location: remote` and
    `Creating object "X" in bucket "Y"`. That is ~200 characters of decoration, so the 220-char
    window was almost entirely banner and the real message was cut off mid-word -- four
    persimmon_lake files failed together on 2026-08-03 and the report said nothing beyond
    "Creating object ... If you t".

    Dropping the boilerplate first means the surviving text is the diagnosis.
    """
    lines = [ln.rstrip() for ln in out.splitlines()]
    keep = [ln for ln in lines if not _WRANGLER_NOISE.search(ln)]
    msg = " | ".join(keep) if keep else out.strip()
    return msg[:400]


def put(local, key, gz, dry, timeout):
    """One wrangler put. Returns (ok, bytes_sent, message)."""
    try:
        with prepared(local, gz) as (src, extra):
            n = src.stat().st_size
            if dry:
                return True, n, "dry"
            # Content type follows the OBJECT, not the script. Everything here was JSON until
            # water_graph.bin, and serving a binary graph as application/json would have the
            # Worker and the browser both reading it as text.
            ctype = ("application/octet-stream" if key.endswith(".bin")
                     else "application/json")
            cmd = ["node", WRANGLER_JS, "r2", "object", "put", f"{BUCKET}/{key}",
                   "--file", str(src), "--content-type", ctype,
                   "--remote", *extra]
            r = subprocess.run(cmd, capture_output=True, timeout=timeout)
            out = (r.stdout + r.stderr).decode("utf-8", "replace")
            ok = r.returncode == 0 or "success" in out.lower()
            return ok, n, ("" if ok else wrangler_error(out))
    except subprocess.TimeoutExpired:
        return False, 0, "wrangler timed out"
    except Exception as exc:
        return False, 0, f"{type(exc).__name__}: {exc}"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", required=True, help="folder of <slug>/<layer>.geojson")
    ap.add_argument("--layers", nargs="*", default=None,
                    help=f"subset of {', '.join(LAYERS)} (default: all present)")
    ap.add_argument("--all", action="store_true", help="every layer, every lake")
    ap.add_argument("--lake", nargs="*", default=None, help="only these slugs")
    ap.add_argument("--prefix", default="", help="prepend to every R2 key, e.g. garmin/")
    ap.add_argument("--jobs", type=int, default=6, help="parallel wrangler processes")
    # gzip is the default as of 2026-08-05; --gzip is kept only so existing commands keep working.
    ap.add_argument("--gzip", action="store_true", help="(default; kept for compatibility)")
    ap.add_argument("--no-gzip", action="store_true",
                    help="upload raw. Only needed if the Worker serving this bucket predates "
                         "r2Body() in worker-core.js -- see the module docstring")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="ignore the manifest, push everything")
    ap.add_argument("--manifest", default=None, help="default <root>/_r2_manifest.json")
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--registry", default=None,
                    help="also publish <registry>/lakes.json to _registry/lakes.json, "
                         "slimmed for the live DNR worker, AND <registry>/lake_index.json "
                         "to _registry/lake_index.json, which is the file the app reads")
    ap.add_argument("--with-pipeline-layers", action="store_true",
                    help="also upload waterbody + hydrography. They are build-time inputs "
                         "(waterbody carries the mode 6/20 lake_id) and nothing in the app "
                         "or the Worker reads them from R2 -- 310 MB of the live bucket.")
    ap.add_argument("--coastal-primary", default=None,
                    help="comma list overriding which coastal zones get every layer. "
                         "Default is Edisto Beach to Murrells Inlet.")
    ap.add_argument("--max-mb", type=float, default=0,
                    help="skip files larger than this before compression (0 = no limit)")
    args = ap.parse_args()

    root = Path(args.root)
    if not root.is_dir():
        sys.exit(f"not a directory: {root}")
    want = set(args.layers) if args.layers else (set(LAYERS) - LAYERS_OPT_IN)
    if args.layers:
        bad = want - set(LAYERS)
        if bad:
            sys.exit(f"unknown layer(s): {', '.join(sorted(bad))}\n"
                     f"known: {', '.join(sorted(LAYERS))}")
    # checked after the arg validation, so a typo reports the typo and not a missing wrangler
    if not args.dry_run and not Path(WRANGLER_JS).exists():
        sys.exit(f"wrangler not found at {WRANGLER_JS}\n"
                 f"set WRANGLER_JS in the environment to override")
    primary = ({x.strip() for x in args.coastal_primary.split(",") if x.strip()}
               if args.coastal_primary else COASTAL_PRIMARY)
    if not args.with_pipeline_layers:
        print("pipeline-only layers held back (nothing reads them from R2): "
              + ", ".join(sorted(PIPELINE_ONLY)))
    print("coastal primary (all layers): " + ", ".join(sorted(primary)))
    if primary:
        print("coastal secondary ships only: " + ", ".join(sorted(COASTAL_SECONDARY_LAYERS)))
    else:
        print("coastal tier OFF -- every coastal zone ships every layer "
              "(pass --coastal-primary to restrict)")

    slugs = set(args.lake) if args.lake else None
    gz = not args.no_gzip

    mpath = Path(args.manifest) if args.manifest else root / "_r2_manifest.json"
    manifest = {}
    if mpath.exists() and not args.force:
        try:
            manifest = json.load(open(mpath))
        except Exception as exc:
            # Do NOT fail silently. An unreadable manifest means every object is about to be
            # re-uploaded, which on this bucket is 6.6 GB and three hours. Say so.
            print(f"!! manifest {mpath} is unreadable ({type(exc).__name__}: {exc})")
            print(f"!! treating it as EMPTY -- everything will be re-uploaded from scratch.")
            print(f"!! if that is not what you want, stop now and restore the manifest.")
            manifest = {}

    # ---- the live worker's copy of the lake list ------------------------------------
    # The state-DNR pull happens at request time in a Cloudflare worker, so it cannot do a
    # spatial join against boundary files it has never seen. It queries the DNR ArcGIS
    # endpoints by EXTENT instead, which needs one small file: slug, name and bounds for
    # every lake. Publishing it here keeps the worker on exactly the same lake identities
    # as the static layers -- the whole point of the registry.
    reg_jobs = []
    if args.registry:
        rp = Path(args.registry) / "lakes.json"
        if not rp.exists():
            sys.exit(f"--registry given but {rp} not found")
        full = json.load(open(rp))
        slim = {"count": full.get("count"), "bbox_wsen": full.get("bbox_wsen"),
                "generated_from": full.get("generated_from"),
                "lakes": [{"slug": r["slug"], "lake_id": r["lake_id"], "name": r["name"],
                           "area_km2": r["area_km2"], "bounds_wsen": r["bounds_wsen"],
                           "centroid": r["centroid"]}
                          for r in full.get("lakes", [])]}
        tmp = Path(tempfile.gettempdir()) / "trollmap_registry_slim.json"
        tmp.write_text(json.dumps(slim, separators=(",", ":")))
        reg_jobs.append((str(tmp), f"{args.prefix}_registry/lakes.json",
                         "_registry", "registry"))
        print(f"registry: {len(slim['lakes']):,} lakes -> "
              f"{args.prefix}_registry/lakes.json "
              f"({tmp.stat().st_size/1024:.0f} KB before gzip)")

        # lake_index.json is what the APP fetches -- lake-registry.js hits
        # /chartpacks/_registry/lake_index.json on load. `lakes.json` above is the slim 3DHP
        # list the DNR worker uses and is NOT the same file.
        #
        # It had no path here at all, so it was being pushed by hand, which means no manifest
        # entry, no record of when, and no way to tell a stale copy from a current one. On
        # 2026-08-02 the live object was several hours behind: it predated the charted-fraction
        # recompute and the county naming, so the app was offering lakes under names the packs
        # no longer matched. Publishing it on the same run as the packs is the fix.
        ip = Path(args.registry) / "lake_index.json"
        if ip.exists():
            reg_jobs.append((str(ip), f"{args.prefix}_registry/lake_index.json",
                             "_registry", "lake_index"))
            n = len(json.load(open(ip, encoding="utf-8")))
            print(f"index:    {n:,} records -> {args.prefix}_registry/lake_index.json "
                  f"({ip.stat().st_size/1024:.0f} KB before gzip)")
        else:
            print(f"!! {ip} not found -- the app reads this file; build it with "
                  f"consolidate_lake_index.py before publishing")

    jobs, skipped, oversize = [], 0, 0
    for d in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith("_")):
        slug = d.name
        if slug in SKIP_SLUGS or (slugs and slug not in slugs):
            continue
        # Per-pack, because a secondary coastal zone ships a different set than a lake.
        for layer in sorted(layers_for(slug, want, primary,
                                       COASTAL_SECONDARY_LAYERS, args.with_pipeline_layers)):
            f = d / LAYERS[layer]
            if not f.exists() or f.stat().st_size == 0:
                continue
            if args.max_mb and f.stat().st_size > args.max_mb * 1e6:
                oversize += 1
                continue
            key = f"{args.prefix}{slug}/{LAYERS[layer]}"
            st = f.stat()
            prev = manifest.get(key)
            # bool(prev.get("gzip")) is part of the identity of what is IN the bucket. The
            # size/mtime pair describes the LOCAL file and does not move when the encoding
            # changes, so without this the 2026-08-05 gzip flip would have skipped all 12,972
            # existing objects and printed "nothing to do" -- a no-op that reads as success.
            # Entries written before the flag existed have no "gzip" key; bool(None) is False,
            # which is correct, because those were uploaded raw.
            if (prev and prev.get("size") == st.st_size
                    and prev.get("mtime") == int(st.st_mtime)
                    and bool(prev.get("gzip")) == gz):
                skipped += 1
                continue
            jobs.append((str(f), key, slug, layer))

    jobs = reg_jobs + jobs
    print(f"{len(jobs)} objects to upload, {skipped} unchanged, "
          f"{oversize} over --max-mb, {args.jobs} parallel, gzip={'on' if gz else 'off'}")
    if not jobs:
        print("nothing to do")
        return
    if args.dry_run:
        for _, key, _, _ in jobs[:25]:
            print(f"  [DRY] {key}")
        if len(jobs) > 25:
            print(f"  ... and {len(jobs)-25} more")
        return

    t0 = time.time()
    ok = fail = 0
    sent = 0
    failures = []
    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        futs = {ex.submit(put, p, k, gz, False, args.timeout): (p, k, s, l)
                for p, k, s, l in jobs}
        for i, fut in enumerate(as_completed(futs), 1):
            p, k, s, l = futs[fut]
            good, n, msg = fut.result()
            if good:
                ok += 1
                sent += n
                st = os.stat(p)
                manifest[k] = {"size": st.st_size, "mtime": int(st.st_mtime),
                               "uploaded_bytes": n, "gzip": gz}
            else:
                fail += 1
                failures.append((k, msg))
                print(f"  FAIL {k}  {msg}", flush=True)
            # Print every object on a small run, every 25 on a card-wide one. The old
            # `i % 25 == 0` alone meant a 7-object lake upload printed NOTHING until it was
            # finished, which is indistinguishable from a hang -- and with a 900 s per-object
            # timeout there is no reason for the user to believe otherwise for 15 minutes.
            if len(jobs) <= 40 or i % 25 == 0 or i == len(jobs):
                el = time.time() - t0
                rate = i / max(el, 1e-9)
                print(f"  [{i}/{len(jobs)}] ok {ok} fail {fail}  {sent/1e6:.1f} MB sent  "
                      f"{el/60:.1f} min, ~{(len(jobs)-i)/max(rate,1e-9)/60:.1f} min left",
                      flush=True)
            # Checkpoint often enough that a Ctrl-C on a small run does not throw away
            # everything that already succeeded.
            if i % 50 == 0 or len(jobs) <= 40:
                save_manifest(manifest, mpath)

    save_manifest(manifest, mpath)
    print(f"\n{ok} uploaded, {fail} failed, {sent/1e6:.1f} MB in "
          f"{(time.time()-t0)/60:.1f} min -> {BUCKET}")
    print(f"manifest: {mpath}  (delete it or pass --force to re-push everything)")
    if failures:
        print("\nfailures — re-run the same command, the manifest will skip what worked:")
        for k, m in failures[:20]:
            print(f"  {k}  {m}")


if __name__ == "__main__":
    main()
