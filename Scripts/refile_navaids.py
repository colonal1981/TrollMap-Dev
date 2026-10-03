#!/usr/bin/env python3
"""refile_navaids.py - every charted aid in the packs filed again by rgn4_pois' current table.

Personal use only, not for distribution or resale; not for navigation.

    py .\\refile_navaids.py --packs "F:\\TrollMapPipeline\\chartpack" --dry-run
    py .\\refile_navaids.py --packs "F:\\TrollMapPipeline\\chartpack" --only lake_murray

Rewrites `<slug>/pois.geojson` in place, moving the original to
`<packs>/../_to_delete/pre_navaid_refile/<slug>/` first (never over an earlier copy).

WHY

Ryan, 2026-10-03, on the buoys at Pinopolis Dam: *"Why can't the plan know that those buoys are
there? They are in the poi layer?"* Measuring it found that the chart NAMES many keep-out lines in
plain words, and the extractor's table only knew one spelling of them. `rgn4_pois.NAVAID_CLASS`
matched 'no boats', so "No Boat Buoy" (89 buoys on waters with a dam, Lake Murray's Saluda spillway
line among them), "Keep Out", "Boats Keep Out" and "Keep Out Buoy" fell through to the generic
'buoy' and were filed as `nav_buoy` -- the class Ryan sorted as "not a hazard". The table is fixed
in rgn4_pois.py; this applies it to the packs already built, which is cheaper than extracting every
tile again and gives the same answer.

WHAT IT TOUCHES. Only features the extractor marked `navaid: true`, and only their `poi_type`. Each
is passed to `rgn4_pois.poi_type()` itself, so there is one table and one function and this script
holds neither. Running it twice changes nothing the second time.
"""
import argparse, collections, json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rgn4_pois import poi_type  # noqa: E402


def refile(features):
    """Re-type every navaid in place. Returns a Counter of (old, new, name) for what changed."""
    changed = collections.Counter()
    for f in features:
        p = f.get('properties') or {}
        if not p.get('navaid'):
            continue
        t, on_water = poi_type(p)
        if t != p.get('poi_type'):
            changed[(p.get('poi_type'), t, p.get('class') or p.get('name') or '')] += 1
            p['poi_type'] = t
            p['on_water'] = on_water
    return changed


def backup(packs, slug, path):
    bak = os.path.join(os.path.dirname(os.path.abspath(packs)), '_to_delete', 'pre_navaid_refile', slug)
    os.makedirs(bak, exist_ok=True)
    dest = os.path.join(bak, 'pois.geojson')
    n = 2
    while os.path.exists(dest):
        dest = os.path.join(bak, 'pois.geojson.%d' % n)
        n += 1
    os.replace(path, dest)
    return dest


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--packs', required=True)
    ap.add_argument('--only', default=None, help='one slug, or several joined by commas')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args(argv)
    slugs = (a.only.split(',') if a.only else
             sorted(d for d in os.listdir(a.packs) if os.path.isfile(os.path.join(a.packs, d, 'pois.geojson'))))
    t0 = time.time()
    packs_changed, total = [], collections.Counter()
    for slug in slugs:
        path = os.path.join(a.packs, slug, 'pois.geojson')
        if not os.path.isfile(path):
            continue
        with open(path, 'r', encoding='utf-8') as fh:
            gj = json.load(fh)
        changed = refile(gj.get('features') or [])
        if not changed:
            continue
        packs_changed.append(slug)
        total.update(changed)
        print('  %-40s %s' % (slug, '; '.join('%d %s -> %s (%s)' % (n, o, t, nm[:30])
                                              for (o, t, nm), n in changed.most_common(4))))
        if not a.dry_run:
            backup(a.packs, slug, path)
            tmp = path + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as fh:
                fh.write(json.dumps(gj, ensure_ascii=False))
            os.replace(tmp, path)
    by_move = collections.Counter()
    for (o, t, _nm), n in total.items():
        by_move[(o, t)] += n
    print('%d packs changed, %d aids refiled (%s), %.0fs%s'
          % (len(packs_changed), sum(total.values()),
             ', '.join('%d %s -> %s' % (n, o, t) for (o, t), n in by_move.most_common()),
             time.time() - t0, ' (dry run, nothing written)' if a.dry_run else ''))
    if packs_changed and not a.dry_run:
        print('changed: ' + ','.join(packs_changed))
    return 0


if __name__ == '__main__':
    sys.exit(main())
