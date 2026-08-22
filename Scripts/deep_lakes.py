#!/usr/bin/env python3
r"""deep_lakes.py - every shipped lake whose contours now go past the old 83 ft ceiling.

Personal use only, not for distribution or resale; not for navigation.

    py .\deep_lakes.py --packs F:\TrollMapPipeline\chartpack
    py .\deep_lakes.py --packs F:\TrollMapPipeline\chartpack --csv F:\TrollMapPipeline\outputs\deep_lakes.csv

WHY THIS EXISTS

Until 2026-08-21 every contour in every pack stopped at 83.0 ft, because the two-byte depth
record `91 07 0e` / `11 07 0e` was not decoded. Lake Jocassee is ~350 ft deep and shipped
capped. The decoder was fixed, the extract re-run and the packs rebuilt, and this is the list
of what changed -- the waters that should now be checked BY EYE, because nothing in the
pipeline can tell a correct 300 ft contour from an incorrect one.

Ryan does the looking. This does the counting, and sorts it so the looking is short: deepest
first, with the position of the deepest contour so the map can be jumped straight to it.

THREE GROUPS, and the middle one is the point

  DEEPER THAN 83 FT   the fix worked here. Check the deepest value is plausible for the water.
  EXACTLY 83.0 FT     ambiguous BY CONSTRUCTION. It is either a real 83 ft lake or a pack that
                      did not get rebuilt. `find_affected_tiles.py` answers this at the TILE
                      level and reported 241 clean; this is the same question asked per LAKE,
                      which is the level a person can actually judge.
  SHALLOWER           nothing to look at.

A SUBSTRING TEST IS NOT A TEST ON A MAXIMUM. The checker this replaces searched for the text
`"depth_ft": 83` and stopped at the first hit, so a deep lake with an 83 ft contour on the way
down to 348 reported as capped -- 121 of 238 tiles on a run that was perfect. This reads every
depth in the file and keeps the largest.
"""
from __future__ import annotations
import argparse, csv, json, os, re, sys

DEPTH = re.compile(r'"depth_ft"\s*:\s*(-?\d+(?:\.\d+)?)')
CEILING = 83.0


def scan(path):
    """(max depth, [lon, lat] of a vertex on the deepest feature, how many depths were read).

    Streamed rather than json.load'ed: a big pack's contours.geojson runs to tens of MB and
    374 of them will not sit in memory at once.
    """
    best, best_pos, n = None, None, 0
    buf = ''
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), ''):
            buf += chunk
            # keep the tail, a depth token can straddle a chunk boundary
            cut = buf.rfind('}', 0, len(buf) - 64)
            if cut < 0:
                continue
            head, buf = buf[:cut], buf[cut:]
            for m in DEPTH.finditer(head):
                n += 1
                v = float(m.group(1))
                if best is None or v > best:
                    best = v
                    c = re.search(r'\[\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)', head[m.end():m.end() + 4000])
                    best_pos = [float(c.group(1)), float(c.group(2))] if c else None
    for m in DEPTH.finditer(buf):
        n += 1
        v = float(m.group(1))
        if best is None or v > best:
            best, best_pos = v, None
    return best, best_pos, n


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--packs', required=True)
    ap.add_argument('--index', help='defaults to <packs>/../registry/lake_index.json; used to '
                                    'name the lakes and to skip what the app does not offer')
    ap.add_argument('--all', action='store_true',
                    help='scan every pack dir, not just the ones the index offers')
    ap.add_argument('--csv', help='also write the whole table here')
    a = ap.parse_args()

    root = a.packs
    ipath = a.index or os.path.join(os.path.dirname(root.rstrip('\\/')), 'registry',
                                    'lake_index.json')
    offered, names = None, {}
    if os.path.exists(ipath):
        d = json.load(open(ipath, encoding='utf-8'))
        rows = d if isinstance(d, list) else (d.get('lakes') or list(d.values()))
        if isinstance(rows, dict):
            rows = list(rows.values())
        rows = [r for r in rows if isinstance(r, dict) and r.get('slug')]
        names = {r['slug']: (r.get('display_name') or r.get('name') or r['slug']) for r in rows}
        offered = set(names)
        print('index: %d slugs offered' % len(offered))
    elif not a.all:
        sys.exit('no lake_index.json at %s -- pass --index, or --all to scan every pack' % ipath)

    dirs = sorted(p for p in os.listdir(root)
                  if os.path.isdir(os.path.join(root, p)) and not p.startswith('_'))
    todo = [d for d in dirs if a.all or offered is None or d in offered]
    print('%d pack dir(s), %d to scan' % (len(dirs), len(todo)))

    rowsout, no_contours = [], 0
    for i, slug in enumerate(todo, 1):
        fp = os.path.join(root, slug, 'contours.geojson')
        if not os.path.exists(fp) or os.path.getsize(fp) == 0:
            no_contours += 1
            continue
        mx, pos, n = scan(fp)
        if mx is None:
            no_contours += 1
            continue
        rowsout.append({'slug': slug, 'name': names.get(slug, slug), 'max_ft': mx,
                        'contours': n, 'lon': (pos or [None, None])[0],
                        'lat': (pos or [None, None])[1],
                        'mb': round(os.path.getsize(fp) / 1e6, 2)})
        if i % 50 == 0:
            print('   %d/%d' % (i, len(todo)))

    deeper = sorted((r for r in rowsout if r['max_ft'] > CEILING), key=lambda r: -r['max_ft'])
    exact = sorted((r for r in rowsout if abs(r['max_ft'] - CEILING) < 0.05),
                   key=lambda r: -r['contours'])

    print('\n%d lake(s) scanned, %d with no contours' % (len(rowsout), no_contours))
    print('\nDEEPER THAN %.0f FT -- %d lake(s). Check the deepest value is plausible.'
          % (CEILING, len(deeper)))
    print('   %-34s %9s  %8s   deepest contour at' % ('lake', 'max ft', 'contours'))
    for r in deeper:
        pos = ('%.5f, %.5f' % (r['lat'], r['lon'])) if r['lat'] is not None else '-'
        print('   %-34s %9.1f  %8d   %s' % (r['name'][:34], r['max_ft'], r['contours'], pos))

    print('\nEXACTLY %.1f FT -- %d lake(s). Real 83 ft water, or a pack that never rebuilt.'
          % (CEILING, len(exact)))
    for r in exact:
        pos = ('%.5f, %.5f' % (r['lat'], r['lon'])) if r['lat'] is not None else '-'
        print('   %-34s %9.1f  %8d   %s' % (r['name'][:34], r['max_ft'], r['contours'], pos))

    if a.csv:
        with open(a.csv, 'w', newline='', encoding='utf-8') as fh:
            w = csv.DictWriter(fh, fieldnames=['slug', 'name', 'max_ft', 'contours', 'lat',
                                               'lon', 'mb'])
            w.writeheader()
            for r in sorted(rowsout, key=lambda r: -r['max_ft']):
                w.writerow(r)
        print('\n-> %s  (all %d)' % (a.csv, len(rowsout)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
