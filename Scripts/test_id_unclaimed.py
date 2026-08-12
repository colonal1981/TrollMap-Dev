#!/usr/bin/env python3
"""Synthetic end-to-end test for id_unclaimed_water.py. Known answers, asserted."""
import importlib.util, json, os, shutil, sqlite3, struct, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('l3', os.path.join(HERE, 'lookup_3dhp.py'))
L3 = importlib.util.module_from_spec(spec); spec.loader.exec_module(L3)
_s2 = importlib.util.spec_from_file_location('idu', os.path.join(HERE, 'id_unclaimed_water.py'))
IRX = importlib.util.module_from_spec(_s2); _s2.loader.exec_module(IRX)

WB, FL = 'hydro_3dhp_all_waterbody', 'hydro_3dhp_all_flowline'


def gpkg_poly(rings_ll, dims=2):
    """rings_ll = [[(lon,lat),...], ...] -> GPKG blob with an XY envelope, EPSG:6350 metres."""
    body = struct.pack('<BII', 1, 3 + (1000 if dims == 3 else 0), len(rings_ll))
    xs, ys = [], []
    for ring in rings_ll:
        body += struct.pack('<I', len(ring))
        for lon, lat in ring:
            x, y = L3.albers(lon, lat)
            xs.append(x); ys.append(y)
            body += struct.pack('<dd', x, y) + (struct.pack('<d', 0.0) if dims == 3 else b'')
    hdr = b'GP' + bytes([0, 0x03]) + struct.pack('<i', 6350) \
        + struct.pack('<dddd', min(xs), max(xs), min(ys), max(ys))
    return hdr, body, (min(xs), max(xs), min(ys), max(ys))


def gpkg_line(pts_ll):
    body = struct.pack('<BII', 1, 2, len(pts_ll))
    xs, ys = [], []
    for lon, lat in pts_ll:
        x, y = L3.albers(lon, lat)
        xs.append(x); ys.append(y)
        body += struct.pack('<dd', x, y)
    hdr = b'GP' + bytes([0, 0x03]) + struct.pack('<i', 6350) \
        + struct.pack('<dddd', min(xs), max(xs), min(ys), max(ys))
    return hdr, body, (min(xs), max(xs), min(ys), max(ys))


def box(lon, lat, dlon, dlat):
    return [(lon - dlon, lat - dlat), (lon + dlon, lat - dlat),
            (lon + dlon, lat + dlat), (lon - dlon, lat + dlat), (lon - dlon, lat - dlat)]


