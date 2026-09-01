#!/usr/bin/env python3
"""
time_fisheries_run.py -- how long does ONE lake's trolling-intelligence run actually take?

WHY THIS EXISTS. Nobody has ever timed a fisheries-only run, and two estimates have already been
put in front of Ryan that were wrong: "about 5 minutes" for a structure rebuild that took 26, and
"7 minutes per lake" for this, which was really Burton's ELEVEN-agent full pipeline including
discovery, downloads and three extraction passes. A quarterly batch over the ~64 inland lakes
above 1,000 acres should be planned from a measurement, not from a third guess.

WHAT IT DOES. Walks the same Worker endpoints the browser walks, in the same order, and times each
phase separately so the answer says WHERE the time goes rather than only how much:

    deterministic-facts -> discover -> get-normalized -> [proxy-download] -> analyze-facts
                        -> agent-llm (fisheries)

WHAT IT DELIBERATELY DOES NOT DO.

  * It never calls /research/save. Save is one of the MUTATING_ROUTES behind isAuthorized(), and a
    benchmark has no business writing a profile version anyway. Every endpoint used here is
    ungated, so this script needs no token, sends no Authorization header, and cannot be made to
    leak one.
  * It does not deploy anything. THE WORKER DEPLOYS ITSELF ON PUSH.

Personal use only, not for distribution or resale; not for navigation.
"""

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

WORKER = "https://trollmap-worker.colonal1981.workers.dev"

# Mirrors lake-research-engine.js. The Worker injects maxDocs=8 at charsPerDoc=20000; the client
# sends a little more so the Worker's relevance filter still has something to choose from.
LLM_DOC_LIMIT = 12
LLM_DOC_CHARS = 20000


def post(path, payload, timeout=300):
    """One POST. Returns (seconds, status, parsed-or-None, bytes_sent, bytes_recv)."""
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{WORKER}{path}", data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            dt = time.perf_counter() - t0
            try:
                return dt, r.status, json.loads(raw), len(body), len(raw)
            except json.JSONDecodeError:
                return dt, r.status, None, len(body), len(raw)
    except urllib.error.HTTPError as e:
        raw = e.read()
        return time.perf_counter() - t0, e.code, None, len(body), len(raw)
    except Exception as e:                                    # noqa: BLE001
        print(f"    !! {path} failed: {e}")
        return time.perf_counter() - t0, 0, None, len(body), 0


def get(path, timeout=300):
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(f"{WORKER}{path}", timeout=timeout) as r:
            raw = r.read()
            dt = time.perf_counter() - t0
            try:
                return dt, r.status, json.loads(raw), len(raw)
            except json.JSONDecodeError:
                return dt, r.status, None, len(raw)
    except urllib.error.HTTPError as e:
        return time.perf_counter() - t0, e.code, None, len(e.read())
    except Exception as e:                                    # noqa: BLE001
        print(f"    !! {path} failed: {e}")
        return time.perf_counter() - t0, 0, None, 0


def human(sec):
    return f"{sec:.1f}s" if sec < 60 else f"{int(sec // 60)}:{int(sec % 60):02d}"


def kb(n):
    return f"{n / 1024:.0f} KB" if n < 1024 * 1024 else f"{n / 1024 / 1024:.1f} MB"


