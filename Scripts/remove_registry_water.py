#!/usr/bin/env python3
r"""remove_registry_water.py -- take water OUT of the registry, in the order that is safe.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\remove_registry_water.py --slugs F:\TrollMapPipeline\outputs\unnamed_waters.txt
    py .\scripts\remove_registry_water.py --slugs water_j0s0y,water_kxs23 --go

Dry run by default. `--go` writes.

WHY THIS EXISTS

There was no remover. `install_registry_boundary.py` is the only writer that touches the
registry and nothing took anything back out, so a removal meant hand-editing three JSON files
and hoping -- which is how a slug survives in one of them and comes back on the next build.

WHAT IT TOUCHES, AND WHAT IT DELIBERATELY DOES NOT

    registry/lakes.json           the `lakes[]` RECORD -- what consolidate walks. by_state,
                                  state_order and count are VIEWS and are rebuilt from it;
                                  editing the view alone removes the water from nothing
    registry/boundaries/<slug>    moved to _to_delete/, never unlinked
    registry/tile_lake_map.json   by_lake and by_tile
    registry/charted.json         the build's own report row
    registry/_removed_waters.json APPENDED: what went, when, and why

    chartpack/<slug>/             LEFT ALONE. It is the local backup the R2 prune rule leans on:
                                  "no longer offered AND we have a backup" is what lets an object
                                  leave R2. Delete the pack here and the rule can never fire.
    R2                            LEFT ALONE. r2_audit.deletable() decides that, on its own pass.

    lake_index.json               NOT edited. consolidate_lake_index.py rebuilds it from
                                  lakes.json, so removing the source is the removal. Editing the
                                  index directly would be undone by the next consolidate.

CUT THE NAME BEFORE THE OBJECT, AND THIS ENFORCES IT

`lake-keys.js` is a SECOND FETCH PATH: contour-data.js resolves a display name through it and
fetches chartpacks/<key>/contours.geojson straight from R2, consulting no registry row. A name
that still resolves after its objects go starts failing instead of going quiet. So this REFUSES
any slug that appears in a name-resolving file and names it, rather than trusting the operator to
have checked. Measured 2026-08-22 on the 26 unnamed waters: none of them appear in any of the
four, which is why they were safe to take out first.
"""
import argparse, io, json, os, shutil, sys

NAME_PATHS = ('TrollMap-Dev/js/data/lake-keys.js', 'TrollMap-Dev/js/data/water-aliases.js',
              'registry/curated_lakes.json', 'registry/lake_aliases.json')


def slug_list(src):
    """A comma list, a file path, or @file. `@` optional -- `@"` is a PowerShell here-string."""
    if not src:
        return []
    s = src[1:] if src.startswith('@') else src
    if os.path.exists(s):
        with io.open(s, encoding='utf-8') as fh:
            return [l.strip() for l in fh if l.strip() and not l.startswith('#')]
    return [x.strip() for x in src.split(',') if x.strip()]


def load(p):
    with io.open(p, encoding='utf-8') as fh:
        return json.load(fh)


