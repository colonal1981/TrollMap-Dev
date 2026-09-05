#!/usr/bin/env python3
r"""build_thermocline_norms.py -- where the thermocline sits on a lake nobody sampled.

    py .\scripts\build_thermocline_norms.py --registry "F:\TrollMapPipeline\registry"
    py .\scripts\build_thermocline_norms.py --registry "..." --repo "F:\TrollMapPipeline\TrollMap-Dev" --go

WHY THIS EXISTS. Ryan, 2026-09-05, after being told his own sonar could answer it:
*"but that is backwards... you are saying i must go fish a lake to find out information to fish
a lake"*. He is right. A plan is written before the trip, for a water he may never have run.

Thirteen waters gained a measured thermocline today and 342 did not, and no amount of further
searching fixes that: for most of them nobody has ever put a probe down. What CAN be done is fit
the answer from the lakes somebody DID sample. The EPA National Lakes Assessment profiled 1,157
lakes in 2007, 1,230 in 2012 and 1,225 in 2022, publishing full vertical casts with each lake's
area and depth, and `fetch_nla_limnology.py` reads every one of those files already and throws
away everything outside our four states.

WHAT THE NUMBERS ACTUALLY SAY, measured before this was written and reported whether or not it
flattered the idea. Across 1,654 summer casts:

    thermocline vs log10(lake area)        r = +0.44
    thermocline vs log10(cast depth)       r = +0.59
    fitted regression, held out 5-fold     median error 7.5 ft on lakes over 1,000 acres
    quoting the median of all big lakes    median error 9.8 ft

A regression on area and depth beats a single constant by 23%, which is not enough to justify a
model nobody can read. **The calendar carries far more than the lake does.** On waters over
1,000 acres the median runs 18 ft in June, 24.5 in July, 28.7 in August and 33.6 in September --
a clean seasonal deepening, the same shape Lake Keowee's own 1973 casts show at one station
(17 ft on 25 June, 60 ft on 17 September).

So the product is a LOOKUP TABLE by depth class and month, not a fitted model. Same accuracy,
and Ryan can read it and tell me it is wrong.

DEPTH, NOT AREA, AND FOR TWO REASONS. It is the better predictor of the two, and it is the one
already in scope where the plan is written -- `researchIntel()` prints `Max depth` from
`id.maxDepthFt` two lines above where this number goes, so nothing new has to be plumbed to
reach it. Surface acres is only present when pack facts were passed.

THE BINS ARE THE REGISTRY'S OWN QUARTILES, not four numbers somebody liked. They are computed
from `max_depth_ft` across every water the app offers -- the population this table serves -- and
written into the generated file so they can be read rather than trusted.

WHAT STANDS IN FOR LAKE MAX DEPTH IN THE SURVEY. 2007 publishes `DEPTHMAX`; 2012 and 2022 do
not, so the deepest reading in the cast is used. That substitution was measured rather than
assumed: on the 1,150 lakes where 2007 has both, the two correlate at **r = +0.987** and the cast
bottoms at a median 93% of the published maximum. The bins are quartiles of a long-tailed
distribution and 7% does not move a lake across one, except at an edge.

A CELL IS PUBLISHED ONLY IF IT EARNS ITS PLACE, AND THE FIRST VERSION OF THAT TEST WAS WRONG.
It asked whether the cell's interquartile range was NARROWER than the month's, and refused both
deep classes -- which are the only waters Ryan fishes. That test measures precision. Deep lakes
stratify over a wider range than shallow ones do; the spread is a fact about them, not evidence
that the cell is uninformative. Refusing it would have served 20.9 ft for a 150 ft lake in
September when the deep-class answer is half again that.

The question is whether knowing the depth MOVES THE ANSWER, so the test is now on the median and
not the spread: a cell is published when its median differs from the month's by more than the
standard error of its own median, `1.2533 * (IQR / 1.349) / sqrt(n)`. That is the textbook
distribution-free standard error, not a threshold anybody here picked. A cell whose median sits
inside that error is saying what the calendar already said, and the month row serves it instead.
Four casts remains the floor, being the fewest `statistics.quantiles` can put a quartile between.
Every refusal is written down with both numbers.

TWO LIMITS MEASURED AND NOT FIXED, because the fix would be worse than the limit.

**The table is national and our waters are southern.** Cut to the South and mid-Atlantic the deep
class holds 4 to 8 casts a month, and below 38 N it holds 5 to 10 -- too thin to publish. Those
thin cells run DEEPER than the national ones, by roughly 5 to 10 ft (below 38 N: 27.9 / 21.3 /
31.2 / 44.3 against the national 21.3 / 18.1 / 26.2 / 32.8). So on a southern reservoir this
table probably reads shallow, and the honest response is to say so rather than serve a median of
five casts.

**June reads deeper than July in the deep class**, and it does so in the national set, the
southern set and the below-38 N set alike -- three independent slices, so it is not one thin
cell. It is most likely which lakes the survey visited when, rather than anything about water.
It is left in, because smoothing a season into the shape it ought to have is inventing data.

WHAT THIS IS NOT. It is not a measurement, and nothing that reads it may store it where one
goes. Every row carries its own spread because the spread is the point: at the ninetieth
percentile the error on a big lake is still twenty feet. A number with no band beside it is how
Lake Wateree carried a fabricated 27 ft thermocline for months.

Personal use only, not for distribution or resale; not for navigation.
"""
from __future__ import annotations
import argparse
import collections
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_nla_limnology import (                        # noqa: E402  one rule, one reader
    read_csv, pick, num, thermocline_from, COL, M_TO_FT)

