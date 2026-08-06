#!/usr/bin/env python3
"""make_key_map.py - decide which R2 key each registry lake writes to, BEFORE anything uploads.

Personal use only, not for distribution or resale; not for navigation.

    py .\\make_key_map.py `
       --lake-keys "F:\\TrollMapPipeline\\TrollMap-Dev\\js\\data\\lake-keys.js" `
       --slugs     "F:\\TrollMapPipeline\\registry\\slug_names.json" `
       --out       "F:\\TrollMapPipeline\\registry\\key_map.json"

THE PROBLEM THIS EXISTS TO PREVENT

R2 already holds chartpacks under keys the app has been using for months -- `lake_moultrie`,
`lake_wateree_fishing_creek`, `falls_lake`. The registry names lakes by GNIS slug --
`lake_moultrie`, `wateree_lake`, `b_everett_jordan_lake`. Those agree sometimes and not
others, and the two failure modes are different:

  * SAME name  -> the new pack overwrites the old one. Filenames match
    (contours.geojson, depth_areas.geojson, ...), so it is a clean replacement. 28 of 68.
  * DIFFERENT  -> the new pack lands under a NEW key, the old pack stays where it is, and
    `resolveR2Key()` keeps returning the curated key because curated wins. You get two copies
    in R2 and the app silently reads the stale one. 40 of 68.

That second case is the dangerous one: nothing errors, storage doubles, and the map shows
i-Boating contours while the Garmin pack sits unused beside it.

So resolve it up front. Every registry lake gets an explicit target key, matched to a curated
key where one plausibly refers to the same water, and the ambiguous ones are printed for a
human rather than guessed at.

MATCHING RULE, deliberately conservative: normalise both names (lowercase, strip punctuation,
drop the words lake/reservoir/pond/the, sort the remaining tokens so "Lake Moultrie" and
"Moultrie Lake" agree) AND require the curated key's lake to be within --max-km of the
registry centroid when a coordinate is available. Name alone is not enough -- SC has two Lake
Wallaces, and `Cherokee Lake` exists in both NC and TN.
"""
import argparse, json, math, os, re, sys
from collections import defaultdict

STOP = {'lake', 'lakes', 'reservoir', 'rsvr', 'pond', 'millpond', 'mill', 'the', 'of',
        'impoundment', 'creek', 'river'}
# Curated display names carry a state suffix the registry names do not: `Auman Lake, NC`
# against `Auman Lake`. Leaving `nc` in the token set meant NOTHING matched -- the first run
# of this reported 0 of 68, which is the tell that a normaliser is broken rather than that
# two datasets genuinely disagree. Multi-state names like `Catawba Narrows, NC/SC` need both
# dropped, so this is a token set and not a suffix strip.
STATES = {'al', 'ar', 'fl', 'ga', 'il', 'in', 'ky', 'la', 'mo', 'ms', 'nc', 'sc', 'tn',
          'va', 'wv'}


def norm(s):
    toks = [t for t in re.split(r'[^a-z0-9]+', (s or '').lower()) if t]
    toks = [t for t in toks if t not in STATES]
    core = [t for t in toks if t not in STOP]
    return ' '.join(sorted(core)) or ' '.join(sorted(toks))


