#!/usr/bin/env python3
"""
build_duke_dam_table.py -- which Duke powerhouse forms which water, checked against evidence.

WHY IT IS NOT DERIVED
    An earlier cut of this file tried to read the pairing out of the gauge strings alone. It
    placed nine Catawba dams correctly, MISSED BRIDGEWATER -- the case that motivated the whole
    idea, because its only gauge says "OLD CATAWBA R BL CATAWBA DAM NEAR BRIDGEWATER, NC" and
    never says James -- gave Thorpe Dam to the Tuckasegee river instead of Lake Glenville, and
    invented four powerhouses out of town names: Hayesville, Irmo, Ivylog, Interstate.

WHY IT IS NOT TAKEN ON TRUST EITHER
    CLAIMS below came from a Google AI summary Ryan pasted on 2026-08-17. It is unsourced for
    several rows and this project has spent a day watching plausible-and-wrong be the default.
    So every row is checked against three things already on the drive, and each carries the
    verdict it earned:

        CONFIRMED (Duke + gauge)   Duke has published this dam name AND a bound gauge names it
        CONFIRMED (Duke payload)   Duke has published the name; no local gauge mentions it
        corroborated (gauge)       a gauge bound to that water names the dam
        UNSUPPORTED locally        plausible, nothing on the drive says so
        NO SUCH WATER              the registry has no such water at all

    /rivers/active-run lists only dams with a release scheduled -- two of eleven on the Catawba
    one day in August -- so DUKE_SEEN can only ever grow. An UNSUPPORTED row is not a wrong row.

NAME MATCHING IS ORDER-INSENSITIVE, and has to be: the list says "Lake Wateree" and "Lake
Rhodhiss" where the registry says "Wateree Lake" and "Rhodhiss Lake". An exact compare missed
both, which is the same fault that put Lake Wateree's pool config on the Wateree RIVER.
"""
import argparse
import json
import re
import sys
from pathlib import Path

REGISTRY_REL = 'registry/lake_index.json'

# Duke spellings actually observed on /rivers/active-run, from the fixture in
# test/chart-datum.test.js that Ryan pasted 2026-08-17. Evidence, not input.
DUKE_SEEN = {'bridgewater', 'oxford', 'wylie', 'wateree', 'nantahala', 'tillery'}

# (water as the source named it, powerhouse). Google AI summary, 2026-08-17, unverified at source.
CLAIMS = [
    ('Lake James', 'Bridgewater'), ('Lake Rhodhiss', 'Rhodhiss'), ('Lake Hickory', 'Oxford'),
    ('Lookout Shoals Lake', 'Lookout Shoals'), ('Lake Norman', 'Cowans Ford'),
    ('Mountain Island Lake', 'Mountain Island'), ('Lake Wylie', 'Wylie'),
    ('Fishing Creek Reservoir', 'Fishing Creek'), ('Great Falls Reservoir', 'Great Falls'),
    ('Rocky Creek Reservoir', 'Rocky Creek'), ('Lake Wateree', 'Wateree'),
    ('Lake Jocassee', 'Jocassee'), ('Lake Keowee', 'Keowee'), ('Bad Creek Reservoir', 'Bad Creek'),
    ('Lake Tillery', 'Tillery'), ('Blewett Falls Lake', 'Blewett Falls'),
    ('Nantahala Lake', 'Nantahala'), ('Lake Glenville', 'Thorpe'),
    ('Bear Creek Lake', 'Bear Creek'), ('Cedar Cliff Lake', 'Cedar Cliff'),
    ('Wolf Creek Lake', 'Wolf Creek'), ('Tanasee Creek Lake', 'Tanasee Creek'),
    ('Waterville Lake', 'Waterville'),
    # ONE DAM, TWO POWERHOUSES, and Duke can post a release under either name. Its own
    # Power Plants map (duke-energy.com/our-company/about-us/power-plants-map, read by Ryan
    # 2026-08-17) labels the structure "Rocky Creek / Cedar Creek Dam" and puts BOTH the Rocky
    # Creek Hydro Station (28 MW, 1909, Fairfield and Lancaster Counties) and the Cedar Creek
    # Hydro Station on it. Ryan, asked which name Duke uses: "both is the right answer".
    #
    # dam -> slug is many-to-one on purpose, so two powerhouses on one impoundment are two rows
    # pointing at one water, and a release under either spelling lands on the same side of
    # Wateree. Without these the chain knows cedar_creek_reservoir_2 is Wateree's upstream and
    # no dam name resolves to it, so WATEREE HAS NO INFLOW LABEL AT ALL -- the exact fact this
    # whole table exists to produce.
    #
    # The slug is given explicitly because the name is ambiguous: the registry holds a Cedar
    # Creek Reservoir in Chester SC, another in Hall GA, and a Cedar Creek in Richland SC.
    ('Cedar Creek Reservoir', 'Rocky Creek', 'cedar_creek_reservoir_2'),
    ('Cedar Creek Reservoir', 'Cedar Creek', 'cedar_creek_reservoir_2'),
]
NOISE = {'dam', 'dams', 'hydro', 'powerhouse', 'project', 'lake', 'reservoir'}