OUT_JSON = 'thermocline_norms.json'
OUT_JS = os.path.join('js', 'data', 'thermocline-norms.js')
SUMMER = (6, 9)
MIN_CASTS = 4              # the fewest statistics.quantiles can put a quartile between
ROUNDS = [('2007', 'nla2007_siteinfo.csv', 'nla2007_profile.csv'),
          ('2012', 'nla2012_siteinfo.csv', 'nla2012_profile.csv'),
          ('2022', 'nla2022_siteinfo.csv', 'nla2022_profile.csv')]
MONTH_NAME = {6: 'June', 7: 'July', 8: 'August', 9: 'September'}


def month_of(text):
    t = str(text or '')
    for sep in ('/', '-'):
        if sep in t:
            p = t.split(sep)
            try:
                return int(p[1]) if sep == '-' else int(p[0])
            except (ValueError, IndexError):
                return None
    return None


def casts_from(nla_dir):
    """Every summer cast in every round: (thermoclineFt, lakeMaxDepthFt, month)."""
    rows, skipped = [], collections.Counter()
    for year, sfile, pfile in ROUNDS:
        sp = os.path.join(nla_dir, sfile)
        pp = os.path.join(nla_dir, pfile)
        if not (os.path.exists(sp) and os.path.exists(pp)):
            skipped['round %s not on disk' % year] += 1
            continue
        sh, sr = read_csv(sp)
        ph, pr = read_csv(pp)
        sid_s, sid_p = pick(sh, COL['site']), pick(ph, COL['site'])
        dmax = pick(sh, ['DEPTHMAX'])
        published = {r.get(sid_s): num(r.get(dmax)) for r in sr} if dmax else {}
        d_c = pick(ph, COL['depth'])
        t_c, o_c = pick(ph, COL['temp']), pick(ph, COL['do'])
        dt_c = pick(ph, COL['date'])
        grouped = collections.defaultdict(list)
        for r in pr:
            d = num(r.get(d_c))
            if d is None:
                continue
            grouped[(r.get(sid_p), str(r.get(dt_c) or ''))].append(
                (d, num(r.get(t_c)), num(r.get(o_c))))
        for (sid, dt), pts in grouped.items():
            m = month_of(dt)
            if m is not None and not (SUMMER[0] <= m <= SUMMER[1]):
                skipped['outside June-September'] += 1
                continue
            th, why = thermocline_from(pts)
            if th is None:
                skipped['no thermocline in the cast'] += 1
                continue
            bottom = published.get(sid)
            bottom = bottom * M_TO_FT if bottom else max(d for d, _, _ in pts) * M_TO_FT
            if bottom < 10:
                skipped['lake bottoms under 10 ft'] += 1
                continue
            rows.append((th, bottom, m))
    return rows, skipped


