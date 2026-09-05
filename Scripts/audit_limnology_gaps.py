#!/usr/bin/env python3
r"""audit_limnology_gaps.py -- where the thermocline stands on every water the app offers.

    py .\scripts\audit_limnology_gaps.py --registry "F:\TrollMapPipeline\registry"
    py .\scripts\audit_limnology_gaps.py --registry "F:\TrollMapPipeline\registry" --min-acres 1000

WHY THIS EXISTS. "How many lakes still need limnology" has been answered from one place at a
time and been wrong every time, in the same shape as the species count that produced the data
map. There are THREE places a thermocline can come from and they do not agree:

    the stored profile        limnology.thermocline.summerDepthFt -- what the app actually shows
    the WQP pull              _wqpLimnology, on the profile: derived from depth profiles, or a
                              REFUSAL that names its reason ("surface/grab samples only")
    registry/nla_limnology.json   EPA National Lakes Assessment 2007/2012/2022, matched by
                              point-in-polygon. 137 waters, 87 thermoclines, 74 anoxic depths.

NOTHING READS THE THIRD ONE. Measured 2026-09-05: `nla_limnology.json` is written by
fetch_nla_limnology.py, shipped to R2 by upload_garmin_to_r2.py, and opened by no other file in
the repo. Eighty-seven thermoclines and seventy-four anoxic boundaries sit on the drive and in
the bucket and reach no plan. Ryan's rule: do not leave unused objects behind, this is how stuff
gets missed.

A WATER WITH NO NUMBER IS NOT AUTOMATICALLY A GAP. Three of these outcomes are ANSWERS:

    answered            a depth, from whichever source
    does not stratify   a reasoned refusal off real depth readings -- White Lake's summer DO
                        never fell under 4 mg/L at any depth and the largest step was 2.3 degF
    needs a source      WQP was asked and its records are surface grabs only. No amount of
                        better querying reaches a profile that was never submitted.
    never asked         no pull, or no profile at all

Only the last two are work, and only the third needs a human to go and find something.

The name binding is IMPORTED from build_data_map.py rather than written again -- a third copy of
"which profile serves this slug" is how the approve and delete paths drifted apart.
"""
from __future__ import annotations
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_data_map import name_index, COUNTY_TAIL          # noqa: E402  one resolver, not three

OUT_NAME = '_limnology_gaps.json'

# A refusal that names depth data it could not use, versus one that names an absence of depth
# data. The first is an ANSWER about the lake; the second is a gap in the feed.
NO_STRATIFY = ('did not stratify', 'no thermocline', 'never fell under', 'no layer reaches')


def first(seq, pick):
    for x in seq:
        v = pick(x)
        if v is not None:
            return v, x
    return None, None