def find_repo_root(explicit=None):
    if explicit:
        p = Path(explicit)
        return p.parent.parent if p.name.endswith('.json') else p
    here = Path.cwd().resolve()
    mine = Path(__file__).resolve().parent
    for cand in [here] + list(here.parents) + [mine] + list(mine.parents):
        if (cand / REGISTRY_REL).exists():
            return cand
    return here


def bare(v):
    return re.sub(r'\s*\(.*?\)', '', str(v or '')).strip().lower()


def name_key(v):
    """Sorted tokens, so "Lake Wateree" and "Wateree Lake" are one name."""
    return ' '.join(sorted(t for t in re.split(r'[^a-z0-9]+', bare(v)) if t))


def dam_key(v):
    """The spelling releaseDirection() looks up. Must agree with normalizeDamName() in
    Worker/conditions.js -- lowercase, punctuation to spaces, generic words dropped."""
    return ' '.join(t for t in re.split(r'[^a-z0-9]+', str(v or '').lower())
                    if t and t not in NOISE) or None


def gauge_names(binding):
    out = []

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k in ('name', 'site_name', 'siteName', 'description', 'label') \
                   and isinstance(v, str) and v.strip():
                    out.append(v.strip())
                else:
                    walk(v)
        elif isinstance(o, list):
            for x in o:
                walk(x)
    walk(binding or {})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', default=None)
    ap.add_argument('--json', default=None, help='write the table here')
    args = ap.parse_args()

    root = find_repo_root(args.registry)
    reg = json.loads((root / REGISTRY_REL).read_text(encoding='utf-8'))
    chain = {}
    cp = root / 'registry' / 'water_chain.json'
    if cp.exists():
        chain = json.loads(cp.read_text(encoding='utf-8')).get('waters', {})
    wbp = root / 'registry' / 'water_bindings.json'
    wb = {}
    if wbp.exists():
        wb = json.loads(wbp.read_text(encoding='utf-8'))
        wb = wb.get('bindings', wb)

    by_name = {}
    for slug, row in reg.items():
        for cand in [row.get('name'), row.get('display_name'),
                     *(row.get('legacy_display_names') or [])]:
            if cand:
                by_name.setdefault(name_key(cand), slug)

    dams, rows = {}, []
    for claim in CLAIMS:
        lake, dam = claim[0], claim[1]
        # A claim may name its slug outright, for when the water's NAME is ambiguous.
        explicit = claim[2] if len(claim) > 2 else None
        slug = explicit if (explicit and explicit in reg) else by_name.get(name_key(lake))
        ev = []
        if slug:
            head = dam.split()[0].lower()
            ev = [g for g in gauge_names(wb.get(slug))
                  if head in g.lower() and 'dam' in g.lower()]
        seen = dam.split()[0].lower() in DUKE_SEEN
        if not slug:
            verdict = 'NO SUCH WATER'
        elif seen and ev:
            verdict = 'CONFIRMED (Duke + gauge)'
        elif seen:
            verdict = 'CONFIRMED (Duke payload)'
        elif ev:
            verdict = 'corroborated (gauge)'
        else:
            verdict = 'UNSUPPORTED locally'
        rows.append({'claimed_water': lake, 'dam': dam, 'slug': slug,
                     'slug_given_explicitly': bool(explicit),
                     'in_chain': bool(slug and slug in chain),
                     'verdict': verdict, 'evidence': ev[:2]})
        if slug and verdict != 'NO SUCH WATER':
            k = dam_key(dam)
            if k:
                dams[k] = slug

    for r in rows:
        print(f"{r['verdict']:<26}{r['dam']:<16}-> {str(r['slug']):<26}"
              f"chain={'yes' if r['in_chain'] else 'no'}")
        if r['evidence']:
            print(f"      {r['evidence'][0][:78]}")

    from collections import Counter
    print()
    for k, v in Counter(r['verdict'] for r in rows).most_common():
        print(f'   {v:>3}  {k}')
    off = [r for r in rows if r['slug'] and not r['in_chain']]
    if off:
        print(f"\n   {len(off)} placed water(s) are NOT in water_chain.json, so a release there "
              f"can never be labelled: {', '.join(r['slug'] for r in off)}")

    out = {'_note': 'Duke powerhouse (normalised) -> the slug it forms. Keys must agree with '
                    'normalizeDamName() in Worker/conditions.js.',
           '_source': 'Google AI summary pasted by Ryan 2026-08-17, every row then checked '
                      'against lake_index.json, water_bindings.json and water_chain.json.',
           '_duke_spellings_observed': sorted(DUKE_SEEN),
           'dams': dams, 'review': rows}
    if args.json:
        Path(args.json).write_text(json.dumps(out, indent=1), encoding='utf-8')
        print(f'\nwrote {args.json}  ({len(dams)} dams)')
    else:
        print('\nno --json given, nothing written')
    return 0


if __name__ == '__main__':
    sys.exit(main())
