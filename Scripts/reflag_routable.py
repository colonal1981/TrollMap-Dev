#!/usr/bin/env python3
"""Re-flag `routable` on trolling runs that already exist, against the graph that is there now.

Personal use only, not for distribution or resale; not for navigation.

WHY THIS EXISTS. A run carries `routable` from the moment it was BUILT. Give a water a graph it
never had -- which is what bathy_graph.py does for the 196 shipped waters Garmin never meshed --
and every run on it still reads `routable: false`, because nothing went back and asked again.

Rebuilding the runs would fix it and is the wrong tool: fit_trolling_runs.py spent 101 minutes of
wall clock and 482 minutes of CPU on 49 packs on 2026-08-26, and a rebuild throws that away. This
touches THREE properties on each existing feature -- `routable`, `reach_node`, `reach_m` -- and
changes no geometry at all.

IT REUSES build_trolling_runs.py'S OWN CODE. read_graph, NodeIndex, main_component and metres are
imported, not reimplemented, and the probe below is the same eight-point walk with the same
`--reach-m` default of 120.0. A second implementation of a reachability rule is a second answer
waiting to disagree with the first.
"""
import argparse, json, os, sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from build_trolling_runs import read_graph, NodeIndex, main_component   # noqa: E402


def reflag_one(pack_dir, reach_m):
    rpath = os.path.join(pack_dir, 'trolling_runs.geojson')
    gpath = os.path.join(pack_dir, 'water_graph.bin')
    if not os.path.isfile(rpath):
        return {'skipped': 'no trolling_runs.geojson'}
    if not os.path.isfile(gpath):
        return {'skipped': 'no water_graph.bin'}
    g = read_graph(gpath)
    if not g:
        return {'skipped': 'unreadable water_graph.bin'}
    nodes, edges = g
    idx = NodeIndex(nodes)
    mainset = main_component(len(nodes), edges)

    with open(rpath, 'r', encoding='utf-8') as fh:
        gj = json.load(fh) or {}
    feats = gj.get('features') or []
    was = sum(1 for f in feats if (f.get('properties') or {}).get('routable'))
    changed = 0
    for f in feats:
        props = f.setdefault('properties', {})
        geom = ((f.get('geometry') or {}).get('coordinates')) or []
        if not geom or not isinstance(geom[0], (list, tuple)):
            continue
        # THE SAME EIGHT-POINT PROBE build_trolling_runs uses, and for its stated reason: one end
        # of a long run can sit in a pocket while the body of it is on open water.
        step = max(1, len(geom) // 8)
        best = (None, float('inf'))
        for p in geom[::step]:
            j, d = idx.nearest(p)
            if j is not None and d < best[1]:
                best = (j, d)
        j, d = best
        before = bool(props.get('routable'))
        if j is not None and d <= reach_m:
            props['reach_node'] = j
            props['reach_m'] = round(d, 1)
            props['routable'] = bool(mainset and j in mainset)
        else:
            props.pop('reach_node', None)
            props.pop('reach_m', None)
            props['routable'] = False
        if bool(props['routable']) != before:
            changed += 1
    now = sum(1 for f in feats if (f.get('properties') or {}).get('routable'))
    return {'runs': len(feats), 'routable_before': was, 'routable_after': now,
            'flags_changed': changed, 'nodes': len(nodes), 'edges': len(edges),
            '_gj': gj, '_path': rpath}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default='.')
    ap.add_argument('--pack', default=None)
    ap.add_argument('--only-lakes', default=None, help='comma-separated slugs')
    ap.add_argument('--reach-m', type=float, default=120.0,
                    help="must match build_trolling_runs.py's --reach-m. Default 120.0, same.")
    ap.add_argument('--report', default='registry/_reflag_routable.json')
    ap.add_argument('--write', action='store_true',
                    help='write the runs back. WITHOUT THIS NOTHING IS MODIFIED -- the default '
                         'is a dry run, because these files are the product of a 101-minute fit.')
    a = ap.parse_args()
    pack = a.pack or os.path.join(a.root, 'chartpack')

    if a.only_lakes:
        slugs = [s.strip() for s in a.only_lakes.split(',') if s.strip()]
    else:
        slugs = sorted(d for d in os.listdir(pack)
                       if os.path.isfile(os.path.join(pack, d, 'trolling_runs.geojson'))
                       and os.path.isfile(os.path.join(pack, d, 'water_graph.bin')))
    print('reflag: %d water%s  %s' % (len(slugs), '' if len(slugs) == 1 else 's',
                                      '' if a.write else '(DRY RUN -- pass --write to save)'),
          flush=True)
    report, gained, touched = {}, 0, 0
    for s in slugs:
        r = reflag_one(os.path.join(pack, s), a.reach_m)
        if 'skipped' in r:
            report[s] = r
            continue
        gj, rpath = r.pop('_gj'), r.pop('_path')
        report[s] = r
        if r['flags_changed']:
            touched += 1
            gained += r['routable_after'] - r['routable_before']
            print('  %-30s %6d runs   routable %5d -> %-5d  (%+d)'
                  % (s, r['runs'], r['routable_before'], r['routable_after'],
                     r['routable_after'] - r['routable_before']), flush=True)
            if a.write:
                tmp = rpath + '.tmp'
                with open(tmp, 'w', encoding='utf-8') as fh:
                    json.dump(gj, fh)
                os.replace(tmp, rpath)
    rp = os.path.join(a.root, a.report)
    os.makedirs(os.path.dirname(rp), exist_ok=True)
    json.dump({'_note': 'Personal use only, not for distribution or resale; not for navigation.',
               'built_by': 'scripts/reflag_routable.py', 'reach_m': a.reach_m,
               'written': bool(a.write), 'lakes': report}, open(rp, 'w'), indent=1)
    print('waters changed %d   net routable runs %+d   -> %s%s'
          % (touched, gained, a.report, '' if a.write else '   (nothing written)'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
