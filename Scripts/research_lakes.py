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
from collections import Counter
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
#
# THIS NUMBER IS THE AGENT'S PAYLOAD AND NOTHING ELSE. It bounded extraction as well until
# 2026-09-16, which is two different jobs sharing one constant -- the pattern this project keeps
# finding. Twelve is right for the agent: agents.js ranks by behaviour density and keeps eight, so
# sending twelve gives that ranker something to choose between without growing the prompt that has
# to reason. Twelve is wrong for extraction, which is one cheap call per document and has no reason
# to stop at twelve when discovery found twenty-seven.
LLM_DOC_LIMIT = 12
LLM_DOC_CHARS = 20000

# EXTRACTION READS EVERYTHING THAT SURVIVED THE GATE. 0 means no limit.
#
# Each document is its own /research/analyze-facts call, paced against the token budget below, and
# measured at ~4,000 characters a document that is about 1,000 input tokens each. Raising
# SOURCE_CAP to take every discovered source would have bought nothing while this stayed at twelve:
# the extra documents would have been fetched, gated, and then dropped one step before the only
# step that turns them into facts.
EXTRACT_DOC_LIMIT = 0

# research/extract.js slices every document to 150,000 characters before it builds the prompt,
# and lake-research-engine.js sends exactly that. This script was sending 200,000 -- 50,000
# characters uploaded on every extraction call for the Worker to throw away.
#
# NOW 20,000, AND THE REASON IS BLAST RADIUS RATHER THAN COST.
#
# Measured over six runs on 2026-09-16: 85 extraction calls, 341,278 characters sent, which is
# 4,015 characters per document. The 150,000 ceiling was being used at under three per cent, so
# lowering it changes nothing about what the extractor reads on an ordinary fishing article.
#
# What it bounds is the unusual one. RESEARCH_502S_ARE_ARITHMETIC counted a limnology run whose
# corpus held 419-, 317- and 274-page PDFs, every one of them hitting the 150,000 cap, and put
# 1.8 MB into a 128 MB isolate that concurrent requests share. That doc's own recommendation was a
# total budget across the batch; this is the same protection with one number instead of a new
# mechanism. Raising SOURCE_CAP below makes pulling such a PDF more likely, not less, so the bound
# goes in first.
#
# And 20,000 is not a guess: it is what agents.js already spends per document on the prompt that
# has to REASON about the text, decided there with the reasoning written down -- "a fishing report
# says everything useful about where fish sit in its first few thousand characters". Extraction
# reading seven times more than the agent does was the two-numbers-disagreeing pattern again.
EXTRACT_DOC_CHARS = 20000

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

# ── HOW MANY DISCOVERED SOURCES WE ARE WILLING TO READ ──────────────────────────────────────
#
# Ryan, 2026-09-16: *"are we discarding those before we have checked them for information or
# after?"* Before. The cap ran the moment discover returned, on a title, a url and a snippet cut to
# 400 characters -- so on the Congaree that night, seventeen of twenty-seven candidates were thrown
# out without a word of their text ever being fetched. Every cut AFTER this one reads the document
# first: the off-lake gate, the usable-length filter, and the behaviour-density ranking in
# agents.js, which is the best-informed cut in the chain. Only this one was blind.
#
# WHAT THE CAP WAS PROTECTING, COUNTED. Fetching is free -- download.js: "TinyFish primary (free)"
# -- and batches ten URLs per call. Extraction is the only spend, and six runs on 2026-09-16 used
# 152 requests and ~85,000 tokens across five keys whose pooled limits are 2,500 requests/day and
# 1.25M tokens/minute. Three and a half per cent of one day. There was no budget here to defend.
#
# WHAT IT COSTS TO LIFT IT. At ~25 requests per water the pooled daily ceiling is about 100 waters;
# reading everything discovery returns puts it near 38 requests, so about 65 waters a day. A full
# 355-water pass goes from roughly two days to four. Ryan took that trade for a permanent stop to
# discarding unread documents. For single-water work, which is how this is actually used, it costs
# nothing but wall clock.
#
# 0 MEANS NO CAP. Named rather than set to a large number, because a large number is a guess about
# how many sources discovery will ever return and this is a statement that we read what we find.
SOURCE_CAP = 0           # AGENT_SOURCE_CAPS.fisheries in lake-research-engine.js is the browser's
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
        # THE SIXTH ARGUMENT IS THE NAME WINDOW, AND THIS CALLER IS NOT THE WORKER.
        #
        # offLakeReason() scans the first 3,000 characters of a document for the water's name by
        # default, and that number is a Cloudflare free-plan CPU budget -- 10 ms per request, not
        # configurable, and exceeding it produced "Error: Worker exceeded CPU time limit" on
        # save-normalized in August. This gate runs in node on a desktop, where there is no such
        # ceiling, and it feeds an extractor that reads 20,000 characters per document. Passing the
        # Worker's budget here refused documents on a limit that does not apply to us: the first run
        # with SOURCE_CAP lifted dropped 13 of 36, including a Carolina Sportsman issue and a
        # Columbia Metro feature that both name the river past their opening pages.
        "m.prepareNormalizedDocuments(inp.documents, inp.lakeName, [], null, inp.altNames,"
        " m.LOCAL_NAME_WINDOW)));"
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
    """{name: {slug, bound_by, state, aliases}} for names the app already chose -- its own binding."""
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


def app_todo_names(repo, include_rivers=False):
    """
    The waters the Research tab shows under "Not researched yet" -- ASKED OF THE APP'S OWN CODE.

    Scripts/research_todo.mjs is populateResearchLakeDropdown() with the DOM taken out. It builds
    the access index from the live worker feeds, filters with PRESETS.research, reads
    /research/list and resolves with researchedNames -- the same modules in the same order.

    IT MUST BE TOLD ABOUT RIVERS. research_todo.mjs filters with PRESETS.research, whose
    `includeRivers` defaults to false, and this call did not forward the switch -- so
    `--todo --include-rivers` offered ZERO rivers and said nothing about it, which is the worst
    shape a filter can have. Caught 2026-09-23 reading the call before the 55-river batch, not
    after it. Same family as the first --todo run: the list is right only if it is asked the same
    question the caller was asked.

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
        argv = ["node", os.path.abspath(src), "--json", out_path]
        if include_rivers:
            argv.append("--rivers")
        proc = subprocess.run(argv,
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


# The Worker writes three kinds of line into `queryLog` and they deserve three fates.
#
# A FAILURE prints whether or not --verbose is on. A query that threw contributed zero sources and
# that is the difference between "quiet week on the river" and "the provider refused", which is the
# question the source count cannot answer.
#
# A PER-QUERY line -- the provider, the query, the result count -- prints under --verbose. That is
# the actual answer to why a run says 15 and the next says 23.
#
# A PER-RESULT line is counted and not printed. `found (score 7): <title>` fifteen times per query
# is what made this log worth ignoring, and it is already recoverable from the report JSON.
_LOG_PER_RESULT = ('off-lake (', 'below threshold (', 'found (score', 'merged tags for',
                   'citation rejected', 'citation skipped')
_LOG_FAILURE = ('failed', 'no valid page', 'no page found')


def discover_log_lines(query_log, verbose):
    """The lines of the Worker's discover log worth putting on screen, in order."""
    out, per_result = [], 0
    for raw in (query_log or []):
        line = " ".join(str(raw or "").split())
        if not line:
            continue
        low = line.lower()
        if any(t in low for t in _LOG_PER_RESULT):
            per_result += 1
        elif any(t in low for t in _LOG_FAILURE):
            out.append(f"!! discover: {line}")
        elif verbose:
            out.append(f"discover: {line}")
    if verbose and per_result:
        out.append(f"discover: {per_result} per-result line(s) not shown -- they are in the report")
    return out


