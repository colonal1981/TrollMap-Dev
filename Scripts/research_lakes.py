#!/usr/bin/env python3
"""
research_lakes.py -- the trolling-intelligence batch, as a pipeline step.

WHY THIS EXISTS. `trollingIntelligence` is the one field left that cannot be computed at plan time
-- it reads documents and asks a model. Everything else the research pipeline used to produce is
now derived from the chartpack the planner already fetches, or from registry JSON the Worker
already caches. See THE_PROFILE_BECAME_A_CACHE_AND_NOBODY_MOVED_THE_READS_2026-09-01.md.

MEASURED, NOT ESTIMATED. One run on Lake Wateree took 48 seconds. Across the ~64 inland lakes above
1,000 acres the research tab offers, that is 51 minutes serial. Three earlier cost claims about
this work were wrong -- "5 minutes" for a rebuild that took 26, "7 minutes a lake" that was really
an eleven-agent pipeline, and a benchmark that printed a number from four failed calls -- so this
one came off a stopwatch.

THAT 48 s IS A REFRESH, NOT A COLD RUN. Wateree already carries a profile, so /research/get-
normalized returned a cached corpus and nothing was downloaded. Seventeen of the sixty-four have
no profile at all -- see SEVENTEEN_HAVE_NO_PROFILE_FOUR_HAVE_NO_SPECIES_2026-09-01.md -- and each
of those adds discovery and document downloads on top. The per-lake line this script prints at the
end is the number to trust for the next quarter; the estimate it prints at the start is a refresh
figure and will run short on the first pass.

Ryan, on why it is a batch and not a tab: "I also don't like the idea of individual reruns for
trolling intel... it is 1 agent x the number of lakes above 1000 acres... I already plan to pull
new chart cards quarterly... maybe all of this can become a pipeline run?"

WHY IT IS NOT IN THE WORKER. A `fetch` handler has a hard CPU ceiling and a run is tens of seconds
of wall time per lake. This drives the Worker's endpoints from outside, where nothing times out.

SERIAL BY DEFAULT, ON PURPOSE. At 48 s a lake the whole card is under an hour, so there is no
reason to spend the rate limit. --jobs exists for when there is.

THE WORKER DEPLOYS ITSELF ON PUSH. Nothing here deploys anything.

Personal use only, not for distribution or resale; not for navigation.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

WORKER = os.environ.get("TROLLMAP_WORKER_URL",
                        "https://trollmap-worker.colonal1981.workers.dev")

# The value stays on the machine that owns it -- never in this file, the repo or a transcript.
#   PowerShell   $env:TROLLMAP_SYNC_TOKEN = "<value from Worker/wrangler.toml>"
#   bash         export TROLLMAP_SYNC_TOKEN='<value>'
SYNC_TOKEN = os.environ.get("TROLLMAP_SYNC_TOKEN", "")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# Matches lake-research-engine.js: the Worker injects 8 docs at 20,000 chars, the client sends a
# little more so the Worker's relevance filter still has something to choose from.
LLM_DOC_LIMIT = 12
LLM_DOC_CHARS = 20000
EXTRACT_PAUSE_S = 1.0


def _headers(body=True):
    h = {"User-Agent": UA, "Accept": "application/json"}
    if body:
        h["Content-Type"] = "application/json"
    if SYNC_TOKEN:
        h["X-Sync-Token"] = SYNC_TOKEN
    return h


def _req(path, payload=None, timeout=300):
    """POST when payload is given, GET otherwise. Returns (status, parsed, error_text)."""
    url = f"{WORKER}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=_headers(data is not None),
                                 method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw), None
            except json.JSONDecodeError:
                return r.status, None, f"non-JSON body ({len(raw)} bytes)"
    except urllib.error.HTTPError as e:
        body = e.read()[:300].decode("utf-8", "replace").replace("\n", " ").strip()
        return e.code, None, body or "empty body"
    except Exception as e:                                    # noqa: BLE001
        return 0, None, str(e)


def research_one(lake, state, dry_run=False, verbose=False):
    """One lake, start to saved profile. Returns a result dict; never raises."""
    t0 = time.perf_counter()
    out = {"lake": lake, "state": state, "ok": False, "species": 0, "saved": False, "error": None,
           "confirmed": [], "returned": [], "missing": [], "documents": 0, "facts": 0,
           "warnings": []}

    code, det, err = _req("/research/deterministic-facts", {"lakeName": lake, "state": state})
    if code != 200 or not det or not det.get("profile"):
        out["error"] = f"deterministic-facts {code}: {err or 'no profile'}"
        return out
    profile = det["profile"]
    species = ((profile.get("biology") or {}).get("predatorSpecies")) or []
    out["confirmed"] = list(species)

    code, disc, err = _req("/research/discover",
                           {"lakeName": lake, "state": state, "agent": "fisheries",
                            "names": [lake], "predatorSpecies": species})
    if code != 200 and verbose:
        print(f"      discover {code}: {err}")

    code, norm, err = _req(f"/research/get-normalized?lake={urllib.parse.quote(lake)}")
    docs = ((norm or {}).get("documents") or (norm or {}).get("docs") or []) if code == 200 else []
    usable = [d for d in docs if len(str(d.get("fullText") or d.get("text") or "")) >= 200]
    out["documents"] = len(usable)

    # EXTRACTION IS NOT OPTIONAL, whatever an earlier reading of the template suggested. The Worker
    # turns these facts into the PARSED OBSERVATION block via parseBehaviour(), and the fisheries
    # prompt ranks that ABOVE the documents: "If a PARSED OBSERVATION covers this species and
    # season, its value is the answer -- copy it, do not adjust it."
    facts = []
    for i, d in enumerate(usable[:LLM_DOC_LIMIT]):
        code, ex, err = _req("/research/analyze-facts", {
            "lakeName": lake, "state": state, "targetFields": ["trollingIntelligence"],
            "documents": [{"title": d.get("title"), "url": d.get("url"),
                           "text": str(d.get("fullText") or d.get("text") or "")[:200000]}]})
        if code == 200:
            facts.extend((ex or {}).get("extracted_facts") or [])
        elif verbose:
            print(f"      analyze-facts {code}: {err}")
        if i + 1 < min(len(usable), LLM_DOC_LIMIT):
            time.sleep(EXTRACT_PAUSE_S)

    out["facts"] = len(facts)
    prev = dict(profile)
    prev["_extractedFacts"] = facts
    prev["_normalizedDocuments"] = [
        {"title": d.get("title"), "url": d.get("url"),
         "text": str(d.get("fullText") or d.get("text") or "")[:LLM_DOC_CHARS]}
        for d in usable[:LLM_DOC_LIMIT]]

    code, res, err = _req("/research/agent-llm",
                          {"lakeName": lake, "state": state, "agent": "fisheries",
                           "previousResults": prev})
    if code != 200 or not res:
        out["error"] = f"agent-llm {code}: {err}"
        return out
    section = res.get("section") or {}
    out["species"] = len(section)
    out["returned"] = [k for k in section.keys() if k != "sources"]
    out["warnings"] = list(res.get("warnings") or [])
    for w in out["warnings"]:
        print(f"      warn [{lake}]: {w}")

    # WHAT WENT IN AND DID NOT COME BACK. The Worker already computes this and warns; this
    # records it per lake so a 64-lake run ends with the list rather than sixty-four scrollback
    # lines nobody reads. Ryan, 2026-08-10, on the run that lost a quarter of a lake's species
    # while every line said success -- and again on 2026-09-01, when Lanier came back 4 of 5.
    #
    # IT DOES NOT ABORT THE SAVE. Four species of five is worth keeping, and one flaky group
    # must not cost the other sixty-three lakes their run. It is counted, printed and reported.
    got = {k.lower() for k in out["returned"]}
    out["missing"] = [s2 for s2 in out["confirmed"] if s2.lower() not in got]

    # AN EMPTY SECTION IS A FAILED RUN, NOT A QUIET ONE. Ryan found this the hard way on
    # 2026-08-10: a group came back empty, a quarter of the lake's species vanished, and every
    # line on screen still said success. It is not written and it is reported.
    if not section:
        out["error"] = "agent-llm returned an empty trollingIntelligence section"
        return out

    profile["trollingIntelligence"] = section
    meta = profile.setdefault("metadata", {})
    meta["status"] = meta.get("status") or "draft"

    if dry_run:
        out["ok"] = True
        out["seconds"] = time.perf_counter() - t0
        return out

    code, _, err = _req("/research/save",
                        {"lakeName": lake, "profile": profile,
                         "status": meta["status"], "requestedBy": "research_lakes.py batch"})
    if code != 200:
        out["error"] = f"save {code}: {err}"
        return out
    out["ok"] = out["saved"] = True
    out["seconds"] = time.perf_counter() - t0
    return out


def load_lakes(args, registry):
    """--lake wins; otherwise the app registry, filtered the way the research tab filters."""
    idx_path = os.path.join(registry, "lake_index.json")
    with open(idx_path, encoding="utf-8") as f:
        idx = json.load(f)

    if args.lake:
        # THE STATE COMES OFF THE REGISTRY, NOT OFF A DEFAULT. A one-lake run is how the cold-run
        # cost gets measured, and the cold lakes are in GA, NC and TN -- Lanier, Townsend, Watauga.
        # Sending state=SC with a Georgia lake binds the wrong regulations into
        # /research/deterministic-facts, and the run has to be done twice. An explicit --state
        # still wins; it is the escape hatch for a name the index does not carry.
        by_name = {}
        for slug, row in idx.items():
            name = row.get("display_name") or row.get("name") or slug
            by_name[name.strip().lower()] = row.get("state")
        out = []
        for n in args.lake:
            st = args.state or by_name.get(n.strip().lower()) or "SC"
            if not args.state and n.strip().lower() not in by_name:
                print(f"!! {n} is not in lake_index.json -- falling back to state=SC. "
                      f"Pass --state if that is wrong.")
            out.append((n, st))
        return out

    out = []
    for slug, row in idx.items():
        # PRESETS.research in js/data/water-filter.js: minAcres 1000, includeRivers false.
        # Mirrored rather than reinvented -- if that preset changes, this must follow it.
        if row.get("feature_type") != "lake":
            continue
        if (row.get("area_acres") or 0) < args.min_acres:
            continue
        if slug.startswith("coast_"):
            continue
        name = row.get("display_name") or row.get("name") or slug
        out.append((name, row.get("state") or "SC"))
    out.sort(key=lambda p: p[0])
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--registry", default="registry", help="folder holding lake_index.json")
    ap.add_argument("--lake", action="append", help="one water by display name (repeatable)")
    ap.add_argument("--state", default=None,
                    help="override the state for --lake runs; the registry supplies it otherwise")
    ap.add_argument("--min-acres", type=int, default=1000,
                    help="matches PRESETS.research (default 1000)")
    ap.add_argument("--jobs", type=int, default=1,
                    help="parallel lakes. 1 by default: 64 lakes is under an hour serial and "
                         "serial cannot trip the LLM rate limit")
    ap.add_argument("--limit", type=int, default=0, help="stop after N lakes (0 = all)")
    ap.add_argument("--dry-run", action="store_true",
                    help="run everything except /research/save")
    # A REPORT IS WRITTEN EVERY RUN, NOT ONLY WHEN ASKED. Ryan drives this box over Chrome
    # Remote Desktop, where copying a PowerShell scrollback back into a conversation is a chore
    # -- so the run leaves a file that can be read directly instead. Pass --report to move it.
    ap.add_argument("--report", default=None,
                    help="where the JSON summary goes (default: _reports/research_lakes_<stamp>.json)")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    if not a.report:
        stamp = time.strftime("%Y%m%d_%H%M%S")
        a.report = os.path.join("_reports", f"research_lakes_{stamp}.json")

    if not SYNC_TOKEN:
        print("!! TROLLMAP_SYNC_TOKEN is not set in this shell. Every research call the app makes")
        print("   sends an X-Sync-Token header; without it the Worker refuses. The value lives in")
        print("   Worker/wrangler.toml -- set it in your shell, not in this file:")
        print('     $env:TROLLMAP_SYNC_TOKEN = "<value>"      # PowerShell')
        print("     export TROLLMAP_SYNC_TOKEN='<value>'      # bash")
        return 2

    lakes = load_lakes(a, a.registry)
    if a.limit:
        lakes = lakes[:a.limit]
    print(f"worker: {WORKER}")
    print(f"{len(lakes)} water(s), --jobs {a.jobs}"
          f"{'  [DRY RUN -- nothing is saved]' if a.dry_run else ''}")
    print("estimate at the measured 48 s/lake: "
          f"{len(lakes) * 48 / max(a.jobs, 1) / 60:.0f} min\n")

    t0 = time.perf_counter()
    done = [0]
    results = []

    def work(pair):
        name, st = pair
        r = research_one(name, st, a.dry_run, a.verbose)
        done[0] += 1
        mark = "ok " if r["ok"] else "FAIL"
        secs = f'{r.get("seconds", 0):5.1f}s'
        # docs and facts are on the line because a cold run that quietly found no documents
        # looks exactly like a fast one, and the difference is the whole point of the batch.
        detail = (f"{len(r['returned'])}/{len(r['confirmed'])} species  "
                  f"{r['documents']} docs  {r['facts']} facts")
        if r["missing"]:
            detail += "  LOST: " + ", ".join(r["missing"])
        print(f"  [{done[0]:3d}/{len(lakes)}] {mark} {secs}  {name[:42]:44s}{detail}"
              + (f"  -- {r['error']}" if r["error"] else ""))
        return r

    if a.jobs > 1:
        with ThreadPoolExecutor(max_workers=a.jobs) as ex:
            results = list(ex.map(work, lakes))
    else:
        results = [work(p) for p in lakes]

    wall = time.perf_counter() - t0
    ok = [r for r in results if r["ok"]]
    bad = [r for r in results if not r["ok"]]
    print(f"\n{len(ok)}/{len(results)} succeeded in {int(wall // 60)}:{int(wall % 60):02d}")
    if ok:
        per = sorted(r["seconds"] for r in ok)
        print(f"per lake: median {per[len(per) // 2]:.0f}s  min {per[0]:.0f}s  max {per[-1]:.0f}s")
    for r in bad:
        print(f"  FAILED {r['lake']}: {r['error']}")

    lost = [r for r in ok if r["missing"]]
    if lost:
        print(f"\n{len(lost)} water(s) came back short of their confirmed species:")
        for r in lost:
            print(f"  {r['lake']}: {len(r['returned'])} of {len(r['confirmed'])} "
                  f"-- no block for {', '.join(r['missing'])}")
    dry = [r for r in ok if r["documents"] == 0]
    if dry:
        print(f"\n{len(dry)} water(s) ran on no documents at all -- the model had only the "
              f"deterministic profile:")
        for r in dry:
            print(f"  {r['lake']}")

    os.makedirs(os.path.dirname(a.report) or ".", exist_ok=True)
    with open(a.report, "w", encoding="utf-8") as f:
        json.dump({"worker": WORKER, "dry_run": a.dry_run, "wall_seconds": round(wall, 1),
                   "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
                   "results": results}, f, indent=2)
    print(f"\nreport -> {a.report}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
