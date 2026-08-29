#!/usr/bin/env python3
"""declare_species_with_no_home.py - close the vocabulary against the books, without guessing.

Personal use only, not for distribution or resale; not for navigation.

PowerShell:

    py .\\declare_species_with_no_home.py --registry "F:\\TrollMapPipeline\\registry"
    py .\\declare_species_with_no_home.py --registry "..." --write

WHY THIS EXISTS

`registry/species_map.json` maps what the books call a fish to what the plan form offers, and its
own rule is that a phrase in none of its blocks is a BUILD ERROR rather than a silent skip. That
rule was being enforced against half a book. check_species_map() skipped every row marked
`statewide coastal` on the reasoning that a coastal species has no checkbox in a freshwater form
-- true, and it is the conclusion the map exists to RECORD, not a reason to stop looking. Ryan,
2026-08-29: "freshwater and saltwater need to be handled exactly the same way... it is the same
damn book."

With the skip removed the check reads all four books whole and finds 80 phrases the map has never
seen -- SC's five saltwater pages and GA's one. Seventy-six of them are marine fish this app will
never plan around. FOUR ARE NOT, and that is the finding:

    Striped bass (Savannah River)              GA p84   <- a water we ship
    Striped bass (Saltwater)                   GA p84
    Hybrid Bass, White Bass, & Combinations    SC p50   <- two plan species, INSHORE FINFISH
    Saltwater Catfishes (Hardhead & gafftopsail catfishes)  SC p50

The first three name species the plan form offers. The fourth names a fish it does not -- hardhead
and gafftopsail are marine catfish and nothing to do with blue, channel or flathead -- and it is
here to prove the point: a containment match would have bound it to the Catfish checkbox and put a
saltwater limit on a freshwater card.

SO THIS SCRIPT DECLARES ONLY WHAT IT CAN DECLARE WITHOUT A JUDGEMENT. A phrase whose text contains
the name of a plan species is never written; it is printed and left UNMAPPED, so the build keeps
reporting it until a person decides whether a saltwater rule reaches a freshwater plan. That is a
legal question about what you may keep, and it is not a script's to answer.

Re-runnable. It only ever adds, never rewrites an existing declaration, and prints what it would
do unless --write is given.
"""
import argparse, json, os, sys, importlib.util


def _brt(script_dir):
    p = os.path.join(script_dir, 'build_regulations_table.py')
    if not os.path.exists(p):
        sys.exit('build_regulations_table.py must sit beside this script -- it owns expand_species()')
    spec = importlib.util.spec_from_file_location('_brt', p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def provenance(doc):
    """phrase -> {'rules': n, 'where': sorted ['GA/saltwater p84', ...]}"""
    out = {}

    def note(ph, st, rec):
        e = out.setdefault(ph, {'rules': 0, 'where': set()})
        e['rules'] += 1
        e['where'].add('%s/%s p%s' % (st, rec.get('table'), rec.get('page')))

    def walk(recs, st):
        for r in recs:
            for f in ('species', 'species_band'):
                if r.get(f):
                    note(r[f], st, r)
            for c in (r.get('closures') or []):
                if c.get('species'):
                    note(c['species'], st, r)
            walk(r.get('rules') or [], st)
    for w in (doc.get('by_water') or {}).values():
        walk(w.get('rules') or [], (w.get('state') or '?'))
    for st, recs in (doc.get('statewide') or {}).items():
        walk(recs, st)
    return {k: {'rules': v['rules'], 'where': sorted(v['where'])} for k, v in out.items()}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--table', default=None, help='regulations_table.json (default: in --registry)')
    ap.add_argument('--write', action='store_true', help='without this it only reports')
    a = ap.parse_args()

    brt = _brt(os.path.dirname(os.path.abspath(__file__)))
    mp = os.path.join(a.registry, 'species_map.json')
    tp = a.table or os.path.join(a.registry, 'regulations_table.json')
    for p in (mp, tp):
        if not os.path.exists(p):
            sys.exit('missing %s' % p)
    smap = json.load(open(mp, encoding='utf-8'))
    doc = json.load(open(tp, encoding='utf-8'))

    check = brt.check_species_map(doc, a.registry)
    if not check.get('checked'):
        sys.exit('the check did not run: %s' % check.get('why'))
    unmapped = list(check['unmapped'])
    prov = provenance(doc)
    plan = [(v, v.lower()) for v in ((smap.get('plan_species') or {}).get('values') or [])]

    declare, hold = {}, []
    for ph in unmapped:
        low = ph.lower()
        hits = sorted({name for name, l in plan if l in low})
        if hits:
            hold.append((ph, hits))
            continue
        e = prov.get(ph) or {'rules': 0, 'where': []}
        declare[ph] = '%d rule%s -- %s' % (e['rules'], '' if e['rules'] == 1 else 's',
                                           ', '.join(e['where']) or 'no record found')

    nh = smap.setdefault('no_home_in_the_form', {})
    fresh = {k: v for k, v in declare.items() if k not in nh}
    print('%d phrase(s) the books name and the map has never seen.' % len(unmapped))
    print('%d can be declared with no judgement; %d already declared; %d HELD BACK.\n'
          % (len(fresh), len(declare) - len(fresh), len(hold)))
    for ph, hits in hold:
        e = prov.get(ph) or {'where': []}
        print('  HELD  %-56s %s' % (ph[:54], ', '.join(e['where'])))
        print('        names the plan species %s -- a person decides whether a saltwater rule '
              'reaches a freshwater plan' % '/'.join(hits))
    if hold:
        print()
    for ph in sorted(fresh):
        print('  +     %-56s %s' % (ph[:54], fresh[ph]))

    if not a.write:
        print('\n(report only -- pass --write to record the %d declaration(s))' % len(fresh))
        return 0
    if not fresh:
        print('\nnothing to add.')
        return 0
    nh.update(fresh)
    # THE FILE'S OWN RULE, KEPT TRUE. It said "EXACT phrase lookup only", and expand_species()
    # now falls back to a case-blind match and then to one with the page's footnote marker
    # stripped -- neither of which is containment or fuzz, and both of which the rule text has
    # to admit or it is describing a resolver that no longer exists.
    (smap.setdefault('rules', {}))['matching'] = (
        'EXACT phrase lookup first. Two normalisations are tried only after every exact test '
        'has failed: the same phrase in a different case, and the same phrase without a trailing '
        'footnote marker (* † ‡), which is typography and not part of a fish\'s name. No '
        'containment and no fuzzy fallback, ever -- containment reported '
        "'Walleye/Sauger or Walleye/Sauger Hybrids' as selectable because the string contains "
        "'Hybrid', and would bind 'Saltwater Catfishes (Hardhead & gafftopsail catfishes)' to "
        'the Catfish checkbox.')
    json.dump(smap, open(mp, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    print('\n%d declaration(s) recorded -> %s' % (len(fresh), mp))
    print('%d phrase(s) left UNMAPPED on purpose. The build will keep naming them.' % len(hold))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
