#!/usr/bin/env python3
r"""
audit_packs_vs_extract.py — does every pack contain the water that was sitting in its own box?

Personal use only, not for distribution or resale; not for navigation.

WHY THIS EXISTS
---------------
2026-08-08. Ryan, after a day in which every layer we looked at had something wrong under it:

    "you have over 1000k tests but none of them finds the real issues..."

He is right, and this is the missing test. The 981 JS tests and the Python ones all check CODE --
does stem() fold "Reservoir", does steer() refuse a shoal, do both stops survive the assembler.
Not one of them looks at a shipped pack and asks whether it holds the data it was cut from.

So a signature mismatch in BboxMask.charted_fraction killed every coastal zone in _flush, before a
single file was written, and the suite stayed green while:

    coast_st_helena_sc     0 contours shipped     83,106 sitting in its box on tile B4E0FB
    coast_core_sound_nc    0 contours shipped     19,898 sitting in its box
    coast_ace_basin_sc     1,126 contours         71,139 after the fix
    coast_beaufort_sc      1,768 contours         53,414 after the fix

Nobody noticed for weeks. Ryan found it by opening the app and asking why ACE Basin drew nothing.

THE ASSERTION, and it is one line
---------------------------------
    If the extraction holds contours inside a lake's own bounds, that lake's pack must hold
    contours.

That is it. It catches all four of the above on the day they break, and it needs no fixtures,
because the inputs and outputs are both already on disk.

WHAT IT DOES NOT CLAIM
----------------------
A bounding box is generous: contours inside a lake's box are not necessarily inside the lake, so
a pack can be legitimately empty when its boundary excludes water the box includes. That is why
this reports a VIOLATION only when the box is emphatically full and the pack is emphatically
empty -- default 500 vertices against zero features -- and why the report prints the numbers
rather than a verdict.

It is a smoke alarm, not a proof. The alarm going off means look; it does not mean the pipeline is
broken. Silence, though, is worth something: on 2026-08-08 it would have been screaming.

    py scripts\audit_packs_vs_extract.py --extract F:\TrollMapPipeline\extract `
                                         --packs   F:\TrollMapPipeline\chartpack `
                                         --registry F:\TrollMapPipeline\registry

Reads only. Exit code 1 when anything is in violation, so it can gate a build.
"""
from __future__ import annotations
import argparse, gzip, json, os, sys
from collections import defaultdict

try:
    import orjson as _oj
except ImportError:
    _oj = None

CELL = 0.01          # ~1.1 km, same grid refresh_yield uses


def loads(b: bytes):
    return _oj.loads(b) if _oj is not None else json.loads(b)


def read_json(path: str):
    op = gzip.open if path.endswith('.gz') else open
    with op(path, 'rb') as fh:
        return loads(fh.read())


