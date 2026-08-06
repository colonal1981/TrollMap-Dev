#!/usr/bin/env python3
"""build_water_advisories.py - EPA ATTAINS impairments, bound to waters CONSERVATIVELY.

Personal use only, not for distribution or resale; not for navigation.

    setx EPA_API_KEY "..."          (or pass --key)
    py .\\build_water_advisories.py --registry "F:\\TrollMapPipeline\\registry"

Writes `registry\\water_advisories.json`.

WHAT IT GIVES

Fish-consumption and mercury advisories, bacteria impairments, and SC/GA shellfish closures,
from the EPA Integrated Report. Verified 2026-08-06 — SC unit SC01-01 returns
`epaIRCategory: 5`, `overallStatus: "Not Supporting"`, and FECAL COLIFORM as a Cause against
Shellfish Harvesting.

WHY THIS IS NOT A SPATIAL JOIN, AND WHY THAT MATTERS

ATTAINS assessment units carry **no geometry**. Measured, not assumed:

    assessmentUnitIdentifier "SCSV-200"
    locationDescriptionText  "TUGALOO RVR ARM OF LAKE HARTWELL AT US 123"
    waterTypeCode            "LAKE"
    stateCode                "SC"
    locations                []          <- empty
    monitoringStations       []          <- empty

So there is no HUC, no lat/lon, and nothing to point-in-polygon against. The only tie to a real
water is that free-text description. Everywhere else in this pipeline the rule is **name AND
geometry, never either alone**, and it is not optional: binding TVA's dams by name alone matched
five waters and all five were wrong, each a same-named water in a different state.

That rule cannot be applied here, so the risk is managed instead of pretended away:

  1. **State-scoped.** Every unit carries `stateCode`. All five TVA failures crossed a state
     line — an Alabama dam onto a North Carolina lake — so scoping to the state removes that
     entire failure mode, which is the biggest one.
  2. **Distinctive tokens only.** "Lake", "River", "Creek", "Pond" and the like identify
     nothing. A match must share a token that is not generic.
  3. **AMBIGUITY IS DROPPED, NOT GUESSED.** If a description matches more than one water in
     that state, no binding is written and it is reported instead. This is the important rule:
     Ryan's own `keys_smoke` failure is three pairs of SC lakes sharing a display name in the
     same county — Lake Wallace, Long Pond, McLaurins Millpond — so within-state collisions are
     known to exist here.
  4. **Every record says how it was matched.** `confidence: "name+state"` — deliberately NOT
     the `name+geom` standard used for gauges, so nothing downstream can mistake the two.

**This data is safety-adjacent.** Telling someone the wrong lake has a fish-consumption advisory
is worse than telling them nothing, so the bias is toward silence. Expect fewer bindings than
there are assessment units; that is the intent, not a shortfall.
"""
import argparse, json, os, re, time, urllib.parse, urllib.request
from collections import Counter, defaultdict

API = 'https://api.epa.gov/attains'
UA = 'TrollMap/1.0 (personal fishing app)'
STATES = ('SC', 'NC', 'GA', 'TN')

# Words that name a KIND of water, not which one.
GENERIC = {
    'lake', 'lakes', 'river', 'rvr', 'creek', 'ck', 'pond', 'reservoir', 'res', 'branch',
    'fork', 'run', 'bay', 'sound', 'inlet', 'harbor', 'arm', 'the', 'of', 'at', 'near', 'from',
    'mouth', 'above', 'below', 'upper', 'lower', 'middle', 'north', 'south', 'east', 'west',
    'old', 'new', 'big', 'little', 'dam', 'pool', 'us', 'sc', 'nc', 'ga', 'tn', 'hwy', 'rd',
    'road', 'bridge', 'and', 'to', 'mi', 'km', 'confluence', 'trib', 'tributary', 'unnamed',
}


def get(url, tries=3, pause=0.4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=90) as r:
                d = json.loads(r.read().decode('utf-8', 'replace'))
            time.sleep(pause)
            return d, None
        except Exception as e:
            last = '%s: %s' % (type(e).__name__, e)
            time.sleep(2 * (i + 1))
    return None, last


def tokens(s):
    s = re.sub(r'[^a-z0-9 ]+', ' ', str(s or '').lower())
    return [t for t in s.split() if len(t) >= 3 and t not in GENERIC and not t.isdigit()]


