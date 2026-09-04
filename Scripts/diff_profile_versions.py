#!/usr/bin/env python3
r"""diff_profile_versions.py -- what a batch run cost, field by field, off the version history.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\diff_profile_versions.py --before 2026-09-01
    py .\scripts\diff_profile_versions.py --before 2026-09-01 --lake lake_wateree_sc

WHY THIS EXISTS

Ryan, 2026-09-04: *"we aren't guessing at it... the old research profiles will tell you"*, and then
*"only about 15 lakes weren't ever researched... those 15 are the unknown"*.

Both are right, and together they say the shape of the answer. Sixty-five of the eighty waters had
a profile before the 2026-09-01/02 batch rewrote them, so for those the question "did the batch
lose anything" is not a guess and never was -- `lakes/versions/<id>/vN.json` holds what they said.
Until 2026-09-04 nothing could read one back, which is why it looked like a guess. `/research/get`
now takes `?version=N`.

WHAT IT COMPARES, AND IT IS NOT THE WHOLE DOCUMENT

Only the fields `researchIntel()` puts in the plan prompt. A profile can lose a hundred keys and
lose nothing that reaches a plan, and it can lose one and lose the thermocline. The list below is
read off js/modules/plan-inputs.js and has to be kept beside it -- see
WHAT_ONLY_THE_RESEARCH_PROFILE_CAN_SUPPLY_2026-09-04.md.

IT WALKS BACK, NOT TO v1. The newest version older than --before is the "before". A lake the batch
touched twice has two batch versions on top of it, and comparing against v1 would report every
improvement of the last two months as a loss.
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
SYNC_TOKEN = os.environ.get("TROLLMAP_SYNC_TOKEN", "")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

PROFILE_DIRNAME = "_research_profiles"

# EXACTLY WHAT researchIntel() PUTS IN THE PROMPT. Nothing else is a loss worth reporting.
FIELDS = [
    ('Lake type',          lambda d: (d.get('identity') or {}).get('archetype')
                                     or (d.get('identity') or {}).get('bodyType')),
    ('Max depth',          lambda d: (d.get('identity') or {}).get('maxDepthFt')),
    ('Average depth',      lambda d: (d.get('identity') or {}).get('averageDepthFt')),
    ('Thermocline',        lambda d: ((d.get('limnology') or {}).get('thermocline') or {}).get('summerDepthFt')),
    ('Anoxic below',       lambda d: ((d.get('limnology') or {}).get('oxygen') or {}).get('anoxicBelowFt')),
    ('O2 depletion',       lambda d: ((d.get('limnology') or {}).get('oxygen') or {}).get('depletionDepthFt')),
    ('Trophic status',     lambda d: (d.get('limnology') or {}).get('trophicStatus')),
    ('Typical clarity',    lambda d: ((d.get('limnology') or {}).get('waterClarity') or {}).get('typical')),
    ('Secchi',             lambda d: ((d.get('limnology') or {}).get('waterClarity') or {}).get('secchiFt')),
    ('Seasonal drawdown',  lambda d: (d.get('limnology') or {}).get('seasonalDrawdownFt')),
    ('Other predators',    lambda d: (d.get('biology') or {}).get('predatorSpecies')),
    ('Primary forage',     lambda d: (d.get('biology') or {}).get('primaryForage')),
    ('Secondary forage',   lambda d: (d.get('biology') or {}).get('secondaryForage')),
    ('Stockings',          lambda d: (d.get('biology') or {}).get('knownStockings')),
    ('Named creek mouths', lambda d: ((d.get('habitat') or {}).get('structuralElements') or {}).get('creekMouths')),
    ('Charted points',     lambda d: ((d.get('habitat') or {}).get('structuralElements') or {}).get('points')),
    ('Charted coves',      lambda d: ((d.get('habitat') or {}).get('structuralElements') or {}).get('coves')),
    ('Structure POIs',     lambda d: ((d.get('habitat') or {}).get('structuralElements') or {}).get('chartedStructurePois')),
    ('Fish attractors',    lambda d: ((d.get('habitat') or {}).get('artificialHabitatDetails') or {}).get('attractorCount')),
    ('Trolling intel',     lambda d: d.get('trollingIntelligence')),
]


def _get(path, timeout=120):
    h = {"User-Agent": UA, "Accept": "application/json"}
    if SYNC_TOKEN:
        h["X-Sync-Token"] = SYNC_TOKEN
    req = urllib.request.Request(WORKER + path, headers=h, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read()), None
    except urllib.error.HTTPError as e:
        body = e.read()[:400].decode("utf-8", "replace")
        try:
            return e.code, json.loads(body), None
        except json.JSONDecodeError:
            return e.code, None, body.replace("\n", " ").strip() or "empty body"
    except Exception as e:                                    # noqa: BLE001
        return 0, None, str(e)


def has(v):
    """The same test researchIntel()'s `put` makes: an empty list is not a value."""
    if v is None or v == '':
        return False
    if isinstance(v, (list, dict)):
        return len(v) > 0
    return True