def base_name(lake_name):
    """cleanLakeBaseName() in lake-research-engine.js. The county stamp is ours, not the water's.

    CORRECTED 2026-09-16: every parenthetical goes, not just the county one. This string is what
    /research/analyze-facts is told to match against DOCUMENT TEXT, and "Congaree River (to
    SC-601)" appears in no document ever written -- the Congaree ran ten good documents through
    the extractor and got zero facts back. 11 of 355 waters were in that state, 8 of them rivers.

    A name that IDENTIFIES A STORED OBJECT must be UNIQUE, which is why legacyStorageName() in
    Worker/research/keys.js still keeps "Saluda River (2)". A name that MATCHES DOCUMENT TEXT must
    be FINDABLE, which is what this one and lakeTerms() in js/utils/doc-relevance.js are for. One
    regex cannot do both jobs and this was the storage rule doing the matching one.
    """
    b = re.sub(r"\s*\([^)]*\)\s*", " ", str(lake_name or ""), flags=re.I)
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


# ── THE REGISTRY'S OWN RAMPS, SENT WITH THE REQUEST ─────────────────────────────────────────
#
# `handleResearchDeterministicFacts` prefers `body.ramps` over its own lookup and says exactly
# why: *"THE CLIENT'S LIST WINS, BECAUSE THE PIPELINE BOUND IT BY GEOMETRY... Re-deriving it here
# by name was always the weaker method; now it is only the fallback, for a caller that cannot
# send the registry's answer."*
#
# THIS SCRIPT WAS THAT CALLER, AND IT COULD SEND IT ALL ALONG. It posted `{lakeName, state}` and
# nothing else, so `clientRamps` was empty on every water of every batch and the weaker fallback
# is what actually ran -- 64 waters' worth. That fallback matches the raw feeds with
# `waterbodyMatchesLake()`, a substring test on the display name, and the same comment records
# what it costs: nineteen feed spellings for J. Strom Thurmond, none a substring of "j strom
# thurmond reservoir lincoln co ga sc", "ramps: 0" reported for a 41,000-acre reservoir the
# registry already had 168 ramps for.
#
# It costs coastal everything. A zone is named for its sound and the feeds name the creek, so no
# coastal zone can ever match by name -- which is why Georgia's four sounds reported no inshore
# species while GA WRD's own access points inside their boxes carry the Redfish, SeaTrout,
# Flounder and Sheepshead columns.
#
# SPECIES LIVE UNDER `meta`, AND THAT IS THE SECOND HALF. build_dnr_ramps_by_lake.py writes
# `{name, wb, type, src, lat, lon, meta: {species, county, owner, lanes}}` while the Worker reads
# `r.species` off the top level. Flattening here rather than teaching the Worker a second shape
# keeps one record shape on the wire; the Worker learns both anyway, because this script is not
# the only caller.
def registry_ramps(row):
    """Every ramp the registry already bound to this water, flat, for `body.ramps`."""
    out = []
    for _src, items in ((row or {}).get("ramps") or {}).items():
        for r in items or []:
            try:
                lat, lon = float(r["lat"]), float(r["lon"])
            except (KeyError, TypeError, ValueError):
                continue          # OSM per-lake records carry no coordinate; the Worker drops
                                  # those anyway, and a centroid guess is not a ramp.
            meta = r.get("meta") or {}
            out.append({"name": r.get("name") or r.get("wb") or "Unnamed access point",
                        "lat": lat, "lon": lon,
                        "lanes": r.get("lanes", meta.get("lanes")),
                        "county": r.get("county", meta.get("county")),
                        "owner": r.get("owner", meta.get("owner")),
                        "species": r.get("species") or meta.get("species") or ""})
    return out

