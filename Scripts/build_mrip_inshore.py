#!/usr/bin/env python3
"""
build_mrip_inshore.py -- the inshore roster and its seasons, measured instead of named.

Personal use only, not for distribution or resale; not for navigation.

WHAT IT REPLACES
    SC_INSHORE_ROSTER in Worker/research/coastal-agents.js is five species Ryan named off SCDNR's
    own snapshots. It is right -- but it is one person's list for one state, and Georgia's four
    shipped zones sat with no roster for two days waiting for the same favour.

    MRIP is NOAA's Access Point Angler Intercept Survey: a federal surveyor standing on a dock
    writing down what came off the boat. Eleven years of it are on the drive. It answers "what is
    caught inshore in this state" without anybody being asked.

WHY FREQUENCY ALONE IS NOT A ROSTER, AND THIS IS THE WHOLE DESIGN
    Ranked purely by how often it is intercepted, South Carolina's inshore list runs red drum,
    seatrout, LEFTEYE FLOUNDER GENUS, croaker, PINFISH, UNIDENTIFIED SHARKS, kingfish genus,
    black sea bass, UNIDENTIFIED SKATE OR RAY, black drum. Georgia's adds BONNETHEAD, STINGRAY
    FAMILY and OYSTER TOADFISH inside the top ten.

    Those are real catches and they are not a plan. A roster wants TARGETS.

    So two signals, and a species needs both:

      CAUGHT      MRIP intercepted it in this state's INLAND waters. `AREA_X == 5` is the
                  survey's own field for inland, which means "nothing saltwater that is not
                  inshore" is enforced by the surveyor's classification rather than by a guess
                  of ours about how far out a kayak goes.

      MANAGED     the state's own book gives it a size limit, a creel limit or a season.
                  A stingray has no limit because nobody is trying to keep one.

    The rule is CALIBRATED, not asserted: run against South Carolina it must return the five
    species Ryan already validated by hand. A rule that cannot reproduce a known-good answer has
    no business producing an unknown one, and test_mrip_inshore.py asserts exactly that.

WHAT ELSE COMES OUT OF THE SAME READ
    seasons     intercepts per two-month wave, per species. The seasonality nothing in this
                project has ever had from a source.
    sizes       measured lengths from the survey's own size file.
    bycatch     caught often and NOT managed. Reported, never silently dropped -- an angler who
                keeps hooking oyster toadfish is being told something about the bottom.

WAVE 1 IS EMPTY IN SOUTH CAROLINA AND THAT IS NOT A ZERO
    MRIP does not sample January-February there. A February plan gets no seasonal signal from
    this source, and the output says `sampled: false` for that wave rather than `0`, because a
    zero is a claim that nobody caught anything.

USAGE
    py build_mrip_inshore.py --dry-run
    py build_mrip_inshore.py
"""

import argparse
import csv
import glob
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:
    from build_species_habitat_weights import norm_species, species_alternates
except ImportError:                                          # pragma: no cover
    print('ERROR: build_species_habitat_weights.py must sit beside this script -- the species '
          'name normaliser is defined there and must not be written twice', file=sys.stderr)
    raise

NOTE = 'Personal use only, not for distribution or resale; not for navigation.'

# MRIP's state FIPS. The four the app ships, minus Tennessee, which has no coast.
STATES = {'45': 'SC', '13': 'GA', '37': 'NC'}

# The survey's own area code for inland waters. NOT our judgement about how far out a kayak goes
# -- the surveyor recorded where the trip fished.
INLAND = '5'

# Two-month waves, and what each covers.
WAVES = {'1': 'Jan-Feb', '2': 'Mar-Apr', '3': 'May-Jun',
         '4': 'Jul-Aug', '5': 'Sep-Oct', '6': 'Nov-Dec'}

# A name MRIP could not pin to a species. Kept out of the roster and counted, because
# "LEFTEYE FLOUNDER GENUS" is a real flounder that nobody identified, not a species to plan for.
UNIDENTIFIED = ('genus', 'family', 'unidentified', 'other fish', 'spp')


def _root():
    d = HERE
    for _ in range(4):
        if glob.glob(os.path.join(d, 'ps_*_csv')):
            return d
        d = os.path.dirname(d)
    return os.path.dirname(HERE)


def is_unidentified(name):
    n = str(name or '').lower()
    return any(w in n for w in UNIDENTIFIED)


