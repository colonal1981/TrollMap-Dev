#!/usr/bin/env python3
r"""mirror_research_profiles.py -- bring the stored research profiles down from R2 onto the drive.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\mirror_research_profiles.py
    py .\scripts\mirror_research_profiles.py --dry-run
    py .\scripts\mirror_research_profiles.py --lake "Parr Shoals Reservoir (Fairfield Co, SC)"

Writes registry\_research_profiles\<id>.json plus _manifest.json. Generated, leading underscore,
never uploaded, never hand-edited.

WHY THIS EXISTS

Ryan, 2026-09-04: *"there are no local copies of research... should we pull those down from R2?
should the new research pipeline make a local copy of the json?"*

Both answers are yes, for three separate reasons, and each one has already cost something.

1. THE COUNT IS WRONG WITHOUT THEM. `_data_map.json` names five kinds of place a species can
   live and can only READ four; the fifth is stamped `"not_countable_offline": true`. So every
   count taken on this machine is a count of the drive, and the drive is not the app. On
   2026-09-04 that produced "192 of 355 waters have species" an hour after "Parr Shoals has ten
   species in its profile -- including Smallmouth Bass", and both were true at once. The map was
   built precisely to stop that class of error and this is the hole left in it.

2. WHERE A FACT CAME FROM IS ONLY IN THE PROFILE. `mergeEvidence` in Worker/research/
   deterministic.js records, per field, which source put each value there -- the ramp feed, the
   advisory floor, SC_INSHORE_ROSTER, an agency page, or the LLM pass with no document behind it.
   That evidence is stored in the master document and nowhere else. The question "the Parr
   smallmouth came in from somewhere -- where?" has an exact answer sitting in R2 that nothing
   here can read.

3. AN OBJECT THAT EXISTS ONLY IN R2 IS UNRECOVERABLE THE MOMENT IT IS PRUNED. That is the whole
   argument of r2_vs_local.py, written before 1,244 chartpacks were deleted, and it applies with
   more force here: a chartpack can be rebuilt from the drive in minutes, a profile is an hour of
   model time and a document corpus that may no longer be online. An R2 prune is on the queue.

WHAT IT DOES NOT DO

It does not delete. A profile that has left the bucket is REPORTED and its local copy is left
alone -- the local copy is then the only copy in the world, which is the state this script exists
to create, not to undo.

It does not write into the repo. registry\ is on the pipeline drive and is not tracked by git, so
mirroring eighty profiles adds nothing to the repository.

THE OTHER HALF IS IN research_lakes.py. This pulls down what is already there; research_lakes.py
writes the same file the moment it saves one, so the mirror does not go stale by a quarter.
"""

from __future__ import annotations
import argparse
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

WORKER = os.environ.get("TROLLMAP_WORKER_URL",
                        "https://trollmap-worker.colonal1981.workers.dev")

# The value stays on the machine that owns it -- never in this file, the repo or a transcript.
#   PowerShell   $env:TROLLMAP_SYNC_TOKEN = "<value from Worker/wrangler.toml>"
SYNC_TOKEN = os.environ.get("TROLLMAP_SYNC_TOKEN", "")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

OUT_DIRNAME = '_research_profiles'
MANIFEST = '_manifest.json'

# The id comes off an R2 key, which is not our string. `lakes/a/b.json` would land outside the
# output directory, and a mirror script that can write anywhere on the drive is a bug waiting for
# a bad key. Anything that is not a plain filename is refused, not sanitised -- a silently
# renamed profile would mirror under a name /research/get can never ask for again.
SAFE_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$')


def _headers():
    h = {"User-Agent": UA, "Accept": "application/json"}
    if SYNC_TOKEN:
        h["X-Sync-Token"] = SYNC_TOKEN
    return h


def _get(path, timeout=180):
    """GET <worker><path>. Returns (status, parsed, error_text)."""
    req = urllib.request.Request(WORKER + path, headers=_headers(), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw), None
            except json.JSONDecodeError:
                return r.status, None, "non-JSON body (%d bytes)" % len(raw)
    except urllib.error.HTTPError as e:
        body = e.read()[:300].decode("utf-8", "replace").replace("\n", " ").strip()
        return e.code, None, body or "empty body"
    except Exception as e:                                    # noqa: BLE001
        return 0, None, str(e)


