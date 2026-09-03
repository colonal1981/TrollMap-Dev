#!/usr/bin/env python3
"""
build_species_habitat_weights.py -- species x habitat weights, from a published ranking.

Personal use only, not for distribution or resale; not for navigation.

WHAT THIS REPLACES
    TIDE_WEIGHTS in js/modules/coastal-scoring.js is a table somebody wrote. Its header says so:
    "Transcribed from the brief's +/++/+++ notation as 1/2/3". It covers three species and its
    numbers have no source behind them.

    species-habitat-matrix.csv is the South Atlantic species-habitat matrix: 1,160 rows, 61
    species, 24 habitat types, four life stages, each ranked Very High 4.0 / High 3.5 /
    Medium 2.0 / Low 1.0 / Unknown 0. That is the same judgement, made by people who study it,
    written down. This script turns it into weights the app can lead with.

    IT DOES NOT REPLACE THE TIDE HALF. The matrix says a red drum wants soft bottom; it says
    nothing about whether that is true on the flood or the ebb. Tide stage stays ours.

TWO OUTPUT BUCKETS, AND WHY THEY ARE SEPARATE
    `structures`  habitat types that map onto a class the app already scores -- oyster reef,
                  marsh, SAV, and so on. These can lead a weight today.
    `substrates`  bottom composition -- loose fine, firm hard, coarse, structured sand, dead
                  shell. NOTHING IN THE PACKS EMITS THESE YET. They are kept, separately and
                  labelled, because the ENC seabed parse and usSEABED are what fills them, and
                  a weight for a type nothing emits would look like it worked and do nothing.
                  That is the mistake structureWeights() already refuses to make; this file
                  refuses it the same way, by keeping the two piles apart instead of merging
                  them and hoping.

    Everything that maps to neither is COUNTED in `unmapped`, not dropped.

THE STRUCTURE VOCABULARY IS READ, NOT TYPED
    The six structure keys come out of coastal-scoring.js at build time. A key renamed there
    and not here produces an empty bucket and a loud report, rather than a weights file quietly
    naming a class the app no longer has.

USAGE
    py build_species_habitat_weights.py
    py build_species_habitat_weights.py --dry-run
"""

import argparse
import csv
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
NOTE = 'Personal use only, not for distribution or resale; not for navigation.'
MATRIX = 'species-habitat-matrix.csv'
SCORING_JS = os.path.join('js', 'modules', 'coastal-scoring.js')
TRAITS = os.path.join('registry', 'species_traits.json')

# ── the one typed table in this file ────────────────────────────────────────────────────────
# The matrix's habitat vocabulary against ours. There is no deriving this: two vocabularies
# written by different people for different purposes only meet where somebody says they meet.
# It is a regex per line so a habitat type that gains a qualifier still lands, and every type
# that matches nothing is reported rather than assumed irrelevant.
#
# Values on the left are the STRUCTURE keys read out of coastal-scoring.js; a value here that
# is not a key there is an error and is reported as one.
HABITAT_TO_STRUCTURE = [
    (r'oyster reef',                         'oyster'),
    (r'salt.*marsh|brackish marsh|tidal freshwater marsh|non-tidal freshwater marsh', 'marsh_edge'),
    (r'submerged aquatic|mesohaline|oligohaline|seagrass', 'grass_flat'),
    (r'tidal channel|creek|inlet',           'creek_mouth'),
    (r'pier|dock|piling|jetty',              'dock_piling'),
    (r'channel|mainstem river',              'channel_edge'),
]

# Bottom composition. Kept apart on purpose -- see the module docstring.
HABITAT_TO_SUBSTRATE = [
    (r'loose fine bottom',                   'fine'),          # mud, silt, sand
    (r'loose coarse bottom',                 'coarse'),        # gravel to cobble
    (r'firm hard bottom',                    'hard'),          # boulders to embedded rock
    (r'structured sand',                     'structured_sand'),
    (r'dead shell',                          'shell'),
    (r'live rock|patch reef',                'live_hard'),
    (r'hard clam bed|scallop bed',           'shellfish_bed'),
]

