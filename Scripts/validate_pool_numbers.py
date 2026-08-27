#!/usr/bin/env python3
"""validate_pool_numbers.py - check the research pipeline's normalPoolFt against known good.

Personal use only, not for distribution or resale; not for navigation.

    py .\\validate_pool_numbers.py --registry "F:\\TrollMapPipeline\\registry"

WHY

The research profiles already carry `normalPoolFt` for 46 waters -- more than a whole day of
reading operator pages by hand produced. Ryan, 2026-08-26: *"I have already ran research profiles
on pretty much every major reservoir we have"*, and then, on being shown the result:
*"right... it is not perfect lol"*.

It is not. Two thirds are simply correct -- Wateree 225.5, Wylie 569.4, Hartwell 660, Keowee 800,
Lanier 1071, Cherokee 1075 -- and the rest fail in three recognisable ways:

    Boone      13,501,400     Jocassee  2.25e13     Ft Loudoun 807,813,000
        a STORAGE VOLUME in acre-feet landing in an elevation field

    Nantahala         100     Norman          1.5
        the DUKE INDEX, where 100 is full pond, landing in a field that wants feet AMSL.
        Worker/conditions.js already documents this exact confusion.

    Thurmond           15     Watauga          44     Burton    10
        truncated -- 330, 1959 and 1866 respectively

None of that is random, so none of it needs a human to catch. This does the catching, and every
check is against a PER-LAKE reference rather than a global band, because a global band is what
flagged Marion and Moultrie -- two real lakes that genuinely sit at 75 ft -- as implausible.

THE VERIFICATION SET IS THE POINT. `registry/full_pool.json` holds values hand-collected from
Duke, Dominion, Santee Cooper, USACE CWMS and a FERC licence document, each recorded with its
source. That file is not the product -- it is the test harness. A derived pipeline that
reproduces it can be trusted on the waters it does not cover.
"""
import argparse, io, json, os, re

DUKE_INDEX_BAND = (80.0, 105.0)     # where a 0-100 pool index masquerades as feet


def J(p, default=None):
    try:
        with io.open(p, encoding='utf-8') as fh: return json.load(fh)
    except Exception: return {} if default is None else default


def tokens(s):
    return set(re.findall(r'[a-z]+', (s or '').lower())) - {
        'lake', 'reservoir', 'the', 'of', 'sc', 'nc', 'ga', 'tn'}


def pool_values(prof):
    """Every normalPoolFt in a profile, WITH ITS PATH. It appears at the top level and under
    `identity`, and where both exist they can disagree -- which is the same field holding two
    quantities, visible inside one document."""
    out = []
    if isinstance(prof.get('normalPoolFt'), (int, float)):
        out.append(('normalPoolFt', float(prof['normalPoolFt'])))
    ident = prof.get('identity')
    if isinstance(ident, dict) and isinstance(ident.get('normalPoolFt'), (int, float)):
        out.append(('identity.normalPoolFt', float(ident['normalPoolFt'])))
    return out