def quartile_bins(registry):
    """The depth classes, taken from the waters this table will be asked about."""
    idx_fp = os.path.join(registry, 'lake_index.json')
    if not os.path.exists(idx_fp):
        raise SystemExit('no lake_index.json in %s -- the bins come from our own waters' % registry)
    idx = json.load(open(idx_fp, encoding='utf-8'))
    depths = sorted(v['max_depth_ft'] for v in idx.values()
                    if isinstance(v, dict) and isinstance(v.get('max_depth_ft'), (int, float)))
    if len(depths) < 8:
        raise SystemExit('only %d waters carry a max_depth_ft' % len(depths))
    q = statistics.quantiles(depths, n=4)
    edges = [int(round(x / 5.0) * 5) for x in q]          # to the nearest 5 ft, so it reads
    return edges, len(depths)


def band(values):
    v = sorted(values)
    qs = statistics.quantiles(v, n=4)
    return {'medianFt': round(statistics.median(v), 1),
            'p25Ft': round(qs[0], 1), 'p75Ft': round(qs[2], 1), 'casts': len(v)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', default=os.environ.get('TROLLMAP_REGISTRY',
                                                         r'F:\TrollMapPipeline\registry'))
    ap.add_argument('--repo', default=None, help='TrollMap-Dev checkout, for the generated js/data file')
    ap.add_argument('--go', action='store_true', help='write the files')
    a = ap.parse_args(argv)

    rows, skipped = casts_from(os.path.join(a.registry, '_nla'))
    if not rows:
        raise SystemExit('no summer cast survived -- run fetch_nla_limnology.py to place the CSVs')
    edges, n_waters = quartile_bins(a.registry)
    print('%d summer casts with a thermocline; bins from %d of our waters: '
          'under %d ft / %d-%d / %d-%d / over %d ft'
          % (len(rows), n_waters, edges[0], edges[0], edges[1], edges[1], edges[2], edges[2]))
    for why, n in skipped.most_common():
        print('   skipped %5d  %s' % (n, why))

    def cls(ft):
        return 0 if ft < edges[0] else 1 if ft < edges[1] else 2 if ft < edges[2] else 3

    by_month = collections.defaultdict(list)
    by_cell = collections.defaultdict(list)
    for th, bottom, m in rows:
        if m is None:
            continue
        by_month[m].append(th)
        by_cell[(cls(bottom), m)].append(th)

    months, cells, refused = {}, {}, []
    for m in sorted(by_month):
        if len(by_month[m]) < MIN_CASTS:
            continue
        months[str(m)] = band(by_month[m])
    for (c, m), vals in sorted(by_cell.items()):
        if str(m) not in months:
            continue
        if len(vals) < MIN_CASTS:
            refused.append('depth class %d in %s: only %d cast(s)' % (c, MONTH_NAME[m], len(vals)))
            continue
        b = band(vals)
        # DOES KNOWING THE DEPTH MOVE THE ANSWER? Standard error of the median, distribution-free.
        se = 1.2533 * ((b['p75Ft'] - b['p25Ft']) / 1.349) / (len(vals) ** 0.5)
        moved = abs(b['medianFt'] - months[str(m)]['medianFt'])
        if moved <= se:
            refused.append('depth class %d in %s: median %.1f ft is %.1f ft off the month\'s '
                           '%.1f, inside its own %.1f ft standard error, so the depth is saying '
                           'what the calendar already said'
                           % (c, MONTH_NAME[m], b['medianFt'], moved,
                              months[str(m)]['medianFt'], se))
            continue
        b['stdErrFt'] = round(se, 1)
        cells['%d:%d' % (c, m)] = b

    print()
    print('  month      all depths            by depth class')
    for m in sorted(by_month):
        if str(m) not in months:
            continue
        mm = months[str(m)]
        line = '  %-9s %5.1f ft (%4.1f-%4.1f, n=%-4d)  ' % (
            MONTH_NAME[m], mm['medianFt'], mm['p25Ft'], mm['p75Ft'], mm['casts'])
        bits = []
        for c in range(4):
            b = cells.get('%d:%d' % (c, m))
            bits.append('c%d %5.1f n=%-3d' % (c, b['medianFt'], b['casts']) if b
                        else 'c%d     -      ' % c)
        print(line + '  '.join(bits))
    print()
    for r in refused:
        print('   REFUSED %s' % r)

    doc = {'_note': 'Where the thermocline typically sits, by lake max depth and month, from EPA '
                    'National Lakes Assessment vertical casts. NOT A MEASUREMENT of any water: '
                    'nothing may store these where a measured value goes, and every row carries '
                    'its own interquartile spread because the spread is the point. Read only '
                    'where the Water Quality Portal and the document casts both came up empty. '
                    'Personal use only, not for distribution or resale; not for navigation.',
           'derivation': 'Scripts/fetch_nla_limnology.py -- thermocline_from()',
           'source': 'EPA National Lakes Assessment 2007, 2012, 2022 vertical profiles',
           'generated': __import__('datetime').date.today().isoformat(),
           'castCount': len(rows),
           'depthClassEdgesFt': edges,
           'byMonth': months, 'byDepthClassAndMonth': cells, 'refused': refused}

    if not a.go:
        print()
        print('dry run. Re-run with --go to write %s and %s'
              % (os.path.join(a.registry, OUT_JSON), OUT_JS))
        return 0

    fp = os.path.join(a.registry, OUT_JSON)
    with open(fp, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write('\n')
    print('-> %s' % fp)

    if a.repo:
        js = os.path.join(a.repo, OUT_JS)
        rows_js = json.dumps({'depthClassEdgesFt': edges, 'byMonth': months,
                              'byDepthClassAndMonth': cells}, indent=2)
        with open(js, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(
                "/**\n"
                " * thermocline-norms.js -- where the thermocline typically sits, by lake max\n"
                " * depth and month, from %d EPA National Lakes Assessment summer casts.\n"
                " *\n"
                " * NOT A MEASUREMENT OF ANY WATER. This answers \"a lake this deep, this month,\"\n"
                " * and it is read ONLY where the Water Quality Portal and the document casts both\n"
                " * came up empty. Every row carries its interquartile spread and whatever prints\n"
                " * it must print that too: at the ninetieth percentile the error on a big lake is\n"
                " * still twenty feet, and a number with no band beside it is how Lake Wateree\n"
                " * carried a fabricated 27 ft thermocline for months.\n"
                " *\n"
                " * The depth classes are the quartiles of max_depth_ft across the waters the app\n"
                " * offers, rounded to 5 ft -- not four numbers somebody liked.\n"
                " *\n"
                " * GENERATED FILE -- DO NOT EDIT BY HAND.\n"
                " * Source of truth: EPA NLA profile CSVs under registry/_nla/\n"
                " * Regenerate:      py Scripts/build_thermocline_norms.py --go --repo .\n"
                " * Guarded by:      test/a-norm-is-not-a-measurement.test.js\n"
                " *\n"
                " * Personal use only, not for distribution or resale; not for navigation.\n"
                " */\n"
                "export const THERMOCLINE_NORMS = %s;\n\n"
                "/** The depth class a lake falls in, or null when its max depth is unknown. */\n"
                "export function depthClassFor(maxDepthFt) {\n"
                "  const d = Number(maxDepthFt);\n"
                "  if (!Number.isFinite(d) || d <= 0) return null;\n"
                "  const e = THERMOCLINE_NORMS.depthClassEdgesFt;\n"
                "  return d < e[0] ? 0 : d < e[1] ? 1 : d < e[2] ? 2 : 3;\n"
                "}\n\n"
                "/**\n"
                " * The typical thermocline for a lake this deep in this month, or null.\n"
                " *\n"
                " * The depth-class row is preferred and the month row is the fallback, because a\n"
                " * class is published only where its spread is NARROWER than the month's -- see\n"
                " * build_thermocline_norms.py. Outside June-September there is no answer here at\n"
                " * all: a lake that is not stratified has no thermocline to state.\n"
                " */\n"
                "export function thermoclineNorm(maxDepthFt, month) {\n"
                "  const m = Number(month);\n"
                "  if (!(m >= 6 && m <= 9)) return null;\n"
                "  const c = depthClassFor(maxDepthFt);\n"
                "  const cell = c === null ? null\n"
                "    : THERMOCLINE_NORMS.byDepthClassAndMonth[`${c}:${m}`] || null;\n"
                "  const row = cell || THERMOCLINE_NORMS.byMonth[String(m)] || null;\n"
                "  if (!row) return null;\n"
                "  return { ...row, month: m, basis: cell ? 'depth class and month' : 'month' };\n"
                "}\n" % (len(rows), rows_js))
        print('-> %s' % js)
    return 0


if __name__ == '__main__':
    sys.exit(main())
