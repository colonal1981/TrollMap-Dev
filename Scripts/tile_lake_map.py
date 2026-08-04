#!/usr/bin/env python3
"""tile_lake_map.py - which GMP tiles cover which registry lakes, and vice versa.

Personal use only, not for distribution or resale; not for navigation.

    py .\\tile_lake_map.py --labels "F:\\TrollMapPipeline\\extract\\labels" `
       --registry "F:\\TrollMapPipeline\\registry" `
       --index "F:\\TrollMapPipeline\\registry\\lake_index.json" `
       --out "F:\\TrollMapPipeline\\registry\\tile_lake_map.json" `
       --tiles-out "F:\\TrollMapPipeline\\registry\\tiles_to_extract.txt" `
       --states "SC,NC,GA,TN" --accessible-only

There is no `--charted-only`, and there cannot be one yet: `charted` is null for every lake
until the extraction this script is scoping has actually run. `--accessible-only` is the
filter that matters here -- it narrows the work list to lakes with public or credentialed
land on the bank, and the run then measures `charted` for free. Ryan's call on 2026-08-02
was to upload only lakes that come back with contours, which is a decision made AFTER this
step, not before it.

Drop `--accessible-only` (and `--index`) to scope the run to all 1,551 registry lakes.

WHY THIS EXISTS

A card-wide run decodes 2,589 B tiles and their C partners. Extracting all of them to find
the 322 lakes worth shipping is the expensive way round. This produces the work list: for
each lake, the tiles that cover it; for each tile, the lakes it is needed for. Feed
`--tiles` on `trollmap_extract_all.py` from the tile list and the run shrinks to the tiles
that actually matter.

It needs no decoding. `trollmap_extract_all.py --layers labels` already wrote a `bounds`
block into every `extract/labels/<TILE>.json`, and the registry carries `bounds_wsen` per
lake. The mapping is a box intersect.

CACHE THE BOUNDS. Reading 2,589 label JSONs is ~250 MB of parsing, and over the Cowork
device bridge it times out. The first run writes `<labels>/_bounds_cache.json` (a few
hundred KB) and every run after reads that in a blink. Delete it after a re-extract.

A TILE BOX IS NOT A LAKE BOX. A tile is roughly 0.70 x 0.59 degrees and holds dozens of
lakes, so this says "decode this tile to get this lake", never "this lake is here". The
extent comes from the registry polygon; this only picks the files.
"""
import argparse, glob, json, os, sys
from collections import defaultdict


def load_bounds(labels):
    """tile -> (w, s, e, n), cached. The cache is the whole point; see the docstring."""
    cache = os.path.join(labels, '_bounds_cache.json')
    if os.path.exists(cache):
        d = json.load(open(cache, encoding='utf-8'))
        print('bounds cache: %d tiles (delete %s after a re-extract)' % (len(d), cache))
        return {k: tuple(v) for k, v in d.items()}

    out = {}
    files = sorted(glob.glob(os.path.join(labels, '*.json'))
                   + glob.glob(os.path.join(labels, '*.json.gz')))
    files = [f for f in files if not f.endswith('_bounds_cache.json')]
    if not files:
        sys.exit('no label files in %s -- run trollmap_extract_all.py --layers labels first'
                 % labels)
    print('building the bounds cache from %d label files (one time, a few minutes)...' % len(files))
    for i, fp in enumerate(files):
        try:
            if fp.endswith('.gz'):
                import gzip
                with gzip.open(fp, 'rt', encoding='utf-8') as f:
                    d = json.load(f)
            else:
                d = json.load(open(fp, encoding='utf-8'))
        except Exception:
            continue
        b = d.get('bounds') or {}
        if not b:
            continue
        tid = d.get('tile') or os.path.basename(fp).split('.')[0]
        out[tid] = (b['west'], b['south'], b['east'], b['north'])
        if (i + 1) % 500 == 0:
            print('   %d/%d' % (i + 1, len(files)))
    json.dump({k: list(v) for k, v in out.items()}, open(cache, 'w'))
    print('-> %s' % cache)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--labels', required=True)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--states', default='SC,NC,GA,TN')
    ap.add_argument('--index', help='lake_index.json, to restrict to accessible lakes')
    ap.add_argument('--accessible-only', action='store_true',
                    help='only lakes whose access_for_me is Open Access or Open With Credential '
                         '(needs --index)')
    ap.add_argument('--tiles-out', help='also write a plain tile list, one per line, for --tiles')
    a = ap.parse_args()

    want = {s.strip().upper() for s in a.states.split(',')}
    reg = json.load(open(os.path.join(a.registry, 'lakes.json'), encoding='utf-8'))
    lakes = [x for x in reg['lakes'] if (x.get('state') or '').upper() in want]

    if a.accessible_only:
        if not a.index:
            sys.exit('--accessible-only needs --index')
        idx = json.load(open(a.index, encoding='utf-8'))
        ok = {'Open Access', 'Open With Credential'}
        keep = {k for k, v in idx.items() if v.get('access_for_me') in ok}
        lakes = [x for x in lakes if x['slug'] in keep]
        print('restricted to %d accessible lakes' % len(lakes))

    B = load_bounds(a.labels)

    by_lake, by_tile, orphan = {}, defaultdict(list), []
    for x in lakes:
        w, s, e, n = x['bounds_wsen']
        hit = [t for t, (tw, ts, te, tn) in B.items()
               if not (e < tw or w > te or n < ts or s > tn)]
        by_lake[x['slug']] = sorted(hit)
        for t in hit:
            by_tile[t].append(x['slug'])
        if not hit:
            orphan.append(x)

    json.dump({'by_lake': by_lake,
               'by_tile': {t: sorted(v) for t, v in by_tile.items()},
               'orphans': [x['slug'] for x in orphan]},
              open(a.out, 'w', encoding='utf-8'), indent=1)

    # A B tile and its C partner differ only in the leading letter, so one list covers both.
    tiles = sorted(by_tile)
    if a.tiles_out:
        with open(a.tiles_out, 'w') as f:
            f.write('\n'.join(tiles) + '\n')
        print('-> %s (%d tiles)' % (a.tiles_out, len(tiles)))

    spread = sorted((len(v) for v in by_lake.values()), reverse=True)
    print('\n%d lakes -> %d distinct tiles (of %d on the card)' % (len(by_lake), len(tiles), len(B)))
    print('   lakes spanning >1 tile: %d' % sum(1 for n in spread if n > 1))
    print('   busiest tiles: %s' % ', '.join(
        '%s(%d)' % (t, len(by_tile[t])) for t in sorted(by_tile, key=lambda t: -len(by_tile[t]))[:6]))
    if orphan:
        print('   %d lakes have NO tile on the card:' % len(orphan))
        for x in sorted(orphan, key=lambda x: -(x.get('area_km2') or 0))[:10]:
            print('      %8.0f ac  %s, %s' % ((x.get('area_km2') or 0) * 247.105,
                                              x['name'], x.get('state')))
    print('-> %s' % a.out)


if __name__ == '__main__':
    main()