def research_one(lake, state, dry_run=False, verbose=False, repo="TrollMap-Dev", alt_names=None,
                 tpm=DEFAULT_TPM, row=None, limnology_only=False):
    """One lake, start to saved profile. Returns a result dict; never raises."""
    t0 = time.perf_counter()
    out = {"lake": lake, "state": state, "aliases": list(alt_names or []),
           "ok": False, "species": 0, "saved": False, "error": None,
           "confirmed": [], "asked": [], "returned": [], "missing": [], "documents": 0,
           "facts": 0,
           "sources": 0, "fetch": {}, "rejected_offlake": 0, "rejected_docs": [],
           "wqp_records": 0, "limnology_gaps": [], "ramps_sent": 0,
           "chars_sent": 0, "retries": 0, "group_attempts": {}, "saved_key": None,
           "saved_version": None, "discovered_species": [], "warnings": [],
           "registry_slug": None, "registry_resolved_by": None, "registry_unresolved": None}

    ramps = registry_ramps(row)
    out["ramps_sent"] = len(ramps)
    # THE ROW THE APP ALREADY BOUND THIS NAME TO, when it bound it on evidence. See SLUG_BY_NAME.
    det_body = {"lakeName": lake, "state": state, "ramps": ramps}
    bound = SLUG_BY_NAME.get(lake.strip().lower())
    if bound:
        det_body["slug"] = bound
    code, det, err = _req("/research/deterministic-facts", det_body)
    if code != 200 or not det or not det.get("profile"):
        out["error"] = f"deterministic-facts {code}: {err or 'no profile'}"
        return out
    # THE RUN MAY ONLY CHANGE WHAT IT COMPUTED, and /research/deterministic-facts hands back a
    # profile built FROM SCRATCH -- deterministic.js line 21 is an empty skeleton. Saving that
    # document replaced the stored one, so every field the deterministic pass does not compute
    # was deleted by a run that never looked at it.
    #
    # MEASURED 2026-09-04 off the version history, 52 lakes with a real before-and-after:
    #
    #     Primary forage    43 of 52      Thermocline    34 of 52
    #     Trophic status    42 of 52      Stockings      32 of 52
    #     Secchi            40 of 52      Anoxic below   26 of 52
    #
    # Ryan: "the fact that the batch profiles are so slim scares me". It was not producing less,
    # it was asserting a whole document while authoring part of one -- the same defect that took
    # 46 verified stamps, one layer down.
    prev_profile, prev_why = stored_profile(lake)
    profile = carry_forward(prev_profile or {}, det["profile"])
    out["carried_forward"] = sorted(carried_keys(prev_profile or {}, det["profile"]))
    if out["carried_forward"]:
        print(f"      [{lake}] carried forward from the stored profile: "
              f"{', '.join(out['carried_forward'])}")
    species = ((profile.get("biology") or {}).get("predatorSpecies")) or []
    out["confirmed"] = list(species)
    # WHICH REGISTRY ROW THE ROSTER CAME OFF, AND WHETHER THERE WAS ONE. Before 2026-09-23 a name
    # that reached no row produced the same empty roster as a water with no fish on file, and the
    # run line said nothing; three rivers were researched blind that way with NC WRC's list for
    # each sitting in R2. It is said out loud now, and it is carried into the report.
    out["registry_slug"] = det.get("registrySlug")
    out["registry_resolved_by"] = det.get("registryResolvedBy")
    if det.get("registryUnresolved"):
        out["registry_unresolved"] = det["registryUnresolved"]
        print(f"      !! [{lake}] reaches no registry row -- every registry roster skipped. "
              f"The species this run finds are all it will have.")

    # ── THE MEASURED LIMNOLOGY, WHICH THIS SCRIPT WAS SAVING OVER THE TOP OF ────────────────
    #
    # The deterministic pass writes exactly one limnology field, `seasonalDrawdownFt`. Every
    # other one -- thermocline, the anoxic boundary, Secchi, trophic status -- comes from the
    # Water Quality Portal pull, and that pull lived only in the browser module this batch
    # replaced. `/research/save` builds its document from what it is sent, so running this
    # script deleted those numbers from all 64 waters. Measured on Wateree, 2026-09-02:
    # thermocline.summerDepthFt null, oxygen.anoxicBelowFt null, waterClarity.secchiFt null,
    # trophicStatus null, seasonalDrawdownFt 2.5.
    #
    # researchIntel() prints the first four into the plan prompt and clampToOxygen() squeezes the
    # depth band against the anoxic boundary, so the plan lost the two lines the code calls "the
    # two that decide where the fish can physically be" and the clamp stopped clamping.
    #
    # The endpoint owns the rule -- pull, 30-day cache, merge, and the list of fields the pull
    # could NOT answer. Nothing about limnology is decided here; this hands over the block and
    # stores what comes back. Ryan, 2026-09-02: "we need the wqp to be there so as to know
    # whether limnology information is needed to be pulled from the facts."
    code, wqp, err = _req("/research/limnology-data",
                          {"lakeName": lake, "base": profile.get("limnology") or {}})
    if code == 200 and wqp and wqp.get("merged"):
        profile["limnology"] = wqp["merged"]
        # Step 5 of the 2026-09-01 plan: the profile keeps the WQP block WITH ITS DATES. A
        # number whose sample date is 2017 and a number measured last week are different claims.
        profile["_wqpLimnology"] = {k: v for k, v in wqp.items()
                                    if k not in ("merged", "evidence", "gaps")}
        for section, fields in (wqp.get("evidence") or {}).items():
            ev = profile.setdefault("evidence", {}).setdefault(section, {})
            for field, rows in (fields or {}).items():
                ev[field] = list(ev.get(field) or []) + list(rows or [])
        out["wqp_records"] = wqp.get("recordCount") or 0
        out["limnology_gaps"] = list(wqp.get("gaps") or [])
    else:
        # NOT FATAL, AND NOT SILENT. A water WQP has never sampled must still produce a profile;
        # a water that has one and did not get it is a different thing and only the count says
        # which. Same argument as the species-traits note below.
        out["limnology_gaps"] = ["limnology.ALL"]
        print(f"      note [{lake}]: no WQP limnology "
              f"({(wqp or {}).get('error') or err or 'no merged block'}) "
              f"-- thermocline, anoxic depth, Secchi and trophic status will be blank in the plan")

    # ── DOCUMENTS AND THE MODEL — SKIPPED ENTIRELY BY --limnology-only ─────────────────────
    #
    # Ryan, 2026-09-12: "why not just add a flag that will run only limnology". The 2026-09-05 fix
    # that makes a WQP refusal travel to the field it refused left 28 profiles holding a bare null,
    # because the merge that wrote them predates it and the sweep is due on CACHE AGE alone. Pushing
    # those 28 through the full chain measured 193 s and ~58k tokens a lake -- 90 minutes and 1.6M
    # tokens to attach a sentence. Nothing below decides anything about limnology: that block is
    # settled by /research/limnology-data above, which also merges document_limnology.json.
    #
    # WHAT STILL RUNS: deterministic-facts, carry_forward, limnology-data, the stored status, the
    # save, and the local mirror. carry_forward() has preserved fields a run did not compute since
    # 2026-09-04, so a pass that skips the agent cannot cost this profile its species, forage or
    # trollingIntelligence -- AND THAT GUARANTEE IS THE ONLY REASON THIS FLAG IS SAFE. On a water
    # with no stored profile there is nothing to carry, so it refuses rather than saving a profile
    # with no biology in it.
    if limnology_only:
        if not prev_profile:
            out["error"] = ("--limnology-only on a water with NO stored profile would save one "
                            "with no biology at all -- run it without the flag first")
            return out
        # THE COUNT COMES OFF THE PROFILE, NOT OFF THE AGENT THAT DID NOT RUN. `out["species"]`
        # is assigned from the agent's response inside the else branch, so a limnology-only pass
        # printed "0/20 species" for a water whose profile holds twenty -- a summary line that
        # reads as data loss when nothing was lost. Ryan has one rule for this: a report must show
        # the change, not the output.
        out["limnology_only"] = True
        out["species"] = len(((profile.get("biology") or {}).get("predatorSpecies")) or [])
        out["returned"] = list(((profile.get("biology") or {}).get("predatorSpecies")) or [])
        out["warnings"] = list(out.get("warnings") or []) + [
            "limnology-only: discover, analyze-facts and agent-llm were skipped"]
        print(f"      [{lake}] --limnology-only: documents and the fisheries agent skipped")
    else:
        code, disc, err = _req("/research/discover",
                               {"lakeName": lake, "state": state, "agent": "fisheries",
                                "names": [lake], "predatorSpecies": species})
        if code != 200 or not disc or not disc.get("success"):
            out["error"] = f"discover {code}: {err or (disc or {}).get('error') or 'no sources'}"
            return out
        found = [s2 for s2 in (disc.get("sources") or [])
                 if not s2.get("agentTags") or "fisheries" in s2["agentTags"]]

        # Seeds (priority 1) always pass; the rest sort by prefetchScore. A source with no score
        # defaults to 3 so it is not cut for a field discovery did not set. SOURCE_CAP = 0 means we
        # take everything discovery found -- see the note at SOURCE_CAP for why the cap it replaces
        # was spending nothing to protect. The sort still runs, because order decides which
        # documents reach the agent's twelve even when nothing is dropped.
        seeds = [s2 for s2 in found if s2.get("priority") == 1]
        rest = sorted((s2 for s2 in found if s2.get("priority") != 1),
                      key=lambda s2: s2.get("prefetchScore", s2.get("score", 3)), reverse=True)
        sources = seeds + (rest if not SOURCE_CAP
                           else rest[:max(0, SOURCE_CAP - len(seeds))])
        out["sources"] = len(sources)
        if verbose:
            print(f"      discover: {len(found)} sources ({len(seeds)} seeds) -> {len(sources)}")

        # WHAT THE WORKER ALREADY WROTE DOWN AND NOTHING READ.
        #
        # handleResearchDiscover builds `queryLog` -- one line per query with the provider and its
        # result count, one per failure, one per recency fallback -- and returns it in the response.
        # The word `queryLog` appeared nowhere in this file, so "why does it say 15 sources one run
        # and 23 the next" had no answer on screen. Ryan asked exactly that, 2026-09-16, and the
        # honest answer was that some of the movement is a live index and some of it is a query that
        # threw, and the printed total cannot tell them apart.
        out["query_log"] = list(disc.get("queryLog") or [])
        for line in discover_log_lines(out["query_log"], verbose):
            print(f"      {line}")

        code, norm, err = _req(f"/research/get-normalized?lake={urllib.parse.quote(lake)}")
        existing = ((norm or {}).get("documents") or (norm or {}).get("docs") or []) if code == 200 else []

        fetched, out["fetch"] = fetch_sources(lake, sources, existing, verbose)

        # The off-lake gate, then back to R2 so the next quarter's run reuses the corpus instead of
        # paying for it again. Untouched cached docs are merged back in, the way runAgent does.
        #
        # FRESHLY FETCHED DOCUMENTS GO FIRST, AND THEY USED TO GO LAST.
        #
        # `chosen = usable[:LLM_DOC_LIMIT]` takes twelve. With cached documents ahead of fetched
        # ones, the twelve slots went to whatever an older run happened to store and the newest
        # documents were the first thing the limit cut. Measured on the Congaree, 2026-09-16, across
        # two runs either side of replacing the paddling query: the same eight sources both times,
        # and Paddle SC's Blue Trail went from 5 facts to 11. The query had changed and the corpus
        # had not, so nothing downstream could see the change.
        #
        # The stored corpus inherits this order, so it becomes recency-ordered too and the next run
        # starts from the newest rather than re-sorting. Nothing here deletes a cached document; a
        # stale one simply stops holding a slot a fresher one wants.
        if fetched:
            touched = {norm_url(d.get("url")) for d in fetched}
            merged = fetched + [d for d in existing if norm_url(d.get("url")) not in touched]
            prepared = gate_documents(repo, merged, lake, alt_names)
            out["rejected_offlake"] = prepared.get("rejected", 0)
            keep = prepared.get("documents") or []
            # NAME WHAT THE GATE DROPPED. A count says six documents did not survive; it does not say
            # whether the gate was right. On 2026-09-01 Lanier fetched nine and kept three, twice, and
            # there was no way to tell a correctly-rejected off-lake page from a Lake Lanier report
            # thrown out for not spelling itself "Sidney Lanier". The titles decide that in one read.
            # AND WHY, FROM THE GATE ITSELF. This used to difference the URL sets, which is a second
            # copy of a question prepareNormalizedDocuments() has already answered and could only ever
            # produce a title -- so "is the gate right" had to be settled by opening the pages by hand,
            # which on 2026-09-02 is exactly what it took for Randleman Lake and Parr Shoals Reservoir.
            # `why` is one of no_name, named_no_state or other_state, and named_no_state is the only
            # one worth arguing with.
            out["rejected_docs"] = prepared.get("refused") or []
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
        chosen = usable if not EXTRACT_DOC_LIMIT else usable[:EXTRACT_DOC_LIMIT]
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

        # ── THE SNIPPETS WE ALREADY PAID FOR ────────────────────────────────────────────────
        #
        # Ryan, 2026-09-16, on the source cap: *"are we discarding those before we have checked them
        # for information or after?"* Before -- and the snippets came back in the discover response
        # either way. Even with no cap, a source whose page fails to fetch, or that the off-lake gate
        # refuses, or that returns under 200 characters, still arrives here with 400 characters of
        # text that discovery already had in hand.
        #
        # Those 400 characters are not filler. Verbatim from searches on this water:
        #
        #   "Even on the lower end of the Congaree River, I focus on the deeper holes of water"
        #   "Use cut bait like shad or Herron on bottom... Saluda is the place to be after may"
        #   "Striped bass in the Congaree River will hold against tree lines and readily take
        #    live herring early in the day"
        #
        # A position, a bait, a season, a time of day. Complete facts, in text we fetched, scored,
        # logged and then dropped on the floor -- the same shape as every other defect found today.
        #
        # ONE CALL, NOT ONE PER SOURCE. The snippets are short enough to travel together, so this
        # costs a single request however many sources discovery returned. `docIndex` is -1 so a fact
        # from here is distinguishable downstream from one taken out of a fetched document.
        snippet_docs = [{"title": s2.get("title"), "url": s2.get("url"),
                         "text": str(s2.get("snippet") or "")}
                        for s2 in found if len(str(s2.get("snippet") or "")) >= 80]
        if snippet_docs:
            code, ex, err = _req("/research/analyze-facts", {
                "lakeName": lake, "baseName": base_name(lake), "state": state,
                "aliases": alt_names or [], "docIndex": -1,
                "targetFields": ["trollingIntelligence"],
                "documents": snippet_docs})
            if code == 200:
                got = (ex or {}).get("extracted_facts") or []
                facts.extend(got)
                out["snippet_facts"] = len(got)
                out["snippet_sources"] = len(snippet_docs)
                if verbose:
                    print(f"      snippets: {len(snippet_docs)} source(s) discovery returned "
                          f"-> {len(got)} fact(s) with no fetch")
            else:
                print(f"      warn [{lake}]: analyze-facts on snippets {code}: {err}")
                out["snippet_facts"] = 0
            out["chars_sent"] += sum(len(d["text"]) for d in snippet_docs)

        out["facts"] = len(facts)
        prev = dict(profile)
        prev["_extractedFacts"] = facts

        # THE FACTS ARE THE PAYLOAD, AND `prev` IS A COPY THAT NOTHING SAVES.
        #
        # `prev = dict(profile)` builds the agent's input. The object that reaches
        # /research/save is `profile`, so setting the facts only on the copy computes them
        # correctly and addresses them to nobody. Measured 2026-09-16: 72 of 79 stored
        # profiles carry no facts at all, and the seven that do were written by
        # lake-research-engine.js -- which has persisted them since it was written -- with
        # carry_forward() keeping those seven alive rather than any batch refreshing them.
        #
        # This is not a debug field. plan-prompt.js:874, smart-plan-v2.js:230 and
        # smart-plan-v2-wiring.js:270 all read `_extractedFacts` off the research profile to
        # build the plan prompt. Every water this script researched has been handing SmartPlan
        # nothing but registry floors.
        #
        # Empty never overwrites, for the reason carry_forward() gives: a run that extracted
        # nothing has not established that there is nothing. And the COUNT is not set here --
        # storage.js:292 derives it from the list, and a second writer for one number is how
        # the two copies end up disagreeing.
        if facts:
            profile["_extractedFacts"] = facts

        # A DERIVED NUMBER MUST NOT BE CARRIED FORWARD, OR IT OUTLIVES WHAT IT COUNTS.
        #
        # carry_forward() brings `_extractedFactsCount` over from the stored profile -- it is a
        # field the run did not compute, so the rule preserves it. storage.js:292 then reads
        # `incomingProfile._extractedFactsCount || (incomingProfile._extractedFacts||[]).length`,
        # so a carried 20 WINS over a fresh list of 35 and the profile ends up claiming a count
        # its own array contradicts. It only escaped notice on the Congaree because the stored
        # count was 0 and 0 is falsy.
        #
        # Dropping it is always right. Whichever facts reach the document -- the fresh ones
        # above, or the stored ones carry_forward kept -- the count derives from those, in the
        # one place that owns it.
        profile.pop("_extractedFactsCount", None)

        # `_normalizedDocuments` stays on the copy on purpose. The corpus already has its own
        # store via /research/save-normalized, south_holston_tn carries 137 facts and no
        # documents, and putting ten documents of full text into every profile would multiply
        # what R2 holds for a second copy of something already saved.
        prev["_normalizedDocuments"] = [
            {"title": d.get("title"), "url": d.get("url"),
             "text": str(d.get("fullText") or d.get("text") or "")[:LLM_DOC_CHARS]}
            for d in usable[:LLM_DOC_LIMIT]]

        # ── THE ONE CALL THAT CAN TIME OUT, AND IT USED TO END THE WATER ────────────────────
        #
        # 2026-09-23, three hours into the 33-river batch:
        #
        #     Ogeechee River, GA   agent-llm 0: The read operation timed out   10 documents
        #     Savannah River, GA   agent-llm 0: The read operation timed out   16 documents
        #
        # Both abandoned with saved=False after their documents had been discovered, fetched and
        # extracted -- the expensive part -- because `_req`'s 300 s default expired on the one
        # call that does the model work. Cape Fear finished the same batch in 774 s total, so
        # 300 s on this leg alone is inside the normal range, not outside it.
        #
        # `code == 0` IS A TRANSPORT FAILURE, NOT AN ANSWER. urllib returns 0 when nothing came
        # back at all; an HTTP status means the Worker replied and said no, which is a different
        # thing and must not be retried -- a 400 retried three times is three times the same
        # rejection. 502/504 are the proxy saying the same "nothing came back", so they ride
        # along. Everything else fails on the first reply, as before.
        #
        # The Worker ALREADY retries internally, per group, and reports it as `retries` -- which
        # means the runs most likely to exceed a client deadline are precisely the ones where it
        # is working hardest. A longer deadline is the fix; the attempts are the safety net.
        AGENT_LLM_TIMEOUT = 900
        AGENT_LLM_TRIES = 3
        code = res = err = None
        for attempt in range(1, AGENT_LLM_TRIES + 1):
            code, res, err = _req("/research/agent-llm",
                                  {"lakeName": lake, "state": state, "agent": "fisheries",
                                   "previousResults": prev},
                                  timeout=AGENT_LLM_TIMEOUT)
            if code == 200 and res:
                break
            if code not in (0, 502, 504):
                break
            out.setdefault("llm_attempts", []).append(f"{code}: {err}")
            if attempt < AGENT_LLM_TRIES:
                print(f"      [{lake}] agent-llm did not answer ({err}) -- attempt "
                      f"{attempt + 1} of {AGENT_LLM_TRIES}")
                time.sleep(20 * attempt)
        if code != 200 or not res:
            out["error"] = f"agent-llm {code}: {err}"
            return out
        section = res.get("section") or {}
        out["species"] = len(section)
        out["returned"] = [k for k in section.keys() if k != "sources"]
        out["warnings"] = list(out.get("warnings") or []) + list(res.get("warnings") or [])
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

    # DRAFT/VERIFIED IS RETIRED, 2026-09-23. This block used to read the stored status and echo
    # it back, because a batch must not assert a field it did not compute -- the rule still holds,
    # it just has nothing left to apply to here. Ryan: "that whole verify and draft thing is
    # dumb... i never looked at them anyways." Measured the same day: 54 of the 61 profiles
    # carrying `verified` held ZERO extracted facts, and the profile with the most facts on the
    # drive was a draft the app was throwing away. handleResearchSave now strips the four keys
    # from every profile it writes, so nothing here has to say anything about them.

    if dry_run:
        out["ok"] = True
        out["seconds"] = time.perf_counter() - t0
        return out

    payload = {"lakeName": lake, "profile": profile,
               "requestedBy": "research_lakes.py batch"}
    code, saved, err = _req("/research/save", payload)
    if code != 200:
        out["error"] = f"save {code}: {err}"
        return out
    # WHICH KEY IT LANDED ON AND WHAT VERSION IT BECAME. handleResearchSave resolves the id
    # before writing, so a lake that already had a profile is versioned rather than forked --
    # and version 1 means this water genuinely had nothing. That is the difference between a
    # batch that filled a gap and a batch that redid work, and it is one field.
    if out.get("registry_unresolved"):
        out["warnings"] = list(out.get("warnings") or []) + [
            f"no registry row for '{out['registry_unresolved']}' -- roster came from documents only"]
    out["saved_key"] = (saved or {}).get("key") or (saved or {}).get("id")
    out["saved_version"] = ((saved or {}).get("version")
                            or ((saved or {}).get("metadata") or {}).get("version"))
    out["ok"] = out["saved"] = True
    out["mirrored"] = mirror_locally(lake)
    out["seconds"] = time.perf_counter() - t0
    return out