STAGE_KEY = {
    'adult': 'adult',
    'spawning adult': 'spawning',
    'juvenile & young-of-year': 'juvenile',
    'egg & larva': 'larva',
}


def _root():
    d = HERE
    for _ in range(4):
        if os.path.exists(os.path.join(d, MATRIX)):
            return d
        d = os.path.dirname(d)
    return os.path.dirname(HERE)


# ── vocabularies ────────────────────────────────────────────────────────────────────────────
def structure_keys(root):
    """
    The six structure classes, read out of coastal-scoring.js.

    Typed here they would drift. Read, a rename in the app empties a bucket loudly instead of
    producing weights for a class the app no longer scores.
    """
    for base in (root, os.path.join(root, 'TrollMap-Dev')):
        p = os.path.join(base, SCORING_JS)
        if not os.path.exists(p):
            continue
        with open(p, encoding='utf-8') as f:
            src = f.read()
        m = re.search(r'export const STRUCTURE\s*=\s*\{(.*?)\}', src, re.S)
        if not m:
            continue
        return {v for v in re.findall(r":\s*'([a-z_]+)'", m.group(1))}
    return set()


def species_alternates(name):
    """
    Every name this species answers to.

    Our roster writes the second name in brackets -- "Speckled Trout (Spotted Seatrout)",
    "Whiting (Southern Kingfish)" -- and the matrix uses whichever it prefers. Both halves count,
    and so does each side of a slash.
    """
    out = [name]
    inner = re.findall(r'\(([^)]*)\)', name)
    out += inner
    out.append(re.sub(r'\s*\([^)]*\)', '', name))
    parts = []
    for o in out:
        parts += [p for p in o.split('/')]
    return [p.strip() for p in parts if p.strip()]


def norm_species(s):
    """Lowercase, letters only. 'Spotted Sea Trout' and 'Spotted Seatrout' become one word."""
    return re.sub(r'[^a-z]', '', str(s or '').lower())


def load_our_species(root):
    """{normalised alternate -> our canonical name}, from the trait roster."""
    for base in (root, os.path.join(root, 'TrollMap-Dev')):
        p = os.path.join(base, TRAITS)
        if not os.path.exists(p):
            continue
        with open(p, encoding='utf-8') as f:
            d = json.load(f)
        out = {}
        for canon in (d.get('species') or {}):
            for alt in species_alternates(canon):
                out.setdefault(norm_species(alt), canon)
        return out
    return {}


def classify_habitat(habitat_type, keys):
    """
    ('structure', key) | ('substrate', key) | (None, None).

    Structure first: a habitat that is both a place and a bottom is a place, because a place is
    what the ranker can put a leg on.
    """
    t = str(habitat_type or '').lower()
    for pat, key in HABITAT_TO_STRUCTURE:
        if re.search(pat, t):
            return ('structure', key) if key in keys else ('bad_key', key)
    for pat, key in HABITAT_TO_SUBSTRATE:
        if re.search(pat, t):
            return ('substrate', key)
    return (None, None)


