#!/usr/bin/env python3
r"""build_coverage_cache.py -- rebuild extract/_garmin_coverage.json, and nothing else.

    py .\scripts\build_coverage_cache.py

WHY THIS EXISTS

`sweep_unclaimed.py` reads the coverage cache and cannot build it. The builder lived inside
`make_river_boundaries.py` as a side effect of cutting river boundaries, so the only documented
way to refresh a stale cache was to run the whole cutter -- which needs `--gpkg`, `--feeds` and
`--out`, loads the 60 GB GeoPackage, and REWRITES BOUNDARY FILES. Rebuilding a derived cache
should not rewrite the registry.

Worse, the sweep's own stop message said "py .\scripts\make_river_boundaries.py" with no
arguments, which is a usage error and nothing else. That is the whole reason this file exists:
a blocker that names a command the reader cannot run is not a blocker, it is a dead end.

The scan itself is unchanged -- `garmin_coverage()` is imported from `make_river_boundaries.py`
rather than copied, so there is exactly one implementation of what counts as coverage and the
SHOAL_DM rule cannot drift between two files.

WHAT IT WRITES

    cells      every grid cell touched by a contour or by a depth area deeper than the shoal band
    da_cells   the subset backed by an actual DEPTH AREA rather than a contour line alone

The second is the one that matters. A cell that only ever saw a contour pass through it is water
by inference; a cell inside a depth polygon is water by measurement. Ryan, 2026-08-12, on a
3,050-acre "lake" that held zero depth areas and seven contour lines: *"garmin doesn't do
bathymetry surveys on these... so that theory doesn't hold."*

REGION

`garmin_coverage()` clips to a bounding box. The cutter passes the box covering all four DNR
feeds; this passes the whole world by default, so the cache is the complete extract and nothing
is silently dropped before `sweep_unclaimed.py` gets a chance to test it against the real state
polygons in `registry/region_mask.json`. A box is the wrong instrument for "is this in the four
states" and there is now a right one, so the crude pre-clip is not needed here.

The extent of what was written is printed, so a change against a previous cache is visible
rather than assumed.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse, importlib.util, json, os, sys


def _unhyphen(argv, flags):
    """`--region -81.5,33.5,...` looks like a flag to argparse, because it starts with a minus.

    argparse only forgives a leading minus when the value parses as a plain negative number, and
    `-81.5,33.5,-80.5,34.5` does not -- so every western-hemisphere invocation fails with
    "expected one argument", pointing nowhere near the cause. lookup_3dhp.py documented this for
    `--near` and it came straight back here. The equals form is applied for the caller.
    """
    out, i = [], 0
    while i < len(argv):
        if argv[i] in flags and i + 1 < len(argv) and argv[i + 1].startswith('-'):
            out.append('%s=%s' % (argv[i], argv[i + 1]))
            i += 2
            continue
        out.append(argv[i])
        i += 1
    return out


def _sibling(name):
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), name + '.py')
    spec = importlib.util.spec_from_file_location(name, p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def main() -> int:
    sys.argv[1:] = _unhyphen(sys.argv[1:], ('--region',))
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--extract', default='extract')
    ap.add_argument('--out', default=os.path.join('extract', '_garmin_coverage.json'))
    ap.add_argument('--region', default='-180,-90,180,90',
                    help='W,S,E,N clip box. Default is the whole world: let sweep_unclaimed.py '
                         'do the geography against real polygons.')
    ap.add_argument('--force', action='store_true',
                    help='rebuild even when the existing cache is already valid')
    a = ap.parse_args()

    MRB = _sibling('make_river_boundaries')
    region = tuple(float(v) for v in a.region.split(','))
    if len(region) != 4:
        sys.exit('--region wants W,S,E,N')

    before = None
    if os.path.exists(a.out):
        try:
            b = json.load(open(a.out, encoding='utf-8'))
            before = (len(b.get('cells') or []), len(b.get('da_cells') or []), b.get('sig'))
            print('existing cache: %s cell(s), %s da_cell(s), sig %s'
                  % (format(before[0], ','), format(before[1], ','), before[2]))
        except Exception as exc:
            print('existing cache unreadable (%s)' % exc)
    if a.force and os.path.exists(a.out):
        os.remove(a.out)
        print('--force: removed the old cache')

    cells = MRB.garmin_coverage(a.extract, region, a.out)
    if not cells:
        sys.exit('no coverage found under %s -- contours and depth_areas are C tiles, not B'
                 % a.extract)

    blob = json.load(open(a.out, encoding='utf-8'))
    da = blob.get('da_cells')
    if da is None:
        sys.exit('the cache came back with no da_cells, which is the thing this was run to fix')
    C = blob['cell']
    xs = [c[0] * C for c in blob['cells']]
    ys = [c[1] * C for c in blob['cells']]
    print()
    print('cells     %s' % format(len(blob['cells']), ','))
    print('da_cells  %s  (%.1f%% of cells are backed by a depth area)'
          % (format(len(da), ','), 100.0 * len(da) / max(1, len(blob['cells']))))
    print('extent    lon %.3f .. %.3f    lat %.3f .. %.3f' % (min(xs), max(xs), min(ys), max(ys)))
    if before:
        d = len(blob['cells']) - before[0]
        print('change    %+d cell(s) against the previous cache%s'
              % (d, '' if before[1] else ', which carried NO da_cells'))
    print()
    print('-> %s' % a.out)
    print('   next:  py .\\scripts\\sweep_unclaimed.py')
    return 0


if __name__ == '__main__':
    sys.exit(main())