def build(path):
    con = sqlite3.connect(path)
    c = con.cursor()
    c.execute('CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT)')
    for t in (WB, FL):
        c.execute('INSERT INTO gpkg_geometry_columns VALUES (?,?)', (t, 'shape'))
        c.execute('CREATE VIRTUAL TABLE rtree_%s_shape USING rtree(id,minx,maxx,miny,maxy)' % t)
    c.execute('CREATE TABLE %s (fid INTEGER PRIMARY KEY, shape BLOB, id3dhp TEXT, gnisid INTEGER,'
              ' gnisidlabel TEXT, featuretype INTEGER, areasqkm REAL, waterbodyid3dhp TEXT)' % WB)
    c.execute('CREATE TABLE %s (fid INTEGER PRIMARY KEY, shape BLOB, id3dhp TEXT, gnisid INTEGER,'
              ' gnisidlabel TEXT, featuretype INTEGER, lengthkm REAL, waterbodyid3dhp TEXT)' % FL)

    def addwb(fid, rings, i3, gid, label, ft, km, dims=2):
        h, b, bb = gpkg_poly(rings, dims)
        c.execute('INSERT INTO %s VALUES (?,?,?,?,?,?,?,?)' % WB,
                  (fid, h + b, i3, gid, label, ft, km, None))
        c.execute('INSERT INTO rtree_%s_shape VALUES (?,?,?,?,?)' % WB, (fid,) + bb)

    def addfl(fid, pts, i3, gid, label, ft, km, wbid=None):
        h, b, bb = gpkg_line(pts)
        c.execute('INSERT INTO %s VALUES (?,?,?,?,?,?,?,?)' % FL,
                  (fid, h + b, i3, gid, label, ft, km, wbid))
        c.execute('INSERT INTO rtree_%s_shape VALUES (?,?,?,?,?)' % FL, (fid,) + bb)

    # A: cluster sits INSIDE a big named lake.  -> waterbody-named, inside, reg_slug blank
    addwb(1, [box(-81.00, 34.00, 0.05, 0.05)], 'AAA111', 5551, 'Test Named Lake', 390, 60.0)
    # B: cluster INSIDE a big UNNAMED polygon, with a tiny named pond 400 m away whose bbox
    #    overlaps the search box. Biggest-wins-by-bbox would have named it after the pond.
    addwb(2, [box(-82.00, 34.00, 0.05, 0.05)], 'BBB222', None, None, 390, 55.0)
    addwb(3, [box(-82.0045, 34.0045, 0.0008, 0.0008)], 'BBB333', 7777, 'Tiny Pond', 390, 0.02)
    # C: flowlines only, no polygon at all. This is the Bates shape.
    addfl(10, [(-83.02, 34.00), (-83.00, 34.00), (-82.98, 34.00)], 'CCC111', 8881,
          'Test River', 460, 3.7, 'ZZZ999')
    addfl(11, [(-83.00, 34.00), (-83.00, 34.02)], 'CCC222', 8881, 'Test River', 558, 2.2, None)
    # D: nothing anywhere near -84.0.
    # E: a NESTED pair -- a small river-area polygon inside a big reservoir. Smallest wins.
    addwb(4, [box(-85.00, 34.00, 0.20, 0.20)], 'EEE111', 6001, 'Big Reservoir', 390, 900.0)
    addwb(5, [box(-85.00, 34.00, 0.01, 0.01)], 'EEE222', 6002, 'Narrow River Area', 460, 2.0)
    # F: registry cross-check -- named, and its gnis id IS carried by the fixture registry.
    addwb(6, [box(-86.00, 34.00, 0.05, 0.05)], 'FFF111', 1220360, 'Already Carried', 390, 40.0)
    # G: bbox-overlap only. A giant L-shaped polygon whose BBOX covers the cluster while its
    #    rings are 8 km away. hit must be 'near', not 'inside'.
    addwb(7, [[(-87.20, 34.00), (-87.00, 34.00), (-87.00, 34.02), (-87.18, 34.02),
               (-87.18, 34.20), (-87.20, 34.20), (-87.20, 34.00)]],
          'GGG111', 6100, 'L Shaped Lake', 390, 300.0)
    # H: a 3D (Z) polygon -- dims must be read from the WKB type, not assumed 2.
    addwb(8, [box(-88.00, 34.00, 0.05, 0.05)], 'HHH111', 6200, 'Three D Lake', 390, 50.0, dims=3)
    # I: THE REAL-DATA FAILURE. The cluster centroid sits on land just outside a big lake, with a
    #    tiny named pond 150 m from that centroid. Probing with the centroid picks the pond --
    #    that is exactly what the 60 GB file did to the first cut of this script. The footprint
    #    straddles the shoreline, so cover must hand it to the big lake.
    addwb(9, [box(-89.00, 34.05, 0.05, 0.05)], 'III111', 6300, 'Big Real Lake', 390, 80.0)
    addwb(10, [box(-89.0015, 33.9985, 0.0006, 0.0006)], 'III222', 6301, 'Decoy Pond', 390, 0.015)
    con.commit(); con.close()


CLUSTERS = [
    # inside the named lake
    {'tag': 'A', 'acres': 400, 'lon': -81.00, 'lat': 34.00, 'fill': .9, 'narrow': False,
     'touches_known': False, 'near_slug': None, 'near_km': None},
    # inside the unnamed polygon, tiny named pond nearby
    {'tag': 'B', 'acres': 300, 'lon': -82.00, 'lat': 34.00, 'fill': .8, 'narrow': False,
     'touches_known': False, 'near_slug': None, 'near_km': None},
    # flowlines only
    {'tag': 'C', 'acres': 250, 'lon': -83.00, 'lat': 34.00, 'fill': .7, 'narrow': False,
     'touches_known': False, 'near_slug': None, 'near_km': None},
    # empty ocean of nothing
    {'tag': 'D', 'acres': 200, 'lon': -84.00, 'lat': 34.00, 'fill': .7, 'narrow': False,
     'touches_known': False, 'near_slug': None, 'near_km': None},
    # nested: smallest containing polygon must win
    {'tag': 'E', 'acres': 700, 'lon': -85.00, 'lat': 34.00, 'fill': .9, 'narrow': False,
     'touches_known': False, 'near_slug': None, 'near_km': None},
    # already in the registry
    {'tag': 'F', 'acres': 600, 'lon': -86.00, 'lat': 34.00, 'fill': .9, 'narrow': False,
     'touches_known': False, 'near_slug': None, 'near_km': None},
    # bbox overlap only -> near
    {'tag': 'G', 'acres': 550, 'lon': -87.05, 'lat': 34.15, 'fill': .9, 'narrow': False,
     'touches_known': False, 'near_slug': None, 'near_km': None},
    # 3D geometry
    {'tag': 'H', 'acres': 500, 'lon': -88.00, 'lat': 34.00, 'fill': .9, 'narrow': False,
     'touches_known': False, 'near_slug': None, 'near_km': None},
    # centroid on land beside a decoy pond; footprint straddles the real lake's shoreline
    {'tag': 'I', 'acres': 450, 'lon': -89.0015, 'lat': 33.9985, 'fill': .9, 'narrow': False,
     'touches_known': False, 'near_slug': None, 'near_km': None,
     'bbox': [-89.006, 33.990, -88.994, 34.004]},
    # --- must all be filtered out ---
    {'tag': 'X_small', 'acres': 50, 'lon': -81.00, 'lat': 34.00, 'fill': .9, 'narrow': False,
     'touches_known': False, 'near_slug': None, 'near_km': None},
    {'tag': 'X_narrow', 'acres': 900, 'lon': -81.00, 'lat': 34.00, 'fill': 1.0, 'narrow': True,
     'touches_known': False, 'near_slug': None, 'near_km': None},
    {'tag': 'X_attached', 'acres': 950, 'lon': -81.00, 'lat': 34.00, 'fill': .9, 'narrow': False,
     'touches_known': True, 'near_slug': 'some_lake', 'near_km': 0.4},
]

