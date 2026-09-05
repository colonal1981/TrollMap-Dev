#!/usr/bin/env python3
r"""derive_nes_limnology.py -- the 1973 casts, turned into the two numbers the plan reads.

    py .\scripts\derive_nes_limnology.py --registry "F:\TrollMapPipeline\registry"
    py .\scripts\derive_nes_limnology.py --registry "F:\TrollMapPipeline\registry" --go

WHY THIS EXISTS, AND WHY IT IS A SEPARATE STEP FROM THE PARSER.

`parse_nes_working_papers.py` writes the casts exactly as the 1973 printout has them and derives
nothing, because the derivation already exists and a third copy of it is how two readers of one
feed start disagreeing. This is the step that applies it -- `thermocline_from()` and
`oxygen_from()` IMPORTED from `Scripts/fetch_nla_limnology.py`, guards unchanged: four readings,
three metres of span, 1.0 C/m, 2.0 mg/L anoxic, 5.0 mg/L depletion.

AND IT WRITES THE SHAPE NLA ALREADY WRITES. `registry/nla_limnology.json` holds
`waters: {slug: {slug, visits: [...]}}` with `thermoclineFt`, `anoxicBelowFt`, `depletionDepthFt`
and a note beside each. This file is the same shape with the same keys, so ONE consumer serves
both and there is no second reader to keep in step. Ryan's rule: merge, reduce, make better.

Measured 2026-09-05, before this ran: `nla_limnology.json` is opened by no file in the repo, and
neither was `nes_1973_profiles.json`. Eighty-seven thermoclines and seventy-four anoxic depths on
the drive and in the bucket, reaching no plan. This file does not fix that -- it makes the two
sources one shape so that fixing it is one reader instead of two.

WHAT IT REFUSES TO DO.

**It will not claim a lake did not stratify off a cast that lost readings.** This is the whole
reason the parser records `dropped`. Lake Murray's 9 July 1973 cast at station 450701 lost 29.8 C
at 15 ft and 24.2 C at 30 ft to the scan, and what survives grades at 0.66 C/m -- under the rule.
`thermocline_from()` then says, correctly for the readings it was given and falsely about the
lake, "This lake did not stratify on this visit." With the printed values that interval is
1.22 C/m and the lake stratifies at about 22 ft.

That sentence is not cosmetic: `audit_limnology_gaps.py` matches it and returns
`does_not_stratify`, which the ledger counts as an ANSWER. A bad scan would have moved Ryan's home
lake from "needs a source" to "does not stratify" carrying a citation to a federal survey. So a
cast with `dropped > 0` may report a depth it FOUND, and its no-stratify note is rewritten to say
what actually happened: the surviving readings show no gradient, and N were lost.

**Summer only.** Months 6 to 9, the window the thermocline rule is about. These papers also
sampled in March and November and those casts describe a mixed lake, which is a true statement
about a different question.

**Bound by name, through the one resolver.** `name_index` from `build_data_map.py`, the same
index the data map and the limnology ledger use. A paper whose printed lake name matches no water,
or matches two, is listed as unbound and attached to nothing -- name matching across two federal
datasets is how Goat Rock Lake reached rock_eagle_lake 200 km away.

**And the year travels with every number.** These are 1973 measurements. Lake Murray had the
Saluda dam remediation in 2005-2010, which changed how its hypolimnion is oxygenated. Whatever
reads this file has to be able to see that a value is fifty-three years old and prefer a newer one.

Personal use only, not for distribution or resale; not for navigation.
"""
from __future__ import annotations
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_data_map import name_index, COUNTY_TAIL              # noqa: E402  one resolver
from fetch_nla_limnology import (                               # noqa: E402  one rule, one join
    thermocline_from, oxygen_from, boundary_index,
    ANOXIC_MGL, DEPLETION_MGL, MIN_DEPTHS, M_TO_FT)

IN_NAME = 'nes_1973_profiles.json'
OUT_NAME = 'nes_limnology.json'
SUMMER = (6, 9)                      # the months the thermocline rule is about
FT_TO_M = 1.0 / M_TO_FT

# The refusal `thermocline_from()` writes when no layer reaches the gradient. It is a claim about
# the LAKE, and a cast that lost readings has not earned it.
NO_STRATIFY_PHRASE = 'did not stratify'


def is_summer(date):
    return SUMMER[0] <= int(str(date)[5:7]) <= SUMMER[1]