def index_extraction(root: str):
    """Grid of occupied cells -> contour vertex count, over every tile in the extraction."""
    grid = defaultdict(int)
    if not os.path.isdir(root):
        sys.exit('not a directory: %s' % root)
    names = sorted(n for n in os.listdir(root) if n.endswith(('.geojson', '.geojson.gz')))
    for i, name in enumerate(names, 1):
        try:
            feats = (read_json(os.path.join(root, name)) or {}).get('features') or []
        except Exception as e:
            print('  !! %s: %s' % (name, str(e)[:60]), file=sys.stderr)
            continue
        for f in feats:
            g = f.get('geometry') or {}
            cs = g.get('coordinates') or []
            lines = [cs] if g.get('type') == 'LineString' else cs
            for ln in lines:
                for p in ln:
                    try:
                        grid[(int(p[0] // CELL), int(p[1] // CELL))] += 1
                    except (TypeError, IndexError):
                        pass
        if i % 25 == 0 or i == len(names):
            print('  indexed %d/%d tiles' % (i, len(names)), flush=True)
    return grid


def in_box(grid, b) -> int:
    w, s, e, n = b
    t = 0
    for x in range(int(w // CELL), int(e // CELL) + 1):
        for y in range(int(s // CELL), int(n // CELL) + 1):
            t += grid.get((x, y), 0)
    return t


def pack_counts(pack_dir: str) -> dict:
    """Feature counts per layer for one pack. Missing file and empty file are both 0."""
    out = {}
    if not os.path.isdir(pack_dir):
        return out
    for layer in ('contours', 'depth_areas', 'docks', 'pois', 'structure', 'trolling_runs'):
        for suf in ('.geojson', '.geojson.gz'):
            p = os.path.join(pack_dir, layer + suf)
            if os.path.exists(p):
                try:
                    out[layer] = len((read_json(p) or {}).get('features') or [])
                except Exception:
                    out[layer] = -1        # unreadable is its own kind of broken
                break
        else:
            out[layer] = 0
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--extract', required=True, help='extraction root (holds contours/)')
    ap.add_argument('--packs', required=True, help='chartpack root')
    ap.add_argument('--registry', required=True, help='folder holding lake_index.json')
    ap.add_argument('--min-vertices', type=int, default=500,
                    help='how full a box must be before an empty pack counts as a violation '
                         '(default 500). A bbox is generous, so a handful of vertices can be the '
                         'lake next door clipping a corner.')
    ap.add_argument('--top', type=int, default=40)
    a = ap.parse_args()

    with open(os.path.join(a.registry, 'lake_index.json'), encoding='utf-8') as fh:
        raw = json.load(fh)
    rows = raw if isinstance(raw, list) else [{**v, 'slug': v.get('slug', k)}
                                              for k, v in raw.items()]
    print('registry: %d rows' % len(rows))
    print('indexing contours from %s ...' % os.path.join(a.extract, 'contours'))
    grid = index_extraction(os.path.join(a.extract, 'contours'))
    print('  %d occupied cells' % len(grid))

    violations, thin, ok, nobox = [], [], 0, 0
    for r in rows:
        b = r.get('bounds_wsen')
        if not (isinstance(b, list) and len(b) == 4):
            nobox += 1
            continue
        avail = in_box(grid, b)
        if avail < a.min_vertices:
            continue                      # nothing was there to lose
        got = pack_counts(os.path.join(a.packs, r['slug']))
        n = got.get('contours', 0)
        if n == 0:
            violations.append((avail, r, got))
        elif n < 0:
            violations.append((avail, r, got))
        else:
            ok += 1
            # A pack holding a hundredth of what its box offers is not proof of anything -- the
            # boundary may simply be small inside a busy box -- but it is where the next
            # BboxMask-shaped bug will show first, so it is worth naming.
            if avail > 20000 and n * 50 < avail / 40:
                thin.append((avail, n, r))

    print()
    print('checked %d lakes with a box and something in it' % (ok + len(violations)))
    print('  packs holding contours          %d' % ok)
    print('  VIOLATIONS, empty or unreadable %d' % len(violations))
    if nobox:
        print('  (%d rows have no bounds and were skipped)' % nobox)

    if violations:
        violations.sort(key=lambda t: -t[0])
        print()
        print('THE EXTRACTION HAS CONTOURS INSIDE THESE BOXES AND THE PACK HAS NONE:')
        for avail, r, got in violations[:a.top]:
            print('  %-34s %-3s %9d vertices available   pack: %s'
                  % (str(r.get('name'))[:34], r.get('state', '--'), avail,
                     ', '.join('%s=%d' % (k, v) for k, v in got.items() if v) or 'EMPTY'))
        if len(violations) > a.top:
            print('  ... and %d more' % (len(violations) - a.top))

    if thin:
        thin.sort(key=lambda t: -t[0])
        print()
        print('not violations, but thin against what their box offers:')
        for avail, n, r in thin[:10]:
            print('  %-34s %8d in pack vs %9d available' % (str(r.get('name'))[:34], n, avail))

    print()
    print('A box is generous, so this is a smoke alarm rather than a proof: contours inside a')
    print("lake's box need not be inside the lake. But a box with thousands of vertices and a")
    print('pack with none is the shape of a real bug, and on 2026-08-08 it was four of them.')
    return 1 if violations else 0


if __name__ == '__main__':
    raise SystemExit(main())