def updated(profile):
    return str(((profile or {}).get('metadata') or {}).get('lastUpdated') or '')[:10]


def version_before(sid, versions, before):
    """The newest stored version older than `before`, walking back. (number, profile) or (None, why).

    Walking back rather than taking v1: a lake the batch touched twice carries two batch versions,
    and v1 is two months of research ago. The first version older than the cutoff is the one that
    says what the run replaced.
    """
    for v in sorted(versions, reverse=True):
        code, data, err = _get('/research/get?lake=%s&version=%d'
                               % (urllib.parse.quote(sid), v))
        if code != 200 or not data or not data.get('ok'):
            return None, (err or (data or {}).get('error') or 'HTTP %s' % code)
        prof = data.get('profile') or {}
        if updated(prof) < before:
            return v, prof
    return None, 'every stored version is newer than %s' % before


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--registry', default=os.environ.get('TROLLMAP_REGISTRY',
                                                         r'F:\TrollMapPipeline\registry'))
    ap.add_argument('--before', default='2026-09-01',
                    help='the cutoff; the newest version older than this is the "before"')
    ap.add_argument('--lake', help='one storage id, for a close look')
    a = ap.parse_args(argv)

    d = os.path.join(a.registry, PROFILE_DIRNAME)
    if not os.path.isdir(d):
        print('no mirror at %s -- run mirror_research_profiles.py first' % d)
        return 2
    if not SYNC_TOKEN:
        print('TROLLMAP_SYNC_TOKEN is not set in this shell. Set it and re-run:')
        print('   $env:TROLLMAP_SYNC_TOKEN = "<value from Worker\\wrangler.toml>"')
        return 2

    ids = [f[:-5] for f in sorted(os.listdir(d)) if f.endswith('.json') and not f.startswith('_')]
    if a.lake:
        ids = [x for x in ids if x == a.lake] or [a.lake]

    lost_by_field, gained_by_field = {}, {}
    compared, no_history, errors = 0, [], []
    for sid in ids:
        with open(os.path.join(d, sid + '.json'), encoding='utf-8') as fh:
            now = json.load(fh)
        if updated(now) < a.before:
            continue                                   # the batch never touched it; nothing to diff
        code, data, err = _get('/research/get?lake=' + urllib.parse.quote(sid))
        if code != 200 or not data or not data.get('ok'):
            errors.append((sid, err or 'HTTP %s' % code))
            continue
        versions = [int(v['version']) for v in (data.get('versions') or [])
                    if str(v.get('version') or '').isdigit()]
        if not versions:
            no_history.append(sid)
            continue
        vnum, before = version_before(sid, versions, a.before)
        if vnum is None:
            no_history.append('%s (%s)' % (sid, before))
            continue
        compared += 1
        lost, gained = [], []
        for name, get in FIELDS:
            b, n = has(get(before)), has(get(now))
            if b and not n:
                lost.append(name)
                lost_by_field.setdefault(name, []).append(sid)
            elif n and not b:
                gained.append(name)
                gained_by_field.setdefault(name, []).append(sid)
        if lost or gained:
            print('%-38s v%-4s -> v%-4s' % (sid, vnum, (now.get('metadata') or {}).get('versionNumber')))
            if lost:
                print('     LOST   %s' % ', '.join(lost))
            if gained:
                print('     gained %s' % ', '.join(gained))

    print('\ncompared %d profile(s) against their last version before %s' % (compared, a.before))
    if no_history:
        print('no usable history for %d: %s' % (len(no_history), ', '.join(no_history[:8])))
    for sid, e in errors[:8]:
        print('   !! %s: %s' % (sid, e))
    print('\nFIELDS LOST, worst first -- these are the ones that reach the plan prompt:')
    for name, waters in sorted(lost_by_field.items(), key=lambda kv: -len(kv[1])):
        print('   %-20s %3d water(s)   %s' % (name, len(waters), ', '.join(waters[:5])))
    if not lost_by_field:
        print('   none.')
    print('\nfields gained:')
    for name, waters in sorted(gained_by_field.items(), key=lambda kv: -len(kv[1])):
        print('   %-20s %3d water(s)' % (name, len(waters)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