# {lowercased display name: the registry row}, filled by load_lakes(). See
# registry_ramps() for why the row has to reach research_one().
ROWS_BY_NAME = {}

# {lowercased app name: registry slug}, filled from research_todo.mjs's own binding. ONLY WHEN THE
# ACCESS INDEX BOUND IT. registryRecordFor() answers a stripped name only when the feed's access
# points sit on that row's water; lakeRecordFor() falls back state-blind, and on 2026-09-23 it
# bound "Silver Lake, GA" and "Goose Creek, TN" to South Carolina lakes. A slug from that second
# path would hand the Worker a confident wrong answer where it now has an honest null, so it is
# not forwarded -- the Worker resolves the name itself and says so if it cannot.
SLUG_BY_NAME = {}


def remember_slugs(rows):
    """Fill SLUG_BY_NAME from research_todo.mjs rows, trusting only the evidenced binding."""
    for r in rows or []:
        name, slug = (r or {}).get("name"), (r or {}).get("slug")
        if name and slug and r.get("bound_by") == "access-index":
            SLUG_BY_NAME[name.strip().lower()] = slug


# The registry folder, so a saved profile can be mirrored onto the drive. Set in main() rather
# than threaded through research_one()'s call chain, exactly like ROWS_BY_NAME above.
REGISTRY_DIR = ""


