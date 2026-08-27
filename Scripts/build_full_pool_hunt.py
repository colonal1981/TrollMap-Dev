#!/usr/bin/env python3
"""Build the full-pool hunt list -- the waters that still have no full-pool datum.

Personal use only, not for distribution or resale; not for navigation.

WHY THIS EXISTS: this list was counted twice by hand on 2026-08-26/27 and came out
50 lakes once and 63 the next time, while COVERAGE WENT UP in between. Two throwaway
snippets, two different run fields, no record of either. Nothing here is hand written
and every report states the inputs it was built from, so two runs can be diffed.

Universe   : water_bindings.json bindings whose feature_type == "lake"
Covered    : slug present in full_pool.json rows
Duke       : slug carried by duke_lake_levels.json (index 100 = full pond, so the
             index already yields feet below full pond -- nothing to hunt)
USACE      : binding carries a `usace` block -- a CWMS pointer exists, so this is a
             FETCH, not an evening in a county water plan. It is a pointer, not a
             promise: some of these point at a river gauge near the lake.
Runs       : _trolling_runs.json lakes[slug][--runs-field]. Default `kept`, the runs
             that survived filtering. `runs` is the raw count and is 2-3x larger.
"""
import argparse, hashlib, json, os, sys
from datetime import datetime, timezone

def read_json(path):
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)

def stamp(path):
    st = os.stat(path)
    with open(path, 'rb') as fh:
        h = hashlib.sha256(fh.read()).hexdigest()[:12]
    return {'path': path.replace('\\', '/'),
            'mtime': datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%d %H:%M:%S'),
            'bytes': st.st_size, 'sha256_12': h}