# ── the build ───────────────────────────────────────────────────────────────────────────────
def build(rows, our_species, keys):
    """Pure. rows are dicts straight off the CSV."""
    species = defaultdict(lambda: {'matrixNames': set(),
                                   'structures': defaultdict(dict),
                                   'substrates': defaultdict(dict)})
    unmapped = defaultdict(int)
    bad_keys = defaultdict(int)
    unmatched = defaultdict(int)
    ranks = {}

    for r in rows:
        raw_sp = (r.get('Species') or '').strip()
        canon = our_species.get(norm_species(raw_sp))
        if not canon:
            unmatched[raw_sp] += 1
            continue
        stage = STAGE_KEY.get((r.get('Life Stage') or '').strip().lower())
        if not stage:
            continue
        try:
            num = float(r.get('Numeric Rank') or 0)
        except ValueError:
            continue
        label = (r.get('Rank') or '').strip()
        if label:
            ranks[label] = num
        kind, key = classify_habitat(r.get('Habitat Type'), keys)
        if kind == 'bad_key':
            bad_keys[key] += 1
            continue
        if not kind:
            unmapped[(r.get('Habitat Type') or '').strip()] += 1
            continue
        rec = species[canon]
        rec['matrixNames'].add(raw_sp)
        bucket = rec['structures'] if kind == 'structure' else rec['substrates']
        # A habitat class can be reached by more than one habitat TYPE -- marsh has three rows,
        # SAV has two. The strongest wins: the matrix is saying this class matters at least this
        # much, and averaging would let a Low row drag down a Very High one.
        prev = bucket[stage].get(key)
        if prev is None or num > prev:
            bucket[stage][key] = num

    out = {}
    for canon, rec in species.items():
        out[canon] = {
            'matrixNames': sorted(rec['matrixNames']),
            'structures': {s: dict(sorted(v.items())) for s, v in sorted(rec['structures'].items())},
            'substrates': {s: dict(sorted(v.items())) for s, v in sorted(rec['substrates'].items())},
        }
    return out, dict(unmapped), dict(unmatched), dict(bad_keys), ranks


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default=None)
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()

    root = a.root or _root()
    src = os.path.join(root, MATRIX)
    if not os.path.exists(src):
        print(f'ERROR: {src} not found', file=sys.stderr)
        return 2

    keys = structure_keys(root)
    if not keys:
        print(f'ERROR: could not read STRUCTURE out of {SCORING_JS} -- refusing to guess the '
              'structure vocabulary', file=sys.stderr)
        return 2
    our = load_our_species(root)
    if not our:
        print(f'ERROR: could not read the species roster from {TRAITS}', file=sys.stderr)
        return 2
    print(f'{len(keys)} structure classes read from coastal-scoring.js: {", ".join(sorted(keys))}')
    print(f'{len(set(our.values()))} species in our roster')

    with open(src, encoding='utf-8-sig') as f:
        rows = list(csv.DictReader(f))
    print(f'{len(rows):,} matrix rows')

    species, unmapped, unmatched, bad, ranks = build(rows, our, keys)

    print(f'\n{len(species)} of our species matched the matrix')
    for canon in sorted(species):
        st = species[canon]['structures'].get('adult', {})
        sub = species[canon]['substrates'].get('adult', {})
        bits = [f'{k} {v:g}' for k, v in sorted(st.items(), key=lambda kv: -kv[1])]
        subs = [f'{k} {v:g}' for k, v in sorted(sub.items(), key=lambda kv: -kv[1])]
        print(f'  {canon[:32]:32} adult structures: {", ".join(bits) or "-"}')
        if subs:
            print(f'  {"":32} adult substrates: {", ".join(subs)}')

    if bad:
        print('\n!! HABITAT_TO_STRUCTURE names a class coastal-scoring.js does not have:')
        for k, n in sorted(bad.items()):
            print(f'   {k}  ({n} rows)')
    if unmapped:
        tot = sum(unmapped.values())
        print(f'\n{tot} row(s) on {len(unmapped)} habitat type(s) map to nothing we score:')
        for k, n in sorted(unmapped.items(), key=lambda kv: -kv[1]):
            print(f'   {n:>4}  {k}')
    if unmatched:
        tot = sum(unmatched.values())
        print(f'\n{tot} row(s) on {len(unmatched)} species not in our roster '
              f'(top 12 by row count):')
        for k, n in sorted(unmatched.items(), key=lambda kv: -kv[1])[:12]:
            print(f'   {n:>4}  {k}')

    if a.dry_run:
        print('\ndry run -- nothing written')
        return 0
    if not species:
        print('!! nothing matched -- not writing', file=sys.stderr)
        return 2

    dest = os.path.join(root, 'registry', 'species_habitat_weights.json')
    with open(dest, 'w', encoding='utf-8') as f:
        json.dump({'note': NOTE,
                   'generatedBy': 'build_species_habitat_weights.py',
                   'generated': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                   'source': MATRIX,
                   'region': 'South Atlantic',
                   'rankScale': ranks,
                   'structureClasses': sorted(keys),
                   'species': species,
                   'unmappedHabitatTypes': unmapped,
                   'speciesNotInOurRoster': unmatched}, f, indent=1)
    print(f'\nwrote {dest}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