EMPTY = (None, "", [], {}, ())


def carry_forward(stored, fresh):
    """`fresh` wins wherever it has a value; `stored` survives everywhere else.

    Not a blind update: a dict is merged key by key so a fresh `limnology` carrying only a
    thermocline cannot delete the Secchi beside it. A value the run did not compute is EMPTY --
    None, "", [] or {} -- and empty never overwrites, because "I did not look" and "there is
    nothing there" are different claims and only one of them belongs in a stored profile.
    """
    if isinstance(stored, dict) and isinstance(fresh, dict):
        out = dict(stored)
        for k, v in fresh.items():
            out[k] = carry_forward(stored.get(k), v) if isinstance(v, dict) else v
            if v in EMPTY and k in stored and stored[k] not in EMPTY:
                out[k] = stored[k]
        return out
    if fresh in EMPTY:
        return stored
    return fresh


def carried_keys(stored, fresh, path=""):
    """Which top-level sections kept something the fresh document did not carry. For the run line."""
    out = set()
    if not isinstance(stored, dict):
        return out
    for k, v in stored.items():
        if v in EMPTY:
            continue
        f = fresh.get(k) if isinstance(fresh, dict) else None
        if f in EMPTY:
            out.add(path + k)
        elif isinstance(v, dict) and isinstance(f, dict):
            out |= carried_keys(v, f, path + k + ".")
    return out


