#!/usr/bin/env python3
r"""prune_shadowed_profiles.py -- delete a batch DRAFT that is hiding a hand-VERIFIED profile.

Personal use only, not for distribution or resale; not for navigation.

    node .\Scripts\which_profile_serves.mjs --registry "F:\TrollMapPipeline\registry" `
                                            --json "F:\TrollMapPipeline\registry\_profile_conflicts.json"
    py .\scripts\prune_shadowed_profiles.py
    py .\scripts\prune_shadowed_profiles.py --go

WHY THIS EXISTS

Four waters carry two profiles each, made on 2026-09-01 when research_lakes.py drove from the
registry's county-stamped display names and /research/save could not yet map them back to the
feed-named keys the profiles were already under. The identity-names fix landed the same day and
stopped it at four. Nobody removed the four.

Ryan, 2026-09-04, asked which half the app shows: *"the app shows the crappy profiles"*. Measured
by running the Worker's own resolver over the mirror -- three of them, and in each the served copy
is a three-source draft hiding a hand-verified profile:

    Lake Sidney Lanier   serves 3 sources, no depth   hides 9 sources, 160 ft, verified
    Watauga Lake         serves 4 species, 0 facts    hides 9 species, 143 facts, verified
    Nottely Lake         serves 5 species, no depth   hides 8 species, 170 ft, verified

THE RULE, AND IT IS ONE RULE

Delete a served profile ONLY when it is a DRAFT and the profile it hides is VERIFIED. Nothing else
qualifies. Species counts do not decide it -- Lanier's two both carry six, and the difference is
nine sources against three -- and a rule written on a count would have skipped the one water where
the loss is a max depth rather than a fish.

It never deletes a verified profile, never deletes when nothing is hidden, and never resolves a
name: it sends the storage id, which is the same object every time it is asked for.

WHAT THE DELETE TAKES. /research/delete removes lakes/<id>.json, lake_packages/<id>/* and every
lakes/versions/<id>/vN.json. The MASTER survives on the drive in registry\_research_profiles\ --
that mirror is one day old and is why this is safe to run at all -- but the version history does
not. These drafts are three versions deep and one day old, so there is no history worth keeping.
"""

from __future__ import annotations
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

WORKER = os.environ.get("TROLLMAP_WORKER_URL",
                        "https://trollmap-worker.colonal1981.workers.dev")

# The value stays on the machine that owns it -- never in this file, the repo or a transcript.
#   PowerShell   $env:TROLLMAP_SYNC_TOKEN = "<value from Worker/wrangler.toml>"
SYNC_TOKEN = os.environ.get("TROLLMAP_SYNC_TOKEN", "")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

CONFLICTS = "_profile_conflicts.json"


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


def verdict(fork):
    """(delete_this_id, why) or (None, why not). The one rule, in one place."""
    served = fork.get("served_detail") or {}
    hidden = [h for h in (fork.get("shadowed") or [])
              if str(h.get("status") or "").lower() == "verified"]
    if str(served.get("status") or "").lower() != "draft":
        return None, "the served profile is %s, not a draft" % (served.get("status") or "?")
    if not hidden:
        return None, "nothing verified is hidden behind it"
    best = max(hidden, key=lambda h: (h.get("sources") or 0, h.get("species") or 0))
    return fork.get("served"), "a %s-source draft is hiding %s, verified, %s sources" % (
        served.get("sources"), best["id"], best.get("sources"))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--registry", default=os.environ.get("TROLLMAP_REGISTRY",
                                                         r"F:\TrollMapPipeline\registry"))
    ap.add_argument("--go", action="store_true", help="actually delete. Without it, nothing is sent")
    a = ap.parse_args(argv)

    p = os.path.join(a.registry, CONFLICTS)
    if not os.path.exists(p):
        print("no %s -- run which_profile_serves.mjs --json first" % p)
        return 2
    with open(p, encoding="utf-8") as fh:
        report = json.load(fh)
    print("%s generated %s" % (CONFLICTS, report.get("generated")))

    todo, refused = [], []
    for f in report.get("forks") or []:
        vid, why = verdict(f)
        (todo if vid else refused).append((f, vid, why))

    for f, _vid, why in refused:
        print("   SKIP  %-42s %s" % (f["name"][:42], why))
    for f, vid, why in todo:
        s = f.get("served_detail") or {}
        print("   %-42s delete %s" % (f["name"][:42], vid))
        print("        %s" % why)
        print("        it goes:   %-34s %s species, %s sources, depth %s, v%s, %s"
              % (s.get("id"), s.get("species"), s.get("sources"), s.get("maxDepthFt"),
                 s.get("version"), s.get("biologyReason")))
        for h in f.get("shadowed") or []:
            print("        it stays:  %-34s %s species, %s sources, depth %s, v%s, %s"
                  % (h.get("id"), h.get("species"), h.get("sources"), h.get("maxDepthFt"),
                     h.get("version"), h.get("biologyReason")))

    if not todo:
        print("\nnothing qualifies.")
        return 0
    if not a.go:
        print("\n%d would be deleted. Re-run with --go to send them." % len(todo))
        return 0
    if not SYNC_TOKEN:
        print("\nTROLLMAP_SYNC_TOKEN is not set in this shell. Set it and re-run:")
        print('   $env:TROLLMAP_SYNC_TOKEN = "<value from Worker\\wrangler.toml>"')
        return 2

    ok, failed = 0, []
    for f, vid, _why in todo:
        code, res, err = _post("/research/delete", {"lakeName": f["name"], "id": vid})
        if code == 200 and res and res.get("ok"):
            ok += 1
            print("   deleted   %-34s (%s)" % (vid, f["name"]))
        else:
            failed.append((vid, err or ("HTTP %s" % code)))
            print("   FAILED    %-34s %s" % (vid, err or ("HTTP %s" % code)))
    print("\ndeleted %d of %d" % (ok, len(todo)))
    for vid, err in failed:
        print("   !! %s: %s" % (vid, err))
    print("   now re-run mirror_research_profiles.py, then which_profile_serves.mjs to confirm "
          "each water serves the profile you kept.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