# ── the book ────────────────────────────────────────────────────────────────────────────────
def managed_species(root):
    """
    {state -> {normalised species name}} out of the parsed regulation books.

    A species with a size limit, a creel limit or a season is one somebody is trying to keep.
    Read from regulations_table.json rather than typed, so a book that gains a species gains it
    here on the next build.

    THE KEY IS `statewide`, AND GUESSING IT COST A RUN. The file also has a `states` key holding
    per-water rules, and the first version read `d.get('states') or d.get('statewide')`, so
    `states` won, produced nothing shaped like a species, and every state came back with an
    EMPTY managed set. The roster was then empty for all three states and every real target
    appeared under `bycatch` -- a result that looks like a finding. There is no fallback now:
    if `statewide` is missing, that is an error worth stopping for.

    Three fields carry the name, and `plan_species` is the best of them because
    build_regulations_table.py has already mapped it into OUR vocabulary.
    """
    p = os.path.join(root, 'registry', 'regulations_table.json')
    with open(p, encoding='utf-8') as f:
        d = json.load(f)
    statewide = d.get('statewide')
    if not isinstance(statewide, dict) or not statewide:
        raise RuntimeError(f'{p} has no "statewide" table -- rebuild it with '
                           'build_regulations_table.py')
    out = defaultdict(set)

    def remember(state, name):
        # BOTH SIDES THROUGH THE SAME EXPANSION. The first version normalised the book's name
        # whole and only expanded the survey's, so Georgia's `plan_species` entry
        # 'Red Drum (Redfish)' became `reddrumredfish` and never met MRIP's `reddrum`.
        # RED DRUM -- in Georgia -- came out as BYCATCH, which is a wrong answer wearing the
        # shape of a finding. South Carolina hid it: its book spells the row 'Red Drum' plainly,
        # so SC matched and GA did not, and only the two states side by side showed it.
        for alt in species_alternates(name):
            k = norm_species(alt)
            if len(k) > 3:
                out[state].add(k)

    for st, rows in statewide.items():
        for r in (rows if isinstance(rows, list) else []):
            # Already mapped to our canon by the regulations build. Cheapest and most reliable.
            for n in (r.get('plan_species') or []):
                remember(st, n)
            for field in ('species', 'label', 'also_covers'):
                raw = r.get(field)
                if not raw:
                    continue
                vals = raw if isinstance(raw, list) else [raw]
                for v in vals:
                    # A row can address several fish: "Striped Bass, White Bass and/or Hybrid",
                    # or carry the aliases inline: "Red drum (Channel bass, Spottail bass,
                    # Redfish)". Splitting on the comma reaches inside the bracket too, which is
                    # wanted -- every one of those names is a name the fish answers to.
                    txt = str(v).replace(' and/or ', ',').replace(' & ', ',')
                    for part in txt.split(','):
                        part = part.strip(' *()').strip()
                        part = re.sub(r'\*+[A-Z]?$', '', part).strip()   # footnote marks
                        if len(part) > 2:
                            remember(st, part)
    return out


# ── the survey ──────────────────────────────────────────────────────────────────────────────
def read_catch(root, states=STATES, inland=INLAND):
    """Stream every catch row for the states we ship, in inland water only."""
    rows = 0
    seen_waves = defaultdict(set)
    counts = defaultdict(Counter)              # state -> species -> intercepts
    waves = defaultdict(lambda: defaultdict(Counter))   # state -> species -> wave -> intercepts
    years = set()
    for folder in sorted(glob.glob(os.path.join(root, 'ps_*_csv'))):
        for path in sorted(glob.glob(os.path.join(folder, 'catch_*.csv'))):
            with open(path, encoding='utf-8-sig', errors='replace') as f:
                for r in csv.DictReader(f):
                    st = states.get(r.get('ST'))
                    if not st:
                        continue
                    if r.get('YEAR'):
                        years.add(r['YEAR'])
                    # Every wave the survey visited this state, whether or not a fish was named.
                    seen_waves[st].add(r.get('WAVE'))
                    if r.get('AREA_X') != inland:
                        continue
                    name = (r.get('COMMON') or '').strip()
                    if not name:
                        continue
                    rows += 1
                    counts[st][name] += 1
                    waves[st][name][r.get('WAVE')] += 1
    return counts, waves, {k: v for k, v in seen_waves.items()}, sorted(years), rows


def read_sizes(root, states=STATES):
    """Measured lengths, inches, per state per species."""
    out = defaultdict(lambda: defaultdict(list))
    for folder in sorted(glob.glob(os.path.join(root, 'ps_*_csv'))):
        for path in sorted(glob.glob(os.path.join(folder, 'size_*.csv'))):
            with open(path, encoding='utf-8-sig', errors='replace') as f:
                for r in csv.DictReader(f):
                    st = states.get(r.get('ST'))
                    name = (r.get('COMMON') or '').strip()
                    if not st or not name:
                        continue
                    try:
                        v = float(r.get('L_IN_BIN') or '')
                    except ValueError:
                        continue
                    if v > 0:
                        out[st][name].append(v)
    return out