def save(p, obj, go):
    if not go:
        return
    if os.path.exists(p) and not os.path.exists(p + '.bak'):
        shutil.copy2(p, p + '.bak')
    with io.open(p, 'w', encoding='utf-8') as fh:
        json.dump(obj, fh, indent=1, sort_keys=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--slugs', required=True, help='comma list, a file path, or @file')
    ap.add_argument('--registry', default='registry')
    ap.add_argument('--reason', default='unnamed water, not identifiable in the picker')
    ap.add_argument('--date', default=None, help='stamp for the _to_delete folder; default today')
    ap.add_argument('--go', action='store_true', help='write. Without it nothing is touched.')
    a = ap.parse_args()
    R = a.registry
    want = sorted(set(slug_list(a.slugs)))
    if not want:
        print('no slugs given'); return 2

    blocked = {}
    for p in NAME_PATHS:
        try:
            with io.open(p, encoding='utf-8', errors='replace') as fh:
                t = fh.read()
        except OSError:
            continue
        for s in want:
            if s in t:
                blocked.setdefault(s, []).append(os.path.basename(p))
    if blocked:
        print('REFUSED -- these resolve by name somewhere, cut the name first:')
        for s, where in sorted(blocked.items()):
            print('   %-28s %s' % (s, ', '.join(where)))
        return 1
    print('%d slug(s); none of them resolve by name in %d checked files' % (len(want), len(NAME_PATHS)))

    stamp = a.date or __import__('time').strftime('%Y-%m-%d')
    trash = os.path.join('_to_delete', 'registry_removed_' + stamp)
    hit = {'lakes.json': 0, 'boundaries': 0, 'tile_lake_map': 0, 'charted': 0}

    # lakes.json's RECORD is `lakes[]`. `by_state`, `state_order` and `count` are VIEWS of it --
    # install_registry_boundary.py rebuilds all three from `lakes[]` every time it writes, and
    # consolidate_lake_index.py:627 walks `lakes[]` and never reads by_state at all. SO EDITING
    # THE VIEW REMOVES A WATER FROM NOTHING.
    #
    # 2026-08-24: this script did exactly that. The seven waters Ryan retired on 08-23 -- their
    # boundary files moved to _to_delete, their tile_lake_map rows and charted verdicts gone --
    # came straight back into lake_index.json on the next consolidate, because their rows were
    # still in `lakes[]`. 365 rows where 358 were expected, each one carrying a chartpack dir
    # this script deliberately leaves behind, so the packless gate saw a drawable pack and kept
    # it.
    #
    # It is the same failure migrate_merged_slugs.py already records at its LEAVE_ALONE block
    # and test_migrate_slugs.py already tripwires: "Rewriting its by_state lists on 2026-08-18
    # left seven records in lakes[] belonging to no state list at all: the inventory disagreeing
    # with its own index." Seven records, both times, eleven days apart.
    #
    # Drop from the record, then REBUILD the views from it -- so a run repairs drift an earlier
    # run left behind rather than adding to it.
    p = os.path.join(R, 'lakes.json')
    lakes = load(p)
    src = lakes.get('lakes') or []
    rows = [r for r in src if (r.get('slug') if isinstance(r, dict) else r) not in want]
    hit['lakes.json'] = len(src) - len(rows)
    lakes['lakes'] = rows
    bs = {}
    for r in rows:
        if isinstance(r, dict) and r.get('slug'):
            bs.setdefault(r.get('state') or '??', []).append(r['slug'])
    order = [st for st in (lakes.get('state_order') or []) if st in bs]
    for st in sorted(bs):
        if st not in order:
            order.append(st)
    lakes['state_order'] = order
    lakes['by_state'] = {st: sorted(bs[st]) for st in order}
    lakes['count'] = len(rows)
    save(p, lakes, a.go)

    p = os.path.join(R, 'tile_lake_map.json')
    tm = load(p)
    by_lake = tm.get('by_lake') or {}
    for s in want:
        if by_lake.pop(s, None) is not None:
            hit['tile_lake_map'] += 1
    for t, lst in list((tm.get('by_tile') or {}).items()):
        tm['by_tile'][t] = [s for s in lst if s not in want]
    save(p, tm, a.go)

    p = os.path.join(R, 'charted.json')
    ch = load(p)
    for s in want:
        if ch.pop(s, None) is not None:
            hit['charted'] += 1
    save(p, ch, a.go)

    if a.go:
        os.makedirs(trash, exist_ok=True)
    for s in want:
        src = os.path.join(R, 'boundaries', s + '.geojson')
        if os.path.exists(src):
            hit['boundaries'] += 1
            if a.go:
                shutil.move(src, os.path.join(trash, s + '.geojson'))

    p = os.path.join(R, '_removed_waters.json')
    log = load(p) if os.path.exists(p) else []
    log.append({'date': stamp, 'reason': a.reason, 'slugs': want})
    save(p, log, a.go)

    print('%slakes.json %d, boundaries %d, tile_lake_map %d, charted.json %d'
          % ('' if a.go else '[DRY RUN] ', hit['lakes.json'], hit['boundaries'],
             hit['tile_lake_map'], hit['charted']))
    print('chartpack dirs and R2 objects LEFT ALONE -- they are the backup the prune rule needs.')
    print('Run consolidate_lake_index.py next; the index is rebuilt from lakes.json.')
    if not a.go:
        print('\nNothing was written. Re-run with --go.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
