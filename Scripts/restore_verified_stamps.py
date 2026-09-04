#!/usr/bin/env python3
r"""restore_verified_stamps.py -- put back the verified stamps the 2026-09-02 batch threw away.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\restore_verified_stamps.py --dry-run
    py .\scripts\restore_verified_stamps.py

WHY THIS EXISTS

Ryan, 2026-09-04: *"so the research pipeline is marking them as draft... all of these profiles
used to be verified... we reran all of these and now they show draft"*.

He is right, and the mirror proves it exactly. Of the 80 profiles in the bucket, 64 were last
written by the 2026-09-02 batch. 46 of those carry a `metadata.verifiedAt` timestamp -- written
by /research/approve, which nothing else writes -- and every one of the 46 now reads
`status: draft, verified: false`. The 15 still verified are precisely the 15 the batch never
touched: each has lastUpdated equal to its verifiedAt.

The cause was two lines in research_lakes.py asserting "draft" on a document it builds fresh
every run, which overrode handleResearchSave's own rule that a re-save of an existing profile
keeps its status. Those lines are fixed; this puts back what they cost.

WHY /research/approve AND NOT A ROLLBACK

The CONTENT of these profiles is the current version and is fine -- it is the stamp that was
reset. handleResearchApprove reads the current master, sets metadata.status = "verified", and
writes it back. It touches nothing else. Rolling back to lakes/versions/<id>/vN.json would undo
real research to fix a one-word field.

WHAT IT WILL NOT DO

It only ever touches a water that ALREADY carries a verifiedAt. A profile that was never verified
by hand is left alone -- inventing a verification is the same failure as destroying one, pointed
the other way. Waters are named with display_name, never a bare id.
"""

from __future__ import annotations
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

WORKER = os.environ.get("TROLLMAP_WORKER_URL",
                        "https://trollmap-worker.colonal1981.workers.dev")

# The value stays on the machine that owns it -- never in this file, the repo or a transcript.
#   PowerShell   $env:TROLLMAP_SYNC_TOKEN = "<value from Worker/wrangler.toml>"
SYNC_TOKEN = os.environ.get("TROLLMAP_SYNC_TOKEN", "")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

PROFILE_DIRNAME = "_research_profiles"


def _post(path, payload, timeout=120):
    h = {"User-Agent": UA, "Accept": "application/json", "Content-Type": "application/json"}
    if SYNC_TOKEN:
        h["X-Sync-Token"] = SYNC_TOKEN
    req = urllib.request.Request(WORKER + path, data=json.dumps(payload).encode("utf-8"),
                                 headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            try:
                return r.status, json.loads(r.read()), None
            except json.JSONDecodeError:
                return r.status, None, "non-JSON body"
    except urllib.error.HTTPError as e:
        body = e.read()[:300].decode("utf-8", "replace").replace("\n", " ").strip()
        return e.code, None, body or "empty body"
    except Exception as e:                                    # noqa: BLE001
        return 0, None, str(e)


def needs_restoring(profile):
    """A water that WAS verified and no longer reads verified. Nothing else qualifies.

    `verifiedAt` is written only by handleResearchApprove, so its presence is the record that a
    human once approved this profile. Without it there is nothing to restore and this returns
    False -- a batch must not invent a verification any more than it may destroy one.
    """
    meta = (profile or {}).get("metadata") or {}
    if not meta.get("verifiedAt"):
        return False
    return str(meta.get("status") or "").lower() != "verified"


def to_restore(directory):
    """[(file, lakeName, versionNumber, verifiedAt, lastUpdated)] read off the mirror."""
    out = []
    for f in sorted(os.listdir(directory)):
        if not f.endswith(".json") or f.startswith("_"):
            continue
        try:
            with open(os.path.join(directory, f), encoding="utf-8") as fh:
                p = json.load(fh)
        except Exception:                                     # noqa: BLE001
            continue
        if not needs_restoring(p):
            continue
        m = p.get("metadata") or {}
        name = p.get("lakeName")
        if not name:
            # /research/approve takes a NAME. Without one there is nothing to send, and
            # guessing it from the filename would send the approve to whatever that resolves
            # to, which is not the same question.
            continue
        out.append((f, name, m.get("versionNumber"), (m.get("verifiedAt") or "")[:10],
                    (m.get("lastUpdated") or "")[:10]))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--registry", default=os.environ.get("TROLLMAP_REGISTRY",
                                                         r"F:\TrollMapPipeline\registry"))
    ap.add_argument("--dry-run", action="store_true", help="list them, send nothing")
    a = ap.parse_args(argv)

    d = os.path.join(a.registry, PROFILE_DIRNAME)
    if not os.path.isdir(d):
        print("no mirror at %s -- run mirror_research_profiles.py first" % d)
        return 2
    rows = to_restore(d)
    print("%d profile(s) were verified once and no longer read verified:" % len(rows))
    for f, name, ver, vat, upd in rows:
        print("   %-44s v%-5s verified %s, overwritten %s" % (name[:44], ver, vat, upd))
    if not rows:
        print("nothing to restore.")
        return 0
    if a.dry_run:
        print("\n--dry-run: nothing sent. Re-run without it to restore the stamps.")
        return 0
    if not SYNC_TOKEN:
        print("\nTROLLMAP_SYNC_TOKEN is not set in this shell. Set it and re-run:")
        print('   $env:TROLLMAP_SYNC_TOKEN = "<value from Worker\\wrangler.toml>"')
        return 2

    ok, failed = 0, []
    for f, name, ver, vat, upd in rows:
        code, res, err = _post("/research/approve", {"lakeName": name})
        if code == 200 and res and res.get("ok"):
            ok += 1
            print("   verified  %s" % name)
        else:
            failed.append((name, err or ("HTTP %s" % code)))
            print("   FAILED    %s -- %s" % (name, err or ("HTTP %s" % code)))
    print("\nrestored %d of %d" % (ok, len(rows)))
    for name, err in failed:
        print("   !! %s: %s" % (name, err))
    # A plain run is enough: /research/approve rewrites the object, so R2's `uploaded`
    # stamp changes and the mirror re-reads exactly these and nothing else.
    print("   now re-run mirror_research_profiles.py so the drive agrees with the bucket.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
