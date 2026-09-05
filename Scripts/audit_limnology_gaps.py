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


# Worker/research/limnology.js needs three summer dissolved-oxygen records carrying a depth, and
# it bins them at 2 ft and takes the first bin whose median falls under 4 mg/L. Not a knob: it is
# the rule's own minimum, and the bins have to clear it too -- see the branch below.
RULE_NEEDS = 3


def hidden_by(probe, hidden):
    """WHICH CEILING IS IT, BECAUSE THERE TURNED OUT TO BE TWO.

    The probe's headline counts are the BEST of the two WQP dialects, so a water whose depth
    records exist only in WQX 3.0 reads here exactly like one the 2015 window alone is hiding --
    and `Worker/research/limnology.js` asks 2.2. Lake Bowen, measured 2026-09-05: 43 summer
    depth-bearing oxygen records in 3.0, ZERO in 2.2. Widening the window alone would have
    returned nothing and looked like a bug in the widening.

    Returns the list of things standing between the app and the number, so the report can stop
    saying "the only thing in the way" about a water where it is not.
    """
    out = ['the 2015 window']
    by = (probe or {}).get('by_api') or {}
    legacy, wqx3 = by.get('legacy'), by.get('wqx3')

    # THREE WAYS TO HAVE NO 3.0 ANSWER, AND THEY SEND A PERSON TO THREE DIFFERENT PLACES.
    # The first version of this said "not asked; re-run with --api both" over Badin Lake, which
    # HAD been asked with --api both and got HTTP 500 -- telling Ryan to do the thing he had just
    # done. And a leg deliberately skipped because 2.2 already answered is not a ceiling at all.
    if not isinstance(wqx3, dict):
        out.append('unknown -- the 3.0 service was not asked; re-run the probe with --api both')
        return out
    if 'error' in wqx3:
        out.append('unknown -- the 3.0 service failed (%s); it needs asking again'
                   % str(wqx3['error'])[:60])
        return out
    if 'not_asked' in wqx3:
        return out                       # skipped on purpose: 2.2 answered, 3.0 could not add

    if isinstance(legacy, dict) and 'error' not in legacy \
            and (legacy.get('hidden_summer_do_depth_recs') or 0) < RULE_NEEDS <= hidden:
        out.append('the 2.2 service the Worker asks -- these records are only in WQX 3.0')
    return out


