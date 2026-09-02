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
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
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

# research/extract.js slices every document to 150,000 characters before it builds the prompt,
# and lake-research-engine.js sends exactly that. This script was sending 200,000 -- 50,000
# characters uploaded on every extraction call for the Worker to throw away.
EXTRACT_DOC_CHARS = 150000

# PACE BY TOKENS, NOT BY A FIXED SLEEP.
#
# Ryan, 2026-09-01, on two runs that each lost a species group to "This model is currently
# experiencing high demand": "i don't think that error is correct i think you are rate limitting
# because you are hitting all of the species at once."
#
# Counted from the code: one lake with eight documents sends eight extraction calls at up to
# 150,000 characters each, then one call per species group carrying up to eight documents at
# 20,000 characters. About 420,000 input tokens inside a minute, on a free tier that meters
# tokens per minute. A one-second sleep between calls does not describe that load at all -- it
# is the same pause whether the document is 2,000 characters or 150,000.
#
# So the pause is computed from what was actually just sent. --tpm sets the ceiling; the default
# leaves most of a 250,000 TPM allowance for the group calls that follow the extraction burst.
DEFAULT_TPM = 120000
CHARS_PER_TOKEN = 4


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


def _raw(path, timeout=300):
    """GET returning (status, bytes, content-type, error). /research/proxy-download hands back
    PDF bytes, not JSON -- the browser runs pdf.js on them and this runs pypdf."""
    req = urllib.request.Request(f"{WORKER}{path}", headers=_headers(body=False), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), r.headers.get("Content-Type", ""), None
    except urllib.error.HTTPError as e:
        body = e.read()[:300].decode("utf-8", "replace").replace("\n", " ").strip()
        return e.code, None, None, body or "empty body"
    except Exception as e:                                    # noqa: BLE001
        return 0, None, None, str(e)


# ── THE DOWNLOAD STAGE, which this script did not have and needed ───────────────────────────
#
# The browser's pipeline is discover -> proxy-download -> save-normalized -> analyze-facts
# (lake-research-engine.js, the comment above runAgent). The first version of this script went
# discover -> get-normalized and skipped the two in the middle, so it read a corpus it never
# filled. On a lake that already had one -- Wateree -- that looked like a 48-second run. On a lake
# that never had one it looked like a FASTER run: Lanier and Townsend came back in 21 s and 15 s
# with `documents: 0`, the model answering from the deterministic profile alone. A batch built
# that way would have written sixty-four profiles with no document behind any of them, which is
# the one thing trollingIntelligence exists to avoid.

SOURCE_CAP = 10          # AGENT_SOURCE_CAPS.fisheries in lake-research-engine.js
BATCH_SIZE = 10          # what /research/proxy-download-batch takes per call
DAY_MS = 24 * 60 * 60 * 1000
TTL_MS = {"academic": 365 * DAY_MS, "official": 90 * DAY_MS,
          "news": 30 * DAY_MS, "anecdotal": 14 * DAY_MS}


def doc_ttl_ms(url):
    """getDocTtl() in lake-research-engine.js -- how long a source of this kind stays fresh."""
    u = str(url or "").lower()
    if re.search(r"seafwa|usgs|nepis|epa\.gov|asmfc|apms|\.edu", u):
        return TTL_MS["academic"]
    if re.search(r"dnr\.sc\.gov|ncwildlife|georgiawildlife|tn\.gov|eregulations|ferc|"
                 r"santeecooper|usace", u):
        return TTL_MS["official"]
    if re.search(r"news|report|stocking|annual|trends|freshwater\.html", u):
        return TTL_MS["news"]
    return TTL_MS["anecdotal"]


def norm_url(u):
    return str(u or "").split("?")[0].lower()


def is_pdf_url(url, type_):
    return str(type_ or "").upper() == "PDF" or re.search(r"\.pdf($|[?#])", str(url or ""), re.I)


def is_special_url(url):
    return bool(re.search(r"nepis\.epa\.gov|ZyNET\.exe|wateratlas\.usf\.edu", str(url or ""), re.I))


def pdf_text(data):
    """Text out of PDF bytes. The browser uses pdf.js; this box already has pypdf."""
    try:
        from pypdf import PdfReader
    except ImportError:
        return ""
    try:
        reader = PdfReader(io.BytesIO(data))
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    except Exception:                                          # noqa: BLE001
        return ""