def run_once(lake, state, skip_extract=False, verbose=False):
    phases = []
    sent = recv = 0
    # A BENCHMARK THAT REPORTS A NUMBER FROM FAILED CALLS IS WORSE THAN ONE THAT REPORTS NOTHING.
    # First test run of this script hit 403 on every request and cheerfully printed "64 lakes at
    # --jobs 4 -> 0.3s". Every phase is checked, and a run with any failure refuses to extrapolate.
    failures = []

    print(f"\n  {lake}")

    # 1. Deterministic facts -- registry, ramps, agency pages, regulations floor, attractors.
    dt, code, det, s, r = post("/research/deterministic-facts",
                               {"lakeName": lake, "state": state})
    sent += s; recv += r
    profile = (det or {}).get("profile") or {}
    species = ((profile.get("biology") or {}).get("predatorSpecies")) or []
    if code != 200: failures.append(f"deterministic-facts HTTP {code}")
    phases.append(("deterministic-facts", dt, f"HTTP {code}, {len(species)} species"))
    print(f"    deterministic-facts   {human(dt):>8}  {len(species)} species")

    # 2. Discover sources for the fisheries agent.
    dt, code, disc, s, r = post("/research/discover",
                                {"lakeName": lake, "state": state, "agent": "fisheries",
                                 "names": [lake], "predatorSpecies": species})
    sent += s; recv += r
    sources = (disc or {}).get("sources") or []
    if code != 200: failures.append(f"discover HTTP {code}")
    phases.append(("discover", dt, f"HTTP {code}, {len(sources)} sources"))
    print(f"    discover              {human(dt):>8}  {len(sources)} sources")

    # 3. The lake-wide normalized document cache. On a re-run this is where the corpus comes from
    #    and no download happens at all -- which is the difference between a first pass and a
    #    quarterly refresh, and the whole reason this script reports them separately.
    dt, code, norm, r = get(f"/research/get-normalized?lake={urllib.parse.quote(lake)}")
    recv += r
    docs = (norm or {}).get("documents") or (norm or {}).get("docs") or []
    if code != 200: failures.append(f"get-normalized HTTP {code}")
    phases.append(("get-normalized", dt, f"HTTP {code}, {len(docs)} cached docs"))
    print(f"    get-normalized        {human(dt):>8}  {len(docs)} cached docs  ({kb(r)})")

    usable = [d for d in docs if len(str(d.get("fullText") or d.get("text") or "")) >= 200]
    print(f"    {'':22}          {len(usable)} with >=200 chars of text")

    # 4. Extraction. This is what parseBehaviour() turns into the PARSED OBSERVATION block, which
    #    the fisheries prompt ranks ABOVE the documents -- so it is not optional, whatever an
    #    earlier reading of the template suggested.
    facts = []
    if skip_extract:
        phases.append(("analyze-facts", 0.0, "SKIPPED (--skip-extract)"))
        print("    analyze-facts          skipped")
    else:
        t0 = time.perf_counter()
        for i, d in enumerate(usable[:LLM_DOC_LIMIT]):
            dt1, code1, ex, s1, r1 = post("/research/analyze-facts", {
                "lakeName": lake, "state": state,
                "targetFields": ["trollingIntelligence"],
                "documents": [{"title": d.get("title"), "url": d.get("url"),
                               "text": str(d.get("fullText") or d.get("text") or "")[:200000]}],
            })
            sent += s1; recv += r1
            facts.extend((ex or {}).get("extracted_facts") or [])
            if verbose:
                print(f"      doc {i + 1}/{min(len(usable), LLM_DOC_LIMIT)} {human(dt1):>7} "
                      f"HTTP {code1} +{len((ex or {}).get('extracted_facts') or [])} facts")
            # The client sleeps 1s between extraction calls. Mirrored so the measurement matches
            # the real run rather than a version of it that would trip rate limits.
            if i + 1 < min(len(usable), LLM_DOC_LIMIT):
                time.sleep(1)
        dt = time.perf_counter() - t0
        phases.append(("analyze-facts", dt, f"{len(facts)} facts from {min(len(usable), LLM_DOC_LIMIT)} docs"))
        print(f"    analyze-facts         {human(dt):>8}  {len(facts)} facts")

    # 5. The agent itself. One call per species group, bounded 2-at-a-time inside the Worker.
    prev = dict(profile)
    prev["_extractedFacts"] = facts
    prev["_normalizedDocuments"] = [
        {"title": d.get("title"), "url": d.get("url"),
         "text": str(d.get("fullText") or d.get("text") or "")[:LLM_DOC_CHARS]}
        for d in usable[:LLM_DOC_LIMIT]
    ]
    dt, code, out, s, r = post("/research/agent-llm",
                               {"lakeName": lake, "state": state, "agent": "fisheries",
                                "previousResults": prev})
    sent += s; recv += r
    section = (out or {}).get("section") or {}
    warns = (out or {}).get("warnings") or []
    if code != 200: failures.append(f"agent-llm HTTP {code}")
    if code == 200 and not section: failures.append("agent-llm returned an empty section")
    phases.append(("agent-llm", dt, f"HTTP {code}, {len(section)} species"))
    print(f"    agent-llm (fisheries) {human(dt):>8}  {len(section)} species returned  "
          f"(sent {kb(s)})")
    for w in warns:
        print(f"      warn: {w}")

    total = sum(p[1] for p in phases)
    print(f"    {'TOTAL':22}{human(total):>8}   up {kb(sent)} / down {kb(recv)}")
    for f in failures:
        print(f"    !! {f}")
    return {"lake": lake, "total": total, "phases": phases, "failures": failures,
            "sent": sent, "recv": recv, "species": len(section)}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lake", action="append", required=True,
                    help="display name, e.g. \"Lake Wateree, SC\" (repeatable)")
    ap.add_argument("--state", default="SC")
    ap.add_argument("--repeat", type=int, default=1,
                    help="run each lake N times; an LLM call is not deterministic in latency")
    ap.add_argument("--skip-extract", action="store_true",
                    help="time WITHOUT the extraction pass, to price what it costs")
    ap.add_argument("--lakes-in-batch", type=int, default=64,
                    help="how many lakes the quarterly batch would cover (default 64)")
    ap.add_argument("--jobs", type=int, default=4, help="parallel lakes the batch would use")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()

    print("Timing a fisheries-only research run. No /research/save -- nothing is written.")
    runs = []
    for lake in a.lake:
        for _ in range(a.repeat):
            runs.append(run_once(lake, a.state, a.skip_extract, a.verbose))

    print("\n" + "=" * 68)
    bad = [f for r in runs for f in r["failures"]]
    if bad:
        print("MEASUREMENT FAILED -- no timing is reported, because the numbers would be fiction.")
        for f in sorted(set(bad)):
            print(f"  {f}")
        print("\nIf every call returned 403, this machine cannot reach the Worker. That is an")
        print("egress restriction, not a bug in the run -- try it from a shell with plain")
        print("internet access. Any other code is a real failure worth reading.")
        return 1
    per = [r["total"] for r in runs]
    med = statistics.median(per)
    print(f"runs: {len(per)}   median {human(med)}   min {human(min(per))}   max {human(max(per))}")

    agg = {}
    for r in runs:
        for name, dt, _ in r["phases"]:
            agg.setdefault(name, []).append(dt)
    print("\nwhere the time goes (median per run):")
    for name, vals in agg.items():
        m = statistics.median(vals)
        share = (m / med * 100) if med else 0
        print(f"  {name:22} {human(m):>8}  {share:4.0f}%")

    wall = med * a.lakes_in_batch / max(a.jobs, 1)
    print(f"\nextrapolated: {a.lakes_in_batch} lakes at --jobs {a.jobs}  ->  {human(wall)}")
    print("  (a floor, not a promise: a first pass also downloads documents, and lakes with more")
    print("   species run more LLM groups than whatever was measured here)")


if __name__ == "__main__":
    sys.exit(main())