def length_stats(vals):
    if not vals:
        return None
    v = sorted(vals)
    return {'n': len(v), 'minIn': v[0], 'medianIn': v[len(v) // 2], 'maxIn': v[-1]}


# ── the rule ────────────────────────────────────────────────────────────────────────────────
def build_roster(counts, managed, min_intercepts=50):
    """
    CAUGHT and MANAGED. Pure, so the calibration test can drive it.

    Returns (roster, bycatch, unseen):
      roster   [{name, intercepts}] ranked, species the book manages and the survey saw
      bycatch  caught at least min_intercepts and NOT in the book -- reported, not dropped
      unseen   in the book and never intercepted inland. Usually offshore, and worth seeing.
    """
    roster, bycatch = [], []
    seen = set()
    for name, n in counts.most_common():
        if is_unidentified(name):
            continue
        keys = {norm_species(a) for a in species_alternates(name)}
        seen |= keys
        if keys & managed:
            roster.append({'name': name, 'intercepts': n})
        elif n >= min_intercepts:
            bycatch.append({'name': name, 'intercepts': n})
    unseen = sorted(managed - seen)
    return roster, bycatch, unseen


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default=None)
    ap.add_argument('--min-intercepts', type=int, default=50,
                    help='how often an unmanaged species must appear to be reported as bycatch')
    ap.add_argument('--top', type=int, default=12, help='roster rows to print per state')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()

    root = a.root or _root()
    if not glob.glob(os.path.join(root, 'ps_*_csv')):
        print(f'ERROR: no ps_*_csv folders under {root}', file=sys.stderr)
        return 2

    managed = managed_species(root)
    print('managed species in the books: '
          + ', '.join(f'{st} {len(v)}' for st, v in sorted(managed.items())))

    counts, waves, seen_waves, years, rows = read_catch(root)
    print(f'{rows:,} inland catch records, {years[0]}-{years[-1]}')
    sizes = read_sizes(root)

    out = {}
    for st in sorted(counts):
        roster, bycatch, unseen = build_roster(counts[st], managed.get(st, set()),
                                               a.min_intercepts)
        sampled = seen_waves.get(st, set())
        species = {}
        for row in roster:
            n = row['name']
            species[n] = {
                'intercepts': row['intercepts'],
                'byWave': {w: ({'sampled': False} if w not in sampled
                               else {'sampled': True, 'intercepts': waves[st][n].get(w, 0)})
                           for w in WAVES},
                'lengthIn': length_stats(sizes.get(st, {}).get(n)),
            }
        out[st] = {'roster': [r['name'] for r in roster],
                   'species': species,
                   'bycatch': bycatch,
                   'managedButNotInterceptedInland': unseen,
                   'wavesSampled': sorted(w for w in sampled if w)}
        print(f'\n== {st}: {len(roster)} on the roster, {len(bycatch)} bycatch, '
              f'{len(unseen)} managed but never seen inland')
        unsampled = [WAVES[w] for w in WAVES if w not in sampled]
        if unsampled:
            print(f'   NOT SAMPLED: {", ".join(unsampled)} -- a plan for those months gets no '
                  'seasonal signal from this source, and that is not a zero')
        for row in roster[:a.top]:
            s = species[row['name']]
            peak = max(((w, v['intercepts']) for w, v in s['byWave'].items() if v['sampled']),
                       key=lambda kv: kv[1], default=(None, 0))
            ln = s['lengthIn']
            print(f"   {row['intercepts']:>6}  {row['name'][:26]:26} "
                  f"peak {WAVES.get(peak[0], '-'):8}"
                  + (f"  median {ln['medianIn']:.0f}\" of {ln['n']}" if ln else ''))
        if bycatch:
            print(f"   bycatch: {', '.join(b['name'].title() for b in bycatch[:6])}"
                  + (' ...' if len(bycatch) > 6 else ''))

    if a.dry_run:
        print('\ndry run -- nothing written')
        return 0

    dest = os.path.join(root, 'registry', 'mrip_inshore.json')
    with open(dest, 'w', encoding='utf-8') as f:
        json.dump({'note': NOTE, 'generatedBy': 'build_mrip_inshore.py',
                   'generated': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                   'source': 'NOAA MRIP Access Point Angler Intercept Survey',
                   'years': years, 'areaCode': INLAND,
                   'areaMeaning': 'inland waters, per the survey\'s own AREA_X field',
                   'rule': 'a species is on the roster when the survey intercepted it inland AND '
                           'the state book gives it a limit or a season',
                   'minInterceptsForBycatch': a.min_intercepts,
                   'waves': WAVES,
                   'states': out}, f, indent=1)
    print(f'\nwrote {dest}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