def stored_profile(lake_name):
    """(profile, why). What R2 already holds for this water, or None with a reason.

    It used to serve two callers -- the stored status and the document the run must not clobber.
    The status is retired; the document is still the reason this read happens before the save.

    "no profile yet" is a clean 404 and means version 1.
    """
    code, data, err = _req("/research/get?lake=" + urllib.parse.quote(lake_name))
    if code == 404:
        return None, "no profile yet"
    if code != 200 or not data or not data.get("ok"):
        return None, err or ("HTTP %s" % code)
    return (data.get("profile") or {}), "stored"


def mirror_locally(lake_name):
    r"""Write the profile that was just saved into registry\_research_profiles\<id>.json.

    WHY THE SAVE IS NOT ENOUGH ON ITS OWN. Until 2026-09-04 a profile existed in exactly one
    place -- R2 -- and three things followed from that: build_data_map.py had to stamp the fifth
    kind of place `not_countable_offline`, so every species count taken on this machine counted
    the drive and called it the app; the per-field evidence that says WHERE a species came from
    was unreadable, so "the Parr smallmouth came in from somewhere -- where?" had no answer here;
    and an R2 prune would have taken an hour of model time per lake with it, unrecoverably.

    IT RE-READS RATHER THAN WRITING WHAT IT SENT. handleResearchSave merges evidence and stamps
    the version, so the object in the bucket is not the object this script posted. A mirror that
    is not the stored bytes is worse than no mirror, because it would be believed.

    NEVER FAILS THE RUN. A research pass that succeeded and could not be mirrored is still a
    research pass that succeeded; the mirror is caught up by mirror_research_profiles.py.
    """
    if not REGISTRY_DIR:
        return None
    try:
        import mirror_research_profiles as MIRROR
    except ImportError:
        print("   (no local mirror: mirror_research_profiles.py is not beside this script)")
        return None
    try:
        code, data, err = _req("/research/get?lake=" + urllib.parse.quote(lake_name))
        if code != 200 or not data or not data.get("ok"):
            print("   (no local mirror for %s: %s)" % (lake_name, err or "HTTP %s" % code))
            return None
        sid = MIRROR.safe_id(data.get("sanitized"))
        profile = data.get("profile")
        if not sid or profile is None:
            print("   (no local mirror for %s: unusable id %r)" % (lake_name, data.get("sanitized")))
            return None
        out_dir = os.path.join(REGISTRY_DIR, MIRROR.OUT_DIRNAME)
        os.makedirs(out_dir, exist_ok=True)
        fp = os.path.join(out_dir, sid + ".json")
        with io.open(fp, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(profile, indent=1, ensure_ascii=False) + "\n")
        return fp
    except Exception as e:                                    # noqa: BLE001
        print("   (no local mirror for %s: %s)" % (lake_name, e))
        return None


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
    # Keyed exactly like alt_names, so a name that resolves to aliases resolves to its row too.
    # A map rather than a fourth tuple element because --todo, --from-report and --lake each
    # build that tuple in their own branch and a fourth field would have to be added to all of
    # them and kept in step.
    ROWS_BY_NAME.clear()
    for slug, row in idx.items():
        name = row.get("display_name") or row.get("name") or slug
        legacy = row.get("legacy_display_names")
        if legacy is None:
            legacy = [row["legacy_display_name"]] if row.get("legacy_display_name") else []
        names = [row.get("name"), row.get("display_name"), *legacy]
        alt_names[name.strip().lower()] = [n for n in dict.fromkeys(names) if n]
        ROWS_BY_NAME[name.strip().lower()] = row

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
        rows = app_todo_names(args.repo, getattr(args, "include_rivers", False))
        remember_slugs(rows)
        if not rows:
            print("nothing to research -- every water the tab offers already has a profile")
        return [(r["name"], args.state or r.get("state") or "SC", r.get("aliases") or [r["name"]])
                for r in rows]
    if getattr(args, "needs_limnology", False):
        # WATERS WHOSE STORED PROFILE HOLDS A NULL THERMOCLINE WITH NO REASON BESIDE IT.
        #
        # Ryan, 2026-09-14: "fix it so that it runs what needs to run". The list was being pasted
        # as thirty --lake lines, which is a stale list the moment one of them is filled, and the
        # answer to "which waters still need this" belongs in the program that acts on it.
        #
        # A NULL WITH NO REASON IS THE TARGET, not a null. "We asked and the data cannot answer"
        # and "nobody has asked" are different claims: the first is an answer and the second is
        # work. So a water drops out of this list the moment it gets EITHER a depth or a reason,
        # which means the list shrinks on its own and empty means done.
        #
        # THE MIRROR IS THE SOURCE, and it can be stale -- research_lakes.py writes it on every
        # save and mirror_research_profiles.py syncs it from R2, so the run says how old it is
        # rather than assuming. Reading R2 per water instead would be one network call per water
        # to decide whether to make a network call for that water.
        import glob as _glob
        prof_dir = os.path.join(args.registry, "_research_profiles")
        files = [p for p in sorted(_glob.glob(os.path.join(prof_dir, "*.json")))
                 if not p.endswith("_manifest.json")]
        if not files:
            print(f"!! no mirrored profiles under {prof_dir} -- run mirror_research_profiles.py")
            return []
        newest = max(os.path.getmtime(p) for p in files)
        age_h = (time.time() - newest) / 3600.0
        by_display = {}
        for _slug, _row in idx.items():
            _dn = (_row.get("display_name") or _row.get("name") or _slug).strip().lower()
            by_display[_dn] = (_row.get("display_name") or _row.get("name") or _slug, _row)
        # THE SERVED OBJECT, read once. Missing is not fatal: with nothing to compare against, every
        # profile's note is as good as it is going to get, and an empty list is the honest answer
        # rather than selecting all of them.
        DOC_LIMNO = {}
        _dl = os.path.join(args.registry, "document_limnology.json")
        if os.path.exists(_dl):
            try:
                with open(_dl, encoding="utf-8") as _f:
                    _parsed = json.load(_f)
                DOC_LIMNO = _parsed.get("waters") or _parsed or {}
            except Exception as _e:
                print(f"!! unreadable {_dl}: {_e} -- nothing can be compared against it")
        else:
            print(f"!! no {_dl} -- build it with build_document_limnology.py --go")
        picked, unbound, has_reason, has_value, superseded = [], [], 0, 0, 0
        for p in files:
            try:
                with open(p, encoding="utf-8") as f:
                    prof = json.load(f)
            except Exception as e:
                print(f"!! unreadable mirror {os.path.basename(p)}: {e}")
                continue
            th = ((prof.get("limnology") or {}).get("thermocline") or {})
            if not isinstance(th, dict):
                continue
            if th.get("summerDepthFt") is not None:
                has_value += 1
                continue
            # RESOLVED HERE -- after the depth check and before the note is judged.
            #
            # After, because the document is keyed by registry slug while the mirror is named by
            # research id, and a water that already carries a depth needs neither. Putting it FIRST
            # took the unbound report from 5 profiles to 15: it began naming profiles that were
            # finished and were never going to be picked, which is noise in a list whose whole job
            # is to say what still needs work.
            #
            # Before, because the note test below has to ask the document what it offers. The
            # unbound mirrors are NAMED rather than dropped: --lake could not resolve them either,
            # and dropping them silently is how "34 need this" and "29 ran" stop agreeing.
            nm = (prof.get("lakeName") or "").strip()
            hit = by_display.get(nm.lower())
            if not hit:
                unbound.append(nm or os.path.basename(p))
                continue
            slug_for_doc = (hit[1] or {}).get("slug")
            # A REASON FROM THE WRONG SOURCE IS NOT THIS WATER'S REASON, AND THE TEST IS EXACT.
            #
            # `if th.get("note"): continue` treated any sentence as done. On 2026-09-15 four waters
            # held a WQP SURFACE-GRAB refusal in that slot -- "these are surface grabs with a depth
            # stamp, not a vertical profile" -- while the pipeline held a real vertical cast for
            # each. build_document_limnology was dropping the cast's own note and the Worker's
            # accept-check was discarding a note-only merge, so the weaker sentence won the slot.
            #
            # THE FIRST FIX USED A PROXY AND THE PROXY WAS WRONG. It asked whether the note named a
            # gradient in C/m, on the theory that every cast refusal does. National Lakes Assessment
            # notes do; National Eutrophication Survey notes do not -- "only 3 temperature readings
            # in the cast; 4 needed", "the 8 readings that survived the scan show no layer". So
            # Murray and Secession stayed selected after they were already fixed, and Monticello --
            # whose oxygen comes off a lake-program statement, with no thermocline cast at all --
            # would have been selected forever. A selector that never empties is a lying counter,
            # and Ryan set the rule for this flag on 2026-09-14: empty means done.
            #
            # SO ASK THE DOCUMENT DIRECTLY. The served object sits in this same registry folder, and
            # "is this profile carrying what the cast says" has an exact answer that needs no
            # heuristic. A profile whose note already matches its document is done. A profile whose
            # document offers no note is done too -- there is no run that would change it.
            doc_note = None
            if slug_for_doc:
                doc_note = (str((DOC_LIMNO.get(slug_for_doc) or {}).get("thermoclineNote") or "")
                            .strip() or None)
            note = str(th.get("note") or "").strip() or None
            if doc_note is None or doc_note == note:
                has_reason += 1
                continue
            if note:
                superseded += 1
            name = hit[0]
            picked.append((name, args.state or hit[1].get("state") or "SC",
                           alt_names.get(name.strip().lower()) or [name]))
        print(f"limnology: {has_value} water(s) already carry a depth, {has_reason} carry a reason, "
              f"{len(picked)} need a run")
        if superseded:
            print(f"           of those {superseded} DO carry a reason -- it just is not the one "
                  f"the cast gives, which document_limnology.json now holds for them")
        print(f"           read from {prof_dir} ({len(files)} profiles, newest "
              f"{age_h:.1f} h old)")
        if age_h > 48:
            print("           !! that mirror is over two days old -- "
                  "mirror_research_profiles.py refreshes it from R2 before this decides anything")
        if unbound:
            print(f"           {len(unbound)} profile(s) SKIPPED -- lakeName matches no water the "
                  f"app offers, so --lake could not resolve them either:")
            for nm in unbound:
                print(f"              - {nm}")
        if not picked:
            print("nothing to do -- every bound profile has a thermocline depth or a stated reason")
        return picked

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
        remember_slugs(resolved.values())
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
        # PRESETS.research in js/data/water-filter.js, mirrored rather than reinvented:
        #
        #     keep: (rec, { bath, isCoastal, isRiver, acres }, cfg) => {
        #       if (isCoastal) return true;
        #       if (isRiver && !cfg.includeRivers) return false;
        #       return bath !== 'no' && acres >= (cfg.minAcres ?? 1000);
        #     }
        #
        # IT SAID IT MIRRORED THAT AND IT INVERTED THE FIRST LINE. `feature_type != "lake"` plus
        # `slug.startswith("coast_")` excluded the coastal zones the preset admits before it looks
        # at anything else -- and the preset's own label says why it is written that way: Ryan
        # asked for a filter "mainly for coastal and large impoundments". So the batch has never
        # offered a coastal zone, and the sixteen have profiles only because they were researched
        # from the browser tab one at a time.
        #
        # Two rules, not three: coastal passes on being coastal, a river needs the switch, and
        # everything else is judged on acreage. `bath !== 'no'` has no mirror here -- the browser
        # reads it off the bathymetry census and the registry row does not carry it -- so a water
        # with no soundings can still be offered by the batch and is refused later by the run.
        ftype = str(row.get("feature_type") or "").lower()
        is_coastal = ftype == "coastal" or slug.startswith("coast_")
        is_river = ftype == "river"
        if not is_coastal:
            if is_river and not args.include_rivers:
                continue
            if (row.get("area_acres") or 0) < args.min_acres:
                continue
        name = row.get("display_name") or row.get("name") or slug
        out.append((name, row.get("state") or "SC", alt_names.get(name.strip().lower(), [])))
    out.sort(key=lambda p: p[0])
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--registry", default="registry", help="folder holding lake_index.json")
    ap.add_argument("--include-rivers", action="store_true",
                    help="offer rivers too. Off by default, mirroring PRESETS.research's "
                         "includeRivers:false. THE REASON FOR THAT DEFAULT EXPIRED ON 2026-09-03: "
                         "it was 'the research questions are lake questions', and the fisheries "
                         "agent now takes river framing -- discharge instead of pool elevation, "
                         "current seams and shoals instead of brush piles, a release schedule as "
                         "the timing input -- from Worker/research/water-type-hints.js. What is "
                         "still thin is the species baseline: 15 of 58 rivers have one, and only "
                         "4 have an agency page. The default is unchanged because flipping it "
                         "changes what a batch spends; the switch is the decision, not a bug. "
                         "Coastal zones are NOT behind this switch; the preset admits them "
                         "unconditionally.")
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
    ap.add_argument("--needs-limnology", action="store_true",
                    help="run exactly the waters whose stored profile holds a null thermocline "
                         "with no reason beside it, read from the mirrored profiles. Implies "
                         "--limnology-only: selecting waters whose limnology needs re-merging and "
                         "then paying for the document chain makes no sense. The list re-derives "
                         "every run, so it shrinks on its own and empty means done.")
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
    ap.add_argument("--limnology-only", action="store_true",
                    help="deterministic facts + WQP/document limnology + save, and nothing else. "
                         "Seconds and no model calls instead of ~193 s and ~58k tokens. For "
                         "re-merging a profile after the limnology rule changed. Refuses a water "
                         "with no stored profile.")
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

    global REGISTRY_DIR
    REGISTRY_DIR = a.registry
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

    if a.needs_limnology and not a.limnology_only:
        a.limnology_only = True
        print("--needs-limnology implies --limnology-only (documents and the agent are skipped)")

    def work(pair):
        name, st, alts = pair
        r = research_one(name, st, a.dry_run, a.verbose, a.repo, alts, a.tpm,
                         ROWS_BY_NAME.get(name.strip().lower()), a.limnology_only)
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
    # A STAGE THAT WAS SKIPPED BY REQUEST IS NOT A STAGE THAT FOUND NOTHING.
    #
    # `documents` is assigned inside the branch --limnology-only skips, so it is 0 on every
    # limnology-only water and all 29 of them landed in this list on 2026-09-14 under the heading
    # "ran on no documents at all -- the model had only the deterministic profile". No model ran at
    # all. Same defect as the "0/20 species" line above it, and the same rule: a report must show
    # the change, not the output.
    lim_only = [r for r in ok if r.get("limnology_only")]
    if lim_only:
        print(f"\n{len(lim_only)} water(s) ran --limnology-only: documents and the fisheries agent "
              f"were skipped by request, so the species, document and source counts above are not "
              f"about them.")
    dry = [r for r in ok if r["documents"] == 0 and not r.get("limnology_only")]
    if dry:
        print(f"\n{len(dry)} water(s) ran on no documents at all -- the model had only the "
              f"deterministic profile:")
        for r in dry:
            f = r.get("fetch") or {}
            print(f"  {r['lake']}: {r.get('sources', 0)} sources discovered, "
                  f"{f.get('failed', 0)} failed to download, "
                  f"{r.get('rejected_offlake', 0)} dropped as off-lake")

    # WHICH WATERS HAVE NO MEASURED LIMNOLOGY, AND WHAT THE DOCUMENTS WOULD HAVE TO ANSWER.
    #
    # This is the line that would have caught the 2026-09-01 regression on the day it happened:
    # 64 waters saved with a null thermocline and nothing on screen saying so. A gap here is not
    # a failure -- WQP genuinely has not sampled some of these -- it is the list of fields the
    # extraction pass is the only remaining source for.
    dryw = [r for r in ok if not r.get("wqp_records")]
    if dryw:
        print(f"\n{len(dryw)} water(s) came back with no WQP limnology -- thermocline, anoxic "
              f"depth, Secchi and trophic status are blank in their plans:")
        for r in dryw:
            print(f"  {r['lake']}")
    gapped = [r for r in ok if r.get("wqp_records") and r.get("limnology_gaps")]
    if gapped:
        every = Counter(g for r in gapped for g in r["limnology_gaps"])
        print(f"\n{len(gapped)} water(s) have WQP data with gaps in it -- "
              + ", ".join(f"{n} missing {g.split('.')[-1]}" for g, n in every.most_common())
              + ".\nThese are the limnology fields a document is the only source for.")

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
        why_all = Counter(d.get("why") or "?" for r in gated for d in r["rejected_docs"])
        print(f"\nthe off-lake gate dropped documents on {len(gated)} water(s) -- "
              + ", ".join(f"{n} {w}" for w, n in why_all.most_common())
              + ".\nno_name is almost never worth arguing with; named_no_state is the one that "
                "is, because a local page about a water often never repeats its state:")
        for r in gated:
            print(f"  {r['lake']}: {len(r['rejected_docs'])} of "
                  f"{len(r['rejected_docs']) + r['documents']}")
            for d in sorted(r["rejected_docs"], key=lambda x: x.get("why") != "named_no_state")[:6]:
                print(f"      [{str(d.get('why'))[:14]:14s}] {str(d.get('title'))[:56]}  "
                      f"{str(d.get('url'))[:64]}")

    flush_report(wall, False)
    print(f"\nreport -> {a.report}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