def visit_from(cast, station, source):
    """One 1973 cast -> one visit record, in the shape nla_limnology.json uses."""
    readings = cast.get('readings') or []
    dropped = cast.get('dropped') or 0
    metres = [(r['depthFt'] * FT_TO_M, r.get('tempC'), r.get('doMgL')) for r in readings]

    th, thn = thermocline_from(metres)
    an, ann = oxygen_from(metres, ANOXIC_MGL)
    de, den = oxygen_from(metres, DEPLETION_MGL)

    # A CAST THAT LOST READINGS MAY REPORT A DEPTH IT FOUND AND MAY NOT ACQUIT THE LAKE.
    if dropped and th is None and NO_STRATIFY_PHRASE in (thn or ''):
        thn = ('the %d readings that survived the scan show no layer reaching the gradient; '
               '%d more were dropped as OCR damage, so this is a statement about the cast we '
               'can read and NOT about the lake' % (len(readings), dropped))
    if dropped and an is None and 'never fell under' in (ann or ''):
        ann = '%s (%d reading(s) were dropped as OCR damage)' % (ann, dropped)
    if dropped and de is None and 'never fell under' in (den or ''):
        den = '%s (%d reading(s) were dropped as OCR damage)' % (den, dropped)

    return {'year': str(cast['date'])[:4], 'date': cast['date'],
            'station': station.get('station'), 'state': None,
            'lat': station.get('lat'), 'lon': station.get('lon'),
            'stationDepthFt': station.get('station_depth_ft'),
            'readings': len(readings), 'dropped': dropped,
            'thermoclineFt': th, 'thermoclineNote': thn,
            'anoxicBelowFt': an, 'anoxicNote': ann,
            'depletionDepthFt': de, 'depletionNote': den,
            'source': 'EPA National Eutrophication Survey working paper %s, Appendix D, '
                      '1973 sampling' % source,
            'profileSource': 'registry/%s' % IN_NAME}


def by_name(printed, byname):
    """The printed lake name -> exactly one slug, or nothing. Never the nearest."""
    raw = str(printed or '').strip().lower()
    for key in (raw, COUNTY_TAIL.sub('', raw).strip()):
        got = byname.get(key)
        if got and len(got) == 1:
            return next(iter(got)), None
        if got and len(got) > 1:
            return None, 'matches %d waters: %s' % (len(got), ', '.join(sorted(got)))
    return None, 'no water in the index answers to this name'