def classify(row, prof, nla):
    """(state, detail). Order matters: what the APP shows wins, then what we hold unused."""
    # A THERMOCLINE IS A LAKE QUESTION. The index offers 284 lakes, 58 rivers and 13 coastal
    # zones; a river does not stratify and an estuary's structure is tidal, not thermal. Counting
    # them as "never asked" put 49 rivers and every coastal zone at the top of a gap list sorted
    # by surface acres -- ACE Basin at 558,752 acres above Lake Murray. That is the census
    # lesson again: a population answers the question it was counted for.
    if (row.get('feature_type') or 'lake') != 'lake':
        return 'not_applicable', {'feature_type': row.get('feature_type')}

    lim = (prof or {}).get('limnology') or {}
    th = (lim.get('thermocline') or {}).get('summerDepthFt')
    ox = lim.get('oxygen') or {}
    wqp = (prof or {}).get('_wqpLimnology') or {}
    visits = (nla or {}).get('visits') or []

    if th is not None:
        return 'answered', {'depthFt': th, 'from': 'profile',
                            'method': (lim.get('thermocline') or {}).get('method'),
                            'anoxicBelowFt': ox.get('anoxicBelowFt')}

    nla_th, visit = first(visits, lambda v: v.get('thermoclineFt'))
    if nla_th is not None:
        return 'nla_unused', {'depthFt': nla_th, 'from': 'nla_limnology.json',
                              'year': visit.get('year'), 'note': visit.get('thermoclineNote'),
                              'anoxicBelowFt': visit.get('anoxicBelowFt'),
                              'depletionDepthFt': visit.get('depletionDepthFt')}

    # A reasoned no-stratify off real readings, from either source.
    note = str(wqp.get('note') or '')
    if wqp.get('depthProfileCount') and any(s in note.lower() for s in NO_STRATIFY):
        return 'does_not_stratify', {'from': 'wqp', 'note': note,
                                     'depthProfileCount': wqp.get('depthProfileCount')}
    for v in visits:
        n = str(v.get('thermoclineNote') or '')
        if v.get('readings') and any(s in n.lower() for s in NO_STRATIFY):
            return 'does_not_stratify', {'from': 'nla', 'note': n, 'year': v.get('year'),
                                         'readings': v.get('readings'),
                                         'anoxicBelowFt': v.get('anoxicBelowFt'),
                                         'depletionDepthFt': v.get('depletionDepthFt')}

    # ASKED, ANSWERED "I CANNOT", IS NOT "NEVER ASKED".
    #
    # The first version of this required `not depthProfileCount`, so a pull that DID return depth
    # rows and still could not derive a depth fell through to `never_asked` -- 13 of the 14 lakes
    # over 1,000 acres in that bucket had a pull, including Murray, Keowee and Badin. The pull
    # writes its own reason and there are three of them, all honest and all meaning the same
    # thing for the work: no vertical profile is going to come out of WQP for this water.
    #
    #   surface/grab samples only -- no vertical depth profiles       Moultrie
    #   every record carries a depth but they fall in one 2 ft band   Murray, Keowee, Greenwood
    #   depth-profile records exist but were insufficient             Badin, Bay Tree
    #
    # The middle one is the same fact as the first wearing a depth stamp: SCDES writes 1 ft on a
    # grab the way Santee Cooper writes 0.3 m. Grouped in the report by that reason, because
    # "the state publishes no profiles here" and "the state publishes thin ones" are different
    # things to go looking for.
    if wqp.get('ok') and (wqp.get('recordCount') or 0) > 0:
        why = wqp.get('surfaceOnlyNote') or wqp.get('note') or 'pull returned no thermocline'
        low = why.lower()
        # THE MOST SPECIFIC TEST FIRST. The one-band note ENDS with "These are surface grabs
        # with a depth stamp", so a `surface grab` test placed above it swallowed Murray,
        # Keowee and Greenwood into "no depth profiles submitted" while their own rows said 68,
        # 31 and 21 records carried a depth. The two readings send you to different places.
        if 'one 2 ft band' in low or 'depth stamp' in low:
            reason = 'depth stamped on a grab, one band'
        elif 'surface/grab samples only' in low or 'surface grab' in low:
            reason = 'no depth profiles submitted'
        elif 'insufficient' in low:
            reason = 'profiles too thin to derive one'
        else:
            reason = 'other'
        return 'needs_a_source', {'from': 'wqp refused', 'reason': reason,
                                  'recordCount': wqp.get('recordCount'),
                                  'depthProfileCount': wqp.get('depthProfileCount'),
                                  'why': why, 'inNla': bool(visits)}

    return 'never_asked', {'hasProfile': prof is not None,
                           'hasWqpPull': bool(wqp), 'inNla': bool(visits)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', default=os.environ.get('TROLLMAP_REGISTRY',
                                                         r'F:\TrollMapPipeline\registry'))
    ap.add_argument('--min-acres', type=float, default=0.0,
                    help='only list waters at or above this size in the gap tables')
    ap.add_argument('--out', default=None)
    a = ap.parse_args(argv)
    reg = a.registry
    if not os.path.isdir(reg):
        raise SystemExit('registry not found: %s' % reg)

    idx_path = os.path.join(reg, 'lake_index.json')
    if not os.path.exists(idx_path):
        raise SystemExit('no lake_index.json in %s' % reg)
    IDX = {k: v for k, v in json.load(open(idx_path, encoding='utf-8')).items()
           if isinstance(v, dict)}

    prof_dir = os.path.join(reg, '_research_profiles')
    if not os.path.isdir(prof_dir):
        raise SystemExit('no _research_profiles in %s -- run mirror_research_profiles.py first'
                         % reg)

    nla_path = os.path.join(reg, 'nla_limnology.json')
    NLA = {}
    if os.path.exists(nla_path):
        NLA = (json.load(open(nla_path, encoding='utf-8')) or {}).get('waters') or {}
    else:
        print('!! nla_limnology.json is missing -- run fetch_nla_limnology.py --go')

    # profile -> slug, through the SAME name index the data map uses.
    byname = name_index(IDX)
    prof_by_slug, unbound = {}, []
    for f in sorted(os.listdir(prof_dir)):
        if not f.endswith('.json') or f.startswith('_'):
            continue
        try:
            p = json.load(open(os.path.join(prof_dir, f), encoding='utf-8'))
        except Exception as exc:
            unbound.append((f, type(exc).__name__))
            continue
        raw = str(p.get('lakeName') or '').strip().lower()
        cands = byname.get(raw) or byname.get(COUNTY_TAIL.sub('', raw).strip()) or set()
        if len(cands) == 1:
            prof_by_slug.setdefault(next(iter(cands)), p)
        else:
            unbound.append((f, 'ambiguous' if cands else 'no index name matches'))

    buckets = {}
    rows = []
    for slug, row in IDX.items():
        state, detail = classify(row, prof_by_slug.get(slug), NLA.get(slug))
        rec = {'slug': slug,
               'display_name': row.get('display_name') or row.get('name') or slug,
               'state': row.get('state'), 'acres': row.get('area_acres'),
               'feature_type': row.get('feature_type'),
               'verdict': state, **detail}
        rows.append(rec)
        buckets.setdefault(state, []).append(rec)

    order = ['answered', 'nla_unused', 'does_not_stratify', 'needs_a_source',
             'never_asked', 'not_applicable']
    lakes = [r for r in rows if r['verdict'] != 'not_applicable']
    big = [r for r in lakes if (r.get('acres') or 0) >= 1000]
    print('%d waters offered -- %d lakes, %d rivers/coastal (a thermocline is a lake question)'
          % (len(IDX), len(lakes), len(rows) - len(lakes)))
    print('                       all lakes    lakes >= 1,000 ac')
    for k in order:
        if k == 'not_applicable':
            continue
        n_all = len(buckets.get(k, []))
        n_big = sum(1 for r in buckets.get(k, []) if (r.get('acres') or 0) >= 1000)
        print('   %-18s %6d %14d' % (k, n_all, n_big))
    print('   %-18s %6d %14d' % ('TOTAL', len(lakes), len(big)))
    if unbound:
        print('   (%d mirrored profile(s) bound to no offered water)' % len(unbound))

    def table(key, title, limit=None):
        got = [r for r in buckets.get(key, [])
               if (r.get('acres') or 0) >= a.min_acres]
        got.sort(key=lambda r: -(r.get('acres') or 0))
        if not got:
            return
        print()
        print('%s -- %d water(s)%s' % (title, len(got),
              '' if not a.min_acres else ' at or above %g acres' % a.min_acres))
        for r in got[:limit or len(got)]:
            print('   %-46s %-3s %9s ac  %s'
                  % (r['display_name'][:46], r.get('state') or '',
                     ('%.0f' % r['acres']) if r.get('acres') else '?',
                     (r.get('why') or r.get('note') or '')[:60]))

    table('nla_unused', 'ALREADY ON DISK AND NOT WIRED -- NLA has a depth the profile lacks')

    got = [r for r in buckets.get('needs_a_source', []) if (r.get('acres') or 0) >= a.min_acres]
    if got:
        print()
        print('NEEDS AN OUTSIDE SOURCE -- WQP was asked and cannot answer -- %d water(s)%s'
              % (len(got), '' if not a.min_acres else ' at or above %g acres' % a.min_acres))
        by_reason = {}
        for r in got:
            by_reason.setdefault(r.get('reason') or 'other', []).append(r)
        for reason in sorted(by_reason):
            rs = sorted(by_reason[reason], key=lambda r: -(r.get('acres') or 0))
            print('   %s -- %d' % (reason, len(rs)))
            for r in rs:
                print('      %-44s %-3s %9s ac   %s records, %s with a depth'
                      % (r['display_name'][:44], r.get('state') or '',
                         ('%.0f' % r['acres']) if r.get('acres') else '?',
                         r.get('recordCount'), r.get('depthProfileCount')))

    table('never_asked', 'NEVER ASKED -- no pull at all')

    out_fp = a.out or os.path.join(reg, OUT_NAME)
    doc = {'generated': __import__('datetime').date.today().isoformat(),
           'registry': reg,
           'offered': len(IDX),
           'min_acres_in_tables': a.min_acres,
           'counts': {k: len(buckets.get(k, [])) for k in order},
           'unbound_profiles': [{'file': f, 'why': w} for f, w in unbound],
           'waters': sorted(rows, key=lambda r: (r['verdict'], -(r.get('acres') or 0)))}
    with open(out_fp, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write('\n')
    print()
    print('-> %s   (%d KB)' % (out_fp, round(os.path.getsize(out_fp) / 1024)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