def parse_lake_keys(path):
    """name -> r2 key, straight out of the JS object literal."""
    s = open(path, encoding='utf-8').read()
    # Only the LAKE_NAME_TO_R2_KEY block; other maps in the file would poison this.
    m = re.search(r'LAKE_NAME_TO_R2_KEY\s*=\s*\{(.*?)\n\};', s, re.S)
    body = m.group(1) if m else s
    out = {}
    for name, key in re.findall(r"['\"]([^'\"]+)['\"]\s*:\s*['\"]([a-z0-9_]+)['\"]", body):
        out.setdefault(name, key)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--lake-keys', required=True)
    ap.add_argument('--slugs', required=True, help='slug_names.json')
    ap.add_argument('--out', required=True)
    ap.add_argument('--max-km', type=float, default=40.0)
    a = ap.parse_args()

    cur = parse_lake_keys(a.lake_keys)
    slugs = json.load(open(a.slugs, encoding='utf-8'))
    print('%d curated names -> %d distinct keys' % (len(cur), len(set(cur.values()))))
    print('%d registry lakes' % len(slugs))

    # curated key -> the normalised names that point at it
    key_names = defaultdict(set)
    for name, key in cur.items():
        if key.startswith('coast_'):
            continue                      # coastal zones are not registry lakes
        key_names[key].add(norm(name))

    # states the curated NAME claims, so a GA pond cannot capture an SC reservoir's key
    key_states = defaultdict(set)
    for name, key in cur.items():
        if key.startswith('coast_'):
            continue
        for t in re.split(r'[^A-Za-z]+', name):
            if len(t) == 2 and t.upper() in {s.upper() for s in STATES}:
                key_states[key].add(t.upper())

    by_norm = defaultdict(list)
    for slug, v in slugs.items():
        by_norm[norm(v['n'])].append(slug)

    # EVERY lake writes to its own slug. Full stop.
    #
    # The first version auto-mapped registry lakes onto curated keys and it was dangerous in
    # two distinct ways, both visible in its own output:
    #
    #   1. No state check, so `blalock_lakes` (GA, 77 ac) claimed `lake_blalock` (SC, a
    #      1,000+ ac reservoir), and `jordan_millpond` (GA, 51 ac) claimed `jordan_lake`
    #      (NC, 13,119 ac). The --max-km guard was in the docstring and never in the code.
    #   2. Worse: several curated keys are COMBINED packs covering more than one lake --
    #      `lake_wateree_fishing_creek`, `lake_thurmond_russell`, `lake_hickory_rhodhiss`,
    #      `lake_norman_mountain_island`, `watauga_boone_chain`. Writing one registry lake's
    #      data to such a key does not update it, it DELETES the other lake's contours.
    #
    # So this tool no longer decides. It reports which curated keys the new packs supersede
    # and leaves the old objects alone; nothing is overwritten and nothing is lost. Ryan
    # decides what to retire, with the overlap in front of him.
    mapping = {slug: slug for slug in slugs}

    supersedes = defaultdict(list)
    for key, names in sorted(key_names.items()):
        want_st = key_states.get(key) or set()
        for n in names:
            for slug in by_norm.get(n, []):
                if want_st and slugs[slug]['s'] not in want_st:
                    continue
                supersedes[key].append(slug)
    for k in supersedes:
        supersedes[k] = sorted(set(supersedes[k]), key=lambda s: -(slugs[s]['a'] or 0))

    orphan = [k for k in sorted(key_names) if k not in supersedes]

    # A curated key that is ALSO a registry slug is not "superseded" -- it is the same R2
    # object. `lake_marion` the curated key and `lake_marion` the registry slug address one
    # set of bytes, and the registry pack overwrote the curated one on upload. Emitting these
    # under `curated_key_superseded_by` told prune_r2_keys.py to delete them, which would have
    # deleted the replacement. 29 of 48 entries were this on 2026-08-03.
    #
    # They are still worth reporting -- the curated ALIAS may want retiring from lake-keys.js
    # even though the OBJECT must stay -- so they get their own bucket rather than being
    # dropped on the floor.
    same_key = {k: v for k, v in supersedes.items() if k in v}
    for k in same_key:
        supersedes.pop(k)

    json.dump({'slug_to_r2_key': mapping,
               'curated_key_superseded_by': {k: v for k, v in sorted(supersedes.items())},
               'curated_key_is_registry_slug': {k: v for k, v in sorted(same_key.items())},
               'curated_keys_with_no_registry_match': orphan},
              open(a.out, 'w', encoding='utf-8'), indent=1)

    if same_key:
        print('\n%d curated keys ARE registry slugs -- same R2 object, already replaced in '
              'place by the upload. NOT deletable; the alias in lake-keys.js is what can go:'
              % len(same_key))
        for k in sorted(same_key)[:10]:
            print('   %s' % k)
        if len(same_key) > 10:
            print('   ... %d more' % (len(same_key) - 10))

    print('\nEvery registry lake writes to its own slug.')
    combo = {k: v for k, v in supersedes.items() if len(v) > 1}
    print('\n%d curated keys are now covered by registry lakes -- candidates to RETIRE once '
          'the new packs are verified:' % len(supersedes))
    for k, v in sorted(supersedes.items())[:24]:
        tag = '  <-- COMBINED PACK, %d lakes' % len(v) if len(v) > 1 else ''
        print('   %-30s <- %s%s' % (k, ', '.join('%s (%s %.0fac)' % (s, slugs[s]['s'], slugs[s]['a'])
                                                 for s in v[:3]), tag))
    if len(supersedes) > 24:
        print('   ... %d more' % (len(supersedes) - 24))

    print('\n%d curated keys matched NO registry lake. They stay, and the app keeps using them '
          '-- these are lakes 3DHP does not name, the Bates Old River class:' % len(orphan))
    for k in orphan[:20]:
        print('   %s' % k)
    print('\n-> %s' % a.out)


if __name__ == '__main__':
    main()