for _c in CLUSTERS:
    _c.setdefault('bbox', [_c['lon'] - 0.004, _c['lat'] - 0.004,
                           _c['lon'] + 0.004, _c['lat'] + 0.004])

FAIL = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        FAIL.append(msg)


def read_tsv(p):
    lines = open(p, encoding='utf-8').read().strip().split('\n')
    head = lines[0].split('\t')
    return [dict(zip(head, l.split('\t'))) for l in lines[1:]]


def run(tmp, extra=(), inp='garmin_unclaimed.json'):
    cmd = [sys.executable, os.path.join(HERE, 'id_unclaimed_water.py'),
           '--in', os.path.join(tmp, inp), '--out', os.path.join(tmp, 'out.tsv'),
           '--gpkg', os.path.join(tmp, 'fix.gpkg'),
           '--index', os.path.join(tmp, 'lake_index.json')]
    extra = list(extra)
    if '--no-allow-da' in extra:
        extra.remove('--no-allow-da')
    else:
        cmd.append('--allow-no-da')
    cmd += extra
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r


def main():
    tmp = tempfile.mkdtemp()
    build(os.path.join(tmp, 'fix.gpkg'))
    json.dump(CLUSTERS, open(os.path.join(tmp, 'garmin_unclaimed.json'), 'w'))
    json.dump({'already_carried_lake': {'gnis': 'gnis:1220360'},
               'coast_thing': {'gnis': 'slug:coast_thing'}},
              open(os.path.join(tmp, 'lake_index.json'), 'w'))

    print('\n--- run 1: defaults ---')
    r = run(tmp)
    print(r.stdout or '', r.stderr or '')
    check(r.returncode == 0, 'exit 0')
    rows = read_tsv(os.path.join(tmp, 'out.tsv'))
    by = {}
    for c in CLUSTERS:
        for row in rows:
            if abs(float(row['lon']) - c['lon']) < 1e-9 and abs(float(row['lat']) - c['lat']) < 1e-9 \
                    and int(row['acres']) == c['acres']:
                by[c['tag']] = row

    check(len(rows) == 9, 'kept 9 of 12 clusters (got %d)' % len(rows))
    check('X_small' not in by, 'min-acres dropped the 50-acre cluster')
    check('X_narrow' not in by, 'narrow dropped the river channel')
    check('X_attached' not in by, 'touches_known dropped the rim')
    check('depth test is OFF' in r.stdout, 'warned loudly that --min-da is off')

    print('\n--- no depth-area share is a BLOCKER without --allow-no-da ---')
    rb = run(tmp, ['--no-allow-da'])
    check(rb.returncode != 0 and 'STOP:' in (rb.stdout + rb.stderr)
          and 'make_river_boundaries' in (rb.stdout + rb.stderr),
          'stops and names the command that rebuilds the cache (rc=%d)' % rb.returncode)

    check(by['A']['kind'] == 'waterbody-named' and by['A']['name'] == 'Test Named Lake'
          and by['A']['hit'] == 'inside' and by['A']['id3dhp'] == 'AAA111'
          and float(by['A']['cover']) == 1.0,
          'A named lake, inside, right id (%s / %s / %s)' % (by['A']['kind'], by['A']['name'], by['A']['hit']))
    check(by['A']['reg_slug'] == '', 'A not in registry')

    check(by['B']['kind'] == 'waterbody-unnamed' and by['B']['id3dhp'] == 'BBB222'
          and by['B']['name'] == '',
          'B unnamed polygon wins over the tiny named pond (%s / %s)' % (by['B']['kind'], by['B']['id3dhp']))
    check('Tiny Pond' in by['B']['alt'], 'B reports the pond in alt, not as the answer (%s)' % by['B']['alt'])

    check(by['C']['kind'] == 'flowline-only' and by['C']['fl_hits'] != '0'
          and by['C']['wb_hits'] == '0',
          'C flowline-only (%s, wb=%s fl=%s)' % (by['C']['kind'], by['C']['wb_hits'], by['C']['fl_hits']))
    check(by['C']['id3dhp'] in ('CCC111', 'CCC222'), 'C carries a flowline id (%s)' % by['C']['id3dhp'])

    check(by['D']['kind'] == 'nothing-in-3dhp' and by['D']['wb_hits'] == '0',
          'D nothing in 3DHP (%s)' % by['D']['kind'])

    check(by['E']['id3dhp'] == 'EEE222' and by['E']['name'] == 'Narrow River Area',
          'E smallest CONTAINING polygon wins over the reservoir (%s)' % by['E']['id3dhp'])

    check(by['F']['reg_slug'] == 'already_carried_lake',
          'F matched the registry by gnis id (%s)' % by['F']['reg_slug'])

    check(by['G']['hit'] == 'near' and float(by['G']['cover']) == 0.0
          and float(by['G']['dist_m']) > 5000,
          'G bbox-overlap only -> near, cover 0, %s m to the EDGE' % by['G']['dist_m'])

    check(by['H']['hit'] == 'inside' and by['H']['name'] == 'Three D Lake',
          'H 3D geometry parsed (%s / %s)' % (by['H']['hit'], by['H']['name']))

    check(by['I']['id3dhp'] == 'III111' and by['I']['name'] == 'Big Real Lake'
          and by['I']['hit'] == 'partial' and 0 < float(by['I']['cover']) < 0.5,
          'I footprint beats the decoy pond the centroid would have picked (%s / %s / cover %s)'
          % (by['I']['id3dhp'], by['I']['name'], by['I']['cover']))

    check(by['I']['probe'] == 'bbox', 'I used the bbox probe (%s)' % by['I']['probe'])

    print('\n--- coordinates for apps.nationalmap.gov ---')
    import math as _m
    a_ = by['A']
    check(a_['xy'] == '%.6f, %.6f' % (float(a_['lon']), float(a_['lat'])), 'xy is lon,lat (%s)' % a_['xy'])
    check(a_['dd'] == '%.6f, %.6f' % (float(a_['lat']), float(a_['lon'])), 'dd is lat,lon (%s)' % a_['dd'])
    check(a_['xy'] != a_['dd'], 'and they are not the same string')
    bx, byy = [float(v) for v in a_['basemap'].split(',')]
    R = 6378137.0
    lon_back = _m.degrees(bx / R)
    lat_back = _m.degrees(2 * _m.atan(_m.exp(byy / R)) - _m.pi / 2)
    check(abs(lon_back - float(a_['lon'])) < 1e-6 and abs(lat_back - float(a_['lat'])) < 1e-6,
          'basemap EPSG:3857 inverts back to the same point (%s)' % a_['basemap'])
    for lon, lat, wx, wy in ((-180.0, 0.0, -20037508.34, 0.0),
                             (180.0, 85.05112878, 20037508.34, 20037508.34)):
        gx, gy = IRX.webmercator(lon, lat)
        check(abs(gx - wx) < 0.01 and abs(gy - wy) < 0.01,
              'EPSG:3857 corner %.0f,%.5f -> %.2f, %.2f' % (lon, lat, gx, gy))

    print('\n--- run 1c: `pts` from the sweep beats the bbox on the same cluster ---')
    # Same geometry as I, but with the cluster's real cells carried in. Every point is water and
    # they are all in the big lake, so cover must go to ~1.0 instead of the diluted 0.28.
    withpts = [dict(c) for c in CLUSTERS]
    for c in withpts:
        if c['tag'] == 'I':
            c['pts'] = [[-89.00 + dx * 0.002, 34.02 + dy * 0.002]
                        for dx in range(-3, 4) for dy in range(-2, 3)]
    json.dump(withpts, open(os.path.join(tmp, 'withpts.json'), 'w'))
    r1c = run(tmp, [], inp='withpts.json')
    rows1c = read_tsv(os.path.join(tmp, 'out.tsv'))
    i1c = [x for x in rows1c if abs(float(x['lon']) + 89.0015) < 1e-9][0]
    check(i1c['probe'] == 'cells' and i1c['id3dhp'] == 'III111'
          and float(i1c['cover']) == 1.0 and i1c['hit'] == 'inside',
          'pts probe: cover %s on %s via %s (bbox probe said 0.28)'
          % (i1c['cover'], i1c['id3dhp'], i1c['probe']))
    check('carry no `pts`' in r1c.stdout, 'still names the clusters that fell back to the bbox')
    check('carry no `pts`' in r.stdout, 'run 1 flagged the whole file as bbox-probed')

    print('\n--- run 1b: --grid 1 is centroid-only and MUST get I wrong ---')
    r1b = run(tmp, ['--grid', '1'])
    rows1b = read_tsv(os.path.join(tmp, 'out.tsv'))
    i1b = [x for x in rows1b if abs(float(x['lon']) + 89.0015) < 1e-9][0]
    check(i1b['id3dhp'] == 'III222',
          'the old centroid-only probe really does pick the decoy (%s) -- fixture proves the bug'
          % i1b['id3dhp'])

    check('named by 3DHP' in r.stdout and 'Already Carried' not in r.stdout.split('named by 3DHP')[-1],
          'summary excludes the registry-carried lake from the new list')

    print('\n--- run 2: --include-attached --include-narrow --min-acres 10 ---')
    r2 = run(tmp, ['--include-attached', '--include-narrow', '--min-acres', '10'])
    rows2 = read_tsv(os.path.join(tmp, 'out.tsv'))
    check(r2.returncode == 0 and len(rows2) == 12, 'all 12 kept (got %d)' % len(rows2))

    print('\n--- run 3: da_share present, filter must bite and say so ---')
    da = [dict(c) for c in CLUSTERS]
    for c in da:
        c['da_share'] = 0.9 if c['tag'] in ('A', 'B') else 0.05
    json.dump(da, open(os.path.join(tmp, 'with_da.json'), 'w'))
    r3 = run(tmp, [], inp='with_da.json')
    print(r3.stdout or '', r3.stderr or '')
    rows3 = read_tsv(os.path.join(tmp, 'out.tsv'))
    check(r3.returncode == 0 and len(rows3) == 2, 'min-da kept only A and B (got %d)' % len(rows3))
    check('depth-area share' in r3.stdout and 'min-da 0.25 is OFF' not in r3.stdout,
          'min-da reported as active, not as off')

    print('\n--- run 4: da_share present but all zero -> filter OFF, loudly ---')
    dz = [dict(c, da_share=0.0) for c in CLUSTERS]
    json.dump(dz, open(os.path.join(tmp, 'zero_da.json'), 'w'))
    r4 = run(tmp, [], inp='zero_da.json')
    rows4 = read_tsv(os.path.join(tmp, 'out.tsv'))
    check(r4.returncode == 0 and len(rows4) == 9,
          'all-zero da_share does NOT nuke the run (got %d)' % len(rows4))
    check('depth test is OFF' in r4.stdout, 'said so')

    print('\n--- run 5: filters remove everything -> non-zero exit, not an empty file ---')
    r5 = run(tmp, ['--min-acres', '99999'])
    check(r5.returncode != 0 and 'nothing left' in (r5.stdout + r5.stderr),
          'exits loud when nothing survives (rc=%d)' % r5.returncode)

    print('\n--- run 6: --limit ---')
    r6 = run(tmp, ['--limit', '3'])
    rows6 = read_tsv(os.path.join(tmp, 'out.tsv'))
    check(r6.returncode == 0 and len(rows6) == 3, '--limit 3 (got %d)' % len(rows6))
    check(int(rows6[0]['acres']) >= int(rows6[-1]['acres']), 'sorted biggest first')

    print('\n--- run 7: missing registry warns and does not crash ---')
    os.remove(os.path.join(tmp, 'lake_index.json'))
    r7 = run(tmp)
    check(r7.returncode == 0 and 'NO registry at' in r7.stdout, 'warned about the missing registry')

    shutil.rmtree(tmp, ignore_errors=True)
    print('\n%s  %d failure(s)' % ('FAILED' if FAIL else 'ALL PASS', len(FAIL)))
    for f in FAIL:
        print('   - ' + f)
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