def gate_documents(repo, documents, lake, alt_names=None):
    """
    The off-lake gate, RUN RATHER THAN REIMPLEMENTED.

    js/utils/doc-relevance.js already holds prepareNormalizedDocuments(), already carries the
    positional-agentTags bug fix, and is already covered by a test. Porting 85 lines of it into
    Python would make a second copy of a rule this project has watched drift before -- the
    fisheries group-term table was two copies and they disagreed, and it cost a species on
    2026-09-01. Node is on this machine and the module is plain ESM with no browser globals, so
    the real function runs on the real documents and Python never learns the rule.
    """
    src = os.path.abspath(os.path.join(repo, "js", "utils", "doc-relevance.js"))
    if not os.path.exists(src):
        raise SystemExit(f"!! cannot find {src} -- pass --repo pointing at the TrollMap-Dev tree")
    script = (
        "import {readFileSync} from 'node:fs';"
        f"const m = await import({json.dumps('file://' + src.replace(os.sep, '/'))});"
        "const inp = JSON.parse(readFileSync(0,'utf8'));"
        "process.stdout.write(JSON.stringify("
        "m.prepareNormalizedDocuments(inp.documents, inp.lakeName, [], null, inp.altNames)));"
    )
    proc = subprocess.run(["node", "--input-type=module", "-e", script],
                          input=json.dumps({"documents": documents, "lakeName": lake,
                                            "altNames": alt_names or []}),
                          capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        raise SystemExit(f"!! the off-lake gate failed to run under node: "
                         f"{(proc.stderr or '').strip()[:300]}")
    return json.loads(proc.stdout)


def resolve_names(repo, names):
    """{name: {state, aliases}} for names the app already chose -- its own binding, not a lookup."""
    src = os.path.join(repo, "Scripts", "research_todo.mjs")
    if not os.path.exists(src):
        raise SystemExit(f"!! cannot find {src} -- pass --repo pointing at the TrollMap-Dev tree")
    with tempfile.TemporaryDirectory() as tmp:
        inp = os.path.join(tmp, "names.json")
        outp = os.path.join(tmp, "resolved.json")
        with open(inp, "w", encoding="utf-8") as f:
            json.dump(names, f)
        proc = subprocess.run(["node", os.path.abspath(src), "--resolve", inp, "--json", outp],
                              capture_output=True, text=True, encoding="utf-8",
                              cwd=os.path.abspath(repo),
                              env=dict(os.environ, TROLLMAP_WORKER_URL=WORKER))
        for line in (proc.stderr or "").splitlines():
            print(f"   {line}")
        if proc.returncode != 0 or not os.path.exists(outp):
            print("!! could not resolve names against the app -- falling back to the registry")
            return {}
        with open(outp, encoding="utf-8") as f:
            return {r["name"]: r for r in json.load(f)}


def app_todo_names(repo):
    """
    The waters the Research tab shows under "Not researched yet" -- ASKED OF THE APP'S OWN CODE.

    Scripts/research_todo.mjs is populateResearchLakeDropdown() with the DOM taken out. It builds
    the access index from the live worker feeds, filters with PRESETS.research, reads
    /research/list and resolves with researchedNames -- the same modules in the same order.

    Nothing here is a reimplementation, because every attempt at one was wrong. This script used
    to derive the list from lake_index.json's county-stamped display_name and 22 of 64 waters came
    back missing while the app was showing their profile. Ryan: "but all of those are able to be
    seen in the app..." The name the profile is filed under comes from findExistingLakeKey() in
    access-index.js -- a feed waterbody within 15 km that also matches by name, else the registry
    display name -- and that join is not reproducible from a JSON file on disk.
    """
    src = os.path.join(repo, "Scripts", "research_todo.mjs")
    if not os.path.exists(src):
        raise SystemExit(f"!! cannot find {src} -- pass --repo pointing at the TrollMap-Dev tree")
    env = dict(os.environ, TROLLMAP_WORKER_URL=WORKER)
    # A FILE, NOT A PIPE. The first --todo run read the list off stdout and got five of
    # access-index.js's own console.info lines mixed in with the seventeen waters -- node sends
    # console.info to STDOUT -- and set about researching "[access-index] folded 18 feed name(s)
    # onto the water they share a name and a launch with". research_todo.mjs now pushes the app's
    # chatter to stderr, and this asks for a file as well, so no amount of noise on a stream can
    # be mistaken for an answer again.
    with tempfile.TemporaryDirectory() as tmp:
        out_path = os.path.join(tmp, "todo.json")
        proc = subprocess.run(["node", os.path.abspath(src), "--json", out_path],
                              capture_output=True, text=True, encoding="utf-8",
                              cwd=os.path.abspath(repo), env=env)
        for line in (proc.stderr or "").splitlines():
            print(f"   {line}")
        if proc.returncode != 0 or not os.path.exists(out_path):
            raise SystemExit("!! could not get the list from the app's own code -- see above")
        with open(out_path, encoding="utf-8") as f:
            data = json.load(f)
    return data.get("todo") or []


def fetch_sources(lake, sources, existing, verbose=False):
    """
    Sources -> normalized documents, the way runAgent does it: batch the HTML through
    /research/proxy-download-batch, take PDFs and the blocked domains one at a time.
    Returns (documents, stats).
    """
    by_url = {norm_url(d.get("url")): d for d in existing}
    now_ms = time.time() * 1000
    to_fetch, reused = [], []
    for src in sources:
        cached = by_url.get(norm_url(src.get("url")))
        if cached:
            fetched = cached.get("fetchedAt")
            age = None
            if fetched:
                try:
                    age = now_ms - time.mktime(time.strptime(
                        str(fetched)[:19], "%Y-%m-%dT%H:%M:%S")) * 1000
                except ValueError:
                    age = None
            if age is not None and age < doc_ttl_ms(src.get("url")):
                reused.append(cached)
                continue
        to_fetch.append(src)

    docs = list(reused)
    stats = {"reused": len(reused), "html_ok": 0, "pdf_ok": 0, "failed": 0, "pdf_no_text": 0}

    batch = [s for s in to_fetch if not is_pdf_url(s.get("url"), s.get("type"))
             and not is_special_url(s.get("url"))]
    individual = [s for s in to_fetch if s not in batch]

    for i in range(0, len(batch), BATCH_SIZE):
        chunk = batch[i:i + BATCH_SIZE]
        payload = {"urls": [{"url": s.get("url"), "canonicalUrl": s.get("canonicalUrl") or s.get("url"),
                             "title": s.get("title"), "type": s.get("type") or "HTML"} for s in chunk]}
        code, data, err = _req("/research/proxy-download-batch", payload)
        if code != 200 or not data:
            if verbose:
                print(f"      proxy-download-batch {code}: {err}")
            stats["failed"] += len(chunk)
            continue
        results = data.get("results") or []
        for j, s2 in enumerate(chunk):
            r = results[j] if j < len(results) else None
            text = (r or {}).get("text") or ""
            if (r or {}).get("ok") and len(text) > 200:
                docs.append({"title": s2.get("title"), "url": s2.get("url"), "fullText": text,
                             "agentTags": s2.get("agentTags") or ["fisheries"],
                             "discoveredBy": "fisheries",
                             "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
                stats["html_ok"] += 1
            elif (r or {}).get("reason") == "unhandled":
                individual.append(s2)          # the batch classified it special -- take it alone
            else:
                stats["failed"] += 1
                if verbose:
                    print(f"      batch miss: {str(s2.get('title'))[:60]} "
                          f"({(r or {}).get('error') or 'no content'})")

    for s3 in individual:
        url = f"/research/proxy-download?url={urllib.parse.quote(str(s3.get('url') or ''), safe='')}" \
              f"&type={s3.get('type') or 'HTML'}"
        code, raw, ctype, err = _raw(url)
        if code != 200 or not raw:
            stats["failed"] += 1
            if verbose:
                print(f"      proxy-download {code} for {str(s3.get('title'))[:60]}: {err}")
            continue
        if "application/pdf" in (ctype or "").lower() or is_pdf_url(s3.get("url"), s3.get("type")):
            text = pdf_text(raw)
            if len(text) <= 200:
                stats["pdf_no_text"] += 1
                continue
            stats["pdf_ok"] += 1
        else:
            text = raw.decode("utf-8", "replace")
            if len(text) <= 200:
                stats["failed"] += 1
                continue
            stats["html_ok"] += 1
        docs.append({"title": s3.get("title"), "url": s3.get("url"), "fullText": text,
                     "agentTags": s3.get("agentTags") or ["fisheries"],
                     "discoveredBy": "fisheries",
                     "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    return docs, stats


def base_name(lake_name):
    """cleanLakeBaseName() in lake-research-engine.js. The county stamp is ours, not the water's."""
    b = re.sub(r"\s*\([^)]*\bCo\b[^)]*\)\s*", " ", str(lake_name or ""), flags=re.I)
    b = re.sub(r"\s+", " ", b).strip()
    b = re.sub(r"^Lake\s+", "", b, flags=re.I)
    b = re.sub(r",\s*(SC|NC|GA|TN)(/(?:SC|NC|GA|TN))*\s*$", "", b, flags=re.I).strip()
    b = re.sub(r"\s+Reservoir$", "", b, flags=re.I).strip()
    b = re.sub(r"\s+Lake$", "", b, flags=re.I).strip()
    return b or str(lake_name or "")


def pace_seconds(chars, tpm):
    """How long to wait after sending `chars` so the minute's token budget is not blown."""
    if tpm <= 0:
        return 0.0
    return min(30.0, (chars / CHARS_PER_TOKEN) / tpm * 60.0)


def research_one(lake, state, dry_run=False, verbose=False, repo="TrollMap-Dev", alt_names=None,
                 tpm=DEFAULT_TPM):
    """One lake, start to saved profile. Returns a result dict; never raises."""
    t0 = time.perf_counter()
    out = {"lake": lake, "state": state, "aliases": list(alt_names or []),
           "ok": False, "species": 0, "saved": False, "error": None,
           "confirmed": [], "asked": [], "returned": [], "missing": [], "documents": 0,
           "facts": 0,
           "sources": 0, "fetch": {}, "rejected_offlake": 0, "rejected_docs": [],
           "chars_sent": 0, "retries": 0, "group_attempts": {}, "saved_key": None,
           "saved_version": None, "discovered_species": [], "warnings": []}

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
    if code != 200 or not disc or not disc.get("success"):
        out["error"] = f"discover {code}: {err or (disc or {}).get('error') or 'no sources'}"
        return out
    found = [s2 for s2 in (disc.get("sources") or [])
             if not s2.get("agentTags") or "fisheries" in s2["agentTags"]]

    # THE CAP THE BROWSER APPLIES, mirrored: seeds (priority 1) always pass, the rest sort by
    # prefetchScore and fill what is left of ten. A source with no score defaults to 3 so it is
    # not cut for a field discovery did not set.
    seeds = [s2 for s2 in found if s2.get("priority") == 1]
    rest = sorted((s2 for s2 in found if s2.get("priority") != 1),
                  key=lambda s2: s2.get("prefetchScore", s2.get("score", 3)), reverse=True)
    sources = seeds + rest[:max(0, SOURCE_CAP - len(seeds))]
    out["sources"] = len(sources)
    if verbose:
        print(f"      discover: {len(found)} sources ({len(seeds)} seeds) -> {len(sources)}")

    code, norm, err = _req(f"/research/get-normalized?lake={urllib.parse.quote(lake)}")
    existing = ((norm or {}).get("documents") or (norm or {}).get("docs") or []) if code == 200 else []

    fetched, out["fetch"] = fetch_sources(lake, sources, existing, verbose)

    # The off-lake gate, then back to R2 so the next quarter's run reuses the corpus instead of
    # paying for it again. Untouched cached docs are merged back in, the way runAgent does.
    if fetched:
        touched = {norm_url(d.get("url")) for d in fetched}
        merged = [d for d in existing if norm_url(d.get("url")) not in touched] + fetched
        prepared = gate_documents(repo, merged, lake, alt_names)
        out["rejected_offlake"] = prepared.get("rejected", 0)
        keep = prepared.get("documents") or []
        # NAME WHAT THE GATE DROPPED. A count says six documents did not survive; it does not say
        # whether the gate was right. On 2026-09-01 Lanier fetched nine and kept three, twice, and
        # there was no way to tell a correctly-rejected off-lake page from a Lake Lanier report
        # thrown out for not spelling itself "Sidney Lanier". The titles decide that in one read.
        kept_urls = {norm_url(d.get("url")) for d in keep}
        out["rejected_docs"] = [{"title": d.get("title"), "url": d.get("url")}
                                for d in merged if norm_url(d.get("url")) not in kept_urls]
        # AN EMPTY CORPUS IS NOT WORTH A KEY IN R2. On 2026-09-01 three console.info lines were
        # researched as if they were lakes; the off-lake gate correctly threw out every document
        # they found, and this then wrote an empty document array to the bucket under each of
        # their names. Nothing to store means nothing to store.
        if keep:
            code, _, err = _req(f"/research/save-normalized?lake={urllib.parse.quote(lake)}"
                                f"&n={len(keep)}&rejected={out['rejected_offlake']}", keep)
            if code != 200:
                print(f"      warn [{lake}]: save-normalized {code}: {err} "
                      f"-- the corpus was used but not stored")
        docs = keep
    else:
        docs = existing

    usable = [d for d in docs if len(str(d.get("fullText") or d.get("text") or "")) >= 200]
    out["documents"] = len(usable)

    # EXTRACTION IS NOT OPTIONAL, whatever an earlier reading of the template suggested. The Worker
    # turns these facts into the PARSED OBSERVATION block via parseBehaviour(), and the fisheries
    # prompt ranks that ABOVE the documents: "If a PARSED OBSERVATION covers this species and
    # season, its value is the answer -- copy it, do not adjust it."
    facts = []
    chosen = usable[:LLM_DOC_LIMIT]
    for i, d in enumerate(chosen):
        text = str(d.get("fullText") or d.get("text") or "")[:EXTRACT_DOC_CHARS]
        code, ex, err = _req("/research/analyze-facts", {
            # baseName and docIndex are what lake-research-engine.js sends. Without baseName the
            # Worker derives one, and the prompt then tells the model to extract only facts that
            # mention it -- so getting it right is the difference between "Sidney Lanier" and a
            # name no document on earth contains.
            "lakeName": lake, "baseName": base_name(lake), "state": state,
            # EVERY NAME THE WATER HAS, into the extractor. Its prompt says to take only facts
            # that mention the base name, and a base name is one string: "John H. Moss" for a
            # water the world calls Moss Lake or Kings Mountain Reservoir. Two documents, zero
            # facts, on 2026-09-01. The registry has carried both other names all along.
            "aliases": alt_names or [],
            "docIndex": i, "targetFields": ["trollingIntelligence"],
            "documents": [{"title": d.get("title"), "url": d.get("url"), "text": text}]})
        if code == 200:
            facts.extend((ex or {}).get("extracted_facts") or [])
        elif verbose:
            print(f"      analyze-facts {code}: {err}")
        out["chars_sent"] += len(text)
        if i + 1 < len(chosen):
            time.sleep(pace_seconds(len(text), tpm))

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
    # How hard the provider made us work for it. A group that needed a second or third attempt
    # succeeded, so nothing warns -- but a run where every group is retrying is a run whose load
    # is still too high, and that is only visible if the number is carried out.
    meta = res.get("meta") or {}
    groups = meta.get("groups") or []
    out["group_attempts"] = {g.get("group"): g.get("attempts", 1) for g in groups if g.get("group")}
    out["retries"] = sum(max(0, (g.get("attempts") or 1) - 1) for g in groups)
    # WHICH DETERMINISTIC BLOCKS WERE IN PLAY. This script never names agency_lake_facts.json or
    # species_traits.json and should not -- it is a driver, and the Worker does the reading inside
    # /research/agent-llm. But both of those reads are against R2, and both callers swallow a
    # missing object on purpose, so an object THAT WAS NEVER UPLOADED produces a run identical to
    # one where it was present and had nothing to say. Recording the counts is what makes the
    # difference visible without opening the profile.
    out["agency_entries"] = meta.get("agencyEntries")
    out["species_trait_rows"] = meta.get("speciesTraitRows")
    if not meta.get("speciesTraitRows"):
        print(f"      note [{lake}]: no species traits in the prompt -- is "
              f"_registry/species_traits.json in the bucket?")
    for w in out["warnings"]:
        print(f"      warn [{lake}]: {w}")

    # WHAT WENT IN AND DID NOT COME BACK -- TAKEN FROM THE WORKER, NOT RECOMPUTED HERE.
    #
    # This script used to work it out itself: every confirmed name with no exactly-matching key in
    # the section. That is a second copy of a rule the Worker already owns, and on 2026-09-02 the
    # two copies disagreed on thirteen of sixty-four waters. Both directions of the same problem:
    # the Worker folds Black Crappie and White Crappie onto the one Crappie it asked about, and it
    # reads a member species as an answer to the group heading the regulations name -- Largemouth,
    # Smallmouth and Spotted Bass ARE the answer to Tennessee's "Black Bass". The naive check knew
    # neither, so it printed a loss for eight NC and SC waters that lost nothing and six TN waters
    # that came back with MORE fish than the roster had names for. The tell was in its own
    # arithmetic: "Cherokee Lake: 6 of 4".
    #
    # See missingConfirmedSpecies() in Worker/research/agents.js, which is now the only copy, and
    # test/the-shortfall-report-said-six-of-four.test.js, which is these waters.
    #
    # IT DOES NOT ABORT THE SAVE. Four species of five is worth keeping, and one flaky group
    # must not cost the other sixty-three lakes their run. It is counted, printed and reported.
    out["missing"] = list(meta.get("missingSpecies") or [])
    # WHAT WAS ACTUALLY ASKED, which is not the roster: the Worker merges names for one fish
    # before it builds the groups, so the roster is the wrong denominator and printing it is how
    # "6 of 4" got onto the screen.
    out["asked"] = sorted({s2 for g in groups for s2 in (g.get("species") or [])})

    # AN EMPTY SECTION IS A FAILED RUN, NOT A QUIET ONE. Ryan found this the hard way on
    # 2026-08-10: a group came back empty, a quarter of the lake's species vanished, and every
    # line on screen still said success. It is not written and it is reported.
    if not section:
        out["error"] = "agent-llm returned an empty trollingIntelligence section"
        return out


    profile["trollingIntelligence"] = section

    # WHAT DISCOVER MODE ESTABLISHED, WRITTEN WHERE THE ROSTER LIVES.
    #
    # Four waters have no deterministic species list -- Lake Robinson (Chesterfield Co, SC), Lake
    # William C Bowen (Spartanburg Co, SC), Bay Tree Lake and White Lake, both Bladen Co, NC --
    # and for those the agent establishes one from the documents and returns it as `speciesFound`
    # beside the section. lake-research-engine.js has folded that into biology.predatorSpecies
    # since the discover path was written; this script was not, so White Lake would have saved
    # trolling intelligence for species its own biology section did not list.
    #
    # `_speciesDiscoveredBy` is the mark the client sets and the reason it sets it: a reader can
    # tell a roster a model read out of a document from one a structured feed supplied.
    data = res.get("data") or {}
    found = [str((f or {}).get("species") or (f or {}).get("name") or "").strip()
             for f in (data.get("speciesFound") or [])]
    found = [f for f in found if f]
    if found:
        bio = profile.setdefault("biology", {})
        have = {str(x).lower() for x in (bio.get("predatorSpecies") or [])}
        added = [f for f in dict.fromkeys(found) if f.lower() not in have]
        if added:
            bio["predatorSpecies"] = list(bio.get("predatorSpecies") or []) + added
            bio["_speciesDiscoveredBy"] = ("fisheries agent, from agency documents "
                                           "(no deterministic source for this water)")
            out["discovered_species"] = added
            print(f"      [{lake}] established {len(added)} species from documents: "
                  f"{', '.join(added)}")
    forage = data.get("lakeForage") or {}
    if forage.get("primary") or forage.get("secondary"):
        bio = profile.setdefault("biology", {})
        if not bio.get("primaryForage") and forage.get("primary"):
            bio["primaryForage"] = forage["primary"]
        if not bio.get("secondaryForage") and forage.get("secondary"):
            bio["secondaryForage"] = forage["secondary"]
        bio["_forageEstablishedBy"] = "fisheries agent, from the documents it was already reading"

    meta = profile.setdefault("metadata", {})
    meta["status"] = meta.get("status") or "draft"

    if dry_run:
        out["ok"] = True
        out["seconds"] = time.perf_counter() - t0
        return out

    code, saved, err = _req("/research/save",
                            {"lakeName": lake, "profile": profile,
                             "status": meta["status"], "requestedBy": "research_lakes.py batch"})
    if code != 200:
        out["error"] = f"save {code}: {err}"
        return out
    # WHICH KEY IT LANDED ON AND WHAT VERSION IT BECAME. handleResearchSave resolves the id
    # before writing, so a lake that already had a profile is versioned rather than forked --
    # and version 1 means this water genuinely had nothing. That is the difference between a
    # batch that filled a gap and a batch that redid work, and it is one field.
    out["saved_key"] = (saved or {}).get("key") or (saved or {}).get("id")
    out["saved_version"] = ((saved or {}).get("version")
                            or ((saved or {}).get("metadata") or {}).get("version"))
    out["ok"] = out["saved"] = True
    out["seconds"] = time.perf_counter() - t0
    return out


def load_lakes(args, registry):
    """--todo and --lake win; otherwise the registry, filtered the way the research tab filters."""
    idx_path = os.path.join(registry, "lake_index.json")
    with open(idx_path, encoding="utf-8") as f:
        idx = json.load(f)

    # EVERY NAME THE WATER HAS, off the registry, for the off-lake gate. lake-research-engine.js
    # builds the same list for /research/discover -- `[name, displayName, ...legacyDisplayNames]`
    # -- and the gate needs it for the same reason: Lanier's documents say "Lake Lanier" and its
    # registry name is "Lake Sidney Lanier". Six of nine were dropped for that on 2026-09-01.
    alt_names = {}
    for slug, row in idx.items():
        name = row.get("display_name") or row.get("name") or slug
        legacy = row.get("legacy_display_names")
        if legacy is None:
            legacy = [row["legacy_display_name"]] if row.get("legacy_display_name") else []
        names = [row.get("name"), row.get("display_name"), *legacy]
        alt_names[name.strip().lower()] = [n for n in dict.fromkeys(names) if n]

    if getattr(args, "from_report", None):
        # THE NAMES A PRIOR RUN USED, WHICH ARE THE APP'S NAMES. --todo only offers waters with no
        # profile, so it cannot repeat a batch: the moment the first run saves, they all disappear
        # from it. Reading them back out of the report keeps the same spellings -- the ones that
        # resolve onto the stored profile on both the read and the write -- without anybody
        # retyping a list.
        with open(args.from_report, encoding="utf-8") as f:
            prior = json.load(f)
        args.lake = [r["lake"] for r in (prior.get("results") or []) if r.get("lake")]
        print(f"repeating {len(args.lake)} water(s) from "
              f"{os.path.basename(args.from_report)}")
        # THE STATE AND THE ALIASES COME FROM THE APP, NOT FROM THE OLD REPORT. A report written
        # before aliases were recorded has none, and a registry lookup on an app name finds none
        # either -- "Lake Richard Russell, GA" is not a key in lake_index.json, and its documents
        # all say "Lake Russell". So the same registryRecordFor() that produced the name answers
        # for it, through research_todo.mjs --resolve.
        args._resolved = resolve_names(args.repo, args.lake)

    if getattr(args, "todo", False):
        # The app's name, its state and its alias set, all decided by the same registryRecordFor()
        # that produced the name. Nothing here is looked up again in lake_index.json: these names
        # -- "HYCO LAKE, NC", "Nottely Lake, GA" -- are not keys in it, and the first --todo run
        # fell back to state=SC for every Georgia, Tennessee and North Carolina water in the list.
        rows = app_todo_names(args.repo)
        if not rows:
            print("nothing to research -- every water the tab offers already has a profile")
        return [(r["name"], args.state or r.get("state") or "SC", r.get("aliases") or [r["name"]])
                for r in rows]
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
        # A report carries the state and the aliases the run used; a registry lookup on an app
        # name does not find them. Same lesson as the first --todo run, which sent Georgia and
        # Tennessee lakes to the Worker as South Carolina.
        # A resolve that answered `null` is not an answer, so it must not shadow the report's
        # value. setdefault() would have let it: the key exists, the value is None, and the
        # report's NC/GA/TN never lands. Every Georgia and Tennessee lake goes back to SC, which
        # is the same failure as the first --todo run, one layer along.
        # ASK THE APP WHO THIS WATER IS, WHETHER THE NAMES CAME FROM A REPORT OR FROM --lake.
        #
        # Only the --from-report branch above resolved, so a bare `--lake "Lake Richard Russell,
        # GA"` skipped it and took the two fallbacks on the next lines: state off `by_name`, which
        # is keyed by lake_index.json display names and does not contain the app's name, so SC;
        # and aliases `[n]`, one name, its own.
        #
        # Measured 2026-09-01 on exactly that command. The run reported state=SC for a GA/SC water
        # and aliases ["Lake Richard Russell, GA"], and the off-lake gate then dropped five of
        # eight documents -- among them "Lake Russell Fishing Report", "Richard B. Russell Lake
        # fishing reports" and "Richard B Russell Lake Fishing", which are the three best pages
        # about the lake. Correctly, on what it was given: the base name of the app's name is
        # "Richard Russell", and not one of those titles contains that string. The registry knows
        # the water as "Richard B Russell Lake" and its documents say "Lake Russell"; both were one
        # resolve away and the branch did not make it.
        #
        # Same lesson as the first --todo run, two branches along, and the comment below already
        # says a registry lookup on an app name does not find these. It does not, so stop doing
        # one: registryRecordFor() produced the name and is the only thing that can answer for it.
        resolved = getattr(args, "_resolved", None)
        if resolved is None:
            resolved = resolve_names(args.repo, args.lake)
        prior_state = {k: v["state"] for k, v in resolved.items() if v.get("state")}
        prior_alias = {k: v["aliases"] for k, v in resolved.items() if v.get("aliases")}
        if getattr(args, "from_report", None):
            with open(args.from_report, encoding="utf-8") as f:
                for r in (json.load(f).get("results") or []):
                    n = r.get("lake")
                    if not n:
                        continue
                    if r.get("state") and not prior_state.get(n):
                        prior_state[n] = r["state"]
                    if r.get("aliases") and not prior_alias.get(n):
                        prior_alias[n] = r["aliases"]
        out = []
        for n in args.lake:
            st = args.state or prior_state.get(n) or by_name.get(n.strip().lower()) or "SC"
            if not args.state and not prior_state.get(n) and n.strip().lower() not in by_name:
                print(f"!! {n} is not in lake_index.json -- falling back to state=SC. "
                      f"Pass --state if that is wrong.")
            names = prior_alias.get(n) or alt_names.get(n.strip().lower(), []) or [n]
            # A WATER RUNNING UNDER ITS OWN NAME ALONE IS THE OFF-LAKE GATE ABOUT TO THROW AWAY
            # ITS BEST DOCUMENTS, AND IT SAID NOTHING. Russell ran with ["Lake Richard Russell,
            # GA"] and the gate dropped the three fishing reports that name the lake in their own
            # titles -- correctly, on one name whose base is a string none of them contain. The
            # run reported "ok 9/9 species" and looked fine.
            if len(names) < 2:
                print(f"!! {n}: the app returned no other name for this water, so the off-lake "
                      f"gate has only \"{n}\" to judge documents by. Expect it to drop pages that "
                      f"name the lake some other way.")
            out.append((n, st, names))
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
        out.append((name, row.get("state") or "SC", alt_names.get(name.strip().lower(), [])))
    out.sort(key=lambda p: p[0])
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--registry", default="registry", help="folder holding lake_index.json")
    ap.add_argument("--repo", default="TrollMap-Dev",
                    help="the TrollMap-Dev tree. This script runs three pieces of the app rather "
                         "than reimplementing them: the off-lake gate, the storage-id resolver, "
                         "and the research tab's own not-researched-yet list.")
    ap.add_argument("--lake", action="append", help="one water by display name (repeatable)")
    ap.add_argument("--from-report", metavar="PATH",
                    help="re-run exactly the waters a previous report covered, with the names it "
                         "used. For repeating a batch after a fix rather than retyping it.")
    ap.add_argument("--todo", action="store_true",
                    help="research exactly what the app's Research tab lists as not researched "
                         "yet, via Scripts/research_todo.mjs. This is the one to use.")
    ap.add_argument("--state", default=None,
                    help="override the state for --lake runs; the registry supplies it otherwise")
    ap.add_argument("--min-acres", type=int, default=1000,
                    help="matches PRESETS.research (default 1000)")
    ap.add_argument("--jobs", type=int, default=1,
                    help="parallel lakes. 1 by default, and that is the measured right answer: "
                         "--jobs multiplies the token rate the pacing exists to hold down, and "
                         "a group that gets rate limited costs a species")
    ap.add_argument("--limit", type=int, default=0, help="stop after N lakes (0 = all)")
    ap.add_argument("--tpm", type=int, default=DEFAULT_TPM,
                    help="input tokens per minute this script will pace extraction to "
                         f"(default {DEFAULT_TPM}; 0 disables pacing)")
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
    if not lakes:
        print("nothing to do")
        return 0
    print(f"worker: {WORKER}")
    print(f"{len(lakes)} water(s), --jobs {a.jobs}"
          f"{'  [DRY RUN -- nothing is saved]' if a.dry_run else ''}")
    # 220 s/lake, from the first two runs that finished with nothing missing: Lake Sidney Lanier
    # (Hall Co, GA) 121 s and Lake Townsend (Guilford Co, NC) 313 s, both 5 of 5 species with
    # documents downloaded, extraction paced and groups serialised. The numbers that preceded it
    # were all measuring something else -- 48 s was a refresh on a cached corpus, 80 s was a cold
    # run whose groups were failing and therefore finishing early.
    #
    # --jobs multiplies the token rate, which is what the pacing exists to hold down. Serial is
    # the default for that reason and not out of caution.
    print(f"estimate at 220 s/lake: {len(lakes) * 220 / max(a.jobs, 1) / 60:.0f} min"
          f"   (extraction paced to {a.tpm:,} input tokens/min)\n")

    t0 = time.perf_counter()
    done = [0]
    results = []

    # THE REPORT IS WRITTEN AFTER EVERY LAKE, NOT AT THE END.
    #
    # It used to be dumped once, when the whole run finished. On two lakes that is a couple of
    # minutes of nothing on disk; on the sixty-four-lake quarterly run it is an hour and a half
    # during which the only way to know anything is to watch the terminal -- which is the exact
    # problem the report was added to solve. Ryan drives this box over Chrome Remote Desktop.
    # A partial report is also what survives a run that dies in the middle.
    report_lock = threading.Lock()

    def flush_report(wall, partial):
        os.makedirs(os.path.dirname(a.report) or ".", exist_ok=True)
        tmp = a.report + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"worker": WORKER, "dry_run": a.dry_run, "wall_seconds": round(wall, 1),
                       "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
                       "in_progress": partial, "done": len(results), "of": len(lakes),
                       "results": results}, f, indent=2)
        os.replace(tmp, a.report)          # never leave a half-written report to be read

    def work(pair):
        name, st, alts = pair
        r = research_one(name, st, a.dry_run, a.verbose, a.repo, alts, a.tpm)
        done[0] += 1
        mark = "ok " if r["ok"] else "FAIL"
        secs = f'{r.get("seconds", 0):5.1f}s'
        # docs and facts are on the line because a cold run that quietly found no documents
        # looks exactly like a fast one, and the difference is the whole point of the batch.
        f = r.get("fetch") or {}
        got = f.get("html_ok", 0) + f.get("pdf_ok", 0)
        ktok = r.get("chars_sent", 0) / CHARS_PER_TOKEN / 1000
        detail = (f"{len(r['returned'])}/{len(r['asked']) or len(r['confirmed'])} species  "
                  f"{r['documents']} docs ({got} new, {f.get('reused', 0)} cached, "
                  f"{f.get('failed', 0)} failed)  {r['facts']} facts  ~{ktok:.0f}k tok"
                  + (f"  {r['retries']} retries" if r.get("retries") else ""))
        if r["missing"]:
            detail += "  LOST: " + ", ".join(r["missing"])
        print(f"  [{done[0]:3d}/{len(lakes)}] {mark} {secs}  {name[:42]:44s}{detail}"
              + (f"  -- {r['error']}" if r["error"] else ""))
        with report_lock:
            results.append(r)
            flush_report(time.perf_counter() - t0, True)
        return r

    if a.jobs > 1:
        with ThreadPoolExecutor(max_workers=a.jobs) as ex:
            list(ex.map(work, lakes))
    else:
        for p in lakes:
            work(p)

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
            print(f"  {r['lake']}: {len(r['returned'])} of "
                  f"{len(r['asked']) or len(r['confirmed'])} "
                  f"-- no block for {', '.join(r['missing'])}")
    dry = [r for r in ok if r["documents"] == 0]
    if dry:
        print(f"\n{len(dry)} water(s) ran on no documents at all -- the model had only the "
              f"deterministic profile:")
        for r in dry:
            f = r.get("fetch") or {}
            print(f"  {r['lake']}: {r.get('sources', 0)} sources discovered, "
                  f"{f.get('failed', 0)} failed to download, "
                  f"{r.get('rejected_offlake', 0)} dropped as off-lake")

    retried = [r for r in ok if r.get("retries")]
    if retried:
        total = sum(r["retries"] for r in retried)
        print(f"\n{total} group retr{'y' if total == 1 else 'ies'} across {len(retried)} water(s) "
              f"-- the provider pushed back and the backoff caught it. Rising numbers here mean "
              f"the per-lake load is still too high:")
        for r in retried:
            hard = {g: n for g, n in (r.get("group_attempts") or {}).items() if n > 1}
            print(f"  {r['lake']}: " + ", ".join(f"{g} x{n}" for g, n in hard.items()))

    gated = [r for r in ok if r.get("rejected_docs")]
    if gated:
        print(f"\nthe off-lake gate dropped documents on {len(gated)} water(s) "
              f"-- check these are actually off-lake:")
        for r in gated:
            print(f"  {r['lake']}: {len(r['rejected_docs'])} of "
                  f"{len(r['rejected_docs']) + r['documents']}")
            for d in r["rejected_docs"][:6]:
                print(f"      {str(d.get('title'))[:70]}  {str(d.get('url'))[:70]}")

    flush_report(wall, False)
    print(f"\nreport -> {a.report}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