def _has_elev(b):
    """True if this binding carries any live lake-elevation source."""
    for g in list(b.get('gauges') or []) + [b.get('pool') or {}, b.get('tailwater') or {}]:
        if '00062' in set((g.get('usgs_parms') or []) + (g.get('usgs_parms_dv') or [])):
            return True
        f = g.get('flood') or {}
        vv = [f.get(x) for x in ('action', 'minor', 'moderate', 'major')]
        vv = [x for x in vv if isinstance(x, (int, float))]
        if vv and min(vv) > 100:
            return True
    c = (b.get('curated') or {}).get('usgs') or {}
    return '00062' in (c.get('params') or '')

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='.')
    ap.add_argument('--runs-field', default='kept', choices=['kept', 'runs', 'closed'])
    ap.add_argument('--min-runs', type=int, default=1)
    ap.add_argument('--min-acres', type=float, default=0.0,
                    help='hide hunt lakes smaller than this. 0 lists everything.')
    ap.add_argument('--worth-it-acres', type=float, default=1000.0,
                    help='acreage the summary line calls out as worth an evening')
    ap.add_argument('--table-cut', type=int, default=0,
                    help='0 lists every hunt lake. Set e.g. 100 to table only the big ones '
                         'and summarise the tail.')
    ap.add_argument('--out-md', default='_reports/full_pool_hunt_list.md')
    ap.add_argument('--out-json', default='registry/_full_pool_hunt.json')
    a = ap.parse_args()
    R = lambda p: os.path.join(a.root, p)

    src = {}
    for key, rel in (('bindings', 'registry/water_bindings.json'),
                     ('full_pool', 'registry/full_pool.json'),
                     ('duke', 'registry/duke_lake_levels.json'),
                     ('runs', 'registry/_trolling_runs.json'),
                     ('sensors', 'registry/_sensor_feeds.json'),
                     ('index', 'registry/lake_index.json'),
                     ('no_pool', 'registry/no_full_pool.json')):
        p = R(rel)
        if not os.path.exists(p):
            if key in ('sensors', 'index', 'no_pool'):
                continue
            sys.exit('MISSING INPUT: ' + p)
        src[key] = stamp(p)

    binds = read_json(R('registry/water_bindings.json'))['bindings']
    fpdoc = read_json(R('registry/full_pool.json'))
    fp = fpdoc['rows']
    duke = read_json(R('registry/duke_lake_levels.json'))['rows']
    troll = read_json(R('registry/_trolling_runs.json'))
    sfp = R('registry/_sensor_feeds.json')
    sensor_feeds = (read_json(sfp).get('feeds') or {}) if os.path.exists(sfp) else {}
    ixp = R('registry/lake_index.json')
    lake_index = read_json(ixp) if os.path.exists(ixp) else {}
    acres = lambda sl: (lake_index.get(sl) or {}).get('area_acres')
    npp = R('registry/no_full_pool.json')
    no_pool = (read_json(npp).get('confirmed') or {}) if os.path.exists(npp) else {}
    lakes_runs = troll['lakes']

    duke_slugs = {v['slug'] for v in duke.values()
                  if isinstance(v, dict) and v.get('slug')}

    universe = {k: v for k, v in binds.items() if v.get('feature_type') == 'lake'}
    hunt, fetch, covered, duke_only, norun, riverine = [], [], [], [], [], []
    for slug, b in universe.items():
        rec = lakes_runs.get(slug) or {}
        n = rec.get(a.runs_field) or 0
        op = (b.get('operator') or {})
        row = {'slug': slug, 'display_name': b.get('display_name', slug),
               'state': b.get('state'), 'runs': n,
               'operator': op.get('operator'), 'feed_name': op.get('feed_name'),
               'usace': bool(b.get('usace')), 'area_acres': acres(slug)}
        if slug in no_pool:
            row['why'] = no_pool[slug].get('why')
            row['watch_instead'] = no_pool[slug].get('watch_instead')
            riverine.append(row)
        elif slug in fp:
            row['full_pool_ft'] = fp[slug].get('full_pool_ft')
            covered.append(row)
        elif slug in duke_slugs:
            duke_only.append(row)
        elif n < a.min_runs:
            norun.append(row)
        elif row['usace']:
            fetch.append(row)
        else:
            hunt.append(row)
    for grp in (hunt, fetch, covered, duke_only, norun, riverine):
        grp.sort(key=lambda r: (-r['runs'], r['display_name']))

    tot = lambda g: sum(r['runs'] for r in g)
    out = {'_note': 'Personal use only, not for distribution or resale; not for navigation.',
           'built': datetime.now(timezone.utc).astimezone().strftime('%Y-%m-%d %H:%M:%S %z'),
           'built_by': 'scripts/build_full_pool_hunt.py',
           'runs_field': a.runs_field, 'min_runs': a.min_runs,
           'inputs': src,
           'counts': {'universe_lakes': len(universe), 'hunt': len(hunt),
                      'hunt_runs': tot(hunt), 'usace_fetch': len(fetch),
                      'covered_full_pool': len(covered), 'duke_only': len(duke_only),
                      'below_min_runs': len(norun),
                      'no_full_pool_exists': len(riverine)},
           'hunt': hunt, 'usace_fetch': fetch, 'duke_only': duke_only,
           'no_full_pool_exists': riverine}
    op = R(a.out_json)
    os.makedirs(os.path.dirname(op), exist_ok=True)
    with open(op, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, indent=1)

    shown = [r for r in hunt if (r['area_acres'] or 0) >= a.min_acres]
    hidden = [r for r in hunt if r not in shown]
    big = [r for r in shown if r['runs'] >= a.table_cut]
    tail = [r for r in shown if r['runs'] < a.table_cut]
    worth = [r for r in hunt if (r['area_acres'] or 0) >= a.worth_it_acres]
    L = []
    W = L.append
    W('# What I am actually looking for -- full pool\n')
    W(out['built'][:10] + '. Personal use only, not for distribution or resale; not for navigation.\n')
    W('## What counts as an answer\n')
    W('The correction consumes FEET BELOW FULL POND and nothing else. Any of these is complete:\n')
    W('1. An elevation in FEET ABOVE SEA LEVEL that the lake is held at and spills over.')
    W('2. A feet-below-full-pond figure directly.')
    W('3. A LOCAL STAFF GAUGE reading plus its full-pond mark. Kings Mountain reports Moss')
    W('   Lake as "normal lake level is at 12\' 8.5\"" -- no msl anywhere, and still a complete')
    W('   answer. Small municipal lakes are more likely to have this than an elevation.')
    W('4. A 0-100 pool index where one point is one foot (Duke). Already yields the term.\n')
    W('A "target", "guide curve" or "summer level" is NOT an answer -- full pool is the MAXIMUM')
    W('of the operating range. NWS summer level reads 1-2 ft low on every Georgia Power lake.\n')
    W('## Where these numbers actually live\n')
    W('These are municipal supplies and cooling ponds. They have no lake-levels page -- that is')
    W('why they are on this list. What they do have:\n')
    W('- **Water shortage response plans.** Required of every NC public water system, and quoted')
    W('  in local press every drought year. BUT CHECK WHICH KIND FIRST: elevation-triggered plans')
    W('  state each stage both as an elevation and as feet below full, so the datum falls out and')
    W('  self-checks (Randleman gave 682 four times in one paragraph). Storage-percentage plans')
    W('  give NOTHING (Asheboro, Ramseur). One in four systems paid out.')
    W('- **Shoreline ordinances.** The strongest source found. Pier permits, dredging limits and')
    W('  property lines are measured from full pool, so it cannot drift. Moss Lake 736.0 came')
    W('  from Chapter 92. WATCH THE UPPER CONTOUR: the same ordinance defines a control strip up')
    W('  to 744.0, eight feet above the datum.')
    W('- **A dated "the lake is full" statement** plus any reading from that date.\n')
    W('## Before trusting any source, check identity\n')
    W('A name is not an identity. lakebrief.com/lake/moss-lake looks like our lake and is a')
    W('1,140-acre reservoir in Cooke Co, TEXAS. Ask for coordinates or a gauge id first.')
    W('USGS site prefix is a free basin check: **02xxxxxx** is every water on this card.\n')
    W('> ' + fpdoc['datum_rule']['statement'] + '\n')
    W('**%d lakes, %s runs.**  Runs are the `%s` field.\n'
      % (len(hunt), f"{tot(hunt):,}", a.runs_field))
    W('> **Only %d of them are %s acres or larger** -- %s -- together %s runs. The other %d'
      % (len(worth), f"{a.worth_it_acres:,.0f}",
         ', '.join(r['display_name'].split(' (')[0] for r in
                   sorted(worth, key=lambda x: -(x['area_acres'] or 0))) or 'none',
         f"{sum(r['runs'] for r in worth):,}", len(hunt) - len(worth)))
    W('> are city lakes, millponds and neighbourhood water. If size is your filter,')
    W('> the hunt is that short list and everything below it is optional.\n')
    W('---\n')
    W('| Lake | Acres | Runs | Operator on record |')
    W('|---|---:|---:|---|')
    for r in big:
        who = r['feed_name'] and '%s -- %s' % (r['operator'], r['feed_name']) or (r['operator'] or '')
        ac = '%,d'.replace('%,d', '{:,.0f}').format(r['area_acres']) if r['area_acres'] else '?'
        W('| %s | %s | %d | %s |' % (r['display_name'], ac, r['runs'], who))
    W('')
    W('The Operator column is read from `water_bindings.json`, not guessed. Blank means the')
    W('record does not know, which is most of them -- that is the finding, not a gap in the report.\n')
    if tail:
        W('Below %d runs: **%d more lakes, %s runs between them.** Full list in the JSON.\n'
          % (a.table_cut, len(tail), f"{tot(tail):,}"))
    else:
        W('That is all %d, every hunt lake, largest first. %s runs in total.\n'
          % (len(shown), f"{tot(shown):,}"))
    if hidden:
        W('**%d lakes under %s acres are not listed** (`--min-acres %s`): %s runs between them.\n'
          % (len(hidden), f"{a.min_acres:,.0f}", f"{a.min_acres:g}", f"{tot(hidden):,}"))
    W('## Not a hunt\n')
    if riverine:
        W('**%d have NO full pool to find.** Side-channel and oxbow waters are cut-off river'
          % len(riverine))
        W('bends still tied to their river: the river\'s stage sets the level and there is no')
        W('pool to be held at. A side-channel water wants a RIVER GAUGE. Asking for a datum')
        W('here is a category error, not a gap. `registry/no_full_pool.json`.\n')
        for r in riverine:
            W('- %s -- %d runs -- watch `%s`' % (r['display_name'], r['runs'],
                                                 r.get('watch_instead') or '?'))
        W('')
    W('**%d have a USACE/CWMS pointer** -- a fetch, not an evening.' % len(fetch))
    for r in fetch:
        W('- %s (%d runs)' % (r['display_name'], r['runs']))
    W('')
    W('Pull `<project>.Elev.Inst.0.Top of Conservation` BY ID with an effective date and take')
    W('the MAXIMUM of `seasonal-values`. The district-wide query returns only today and reads')
    W('~4 ft low in late August -- that is how Hartwell first came back 656 instead of 660.')
    W('The pointer is a binding, not a promise; some point at a river gauge near the lake.\n')
    W('**%d Duke lakes need nothing.** One index point is one foot, so the index already gives'
      % len(duke_only))
    W('feet below full pond, which is the only term the correction uses.\n')
    W('**%d already have a full pool** and %d bound %s below the %d-run floor.\n'
      % (len(covered), len(norun), 'lake is' if len(norun)==1 else 'lakes are', a.min_runs))
    datum_no_feed = [r for r in covered if not (r['usace'] or r['operator']
                                                or r['slug'] in duke_slugs)]
    datum_no_feed = [r for r in datum_no_feed if not _has_elev(binds[r['slug']])]
    unbound = [r for r in datum_no_feed if r['slug'] in sensor_feeds]
    nofeed = [r for r in datum_no_feed if r['slug'] not in sensor_feeds]
    if unbound:
        W('## Feed FOUND but not bound\n')
        W('A working live source exists and is written down in `registry/_sensor_feeds.json`,')
        W('but no binder consumes that file yet, so `water_bindings.json` does not know about')
        W('it and nothing in the app can read it. The data is real; the wiring is missing.\n')
        for r in sorted(unbound, key=lambda x: -x['runs']):
            W('- %s -- %d runs, full pool %s' % (r['display_name'], r['runs'],
                                                 r.get('full_pool_ft')))
        W('')
    if nofeed:
        W('## Datum known, no live level anywhere\n')
        W('Full pool on file and NO live elevation from any source, bound or found, so the')
        W('drawdown correction cannot run on them. A FEED problem, not a hunt.\n')
        for r in sorted(nofeed, key=lambda x: -x['runs']):
            W('- %s -- %d runs, full pool %s' % (r['display_name'], r['runs'],
                                                 r.get('full_pool_ft')))
        W('')
    W('## Inputs this list was built from\n')
    W('| File | Modified | sha256 |')
    W('|---|---|---|')
    for k in ('bindings', 'full_pool', 'duke', 'runs'):
        s = src[k]
        W('| `%s` | %s | `%s` |' % (s['path'], s['mtime'], s['sha256_12']))
    W('')
    W('If this count disagrees with an earlier one, diff these four lines first.')
    if troll.get('partial'):
        W('\n**`_trolling_runs.json` is marked `partial: true`** -- a fit was still running when')
        W('it was written, so the run counts can move under this list.')
    mp = R(a.out_md)
    os.makedirs(os.path.dirname(mp), exist_ok=True)
    with open(mp, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write('\n'.join(L) + '\n')

    print('hunt %d lakes / %s runs (field=%s)' % (len(hunt), f"{tot(hunt):,}", a.runs_field))
    print('usace-fetch %d   duke-only %d   covered %d   below-min-runs %d'
          % (len(fetch), len(duke_only), len(covered), len(norun)))
    print('->', a.out_md)
    print('->', a.out_json)

if __name__ == '__main__':
    main()
