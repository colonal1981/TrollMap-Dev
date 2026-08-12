#!/usr/bin/env python3
"""Synthetic end-to-end test for build_coverage_cache.py. Known answers, asserted."""
import json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FAIL = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        FAIL.append(msg)


def poly(lon0, lat0, d=0.01):
    return [[[lon0 - d, lat0 - d], [lon0 + d, lat0 - d], [lon0 + d, lat0 + d],
             [lon0 - d, lat0 + d], [lon0 - d, lat0 - d]]]


def line(lon0, lat0, d=0.01):
    return [[lon0 - d, lat0], [lon0 + d, lat0]]


def main():
    tmp = tempfile.mkdtemp()
    ex = os.path.join(tmp, 'extract')
    for lay in ('contours', 'depth_areas', 'pois', 'docks'):
        os.makedirs(os.path.join(ex, lay), exist_ok=True)

    # DEEP: a depth area below the shoal band -> counts, and lands in da_cells.
    # SHOAL: depth_min 0 / depth_max 3 -> Garmin's outline around ALL water, must NOT count.
    # CONTOUR: a contour line -> counts as coverage but NOT as a depth area.
    json.dump({'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'properties': {'depth_min_dm': 30, 'depth_max_dm': 70},
         'geometry': {'type': 'Polygon', 'coordinates': poly(-81.00, 34.00)}},
        {'type': 'Feature', 'properties': {'depth_min_dm': 0, 'depth_max_dm': 3},
         'geometry': {'type': 'Polygon', 'coordinates': poly(-82.00, 34.00)}},
    ]}, open(os.path.join(ex, 'depth_areas', 'C4E0F1.geojson'), 'w'))
    json.dump({'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'properties': {'depth_dm': 50},
         'geometry': {'type': 'LineString', 'coordinates': line(-83.00, 34.00)}},
    ]}, open(os.path.join(ex, 'contours', 'C4E0F2.geojson'), 'w'))
    # B tiles in the same folders must be ignored -- contours/depth_areas are C tiles. Globbing
    # for the wrong letter has cost this project two debugging sessions.
    json.dump({'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'properties': {'depth_min_dm': 30, 'depth_max_dm': 90},
         'geometry': {'type': 'Polygon', 'coordinates': poly(-84.00, 34.00)}},
    ]}, open(os.path.join(ex, 'depth_areas', 'B4E0F9.geojson'), 'w'))
    # pois and docks are not evidence of a survey and must never be scanned
    json.dump({'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'properties': {},
         'geometry': {'type': 'Point', 'coordinates': [-85.00, 34.00]}},
    ]}, open(os.path.join(ex, 'pois', 'B4E0FA.geojson'), 'w'))

    out = os.path.join(tmp, 'cov.json')

    def run(extra=()):
        return subprocess.run([sys.executable, os.path.join(HERE, 'build_coverage_cache.py'),
                               '--extract', ex, '--out', out] + list(extra),
                              capture_output=True, text=True)

    print('\n--- build ---')
    r = run()
    print(r.stdout or '', r.stderr or '')
    check(r.returncode == 0, 'exit 0')
    b = json.load(open(out, encoding='utf-8'))
    C = b['cell']
    cells = {tuple(c) for c in b['cells']}
    da = {tuple(c) for c in b['da_cells']}

    def at(lon, lat):
        return (int(lon / C), int(lat / C))

    # garmin_coverage() claims the cell of every VERTEX it walks -- it does not fill polygons.
    # So the test points are corners and endpoints, not centres. Both `cells` and `da_cells` are
    # outline-derived, which is what makes their ratio meaningful.
    check('da_cells' in b, 'the cache carries da_cells, which is the whole point')
    check(at(-81.01, 33.99) in cells and at(-81.01, 33.99) in da,
          'a 30-70 dm depth area is coverage AND a depth area')
    check(at(-80.99, 34.01) in cells and at(-80.99, 34.01) in da, '...on every corner')
    check(at(-82.01, 33.99) not in cells and at(-82.01, 34.01) not in cells,
          'a 0-3 dm shoal band is NOT coverage -- it is the outline Garmin draws around all water')
    check(at(-83.01, 34.00) in cells and at(-83.01, 34.00) not in da,
          'a contour is coverage but not a depth area')
    check(at(-84.01, 33.99) not in cells, 'a B tile in depth_areas is ignored (C tiles only)')
    check(at(-85.00, 34.00) not in cells, 'pois are never scanned')
    check(len(cells) == 6 and len(da) == 4,
          '6 cells: 4 depth-area corners + 2 contour ends; 4 of them depth-backed (%d/%d)'
          % (len(cells), len(da)))
    check(da < cells and len(da) < len(cells), 'da_cells is a strict subset of cells')
    check('extent' in r.stdout and 'da_cells' in r.stdout, 'printed the counts and the extent')

    print('\n--- second run reads the cache instead of rescanning ---')
    r2 = run()
    check(r2.returncode == 0 and 'read from cache' in r2.stdout,
          'valid cache is reused')
    check('existing cache:' in r2.stdout and 'sig' in r2.stdout, 'reported what was already there')

    print('\n--- a cache with no da_cells is refused, which is the bug this was built for ---')
    stale = json.load(open(out, encoding='utf-8'))
    stale.pop('da_cells')
    json.dump(stale, open(out, 'w'))
    r3 = run()
    check(r3.returncode == 0 and 'rescanning' in r3.stdout,
          'the old format is rescanned, not accepted')
    check('da_cells' in json.load(open(out, encoding='utf-8')), 'and the rebuild restores it')
    check('carried NO da_cells' in r3.stdout, 'and says the previous one lacked it')

    print('\n--- --force and --region ---')
    r4 = run(['--force'])
    check(r4.returncode == 0 and 'removed the old cache' in r4.stdout, '--force rescans')
    r5 = run(['--force', '--region', '-81.5,33.5,-80.5,34.5'])
    b5 = json.load(open(out, encoding='utf-8'))
    c5 = {tuple(c) for c in b5['cells']}
    check(r5.returncode == 0 and at(-81.01, 33.99) in c5 and at(-83.01, 34.00) not in c5
          and len(c5) < len(cells),
          '--region clips the contour out and keeps the depth area (%d cells vs %d unclipped)'
          % (len(c5), len(cells)))

    print('\n--- an empty extract is a hard error, not an empty cache ---')
    empty = os.path.join(tmp, 'nothing')
    os.makedirs(os.path.join(empty, 'contours'), exist_ok=True)
    r6 = subprocess.run([sys.executable, os.path.join(HERE, 'build_coverage_cache.py'),
                         '--extract', empty, '--out', os.path.join(tmp, 'e.json')],
                        capture_output=True, text=True)
    check(r6.returncode != 0 and 'C tiles' in (r6.stdout + r6.stderr),
          'refuses to write an empty cache and says why (rc=%d)' % r6.returncode)

    shutil.rmtree(tmp, ignore_errors=True)
    print('\n%s  %d failure(s)' % ('FAILED' if FAIL else 'ALL PASS', len(FAIL)))
    for f in FAIL:
        print('   - ' + f)
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