def elevation_reference(binding):
    """A per-lake ceiling from the water's own NWPS flood thresholds, when they are elevations.

    A gauge whose flood stages read 99/100/102/105 is on an operator INDEX, not feet, and says
    nothing about elevation -- so it is refused rather than used. One that reads 656/660/665 is
    feet AMSL, and full pool sits at or just below the lowest flood threshold, because a
    reservoir floods by exceeding it.
    """
    f = ((binding.get('pool') or {}).get('flood')) or {}
    vals = [f.get(k) for k in ('action', 'minor', 'moderate', 'major')]
    vals = [float(v) for v in vals if isinstance(v, (int, float))]
    if not vals: return None
    lo = min(vals)
    if 80.0 <= max(vals) <= 115.0: return None          # an index, not an elevation
    return lo


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', required=True)
    ap.add_argument('--out', default=None, help='default <registry>/_pool_validation.json')
    a = ap.parse_args()
    out_path = a.out or os.path.join(a.registry, '_pool_validation.json')

    profs = J(os.path.join(a.registry, '_research_profiles_cache.json'))
    binds = (J(os.path.join(a.registry, 'water_bindings.json')) or {}).get('bindings') or {}
    known = (J(os.path.join(a.registry, 'full_pool.json')) or {}).get('rows') or {}

    # name -> bound slug. Geometry would be better and the pipeline's own rule demands it, but
    # `gpsCenter` is null on every profile, so name plus state is all there is. State is required
    # rather than optional: it is what stops a Lake Robinson in one state answering for another.
    idx = {}
    for slug, v in binds.items():
        for nm in [v.get('display_name'), slug]:
            idx.setdefault(frozenset(tokens(nm)), []).append((slug, v.get('state')))

    rows, tally = {}, {'match': 0, 'contradicts': 0, 'index_not_feet': 0,
                       'above_reference': 0, 'internally_inconsistent': 0, 'unchecked': 0}
    for pslug, prof in profs.items():
        vals = pool_values(prof)
        if not vals: continue
        names = [prof.get('lakeName'), pslug] + list(prof.get('aliases') or [])
        state = (prof.get('state') or '').upper()
        slug = None
        for nm in names:
            t = tokens(nm)
            for key, cands in idx.items():
                if not t or not (t & key) or len(t & key) < len(t): continue
                for cand, st in cands:
                    if not state or not st or st.upper() == state or state in (st or ''):
                        slug = cand; break
                if slug: break
            if slug: break

        r = {'profile': pslug, 'lakeName': prof.get('lakeName'), 'state': state,
             'bound_slug': slug, 'values': [{'path': p, 'ft': v} for p, v in vals],
             'flags': [], 'verdict': None, 'accepted_ft': None}

        if len({v for _p, v in vals}) > 1:
            r['flags'].append('internally_inconsistent: %s'
                              % ', '.join('%s=%g' % (p, v) for p, v in vals))
            tally['internally_inconsistent'] += 1

        v = vals[0][1]
        truth = (known.get(slug) or {}).get('full_pool_ft') if slug else None
        b = binds.get(slug) or {}
        ref = elevation_reference(b)

        if truth is not None:
            if abs(v - truth) <= 1.0:
                r['verdict'] = 'MATCHES the verified value %.1f' % truth
                r['accepted_ft'] = truth; tally['match'] += 1
            else:
                r['verdict'] = 'CONTRADICTS the verified value %.1f' % truth
                r['accepted_ft'] = truth; tally['contradicts'] += 1
        elif DUKE_INDEX_BAND[0] <= v <= DUKE_INDEX_BAND[1] and ref and ref > 150:
            r['verdict'] = ('looks like an operator INDEX, not feet: the water\'s own flood '
                            'thresholds start at %.1f ft' % ref)
            tally['index_not_feet'] += 1
        elif ref and v > ref + 5:
            r['verdict'] = ('IMPOSSIBLE: %.1f ft is above this water\'s lowest flood threshold '
                            'of %.1f ft' % (v, ref))
            tally['above_reference'] += 1
        elif ref and v < ref - 200:
            r['verdict'] = ('IMPOSSIBLE: %.1f ft is more than 200 ft below its own flood '
                            'threshold of %.1f ft' % (v, ref))
            tally['above_reference'] += 1
        else:
            r['verdict'] = 'no per-lake reference available; not judged'
            tally['unchecked'] += 1
        rows[pslug] = r

    with io.open(out_path, 'w', encoding='utf-8') as fh:
        json.dump({'_note': 'Personal use only, not for distribution or resale; not for '
                            'navigation. Validation of research-profile normalPoolFt against '
                            'registry/full_pool.json and each water\'s own flood thresholds. '
                            'Built by validate_pool_numbers.py.',
                   'profiles_with_a_pool_value': len(rows), 'tally': tally, 'rows': rows}, fh, indent=1)
    print('%d profiles carry a normalPoolFt\n' % len(rows))
    for k, n in tally.items(): print('   %-26s %3d' % (k, n))
    print('\n-> %s' % out_path)
    print('\nthe ones that fail:')
    for s, r in sorted(rows.items()):
        if r['verdict'].startswith(('CONTRADICTS', 'IMPOSSIBLE', 'looks like')):
            print('   %-28s %-12s %s' % (s[:28], '%g' % r['values'][0]['ft'], r['verdict'][:70]))


if __name__ == '__main__':
    main()
