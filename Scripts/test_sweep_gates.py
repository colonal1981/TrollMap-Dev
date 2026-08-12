#!/usr/bin/env python3
"""Synthetic end-to-end test for the two gates added to sweep_unclaimed.py:
the orphan-boundary gate on the claim pass, and the four-state gate on the report pass."""
import importlib.util, json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
TM = __import__('test_region_mask')          # reuse its shapefile/dbf writers

FAIL = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        FAIL.append(msg)


CELL = 0.002


def cells(lon0, lat0, w, h):
    """A solid block of Garmin cells with its SW corner at lon0/lat0."""
    x0, y0 = int(lon0 / CELL), int(lat0 / CELL)
    return [[x0 + i, y0 + j] for i in range(w) for j in range(h)]


def ring(lon0, lat0, w, h, pad=1.0):
    """A boundary that covers exactly the block above."""
    x0, y0 = int(lon0 / CELL), int(lat0 / CELL)
    a, b = (x0 - pad) * CELL, (y0 - pad) * CELL
    c, d = (x0 + w - 1 + pad) * CELL, (y0 + h - 1 + pad) * CELL
    return [[a, b], [c, b], [c, d], [a, d], [a, b]]


def main():
    tmp = tempfile.mkdtemp()
    os.makedirs(os.path.join(tmp, 'boundaries'), exist_ok=True)

    # region: AA = lon -81..-80, lat 34..35.  CC = lon -85..-84 (NOT served).
    shp = os.path.join(tmp, 'states.shp')
    TM.write_shp(shp, [[TM.box(-81.0, 34.0, -80.0, 35.0)], [TM.box(-85.0, 34.0, -84.0, 35.0)]])
    TM.write_dbf(os.path.join(tmp, 'states.dbf'), ['AA', 'CC'])
    mask = os.path.join(tmp, 'region_mask.json')
    r = subprocess.run([sys.executable, os.path.join(HERE, 'make_region_mask.py'),
                        '--shp', shp, '--out', mask, '--states', 'AA'],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr

    # Four blocks of Garmin coverage, 12x12 cells each = ~1,469 acres:
    #   KEPT_UNCLAIMED  in AA, no boundary at all           -> must survive
    #   IN_INDEX        in AA, boundary IS in the index     -> claimed, so absent
    #   ORPHAN          in AA, boundary NOT in the index    -> must survive (ghost claim ignored)
    #   OUT_OF_REGION   in CC, no boundary                  -> must be dropped by the state gate
    blocks = {'KEPT_UNCLAIMED': (-80.90, 34.10), 'IN_INDEX': (-80.70, 34.10),
              'ORPHAN': (-80.50, 34.10), 'OUT_OF_REGION': (-84.50, 34.10)}
    cov = []
    for lon, lat in blocks.values():
        cov += cells(lon, lat, 12, 12)
    json.dump({'cells': cov, 'da_cells': cov, 'sig': 'test', 'cell': CELL},
              open(os.path.join(tmp, 'coverage.json'), 'w'))

    for name, slug in (('IN_INDEX', 'in_index_lake'), ('ORPHAN', 'orphan_lake')):
        lon, lat = blocks[name]
        json.dump({'type': 'Feature', 'geometry': {'type': 'Polygon',
                   'coordinates': [ring(lon, lat, 12, 12)]}},
                  open(os.path.join(tmp, 'boundaries', slug + '.geojson'), 'w'))

    # The index carries ONE of the two boundaries. The other is a shrink orphan.
    json.dump({'in_index_lake': {'slug': 'in_index_lake', 'centroid': [-80.69, 34.11],
                                 'area_acres': 1469}},
              open(os.path.join(tmp, 'lake_index.json'), 'w'))

    def sweep(extra=()):
        return subprocess.run(
            [sys.executable, os.path.join(HERE, 'sweep_unclaimed.py'),
             '--coverage', os.path.join(tmp, 'coverage.json'),
             '--boundaries', os.path.join(tmp, 'boundaries'),
             '--claimed', os.path.join(tmp, 'claimed.json'),
             '--index', os.path.join(tmp, 'lake_index.json'),
             '--region-mask', mask, '--out', os.path.join(tmp, 'unclaimed.json'),
             '--near-km', '0', '--min-acres', '100'] + list(extra),
            capture_output=True, text=True)

    print('\n--- claim pass ---')
    r1 = sweep()
    print(r1.stdout or '', r1.stderr or '')
    check(r1.returncode == 0, 'claim pass exit 0')
    check('1 orphan(s) IGNORED' in r1.stdout, 'named the orphan it ignored')
    claimed = json.load(open(os.path.join(tmp, 'claimed.json')))
    owners = {c[2] for c in claimed}
    check(owners == {'in_index_lake'}, 'only the indexed boundary claimed cells (%s)' % owners)
    check(len(claimed) == 144, 'it claimed its own 144 cells (%d)' % len(claimed))

    print('\n--- report pass ---')
    r2 = sweep(['--report'])
    print(r2.stdout or '', r2.stderr or '')
    check(r2.returncode == 0, 'report pass exit 0')
    rows = json.load(open(os.path.join(tmp, 'unclaimed.json')))
    at = {}
    for row in rows:
        for name, (lon, lat) in blocks.items():
            if abs(row['lon'] - lon) < 0.03 and abs(row['lat'] - lat) < 0.03:
                at[name] = row
    check('KEPT_UNCLAIMED' in at, 'unclaimed water in the region survives')
    check('ORPHAN' in at,
          'water claimed only by an ORPHAN boundary now surfaces -- it was hidden before')
    check('IN_INDEX' not in at, 'water inside a boundary the app actually carries stays claimed')
    check('OUT_OF_REGION' not in at, 'water outside AA is dropped by the state gate')
    check('outside AA' in r2.stdout and '1,469 ac' in r2.stdout,
          'reported what the state gate ate, in acres')
    check(len(rows) == 2, 'exactly 2 clusters reported (%d)' % len(rows))
    check(all(r.get('pts') for r in rows), 'every row carries pts for id_unclaimed_water')

    print('\n--- the gates can be turned off, loudly ---')
    r3 = sweep(['--report', '--no-region'])
    rows3 = json.load(open(os.path.join(tmp, 'unclaimed.json')))
    check(r3.returncode == 0 and len(rows3) == 3,
          '--no-region lets the out-of-region block back in (%d)' % len(rows3))
    r4 = sweep(['--report', '--region-mask', os.path.join(tmp, 'nope.json')])
    check('NO region mask' in r4.stdout, 'a missing mask warns instead of silently passing all')
    rows4 = json.load(open(os.path.join(tmp, 'unclaimed.json')))
    check(len(rows4) == 3, 'and it does pass all, which is why it has to say so (%d)' % len(rows4))

    print('\n--- a coverage cache with no da_cells is a BLOCKER ---')
    json.dump({'cells': cov, 'sig': 'test', 'cell': CELL},
              open(os.path.join(tmp, 'no_da.json'), 'w'))

    def sweep_noda(extra=()):
        return subprocess.run(
            [sys.executable, os.path.join(HERE, 'sweep_unclaimed.py'),
             '--coverage', os.path.join(tmp, 'no_da.json'),
             '--boundaries', os.path.join(tmp, 'boundaries'),
             '--claimed', os.path.join(tmp, 'c3.json'),
             '--index', os.path.join(tmp, 'lake_index.json'),
             '--region-mask', mask, '--out', os.path.join(tmp, 'u3.json'),
             '--near-km', '0', '--min-acres', '100'] + list(extra),
            capture_output=True, text=True)
    rn = sweep_noda()
    check(rn.returncode == 2 and 'STOP:' in rn.stdout, 'stops rather than running the depth test off')
    check('build_coverage_cache' in rn.stdout,
          'names the script that rebuilds it -- this one only READS the cache')
    rn2 = sweep_noda(['--allow-no-da'])
    check(rn2.returncode == 0, '--allow-no-da runs anyway (rc=%d)' % rn2.returncode)

    print('\n--- no index: the old, contaminating behaviour, announced ---')
    r5 = subprocess.run(
        [sys.executable, os.path.join(HERE, 'sweep_unclaimed.py'),
         '--coverage', os.path.join(tmp, 'coverage.json'),
         '--boundaries', os.path.join(tmp, 'boundaries'),
         '--claimed', os.path.join(tmp, 'claimed2.json'),
         '--index', os.path.join(tmp, 'gone.json'),
         '--region-mask', mask, '--out', os.path.join(tmp, 'u2.json'),
         '--near-km', '0', '--min-acres', '100'], capture_output=True, text=True)
    owners5 = {c[2] for c in json.load(open(os.path.join(tmp, 'claimed2.json')))}
    check('NO index' in r5.stdout and owners5 == {'in_index_lake', 'orphan_lake'},
          'without an index it claims from every file and says so (%s)' % owners5)

    shutil.rmtree(tmp, ignore_errors=True)
    print('\n%s  %d failure(s)' % ('FAILED' if FAIL else 'ALL PASS', len(FAIL)))
    for f in FAIL:
        print('   - ' + f)
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