def bind(printed, stations, byname, slug_at):
    """THE COORDINATE IS THE JOIN AND THE NAME IS THE CROSS-CHECK.

    `fetch_nla_limnology.py` settled this already -- "A LAKE IS MATCHED BY ITS COORDINATES, NEVER
    BY ITS NAME" -- and the first version of this file ignored it and bound three of seven papers.
    The three it lost say why the rule exists:

        LAKE WILLIAM C. BOWEN   the index writes `Lake William C Bowen`. A full stop.
        LAKE KEOQWEE            OCR damage in the printed name itself
        LAKE ROBINSON           two real waters answer to it -- Chesterfield and Greer

    Every one is settled instantly by where the survey said its stations were. And the name still
    earns its place, because the coordinate is not always readable either: Lake Secession's
    degrees came off the scan as 35 15 35.0, which is in North Carolina.

    A paper is about ONE lake, so its stations vote and the majority wins -- the document's own
    structure, not a threshold. A tie is a refusal. And when the coordinate and the name disagree
    nothing is written: two joins pointing at different waters is exactly the state in which
    guessing has cost this project a species list before.

    Returns (slug, how, why).
    """
    votes = {}
    for st in stations or []:
        s = slug_at(st.get('lat'), st.get('lon'))
        if s:
            votes[s] = votes.get(s, 0) + 1
    coord, winners = None, []
    if votes:
        top = max(votes.values())
        winners = sorted(k for k, v in votes.items() if v == top)
        if len(winners) == 1:
            coord = winners[0]

    name, name_why = by_name(printed, byname)

    if coord and name and coord != name:
        return None, None, 'the coordinate says %s and the printed name says %s' % (coord, name)
    if coord:
        return coord, 'coordinate, %d of %d station(s)%s' % (
            votes[coord], len(stations or []),
            '; name agrees' if name == coord else '; the name did not bind'), None
    if len(winners) > 1:
        # A TIE IS BROKEN BY THE NAME ONLY IF THE NAME PICKS ONE OF THE TIED WATERS.
        # Otherwise there are three answers on the table and no reason to prefer any of them.
        if name in winners:
            return name, ('stations split between %s; the printed name picked one of them'
                          % ', '.join(winners)), None
        return None, None, ('stations split evenly between %s%s'
                            % (', '.join(winners),
                               ' and the printed name says %s' % name if name else ''))
    if name:
        return name, 'printed name (no station coordinate landed in a boundary)', None
    return None, None, name_why


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', default=os.environ.get('TROLLMAP_REGISTRY',
                                                         r'F:\TrollMapPipeline\registry'))
    ap.add_argument('--go', action='store_true', help='write the registry file')
    a = ap.parse_args(argv)

    reg = a.registry
    src = os.path.join(reg, IN_NAME)
    if not os.path.exists(src):
        raise SystemExit('%s not found -- run parse_nes_working_papers.py --go first' % src)
    idx_fp = os.path.join(reg, 'lake_index.json')
    if not os.path.exists(idx_fp):
        raise SystemExit('no lake_index.json in %s' % reg)

    doc = json.load(open(src, encoding='utf-8'))
    IDX = {k: v for k, v in json.load(open(idx_fp, encoding='utf-8')).items()
           if isinstance(v, dict)}
    byname = name_index(IDX)
    try:
        slug_at, n_poly = boundary_index(reg)
    except ImportError:
        raise SystemExit('shapely is required: py -m pip install shapely')
    print('%d boundary polygons to match against' % n_poly)

    waters, unbound = {}, []
    for paper, p in sorted((doc.get('papers') or {}).items()):
        printed = p.get('lake_as_printed')
        slug, how, why = bind(printed, p.get('stations') or [], byname, slug_at)
        if not slug:
            unbound.append((paper, printed, why))
            print('   !! %-28s %-26s %s' % (paper, str(printed)[:26], why))
            continue
        visits = []
        for st in p.get('stations') or []:
            for c in st.get('casts') or []:
                if is_summer(c['date']):
                    visits.append(visit_from(c, st, paper))
        if not visits:
            print('   -- %-28s %-26s no summer cast' % (paper, str(printed)[:26]))
            continue
        for v in visits:
            v['state'] = IDX[slug].get('state')
        # DEEPEST FIRST IS NOT THE RULE; SHALLOWEST IS. A plan clamps against the shallowest
        # depth oxygen fails at, because that is the ceiling the fish actually meet.
        waters[slug] = {'slug': slug, 'lake_as_printed': printed, 'bound_by': how,
                        'storet_lake_code': p.get('storet_lake_code'),
                        'visits': sorted(visits, key=lambda v: (v['date'], v['station'] or ''))}
        th = [v['thermoclineFt'] for v in visits if v['thermoclineFt'] is not None]
        an = [v['anoxicBelowFt'] for v in visits if v['anoxicBelowFt'] is not None]
        de = [v['depletionDepthFt'] for v in visits if v['depletionDepthFt'] is not None]
        print('   %-28s %-26s %2d summer cast(s)  thermocline %-16s anoxic %-16s depletion %s'
              % (paper, slug[:26], len(visits),
                 ('%s ft (%d)' % (min(th), len(th))) if th else '-',
                 ('%s ft (%d)' % (min(an), len(an))) if an else '-',
                 ('%s ft (%d)' % (min(de), len(de))) if de else '-'))

    if not a.go:
        print()
        print('dry run. Re-run with --go to write %s' % os.path.join(reg, OUT_NAME))
        return 0

    out = {'_note': 'Vertical temperature and dissolved-oxygen casts from the 1973 EPA National '
                    'Eutrophication Survey, derived with the SAME rule as nla_limnology.json -- '
                    'thermocline_from() and oxygen_from() imported from fetch_nla_limnology.py, '
                    'guards unchanged. Same shape as that file so one consumer serves both. '
                    'THE YEAR IS PART OF THE FACT: these are 1973 measurements and several of '
                    'these reservoirs have been re-operated since -- Lake Murray had the Saluda '
                    'dam remediation in 2005-2010. A newer measurement should always win. '
                    'Personal use only, not for distribution or resale; not for navigation.',
           'source': 'EPA National Eutrophication Survey, working paper per lake, 1973 sampling',
           'derivation': 'Scripts/fetch_nla_limnology.py -- thermocline_from(), oxygen_from()',
           'guards': {'minDepths': MIN_DEPTHS, 'anoxicMgL': ANOXIC_MGL,
                      'depletionMgL': DEPLETION_MGL, 'summerMonths': list(SUMMER)},
           'generated': __import__('datetime').date.today().isoformat(),
           'water_count': len(waters),
           'unbound': [{'paper': p, 'lake_as_printed': n, 'why': w} for p, n, w in unbound],
           'waters': dict(sorted(waters.items()))}
    fp = os.path.join(reg, OUT_NAME)
    with open(fp, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)
        fh.write('\n')
    print('-> %s   (%d water(s), %d KB)' % (fp, len(waters), round(os.path.getsize(fp) / 1024)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