# "LAKE HARTWELL", "HARTWELL LAKE", "RUSSELL RESERVOIR" — the word beside the water-type noun is
# the water being named. Everything else in the description is a landmark.
_NAMED = re.compile(r'\b(?:lake|reservoir|lk|impoundment)\s+([a-z]{3,})\b'
                    r'|\b([a-z]{3,})\s+(?:lake|reservoir|impoundment)\b', re.I)


def norm_phrase(s):
    """Lowercase, punctuation-free, single-spaced — for whole-NAME comparison."""
    s = re.sub(r'\(.*?\)', ' ', str(s or ''))
    s = re.sub(r'[^a-z0-9 ]+', ' ', s.lower())
    return ' ' + ' '.join(s.split()) + ' '


def named_water(desc):
    """Tokens the description explicitly calls a lake, in order of appearance.

    This is grammar, not a guess, and it is what rescues the very first record in the SC
    dataset. "TUGALOO RVR ARM OF LAKE HARTWELL AT US 123" contains two real water names and a
    bag-of-words match finds both `tugaloo_lake` and `hartwell_lake` — so the ambiguity rule
    drops it, correctly but uselessly. A person reads "ARM **OF LAKE HARTWELL**" and knows the
    unit is on Hartwell; Tugaloo is the arm it sits in, named as a landmark.

    So a structurally-named water wins over one merely mentioned. If the structure is itself
    ambiguous, or names nothing in the registry, the bag-of-words path and its drop rule stand.
    """
    out = []
    for m in _NAMED.finditer(str(desc or '')):
        t = (m.group(1) or m.group(2) or '').lower()
        if t and t not in GENERIC and t not in out:
            out.append(t)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--key', default=os.environ.get('EPA_API_KEY') or 'DEMO_KEY',
                    help='api.data.gov key; falls back to $EPA_API_KEY then DEMO_KEY')
    ap.add_argument('--cycle', default='2024')
    ap.add_argument('--out', default=None)
    ap.add_argument('-v', '--verbose', action='store_true')
    a = ap.parse_args()
    if a.key == 'DEMO_KEY':
        print('!! using DEMO_KEY — heavily rate limited. Set EPA_API_KEY.')

    with open(os.path.join(a.registry, 'lake_index.json'), 'r', encoding='utf-8') as fh:
        index = json.load(fh)

    # Lakes bucketed by state, with their distinctive tokens.
    by_state = defaultdict(list)
    for slug, rec in index.items():
        if not isinstance(rec, dict):
            continue
        st = (rec.get('state') or '').upper()
        names = {rec.get('name'), rec.get('display_name')}
        names.update(rec.get('legacy_display_names') or [])
        tk = set()
        phrases = set()
        for n in names:
            tk |= set(tokens(n))
            # The registry's OWN name as a phrase. "LAKE MURRAY NEAR DREHER ISLAND" contains
            # "lake murray" and does NOT contain "murray pond", which separates two waters that
            # share every token. Strongest signal available without geometry.
            pn = norm_phrase(re.sub(r',.*$', '', str(n or '')))
            if len(pn.strip()) >= 6:
                phrases.add(pn.strip())
        if not tk:
            continue
        # A state field can be "SC/NC" on a border water; index under both.
        for s in re.split(r'[^A-Z]+', st):
            if s in STATES:
                by_state[s].append((slug, tk, phrases))
    print('lakes with usable name tokens: %s' % {k: len(v) for k, v in by_state.items()})

    out, report = {}, {'cycle': a.cycle, 'states': {}}
    for st in STATES:
        d, err = get('%s/states/%s/organizations?api_key=%s' % (API, st, a.key))
        orgs = [x.get('code') for x in ((d or {}).get('data') or []) if x.get('code')]
        if not orgs:
            report['states'][st] = {'error': err or 'no organizations returned'}
            print('  %s: no organizations (%s)' % (st, err))
            continue

        units, assess = {}, {}
        for org in orgs:
            d, err = get('%s/assessmentUnits?organizationId=%s&api_key=%s'
                         % (API, urllib.parse.quote(org), a.key))
            for blk in ((d or {}).get('items') or []):
                for u in (blk.get('assessmentUnits') or [blk]):
                    uid = u.get('assessmentUnitIdentifier')
                    if uid:
                        units[uid] = u
            d, err = get('%s/assessments?organizationId=%s&reportingCycle=%s&api_key=%s'
                         % (API, urllib.parse.quote(org), a.cycle, a.key))
            for blk in ((d or {}).get('items') or []):
                for x in (blk.get('assessments') or [blk]):
                    uid = x.get('assessmentUnitIdentifier')
                    if uid:
                        assess[uid] = x

        bound = amb = nomatch = 0
        ambiguous = []
        pool = by_state.get(st, [])
        for uid, u in units.items():
            # Only water a boat is on. A unit typed STREAM 450 m up a creek is not the lake.
            if (u.get('waterTypeCode') or '').upper() not in ('LAKE', 'RESERVOIR', 'ESTUARY', 'BAY'):
                continue
            desc = ' '.join(str(u.get(k) or '') for k in
                            ('locationDescriptionText', 'assessmentUnitName'))
            dtok = set(tokens(desc))
            if not dtok:
                continue
            dphrase = norm_phrase(desc)
            # TIER 1 — the registry's own name appears verbatim in the description.
            exact = [slug for slug, _tk, ph in pool if any((' ' + p + ' ') in dphrase for p in ph)]
            hits = exact if len(exact) == 1 else [slug for slug, tk, _p in pool if tk & dtok]
            how = 'name+state (exact registry name in the description)' if len(exact) == 1 else 'name+state'
            if len(hits) > 1:
                # Prefer a water the description STRUCTURALLY names ("...OF LAKE HARTWELL...")
                # over one it merely mentions as a landmark. See named_water().
                nw = set(named_water(desc))
                if nw:
                    strong = [slug for slug, tk, _p in pool if slug in hits and (tk & nw)]
                    if len(strong) == 1:
                        hits = strong
                        how = 'name+state (structural: description calls it a lake)'
            if len(hits) > 1:
                # The rule that matters. Three pairs of SC lakes share a display name in the
                # same county, so "more than one match" is a real state here, not a corner case.
                amb += 1
                ambiguous.append({'unit': uid, 'desc': desc.strip()[:90], 'candidates': hits[:6]})
                continue
            if not hits:
                nomatch += 1
                continue
            slug = hits[0]
            asmt = assess.get(uid) or {}
            causes = []
            for p in (asmt.get('parameters') or []):
                if (p.get('parameterStatusName') or '') == 'Cause' and p.get('parameterName'):
                    causes.append({
                        'parameter': p['parameterName'],
                        'uses': [au.get('associatedUseName') for au in (p.get('associatedUses') or [])
                                 if au.get('associatedUseName')],
                    })
            uses = [{'use': ua.get('useName'), 'status': ua.get('useAttainmentCodeName')}
                    for ua in (asmt.get('useAttainments') or []) if ua.get('useName')]
            entry = {
                'unit': uid,
                'unit_name': u.get('assessmentUnitName'),
                'where': (u.get('locationDescriptionText') or '').strip() or None,
                'water_type': u.get('waterTypeCode'),
                'state': st,
                'epa_category': asmt.get('epaIRCategory'),
                'status': asmt.get('overallStatus'),
                'assessed': asmt.get('cycleLastAssessedText'),
                'causes': causes,
                'uses': uses,
                # NOT name+geom. ATTAINS ships no geometry; see the module docstring.
                'confidence': how,
            }
            out.setdefault(slug, []).append(entry)
            bound += 1
            if a.verbose:
                print('   %-26s <- %-12s %s' % (slug, uid, entry['where'] or ''))

        report['states'][st] = {'organizations': orgs, 'units': len(units),
                                'assessments': len(assess), 'bound': bound,
                                'ambiguous_dropped': amb, 'unmatched': nomatch,
                                'ambiguous_sample': ambiguous[:15]}
        print('  %s: %d units, %d bound, %d dropped as ambiguous, %d unmatched'
              % (st, len(units), bound, amb, nomatch))

    dest = a.out or os.path.join(a.registry, 'water_advisories.json')
    with open(dest, 'w', encoding='utf-8') as fh:
        json.dump({'_note': 'ATTAINS has NO geometry — these are name+state matches, and any '
                            'description matching more than one water in its state was DROPPED '
                            'rather than guessed. Safety-adjacent data; bias is toward silence.',
                   'cycle': a.cycle, 'report': report, 'waters': out}, fh, indent=1)
    tot = sum(len(v) for v in out.values())
    print('\n%d waters carry %d assessment(s)' % (len(out), tot))
    print('   dropped as ambiguous: %d' % sum(r.get('ambiguous_dropped', 0)
                                              for r in report['states'].values() if isinstance(r, dict)))
    print('   ^ read those before widening the match. An advisory on the wrong lake is worse '
          'than none.')
    print('-> %s' % dest)


if __name__ == '__main__':
    main()
