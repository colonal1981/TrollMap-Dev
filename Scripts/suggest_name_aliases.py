#!/usr/bin/env python3
r"""suggest_name_aliases.py - find DNR names that are the same water as a registry lake.

Personal use only, not for distribution or resale; not for navigation.

    py .\suggest_name_aliases.py --registry "F:\TrollMapPipeline\registry"
    # ... prints candidates, writes nothing. Then --write to add them to lake_aliases.json.

WHY THIS EXISTS

The picker merges a DNR waterbody into a registry lake when their names agree. Three ways
they can disagree, and only two of them can be handled at runtime:

  1. WORD ORDER AND GENERIC WORDS -- "Lake Wateree" vs "Wateree Lake", "Parr Shoals" vs
     "Parr Shoals Reservoir", "Boyd Pond" vs "Boyd Millpond". `lakeNameLooseKey()` in
     access-index.js strips these at runtime. Nothing to curate.

  2. SPELLING. "Louthers" vs "Lowthers". "Braodway" vs "Broadway". "Watagua" vs "Watauga".
     "Ft. Loudoun" vs "Fort Loudoun". Edit distance, and edit distance does NOT belong in the
     browser: it is O(names x lakes) on every page load, and a fuzzy matcher shipped to the
     client is how `resolveR2Key` came to answer with the wrong lake for 26 waterbodies.
     So it is computed HERE, checked by a human, and shipped as an exact alias.

  3. GENUINELY DIFFERENT NAMES -- "Clarks Hill Lake" is "J. Strom Thurmond Reservoir",
     "Wee Tee" is "Wittee". No rule derives those. Curated, always.

This script covers 2 and 3, and it exists because THE DNR FEEDS ARE A LIVE ArcGIS PULL. A
table written once goes stale the moment a state renames or fixes a typo upstream. Re-dump
the feeds, re-run this, read what it proposes.

THE SAFETY RULE, WHICH IS THE WHOLE DESIGN

A name is never accepted on spelling alone. Every candidate must ALSO have a landing inside
the registry lake's own bounding box. Two independent signals, because one is how you get
"May River" resolving to `mayo_lake` 400 km away. On the four live feeds this rule proposed
15 spelling matches and every one had 100% of its landings inside the lake it matched.

It reports, it does not decide. `--write` appends only what you have read.
"""
import argparse, codecs, json, os, re, sys

GENERIC = r'\b(lake|lakes|reservoir|pond|millpond|mill pond|impoundment|sp|state park|the)\b'
PAD_DEG = 0.005          # ~550 m; a ramp sits on the bank, not on the water


def dedup_key(n):
    n = re.sub(r'\([^)]*\)', ' ', str(n or '').lower())
    n = re.sub(r',.*$', '', n)
    return re.sub(r'[^a-z0-9]+', ' ', n).strip()


def loose_key(n):
    return re.sub(r'[^a-z0-9]', '', re.sub(GENERIC, ' ', dedup_key(n)))


def edits(a, b, cap=2):
    """Levenshtein, abandoned early. Only ever asked about short keys."""
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        if min(cur) > cap:
            return cap + 1
        prev = cur
    return prev[-1]