def classify(row, prof, nla, probe=None):
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

    # THE WINDOW, NOT THE LAKE. probe_wqp_depth_history.py asks WQP with no start date and
    # counts the summer dissolved-oxygen records that carry a depth and fall BEFORE 2015-01-01 --
    # the ones Worker/research/limnology.js cannot see. The rule needs three. Lake Moultrie has
    # 2,788 across 30 two-foot bins and its profile says "surface/grab samples only", which was
    # a true statement about the window and a false one about the lake.
    #
    # This outranks the WQP verdict below because it is the SAME SOURCE asked a wider question.
    hidden = (probe or {}).get('hidden_summer_do_depth_recs') or 0
    bins = (probe or {}).get('distinct_2ft_bins') or 0
    # AND THE BINS HAVE TO CLEAR IT TOO, BECAUSE A STACK OF GRABS IS NOT A CAST.
    #
    # Measured 2026-09-05 on the both-dialect census, three waters crossed the three-record line
    # for the first time and only one of them is a profile:
    #
    #   lake_william_c_bowen   43 records   8 bins   0.1 to 32.2 ft    a cast
    #   cherokee_lake          60 records   2 bins   0.0 to 220.0 ft   two depths, 220 ft apart
    #   watauga_lake            8 records   1 bin    1.0 to 1.0 ft     eight grabs at one foot
    #
    # Counting records and not their spread is the Wateree mistake exactly -- 3,211 records in a
    # single 2 ft band, which the Worker's own note already calls "surface grabs with a depth
    # stamp". The probe computes `distinct_2ft_bins` for this reason and the ledger was ignoring
    # it. Applied across all 48 waters that clear the record test, this drops those two and keeps
    # the other 46.
    if hidden >= RULE_NEEDS and bins >= RULE_NEEDS:
        return 'window_is_hiding_it', {
            'from': 'wqp, full history', 'hidden_summer_do_depth_recs': hidden,
            'hidden_by': hidden_by(probe, hidden),
            'distinct_2ft_bins': (probe or {}).get('distinct_2ft_bins'),
            'max_depth_ft': (probe or {}).get('max_depth_ft'),
            'organizations': (probe or {}).get('hidden_organizations'),
            'deepest': (probe or {}).get('deepest')}

    nla_th, visit = first(visits, lambda v: v.get('thermoclineFt'))
    if nla_th is not None:
        return 'nla_unused', {'depthFt': nla_th, 'from': 'nla_limnology.json',
                              'year': visit.get('year'), 'note': visit.get('thermoclineNote'),
                              'anoxicBelowFt': visit.get('anoxicBelowFt'),
                              'depletionDepthFt': visit.get('depletionDepthFt')}

    # AN OXYGEN DEPTH WITHOUT A THERMOCLINE IS STILL SOMETHING WE HOLD AND DO NOT USE.
    # The branch above only fires on a thermocline, so a water whose NLA visit produced an
    # anoxic or depletion boundary and no thermocline fell through to a gap verdict. Measured
    # 2026-09-05: one water, Little Ocmulgee Lake, 238 acres, depletion at 3.3 ft. Small, and
    # exactly the shape of hole that is large somewhere else next month.
    nla_ox, oxvisit = first(visits, lambda v: v.get('anoxicBelowFt') if v.get('anoxicBelowFt')
                            is not None else v.get('depletionDepthFt'))
    if nla_ox is not None and ox.get('anoxicBelowFt') is None \
            and ox.get('depletionDepthFt') is None:
        return 'nla_unused', {'depthFt': None, 'from': 'nla_limnology.json (oxygen only)',
                              'year': oxvisit.get('year'),
                              'anoxicBelowFt': oxvisit.get('anoxicBelowFt'),
                              'depletionDepthFt': oxvisit.get('depletionDepthFt'),
                              'note': oxvisit.get('anoxicNote') or oxvisit.get('depletionNote')}

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
    # RECORDS WITHOUT A COLUMN. The probe saw enough rows and they do not describe a water
    # column, so this is a gap -- but a differently shaped one from "the state publishes no
    # profiles here", and it is a wider fact than the Worker's 2015-window note, so it is said
    # first. NLA still wins above this: a depth we already hold beats a refusal.
    if hidden >= RULE_NEEDS:
        return 'needs_a_source', {
            'from': 'wqp, full history', 'reason': 'records without a column',
            'hidden_summer_do_depth_recs': hidden, 'distinct_2ft_bins': bins,
            'organizations': (probe or {}).get('hidden_organizations'),
            'why': '%d summer depth-bearing oxygen records across only %d distinct 2 ft band(s), '
                   '%s to %s ft. A stack of grabs, not a cast.'
                   % (hidden, bins, (probe or {}).get('min_depth_ft'),
                      (probe or {}).get('max_depth_ft'))}

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

    probe_path = os.path.join(reg, '_wqp_depth_history.json')
    PROBE = {}
    if os.path.exists(probe_path):
        pdoc = json.load(open(probe_path, encoding='utf-8')) or {}
        PROBE = pdoc.get('waters') or {}
        print('probe: %s waters, %s of %s, complete=%s'
              % (len(PROBE), pdoc.get('done'), pdoc.get('of'), pdoc.get('complete')))
    else:
        print('!! no _wqp_depth_history.json -- run probe_wqp_depth_history.py to learn what the '
              '2015 window is hiding')

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
        state, detail = classify(row, prof_by_slug.get(slug), NLA.get(slug),
                                 PROBE.get(slug))
        rec = {'slug': slug,
               'display_name': row.get('display_name') or row.get('name') or slug,
               'state': row.get('state'), 'acres': row.get('area_acres'),
               'feature_type': row.get('feature_type'),
               'verdict': state, **detail}
        rows.append(rec)
        buckets.setdefault(state, []).append(rec)

    order = ['answered', 'window_is_hiding_it', 'nla_unused', 'does_not_stratify',
             'needs_a_source', 'never_asked', 'not_applicable']
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

    got = [r for r in buckets.get('window_is_hiding_it', []) if (r.get('acres') or 0) >= a.min_acres]
    got.sort(key=lambda r: -(r.get('acres') or 0))

    def hiding_lines(rows):
        for r in rows:
            print('   %-42s %-3s %8s ac  %6d summer DO before 2015, %2d bins, to %s ft  [%s]'
                  % (r['display_name'][:42], r.get('state') or '',
                     ('%.0f' % r['acres']) if r.get('acres') else '?',
                     r['hidden_summer_do_depth_recs'], r.get('distinct_2ft_bins') or 0,
                     r.get('max_depth_ft'), ', '.join(r.get('organizations') or [])))
            for extra in (r.get('hidden_by') or [])[1:]:
                print('        and %s' % extra)

    # ONE HEADLINE PER CAUSE. "The only thing in the way" was printed over Lake Bowen, whose
    # records are not in the service the Worker asks at all -- so widening the window would have
    # changed nothing and the report would have been the reason someone believed it should.
    only = [r for r in got if len(r.get('hidden_by') or ['x']) <= 1]
    also = [r for r in got if len(r.get('hidden_by') or ['x']) > 1]
    if only:
        print()
        print('THE 2015 WINDOW IS THE ONLY THING IN THE WAY -- %d water(s). Same feed, wider ask.'
              % len(only))
        hiding_lines(only)
    if also:
        print()
        print('THE WINDOW IS NOT THE ONLY THING IN THE WAY -- %d water(s). Widening it alone '
              'returns nothing here.' % len(also))
        hiding_lines(also)

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