# ── the pure parts, which is everything worth testing ───────────────────────────────────────

def safe_id(x):
    """The R2 id as a filename, or None if it is not one."""
    x = str(x or '')
    return x if SAFE_ID.match(x) and x not in ('.', '..') else None


def plan(lakes, manifest, force=False):
    """What to fetch, what to leave, what has left the bucket.

    `uploaded` is R2's own stamp on the object, so an unchanged profile is skipped without
    reading it. --force ignores the manifest and re-reads everything, which is what to run when
    the shape of what is stored has changed rather than its content.
    """
    have = (manifest or {}).get('lakes') or {}
    fetch, unchanged, bad = [], [], []
    seen = set()
    for row in lakes or []:
        sid = safe_id(row.get('id'))
        if not sid:
            bad.append(row.get('id'))
            continue
        seen.add(sid)
        prev = have.get(sid)
        if not force and prev and prev.get('uploaded') == row.get('uploaded'):
            unchanged.append(sid)
        else:
            fetch.append(row)
    gone = sorted(set(have) - seen)
    return {'fetch': fetch, 'unchanged': sorted(unchanged), 'gone': gone, 'unusable_ids': bad}


def profile_species(profile):
    """biology.predatorSpecies, which is the field Smart Plan consumes."""
    bio = (profile or {}).get('biology') or {}
    v = bio.get('predatorSpecies')
    return sorted({str(s) for s in v if s}) if isinstance(v, list) else []


def profile_status(profile):
    meta = (profile or {}).get('metadata') or {}
    return str(meta.get('status') or 'unknown')


def evidence_sources(profile, section='biology', field='predatorSpecies'):
    """Every source label recorded against one field, best-effort across the shapes stored.

    mergeEvidence has written `evidence[section][field]` as a list of entries and, in older
    profiles, as a bare entry. Both are read; anything else is reported as its type rather than
    guessed at, because an evidence block that cannot be read is the thing this mirror exists to
    make visible.
    """
    ev = ((profile or {}).get('evidence') or {}).get(section) or {}
    node = ev.get(field)
    items = node if isinstance(node, list) else ([node] if isinstance(node, dict) else [])
    out = []
    for e in items:
        if not isinstance(e, dict):
            continue
        label = e.get('sourceLabel') or e.get('label') or e.get('source') or e.get('url')
        kind = e.get('sourceType') or e.get('type') or e.get('method')
        out.append(' '.join(str(x) for x in (kind, label) if x).strip() or '(unlabelled)')
    return out


def summarise(profiles):
    """{id: profile} -> the two numbers the map could not take offline."""
    with_species = {k: profile_species(v) for k, v in profiles.items()}
    carrying = {k: v for k, v in with_species.items() if v}
    statuses = {}
    for k, v in profiles.items():
        statuses[profile_status(v)] = statuses.get(profile_status(v), 0) + 1
    return {
        'profiles': len(profiles),
        'carrying_predator_species': len(carrying),
        'distinct_species': len({s for v in carrying.values() for s in v}),
        'by_status': dict(sorted(statuses.items())),
    }


# ── the run ─────────────────────────────────────────────────────────────────────────────────

def read_manifest(out_dir):
    p = os.path.join(out_dir, MANIFEST)
    if not os.path.exists(p):
        return {}
    try:
        with open(p, encoding='utf-8') as fh:
            return json.load(fh)
    except Exception as e:                                    # noqa: BLE001
        print('   manifest unreadable (%s) -- treating every profile as new' % e)
        return {}


