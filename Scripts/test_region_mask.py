#!/usr/bin/env python3
"""Synthetic end-to-end test for make_region_mask.py + in_region.py. Known answers, asserted."""
import importlib.util, json, os, shutil, struct, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name):
    p = os.path.join(HERE, name + '.py')
    s = importlib.util.spec_from_file_location(name, p)
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


IR = load('in_region')

FAIL = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        FAIL.append(msg)


# ---------------------------------------------------------------- shapefile writer
def write_shp(path, shapes):
    """shapes = [[ring, ring, ...], ...] where ring = [(x, y), ...] -- Polygon (type 5)."""
    recs = []
    for shp in shapes:
        pts = [p for ring in shp for p in ring]
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        parts, n = [], 0
        for ring in shp:
            parts.append(n)
            n += len(ring)
        body = struct.pack('<i', 5)
        body += struct.pack('<4d', min(xs), min(ys), max(xs), max(ys))
        body += struct.pack('<ii', len(parts), len(pts))
        body += struct.pack('<%di' % len(parts), *parts)
        for x, y in pts:
            body += struct.pack('<dd', x, y)
        recs.append(body)
    out = bytearray(b'\x00' * 100)
    struct.pack_into('>i', out, 0, 9994)
    struct.pack_into('<ii', out, 28, 1000, 5)
    offs = []
    for i, b in enumerate(recs):
        offs.append(len(out) // 2)
        out += struct.pack('>ii', i + 1, len(b) // 2) + b
    struct.pack_into('>i', out, 24, len(out) // 2)
    open(path, 'wb').write(bytes(out))
    # .shx -- unread by this pipeline but written so the file set is not a lie
    shx = bytearray(out[:100])
    struct.pack_into('>i', shx, 24, (100 + 8 * len(recs)) // 2)
    for o, b in zip(offs, recs):
        shx += struct.pack('>ii', o, len(b) // 2)
    open(path[:-4] + '.shx', 'wb').write(bytes(shx))


def write_dbf(path, rows, field='STUSPS', size=2):
    n = len(rows)
    hlen = 32 + 32 + 1
    rlen = 1 + size
    h = bytearray(32)
    h[0] = 3
    h[1], h[2], h[3] = 26, 1, 1
    struct.pack_into('<iHH', h, 4, n, hlen, rlen)
    fd = bytearray(32)
    fd[0:len(field)] = field.encode()
    fd[11] = ord('C')
    fd[16] = size
    body = b''.join(b' ' + r.encode().ljust(size) for r in rows)
    open(path, 'wb').write(bytes(h) + bytes(fd) + b'\r' + body)


def box(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]


def main():
    tmp = tempfile.mkdtemp()
    shp = os.path.join(tmp, 'states.shp')
    # AA is a 1x1 deg square. BB shares its eastern edge, so AA+BB is a 2x1 rectangle and the
    # seam between them must fill solid -- a gap there would drop every border lake.
    # CC is the state we do NOT want, well clear to the west.
    # AA also carries a HOLE, to prove even-odd fill handles interior rings.
    write_shp(shp, [
        [box(-81.0, 34.0, -80.0, 35.0), box(-80.8, 34.8, -80.6, 34.9)[::-1]],
        [box(-80.0, 34.0, -79.0, 35.0)],
        [box(-85.0, 34.0, -84.0, 35.0)],
    ])
    write_dbf(os.path.join(tmp, 'states.dbf'), ['AA', 'BB', 'CC'])
    mask = os.path.join(tmp, 'region_mask.json')

    def build(extra=()):
        return subprocess.run([sys.executable, os.path.join(HERE, 'make_region_mask.py'),
                               '--shp', shp, '--out', mask, '--states', 'AA,BB'] + list(extra),
                              capture_output=True, text=True)

    print('\n--- build ---')
    r = build()
    print(r.stdout or '', r.stderr or '')
    check(r.returncode == 0, 'exit 0')
    reg = IR.Region.load(mask)

    check(reg.inside(-80.5, 34.5), 'deep inside AA is IN')
    check(reg.inside(-79.5, 34.5), 'deep inside BB is IN')
    check(not reg.inside(-84.5, 34.5), 'CC was not requested, so it is OUT')
    check(not reg.inside(-82.0, 34.5), 'west of AA is OUT')
    check(not reg.inside(-78.5, 34.5), 'east of BB is OUT')
    check(not reg.inside(-80.5, 33.5), 'south of both is OUT')
    check(not reg.inside(-80.5, 35.5), 'north of both is OUT')
    check(not reg.inside(-80.7, 34.85), 'the hole in AA is OUT')

    # THE SEAM. AA's east edge and BB's west edge are the same line; if the two fills do not meet,
    # every lake sitting on a shared state line falls through the crack.
    seam = [reg.inside(-80.0 + d, 34.5) for d in (-0.004, -0.002, 0.0, 0.002, 0.004)]
    check(all(seam), 'the AA/BB seam fills solid: %s' % seam)

    # Corners, one cell in from each side.
    for lon, lat, want, what in ((-80.999, 34.001, True, 'SW corner of AA'),
                                 (-79.001, 34.999, True, 'NE corner of BB'),
                                 (-81.003, 34.5, False, 'one cell west of AA'),
                                 (-78.997, 34.5, False, 'one cell east of BB')):
        check(reg.inside(lon, lat) is want, '%s is %s' % (what, 'IN' if want else 'OUT'))

    # Cell arithmetic must agree with int(lon / CELL) used everywhere else in the pipeline.
    check(reg.cell_inside(int(-80.5 // 0.002), int(34.5 // 0.002)), 'cell_inside agrees with //')

    # Area: AA + BB is 2 deg x 1 deg minus a 0.2 x 0.1 hole.
    cells = sum(e - s + 1 for st, en in reg.rows.values() for s, e in zip(st, en))
    want = (2.0 * 1.0 - 0.2 * 0.1) / (0.002 ** 2)
    check(abs(cells - want) / want < 0.01, 'filled area within 1%% of geometry (%d vs %d)'
          % (cells, want))

    print('\n--- ANY PART, not the centroid ---')
    # A border lake: centroid in CC (out), one arm reaching into AA. It must be kept.
    lake = [(-84.5, 34.5), (-83.0, 34.5), (-81.5, 34.5), (-80.9, 34.5)]
    check(reg.any_inside(lake), 'a lake with one arm in AA is kept')
    check(not reg.inside(-84.5, 34.5), '...even though its centroid is out')
    check(not reg.any_inside([(-84.5, 34.5), (-84.2, 34.6)]), 'a lake wholly in CC is dropped')

    print('\n--- pad ---')
    r2 = build(['--pad-km', '1'])
    reg2 = IR.Region.load(mask)
    check(r2.returncode == 0 and reg2.inside(-81.003, 34.5),
          'pad 1 km reaches a cell that was OUT unpadded')
    check(not reg2.inside(-81.05, 34.5), 'pad 1 km does not reach 5 km out')
    check(reg2.pad_km == 1.0 and 'padded' in r2.stdout, 'pad recorded and reported')

    print('\n--- failure modes ---')
    r3 = subprocess.run([sys.executable, os.path.join(HERE, 'make_region_mask.py'),
                         '--shp', shp, '--out', mask, '--states', 'AA,ZZ'],
                        capture_output=True, text=True)
    check(r3.returncode != 0 and 'ZZ' in (r3.stdout + r3.stderr),
          'an unknown state code is a hard error, not a silent skip')
    r4 = subprocess.run([sys.executable, os.path.join(HERE, 'make_region_mask.py'),
                         '--shp', os.path.join(tmp, 'nope.shp'), '--out', mask],
                        capture_output=True, text=True)
    check(r4.returncode != 0, 'a missing shapefile is a hard error')
    check(IR.Region.load(os.path.join(tmp, 'nope.json'), required=False) is None,
          'load(required=False) returns None instead of dying')

    print('\n--- registry audit ---')
    build()
    reg = IR.Region.load(mask)
    bdir = os.path.join(tmp, 'boundaries')
    os.makedirs(bdir, exist_ok=True)
    json.dump({'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates':
              [[[-84.5, 34.5], [-84.4, 34.5], [-80.9, 34.5], [-84.5, 34.5]]]}},
              open(os.path.join(bdir, 'border_lake.geojson'), 'w'))
    idx = {
        'in_lake': {'slug': 'in_lake', 'area_acres': 500, 'centroid': [-80.5, 34.5],
                    'bounds_wsen': [-80.6, 34.4, -80.4, 34.6]},
        'out_lake': {'slug': 'out_lake', 'area_acres': 900, 'centroid': [-84.5, 34.5],
                     'bounds_wsen': [-84.6, 34.4, -84.4, 34.6]},
        # centroid in CC and bounds in CC, but its BOUNDARY reaches AA -- only the boundary saves it
        'border_lake': {'slug': 'border_lake', 'area_acres': 700, 'centroid': [-84.5, 34.5],
                        'bounds_wsen': [-84.6, 34.4, -84.4, 34.6]},
        'no_geom': {'slug': 'no_geom', 'area_acres': 10, 'centroid': [-84.5, 34.5]},
    }
    ipath = os.path.join(tmp, 'lake_index.json')
    json.dump(idx, open(ipath, 'w'))
    r5 = subprocess.run([sys.executable, os.path.join(HERE, 'in_region.py'),
                         '--mask', mask, '--audit-registry', '--index', ipath,
                         '--boundaries', bdir, '--out', os.path.join(tmp, 'drop.json')],
                        capture_output=True, text=True)
    print(r5.stdout or '', r5.stderr or '')
    dropped = json.load(open(os.path.join(tmp, 'drop.json')))
    check(r5.returncode == 0, 'audit exit 0')
    check('in_lake' not in dropped, 'in_lake kept')
    check('out_lake' in dropped, 'out_lake dropped')
    check('border_lake' not in dropped,
          'border_lake kept on its BOUNDARY though its centroid and bounds are out')
    check('no_geom' in dropped and 'weak test' in r5.stdout,
          'a centroid-only row is judged and flagged as the weak test')

    shutil.rmtree(tmp, ignore_errors=True)
    print('\n%s  %d failure(s)' % ('FAILED' if FAIL else 'ALL PASS', len(FAIL)))
    for f in FAIL:
        print('   - ' + f)
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
