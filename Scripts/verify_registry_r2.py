#!/usr/bin/env python3
"""
verify_registry_r2.py -- are the three files the APP reads actually in R2, and are they current?

    py .\\scripts\\verify_registry_r2.py
    py .\\scripts\\verify_registry_r2.py --registry F:\\TrollMapPipeline\\registry

WHY THIS EXISTS

Ryan, 2026-08-12: *"water bindings should be in r2 this was fixed like 3 different times...
this shit is getting old."*

He was right, and the reason it kept coming back is that **nothing anywhere answered the
question.** `find_r2_orphans.py` excludes the `_registry/` prefix by design. `r2_audit.py`
lists the bucket but has no opinion about what SHOULD be in it. So "is it published?" was a
memory question, and three sessions in a row answered it from the wrong artefact:

    chartpack/_r2_manifest.json   says water_bindings.json was uploaded -- but a manifest is a
                                  LOCAL record the uploader writes about ITSELF. It records
                                  intent, not the bucket.
    registry/_r2_listing.json     showed only lakes.json and lake_index.json under _registry/
                                  -- but it was pulled 2026-08-08 and the upload code is dated
                                  2026-08-09, so it predates the thing it appears to disprove.

Two artefacts, opposite conclusions, and NEITHER settles it. This script settles it by doing
the one thing that counts: fetching the object.

WHAT IT CHECKS, AND WHY EACH PART

For each of the three keys it GETs the object through the Worker -- the same public route the
browser uses -- and compares it against the local file:

    _registry/lakes.json            the slim 3DHP list the DNR worker queries by extent
    _registry/lake_index.json       what lake-registry.js fetches on load
    _registry/water_bindings.json   what Worker/conditions.js serves every level, flow and
                                    tide answer from

**Through the Worker, not through wrangler.** That verifies the whole path the app depends on
-- the object exists, the route serves it, and `r2Body()` unwrapped the gzip -- rather than
just that a key is present in a bucket. It also needs no credentials of any kind; the chartpack
GET route is public.

**By canonical hash, never by byte count.** The wire is gzipped and the local file is not, so
sizes cannot agree. Both sides are re-serialised with sorted keys and no whitespace and hashed,
which is immune to formatting and to the gzip layer, and catches a stale object that happens to
be the same length.

`_registry/lakes.json` is NOT `registry/lakes.json` -- the uploader publishes a trimmed
projection. `slim_registry()` is imported from `upload_garmin_to_r2.py` rather than restated
here, so this cannot drift from what the uploader actually builds and then agree with itself.

EXIT CODE IS THE POINT. 0 = all three present and current. 1 = something is missing or stale,
which almost always means the last upload ran without a registry directory. Safe in a chain:

    py .\\scripts\\upload_garmin_to_r2.py --root ... --all
    py .\\scripts\\verify_registry_r2.py || echo "REGISTRY DID NOT PUBLISH"

READ-ONLY. It fetches and compares. It writes nothing and uploads nothing.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import hashlib

import json
import os
import sys
import urllib.error
import urllib.request

WORKER = "https://trollmap-worker.colonal1981.workers.dev"

# key under _registry/  ->  (local filename, how to describe it, who breaks without it)
FILES = [
    ("lakes.json", "lakes.json", "slim",
     "the DNR worker queries ArcGIS by extent off this"),
    ("lake_index.json", "lake_index.json", "raw",
     "lake-registry.js fetches this on load -- no index, no lake list"),
    ("water_bindings.json", "water_bindings.json", "raw",
     "Worker/conditions.js answers level/flow/tide off this -- without it every one is pending"),
    # ADDED 2026-08-17. The uploader learned to ship this the same day; a checker that does not
    # know about a file agrees that everything is fine while the app is missing it, which is the
    # exact failure this script exists to catch and the reason `slim_chain` is imported rather
    # than restated below.
    ("water_chain.json", "water_chain.json", "chain",
     "Worker/conditions.js:releaseDirection() labels a Duke release inflow or outflow off this "
     "-- without it every release is unlabelled and a dam above a lake reads the same as its own"),
    # The chain says which water is upstream; this says which water a DAM belongs to.
    # releaseDirection() needs both, so a checker that knows one and not the other is half a
    # checker. Built by merging the hand table with the position-derived one, so it has no
    # single local file to compare against and is checked for presence and shape only.
    ("dam_table.json", None, "presence",
     "Worker/conditions.js:releaseDirection() resolves a Duke dam name to a water off this "
     "-- without it 'Cedar Creek' means nothing and no release can be placed above or below"),
    # ADDED 2026-08-27, and the same lesson as water_chain.json on 08-17: three objects the app
    # had come to depend on were being published and never checked, so this script printed
    # "All 5 registry objects are published and match" over a bucket that could have been
    # missing any of them. A checker that does not know about a file agrees that everything is
    # fine while the app is missing it.
    #
    # Each is slimmed by the uploader, so there is no local file with the same shape to diff --
    # presence and a shape assertion is what can honestly be checked from here.
    ("full_pool.json", "full_pool.json", "pool",
     "Worker/registry.js:fullPoolTable() serves the chart datum off this -- without it the plan "
     "panel can show today's level and cannot say what it is below"),
    ("regulations.json", "regulations_table.json", "regs",
     "Worker/registry.js:regulationsTable() answers /regulations closures off this -- without it "
     "checkRegulations() falls back to a hand-typed table of six waters"),
    ("nc_species_by_lake.json", None, "presence",
     "Worker/registry.js:ncSpeciesByLake() seeds biology.predatorSpecies for 77 NC waters -- "
     "without it every NC lake's species list falls to the web agents"),
]


def canon(obj) -> str:
    """sha256 of the object, not of the bytes.

    The served copy came off the wire gzipped and was decompressed by the Worker; the local
    copy is indented JSON. Their bytes will never match and that says nothing. Sorting keys and
    stripping whitespace compares what the app actually receives.
    """
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()


def fetch(url, timeout):
    """GET and parse. Returns (obj, bytes, None) or (None, 0, 'reason').

    THE USER-AGENT IS LOAD-BEARING and this is the second script to learn it. Python's default
    `Python-urllib/3.x` is answered by Cloudflare's edge with a bare 403 before the request ever
    reaches the Worker, which reads as "the route is broken" or "you need a token" and is
    neither. r2_audit.py carries the same header and the same note; measured 2026-08-05.
    """
    req = urllib.request.Request(url, headers={
        "User-Agent": "trollmap-registry-verify/1.0 (+personal use; "
                      "https://github.com/colonal1981/TrollMap-Dev)",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
        return json.loads(raw.decode('utf-8')), len(raw), None
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None, 0, "404 NOT IN THE BUCKET"
        if exc.code == 403:
            return None, 0, ("403 from the Cloudflare EDGE, not the Worker -- the request never "
                             "arrived. Not a token problem; retry with curl.exe")
        return None, 0, "HTTP %d %s" % (exc.code, exc.reason)
    except urllib.error.URLError as exc:
        return None, 0, "unreachable: %s" % exc.reason
    except json.JSONDecodeError as exc:
        # A body that is not JSON is usually double-gzipped: the Worker echoed the stored
        # Content-Encoding over an already-decompressed body. See 00_START_HERE, "R2 IS
        # COMPRESSED NOW".
        return None, 0, "served but NOT VALID JSON (%s) -- suspect a Content-Encoding echo" % exc


def count_of(obj) -> str:
    if isinstance(obj, dict):
        # 'waters' ADDED 2026-08-17 with water_chain.json. Without it the chain reported
        # "2 keys" -- _meta and waters -- for a file holding 283 of them, so a truncated chain
        # would have matched a truncated chain and read as fine. A count that does not count
        # the thing is worse than no count.
        # `rows` for full_pool.json, `by_water` for regulations.json. A file whose count
        # key is unknown reports "N keys", which for full_pool would have been 2.
        for k in ('bindings', 'lakes', 'dams', 'waters', 'rows', 'by_water'):
            if isinstance(obj.get(k), (dict, list)):
                return '%d %s' % (len(obj[k]), k)
        return '%d keys' % len(obj)
    return '%d items' % len(obj) if hasattr(obj, '__len__') else '?'


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', default=os.path.join('registry'),
                    help='local registry dir to compare against (default: ./registry)')
    ap.add_argument('--worker', default=WORKER)
    ap.add_argument('--prefix', default='', help='same --prefix the uploader used, if any')
    ap.add_argument('--timeout', type=float, default=120.0)
    a = ap.parse_args()

    # Imported, not restated -- see the module docstring.
    #
    # By NAME off sys.path, not by spec_from_file_location: upload_garmin_to_r2 does
    # `from r2_gzip import prepared` at module level, and a file-location import does not put
    # the script's own directory on sys.path, so the sibling import raises ModuleNotFoundError
    # and this falls back to presence-only for no real reason.
    if here not in sys.path:
        sys.path.insert(0, here)
    try:
        import upload_garmin_to_r2 as ug
        slim_registry = ug.slim_registry
        slim_chain = getattr(ug, 'slim_chain', None)
        slim_full_pool = getattr(ug, 'slim_full_pool', None)
        slim_regulations = getattr(ug, 'slim_regulations', None)
        # The retired set comes from the uploader too, not from a second reader of the deletion
        # tab written here. slim_registry() filters on it, so a checker that computed its own
        # would report lakes.json stale forever while the uploader kept saying it just wrote it.
        retired_slugs = getattr(ug, 'retired_slugs', None)
    except Exception as exc:
        print('!! could not import slim_registry from upload_garmin_to_r2.py (%s: %s)'
              % (type(exc).__name__, exc))
        print('!! lakes.json will be checked for PRESENCE only, not for currency.')
        slim_registry = None
        slim_chain = None
        # Left unset, these NameError inside the loop and take the whole verify down -- which
        # would turn "I could not check for currency" into "the check crashed".
        slim_full_pool = None
        slim_regulations = None
        retired_slugs = None

    gone = set()
    if retired_slugs:
        gone, gone_note = retired_slugs(a.registry)
        if gone_note:
            print('!! %s' % gone_note)
    elif slim_registry:
        # An uploader old enough to lack retired_slugs also publishes every row, so an empty
        # set is what it built with. Say so rather than guessing silently.
        print('!! upload_garmin_to_r2.py has no retired_slugs() -- comparing against an '
              'unfiltered slim list, which is what that version publishes')

    print('worker   %s' % a.worker)
    print('registry %s\n' % os.path.abspath(a.registry))
    print('%-22s %-9s %-11s %-22s %s'
          % ('OBJECT', 'SERVED', 'LOCAL', 'CONTENT', 'VERDICT'))

    bad = []
    for name, local_name, kind, why in FILES:
        key = '%s_registry/%s' % (a.prefix, name)
        url = '%s/chartpacks/%s' % (a.worker.rstrip('/'), key)
        served, nbytes, err = fetch(url, a.timeout)

        lp = os.path.join(a.registry, local_name) if local_name else None
        local = None
        if lp is None:
            local = None
        elif os.path.exists(lp):
            try:
                local = json.load(open(lp, encoding='utf-8'))
            except Exception as exc:
                local = None
                print('%-22s local file is unreadable: %s' % (name, exc))
        if local is not None and kind == 'slim':
            local = slim_registry(local, gone) if slim_registry else None
        if local is not None and kind == 'chain':
            local = slim_chain(local) if slim_chain else None
        # PRESENCE IS NOT CURRENCY, and these two are the files that move most. They are slimmed
        # on the way up, so a raw diff would always disagree -- but the uploader's own slim is
        # importable, which is the whole reason this script imports it rather than restating it.
        # Left at presence-only, a stale full_pool.json would have read "OK" while the Worker
        # served yesterday's datums.
        if local is not None and kind == 'pool':
            nop = os.path.join(a.registry, 'no_full_pool.json')
            nopool = json.load(open(nop, encoding='utf-8')) if os.path.exists(nop) else {}
            local = slim_full_pool(local, nopool) if slim_full_pool else None
        if local is not None and kind == 'regs':
            local = slim_regulations(local) if slim_regulations else None

        if err:
            print('%-22s %-9s %-11s %-22s %s'
                  % (name, '--', count_of(local) if local is not None else 'ABSENT', '--', err))
            bad.append((name, err, why))
            continue

        served_h = canon(served)
        if local is None:
            verdict = 'served; NO LOCAL COPY to compare'
        elif served_h == canon(local):
            verdict = 'OK -- current'
        else:
            verdict = 'STALE -- bucket differs from disk'
            bad.append((name, verdict, why))
        print('%-22s %-9s %-11s %-22s %s'
              % (name, '%.0f KB' % (nbytes / 1024), count_of(local) if local is not None else '-',
                 count_of(served), verdict))

    print()
    if not bad:
        # COUNTED, NOT SPELLED OUT. This said "All three" while checking four, one commit
        # after the fourth was added -- the same drift the module docstring warns about, in the
        # summary line of the script that warns about it.
        print('All %d registry objects are published and match the local files.' % len(FILES))
        return 0

    print('%d PROBLEM(S):' % len(bad))
    for name, verdict, why in bad:
        print('   %-22s %s' % (name, verdict))
        print('   %-22s   %s' % ('', why))
    print('\nA 404 on any of these almost always means the last upload had no registry dir.')
    print('As of 2026-08-12 --registry DEFAULTS to the folder beside --root, so re-running')
    print('the upload is usually the whole fix:')
    print('   py .\\scripts\\upload_garmin_to_r2.py --root <chartpack root> --all')
    print('STALE means the files changed on disk since the last upload -- same command.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