def fetch_one(row):
    """(id, profile, error). Asked for by id; the response says which key was actually read."""
    sid = safe_id(row.get('id'))
    code, data, err = _get('/research/get?lake=' + urllib.parse.quote(sid))
    if code != 200 or not data or not data.get('ok'):
        return sid, None, None, err or ('HTTP %s' % code)
    return sid, data.get('profile'), data.get('sanitized') or sid, None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--registry', default=os.environ.get('TROLLMAP_REGISTRY',
                                                         r'F:\TrollMapPipeline\registry'))
    ap.add_argument('--lake', help='mirror one water by name or id, and nothing else')
    ap.add_argument('--force', action='store_true', help='re-read every profile, ignore the manifest')
    ap.add_argument('--dry-run', action='store_true', help='say what would change, write nothing')
    ap.add_argument('--jobs', type=int, default=4)
    a = ap.parse_args(argv)

    out_dir = os.path.join(a.registry, OUT_DIRNAME)
    if not os.path.isdir(a.registry):
        print('registry not found: %s' % a.registry)
        return 2
    if not SYNC_TOKEN:
        print('TROLLMAP_SYNC_TOKEN is not set in this shell. Set it and re-run:')
        print('   $env:TROLLMAP_SYNC_TOKEN = "<value from Worker/wrangler.toml>"')
        return 2

    if a.lake:
        # A display name is not a filename, so the id has to come back from the Worker.
        code, data, err = _get('/research/get?lake=' + urllib.parse.quote(a.lake))
        if code != 200 or not data or not data.get('ok'):
            print('no profile for %s (%s)' % (a.lake, err or 'HTTP %s' % code))
            return 1
        # WHICH KEY THAT NAME ACTUALLY SERVES, on its own line. Four waters carry two profiles
        # each -- the 2026-09-01 fork, before /research/save learned to resolve through
        # legacy_display_names -- and in all four the older profile is the better one. Whether
        # the app shows the good half or the thin one depends on resolveResearchStorageId's
        # candidate order, which cannot be worked out from the drive: only the Worker can say,
        # and this is the call that asks it.
        print('   %r resolves to lakes/%s.json' % (a.lake, data.get('sanitized')))
        # `uploaded` is R2's stamp and only /research/list carries it, so a single-water read
        # records None -- honest, and it costs one extra read on the next full run rather than
        # writing a stamp that might not describe what is on disk.
        lakes = [{'id': data.get('sanitized'), 'uploaded': None,
                  'size': None, 'key': data.get('masterKey')}]
        manifest = read_manifest(out_dir)
    else:
        code, listing, err = _get('/research/list')
        if code != 200 or not listing or not listing.get('ok'):
            print('/research/list failed: %s' % (err or 'HTTP %s' % code))
            return 1
        lakes = listing.get('lakes') or []
        manifest = read_manifest(out_dir)
        print('bucket holds %d profile(s), %d version file(s)'
              % (len(lakes), listing.get('versionFiles') or 0))

    p = plan(lakes, manifest, force=a.force)
    print('   %d to read, %d unchanged, %d in the manifest but no longer in the bucket'
          % (len(p['fetch']), len(p['unchanged']), len(p['gone'])))
    for bad in p['unusable_ids']:
        print('   !! refusing an id that is not a plain filename: %r' % bad)
    for g in p['gone']:
        print('   !! %s has left the bucket -- the local copy is now the only one. Not deleted.' % g)
    if a.dry_run:
        for row in p['fetch'][:40]:
            print('      would read %s' % row.get('id'))
        if len(p['fetch']) > 40:
            print('      ... and %d more' % (len(p['fetch']) - 40))
        return 0
    if not p['fetch']:
        print('nothing to do.')
        return 0

    os.makedirs(out_dir, exist_ok=True)
    got, failed = {}, []
    with ThreadPoolExecutor(max_workers=max(1, a.jobs)) as ex:
        for sid, profile, sanitized, err in ex.map(fetch_one, p['fetch']):
            if err or profile is None:
                failed.append((sid, err or 'empty profile'))
                continue
            got[sid] = (profile, sanitized)

    lakes_by_id = {safe_id(r.get('id')): r for r in p['fetch']}
    written = dict((manifest or {}).get('lakes') or {})

    # A FILE NAMED FOR ONE PROFILE MUST NOT HOLD ANOTHER.
    #
    # `/research/get?lake=<id>` runs the app's name resolution, which folds a shadowed id onto the
    # profile that is actually SERVED for that water. So asking for `nottely_lake_ga` returns
    # `lake_nottely_ga`, and this loop wrote the served profile into `nottely_lake_ga.json`.
    #
    # It already knew. `resolved_to` was recorded in the manifest on every one of those rows and
    # nothing acted on it -- a report that names a condition and does not act on it reads as a
    # decision. Measured 2026-09-05: three of the eighty mirrored files held someone else's
    # profile, byte for byte.
    #
    #     asked lake_sidney_lanier_hall_co_ga   got lake_lanier_ga     draft(3 sources) -> verified(9)
    #     asked nottely_lake_ga                 got lake_nottely_ga    5 species -> 8
    #     asked watauga_lake_tn                 got watauga_tn
    #
    # THE COST IS NOT A WRONG FILE, IT IS A WRONG DELETION. This mirror is the local copy the R2
    # prune rule's middle row depends on -- "no longer offered AND recoverable, may go". A
    # shadowed profile is not recoverable from a file holding a different profile, so pruning it
    # would destroy the only copy while every check said there was a backup.
    #
    # The read cannot ask for an exact key -- handleResearchGet resolves before it fetches, and a
    # second route would be a second copy of that resolution. So the honest thing is to refuse the
    # write and say which ids have no local copy.
    mismatched = []
    for sid, (profile, sanitized) in sorted(got.items()):
        if sanitized and sanitized != sid:
            mismatched.append((sid, sanitized))
            written.pop(sid, None)
            continue
        fp = os.path.join(out_dir, sid + '.json')
        blob = json.dumps(profile, indent=1, ensure_ascii=False) + '\n'
        with open(fp, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(blob)
        row = lakes_by_id.get(sid) or {}
        written[sid] = {'key': row.get('key') or ('lakes/%s.json' % sid),
                        'uploaded': row.get('uploaded'),
                        'r2_size': row.get('size'),
                        'bytes': len(blob.encode('utf-8')),
                        'resolved_to': sanitized,
                        'species': len(profile_species(profile)),
                        'status': profile_status(profile)}

    # AND THE ONES WRITTEN BEFORE THIS CHECK EXISTED. `fetch` only carries profiles that CHANGED,
    # so a stale wrong file is never revisited on a quiet run. Every manifest row is re-examined.
    for sid, row in sorted(list(written.items())):
        r = row.get('resolved_to')
        if r and r != sid:
            mismatched.append((sid, r))
            written.pop(sid, None)
    seen = set()
    mismatched = [m for m in mismatched if not (m[0] in seen or seen.add(m[0]))]

    summary = summarise({k: v[0] for k, v in got.items()})
    doc = {'generated': datetime.date.today().isoformat(),
           'worker': WORKER,
           'count': len(written),
           'read_this_run': len(got),
           'summary_of_this_run': summary,
           'lakes': dict(sorted(written.items()))}
    with open(os.path.join(out_dir, MANIFEST), 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write('\n')

    print('read %d profile(s): %d carry predatorSpecies, %d distinct species, %s'
          % (summary['profiles'], summary['carrying_predator_species'],
             summary['distinct_species'],
             ', '.join('%s %d' % kv for kv in summary['by_status'].items())))
    for sid, err in failed:
        print('   !! %s: %s' % (sid, err))
    if mismatched:
        print()
        print('   %d id(s) HAVE NO LOCAL COPY -- /research/get resolved each to another profile:'
              % len(mismatched))
        for sid, r in mismatched:
            print('      %-42s is served by %s' % (sid, r))
        stale = [os.path.join(out_dir, sid + '.json') for sid, _ in mismatched
                 if os.path.exists(os.path.join(out_dir, sid + '.json'))]
        if stale:
            print('   %d file(s) on disk are named for one profile and hold another. Delete them:'
                  % len(stale))
            for fp in stale:
                print('      %s' % fp)
        print('   These profiles are NOT recoverable from this mirror. Do not prune them from R2.')
    print('-> %s   (%d file(s) on disk)' % (out_dir, len(written)))
    print('   now re-run build_data_map.py -- the fifth place is readable.')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