def read_feeds(folder):
    out = {}
    for st in ('sc', 'nc', 'ga', 'tn'):
        fp = os.path.join(folder, '_dnr_ramps_%s.json' % st)
        if not os.path.exists(fp):
            print('  !! no feed for %s -- its names cannot be checked' % st.upper())
            continue
        raw = open(fp, 'rb').read()
        if raw[:3] == codecs.BOM_UTF8:
            raw = raw[3:]
        for name, ramps in (json.loads(raw.decode('utf-8')).get('waterbodies') or {}).items():
            pts = [(r['lat'], r['lon']) for r in ramps
                   if isinstance(r.get('lat'), (int, float))
                   and isinstance(r.get('lon'), (int, float))]
            if pts:
                out.setdefault(name, {'pts': [], 'states': set()})
                out[name]['pts'] += pts
                out[name]['states'].add(st.upper())
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--max-edits', type=int, default=2)
    ap.add_argument('--min-key', type=int, default=4,
                    help='ignore keys shorter than this. "Big" and "Bog" are one edit apart.')
    ap.add_argument('--write', action='store_true',
                    help='append accepted candidates to lake_aliases.json. Default is a report.')
    a = ap.parse_args()

    ix = json.load(open(os.path.join(a.registry, 'lake_index.json'), encoding='utf-8'))
    apath = os.path.join(a.registry, 'lake_aliases.json')
    aliases = json.load(open(apath, encoding='utf-8')) if os.path.exists(apath) else {}
    feeds = read_feeds(a.registry)
    print('%d DNR waterbody names, %d registry records, %d aliases already curated\n'
          % (len(feeds), len(ix), len(aliases)))

    # Every name any registry record already answers to. A DNR name matching one of these
    # merges at runtime and needs no alias.
    known = set()
    for slug, r in ix.items():
        for n in ([r.get('name'), r.get('display_name'), r.get('legacy_display_name')]
                  + (r.get('legacy_display_names') or [])):
            if n:
                known.add(dedup_key(n))
    loose_index = {}
    for slug, r in ix.items():
        if not r.get('bounds_wsen'):
            continue                      # nothing to corroborate against
        k = loose_key(r.get('display_name') or slug)
        if len(k) >= a.min_key:
            loose_index.setdefault(k, []).append(slug)

    def inside(slug, lat, lon):
        b = ix[slug].get('bounds_wsen')
        if not b or len(b) != 4:
            return False
        w, s, e, n = b
        return (s - PAD_DEG) <= lat <= (n + PAD_DEG) and (w - PAD_DEG) <= lon <= (e + PAD_DEG)

    proposals, runtime_ok, no_match = [], 0, 0
    for name, e in sorted(feeds.items()):
        if dedup_key(name) in known or name in aliases:
            continue
        k = loose_key(name)
        if len(k) < a.min_key:
            continue
        if k in loose_index:
            runtime_ok += 1               # access-index.js handles this one without us
            continue
        best = None
        for rk, slugs in loose_index.items():
            d = edits(k, rk, a.max_edits)
            if d == 0 or d > a.max_edits:
                continue
            for slug in slugs:
                hits = sum(1 for la, lo in e['pts'] if inside(slug, la, lo))
                if not hits:
                    continue              # THE rule: spelling alone is never enough
                score = (d, -hits)
                if best is None or score < best[0]:
                    best = (score, slug, hits, len(e['pts']), d)
        if best:
            _, slug, hits, tot, d = best
            proposals.append((name, slug, hits, tot, d, ''.join(sorted(e['states']))))
        else:
            no_match += 1

    print('%d names already merge at runtime (word order / generic words)' % runtime_ok)
    print('%d names match nothing -- rivers, coastal creeks, water with no registry row'
          % no_match)
    print('%d PROPOSED aliases (spelling near-miss AND a landing inside the lake):\n'
          % len(proposals))
    if proposals:
        print('%-30s %-44s %6s %6s' % ('DNR name', 'registry lake', 'edits', 'inside'))
        for name, slug, hits, tot, d, st in proposals:
            print('  %-28s %-44s %6d %6s'
                  % (('%s (%s)' % (name, st))[:28],
                     (ix[slug].get('display_name') or slug)[:44], d, '%d/%d' % (hits, tot)))
    if a.write and proposals:
        for name, slug, *_ in proposals:
            aliases[name] = slug
        json.dump(aliases, open(apath, 'w', encoding='utf-8'), indent=2, sort_keys=True)
        print('\n-> %s  (%d aliases)' % (apath, len(aliases)))
        print('   run consolidate_lake_index.py so they reach lake_index.json as legacy names')
    elif proposals:
        print('\nreport only -- add --write to accept these')


if __name__ == '__main__':
    main()
