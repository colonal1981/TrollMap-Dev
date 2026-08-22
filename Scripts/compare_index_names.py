#!/usr/bin/env python3
r"""compare_index_names.py - what a lake_index.json rebuild LOST.

Personal use only, not for distribution or resale; not for navigation.

    py .\compare_index_names.py --before registry\lake_index.before.json `
                                --after  registry\lake_index.json

Exit code 1 if anything was lost, 0 if nothing was.

WHY THIS EXISTS

The three hardcoded lists -- scdnr-state-lakes.js, user-known-lakes.js and curated_lakes.json --
are being retired in favour of names harvested from the live ramp feeds. The migration is only
safe if NOTHING a person could type stops resolving, and "the index still has 452 rows" does not
show that: a row can survive while every name anybody actually uses for it disappears.

So this compares the two things that break silently:

  * every string either index answers to -- name, display_name, legacy_display_name and every
    entry of legacy_display_names -- normalised the way the app normalises. A name that
    resolved before and resolves to nothing now is a REGRESSION.
  * a name that now resolves to a DIFFERENT slug. That is worse than losing it. `'High Falls
    Lake, GA'` resolved to `falls_lake` in NORTH CAROLINA once a mapping was cut, because
    cutting a name does not retire it, it RE-POINTS it.

Additions are reported but are never a failure -- the feeds are expected to add.

Run it BEFORE deleting any of the three lists, with both indexes built while the lists are
still in place, and again after. Deleting first and checking after is how six coastal zones
went missing for eight days.
"""
from __future__ import annotations
import argparse, json, re, sys


def norm(s):
    """Whole normalised string, never a substring -- plain substring matching cannot be made
    safe and this repo has paid for that five times."""
    s = re.sub(r'\([^)]*\)', ' ', s or '')
    s = re.sub(r',\s*[A-Za-z]{2}(\s*/\s*[A-Za-z]{2})*\s*$', ' ', s)
    return re.sub(r'[^a-z0-9]+', ' ', s.lower()).strip()


def load(path):
    d = json.load(open(path, encoding='utf-8'))
    rows = d if isinstance(d, list) else (d.get('lakes') or list(d.values()))
    if isinstance(rows, dict):
        rows = list(rows.values())
    return [r for r in rows if isinstance(r, dict) and r.get('slug')]


def names_of(r):
    out = [r.get('name'), r.get('display_name'), r.get('legacy_display_name')]
    out += list(r.get('legacy_display_names') or [])
    return {norm(x): x for x in out if norm(x)}


def index_names(rows):
    """normalised name -> set of slugs that answer to it, plus one raw spelling for reporting."""
    who, raw = {}, {}
    for r in rows:
        for n, spell in names_of(r).items():
            who.setdefault(n, set()).add(r['slug'])
            raw.setdefault(n, spell)
    return who, raw


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--before', required=True)
    ap.add_argument('--after', required=True)
    ap.add_argument('--show', type=int, default=25, help='how many of each list to print')
    a = ap.parse_args()

    B, A = load(a.before), load(a.after)
    bs = {r['slug']: r for r in B}
    as_ = {r['slug']: r for r in A}
    bw, braw = index_names(B)
    aw, araw = index_names(A)

    bad = 0
    print('rows   before %d   after %d' % (len(B), len(A)))
    gone_rows = sorted(set(bs) - set(as_))
    new_rows = sorted(set(as_) - set(bs))
    if gone_rows:
        bad += len(gone_rows)
        print('\nROWS LOST (%d):' % len(gone_rows))
        for s in gone_rows[:a.show]:
            print('   %-40s was %s' % (s, bs[s].get('display_name') or bs[s].get('name')))
    if new_rows:
        print('\nrows added (%d): %s' % (len(new_rows), ', '.join(new_rows[:a.show])))

    lost = sorted(n for n in bw if n not in aw)
    if lost:
        bad += len(lost)
        print('\nNAMES THAT NO LONGER RESOLVE (%d):' % len(lost))
        for n in lost[:a.show]:
            print('   %-44s went to %s' % (braw[n], ', '.join(sorted(bw[n]))))
        if len(lost) > a.show:
            print('   ... %d more' % (len(lost) - a.show))

    moved = []
    for n in bw:
        if n in aw and not (bw[n] & aw[n]):
            moved.append(n)
    if moved:
        bad += len(moved)
        print('\nNAMES NOW POINTING AT A DIFFERENT WATER (%d) -- worse than losing them:'
              % len(moved))
        for n in sorted(moved)[:a.show]:
            print('   %-40s %s  ->  %s'
                  % (braw[n], ', '.join(sorted(bw[n])), ', '.join(sorted(aw[n]))))

    added = [n for n in aw if n not in bw]
    print('\nnames added: %d  (expected -- the feeds add)' % len(added))

    lost_notes = [s for s in bs if bs[s].get('note') and not (as_.get(s) or {}).get('note')]
    if lost_notes:
        bad += len(lost_notes)
        print('\nNOTES LOST (%d): %s' % (len(lost_notes), ', '.join(sorted(lost_notes))))

    print('\n%s' % ('NOTHING LOST' if not bad else '%d PROBLEM(S) -- do not delete anything yet'
                    % bad))
    return 1 if bad else 0


if __name__ == '__main__':
    raise SystemExit(main())
