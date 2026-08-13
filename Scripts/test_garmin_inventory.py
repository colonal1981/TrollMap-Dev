#!/usr/bin/env python3
"""Synthetic end-to-end test for build_garmin_water_inventory.py.

Builds land_fill and waterbody tiles by hand with a lake of a KNOWN area, deliberately split
across subdivision seams the way Garmin splits them, and asserts the reassembly."""
import gzip, importlib.util, json, math, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
_s = importlib.util.spec_from_file_location('inv', os.path.join(HERE, 'build_garmin_water_inventory.py'))
INV = importlib.util.module_from_spec(_s); _s.loader.exec_module(INV)

FAIL = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        FAIL.append(msg)


def circle(cx, cy, r_deg, n=240, squash=1.0):
    return [(cx + r_deg * math.cos(2 * math.pi * i / n) / squash,
             cy + r_deg * math.sin(2 * math.pi * i / n)) for i in range(n)]


def clip_to(ring, box):
    """Keep the part of `ring` inside `box`, walking the box edge between exits -- which is
    exactly what Garmin does at a subdivision boundary."""
    W, E, S, N = box
    out = []
    for x, y in ring:
        out.append((min(max(x, W), E), min(max(y, S), N)))
    return out


def write(path, feats):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path, 'wt', encoding='utf-8') as fh:
        json.dump({'type': 'FeatureCollection', 'features': feats}, fh)


def poly(ring, props):
    return {'type': 'Feature', 'properties': props,
            'geometry': {'type': 'Polygon', 'coordinates': [[list(p) for p in ring]]}}


def main():
    tmp = tempfile.mkdtemp()
    ex = os.path.join(tmp, 'extract')

    # A NAMED lake: a circle at (-81.00, 34.00) r=0.02 deg, straddling the seam at lon -81.00.
    # It goes in land_fill as a hole in two subdivision boxes.
    LAKE = circle(-81.00, 34.00, 0.02)
    true_acres = INV.acres(LAKE)
    boxL = (-81.05, -81.00, 33.95, 34.05)
    boxR = (-81.00, -80.95, 33.95, 34.05)
    lf = []
    for i, (box, side) in enumerate(((boxL, 'L'), (boxR, 'R'))):
        W, E, S, N = box
        part = [p for p in LAKE if W <= p[0] <= E]
        # box outline, then a seam in to the shore and back -- Garmin's single-ring hole
        ring = [(W, S), (E, S), (E, N), (W, N), (W, S)] + clip_to(part, box) + [(W, S)]
        lf.append(poly(ring, {'mode': '1/10', 'zoom': 0, 'subdivision': i,
                              'layer': 'land_fill', 'area_m2': 1.0}))
    # a solid subdivision with no water at all
    lf.append(poly([(-79.05, 33.95), (-79.00, 33.95), (-79.00, 34.05), (-79.05, 34.05),
                    (-79.05, 33.95)], {'mode': '1/10', 'zoom': 0, 'subdivision': 9,
                                       'layer': 'land_fill', 'area_m2': 1.0}))
    # a generalised copy at zoom 3 that must be ignored
    lf.append(poly([(p[0], p[1]) for p in circle(-81.00, 34.00, 0.03, 12)],
                   {'mode': '1/10', 'zoom': 3, 'subdivision': 0, 'layer': 'land_fill'}))
    write(os.path.join(ex, 'land_fill', 'B0001.geojson.gz'), lf)

    # An UNNAMED lake at (-82.00, 34.00), r=0.01: no hole in land_fill, drawn in waterbody,
    # split at the seam lon -82.00, and duplicated as mode 11/19 which must be dropped.
    POND = circle(-82.00, 34.00, 0.01)
    pond_acres = INV.acres(POND)
    boxA = (-82.05, -82.00, 33.95, 34.05)
    boxB = (-82.00, -81.95, 33.95, 34.05)
    lf2 = []
    for i, box in enumerate((boxA, boxB), start=20):
        W, S, E, N = box[0], box[2], box[1], box[3]
        lf2.append(poly([(W, S), (E, S), (E, N), (W, N), (W, S)],
                        {'mode': '1/10', 'zoom': 0, 'subdivision': i, 'layer': 'land_fill'}))
    write(os.path.join(ex, 'land_fill', 'B0002.geojson.gz'), lf2)
    wbf = []
    for i, box in enumerate((boxA, boxB), start=20):
        W, E, S, N = box
        part = clip_to([p for p in POND if W <= p[0] <= E], box)
        for mode in ('6/20', '11/19'):
            wbf.append(poly(part, {'mode': mode, 'zoom': 0, 'subdivision': i,
                                   'layer': 'waterbody'}))
    write(os.path.join(ex, 'waterbody', 'B0002.geojson.gz'), wbf)

    idx = os.path.join(tmp, 'lake_index.json')
    json.dump({'known_lake': {'slug': 'known_lake', 'bounds_wsen': [-79.9, 33.9, -79.8, 34.1]}},
              open(idx, 'w'))
    out = os.path.join(tmp, 'inv.tsv')

    def run(extra=()):
        return subprocess.run([sys.executable, os.path.join(HERE, 'build_garmin_water_inventory.py'),
                               '--extract', ex, '--out', out, '--index', idx,
                               '--min-acres', '1'] + list(extra),
                              capture_output=True, text=True)

    print('\n--- reassembly ---')
    r = run()
    print(r.stdout or '', r.stderr or '')
    check(r.returncode == 0, 'exit 0')
    rows = [dict(zip(open(out).readline().strip().split('\t'), l.strip().split('\t')))
            for l in open(out).readlines()[1:]]
    print('   truth: named lake %.0f ac, unnamed pond %.0f ac' % (true_acres, pond_acres))
    for x in rows:
        print('   got: %s ac closed=%s gap=%s pts=%s at %s'
              % (x['acres'], x['closed'], x['gap_m'], x['pts'], x['xy']))

    named = [x for x in rows if abs(float(x['lon']) + 81.0) < 0.02]
    pond = [x for x in rows if abs(float(x['lon']) + 82.0) < 0.02]
    check(len(named) == 1, 'the named lake reassembled into ONE water (%d)' % len(named))
    check(len(pond) == 1, 'the unnamed pond reassembled into ONE water (%d)' % len(pond))
    if named:
        e = abs(int(named[0]['acres']) - true_acres) / true_acres
        check(e < 0.10, 'named lake area within 10%% of truth (%s vs %.0f)'
              % (named[0]['acres'], true_acres))
        check(named[0]['closed'] == 'True', 'named lake ring CLOSED')
    if pond:
        e = abs(int(pond[0]['acres']) - pond_acres) / pond_acres
        check(e < 0.10, 'unnamed pond area within 10%% of truth (%s vs %.0f)'
              % (pond[0]['acres'], pond_acres))
        check(pond[0]['closed'] == 'True', 'unnamed pond ring CLOSED')
        check(int(pond[0]['acres']) < true_acres,
              'the 11/19 duplicate did NOT double the pond (%s ac)' % pond[0]['acres'])
    check(not [x for x in rows if abs(float(x['lon']) + 79.0) < 0.02],
          'a subdivision with no water produced no ring')
    check(all(int(x['pts']) < 400 for x in rows),
          'the zoom-3 generalised copy was ignored (no 12-pt ring merged in)')

    print('\n--- registry cross-check ---')
    check(all(x['in_registry'] == '' for x in rows),
          'nothing falls in the fixture registry bounds, so in_registry is blank')
    json.dump({'known_lake': {'slug': 'known_lake', 'bounds_wsen': [-81.1, 33.9, -80.9, 34.1]}},
              open(idx, 'w'))
    bdir = os.path.join(tmp, 'boundaries')
    os.makedirs(bdir, exist_ok=True)
    json.dump({'type': 'Feature', 'properties': {}, 'geometry': {'type': 'Polygon',
               'coordinates': [[[-81.1, 33.9], [-80.9, 33.9], [-80.9, 34.1], [-81.1, 34.1],
                                [-81.1, 33.9]]]}},
              open(os.path.join(bdir, 'known_lake.geojson'), 'w'))
    run(['--boundaries', bdir])
    rows2 = [dict(zip(open(out).readline().strip().split('\t'), l.strip().split('\t')))
             for l in open(out).readlines()[1:]]
    n2 = [x for x in rows2 if abs(float(x['lon']) + 81.0) < 0.02]
    check(n2 and n2[0]['in_registry'] == 'known_lake',
          'a water inside a registry BOUNDARY is attributed (%s)' % (n2[0]['in_registry'] if n2 else '-'))
    json.dump({'type': 'Feature', 'properties': {}, 'geometry': {'type': 'Polygon',
               'coordinates': [[[-81.1, 33.9], [-81.06, 33.9], [-81.06, 33.94], [-81.1, 33.94],
                                [-81.1, 33.9]]]}},
              open(os.path.join(bdir, 'known_lake.geojson'), 'w'))
    run(['--boundaries', bdir])
    n3 = [x for x in [dict(zip(open(out).readline().strip().split('\t'), l.strip().split('\t')))
                      for l in open(out).readlines()[1:]] if abs(float(x['lon']) + 81.0) < 0.02]
    check(n3 and n3[0]['in_registry'] == '',
          'and a registry row whose BOUNDS overlap but whose GEOMETRY does not is NOT credited '
          '-- that is the arms-of-Alligator-River bug (%s)' % (n3[0]['in_registry'] if n3 else '-'))

    print('\n--- an arm of a known lake is not a discovery ---')
    # boundary covers only the WEST half of the named lake, so the east half must read as an ARM
    json.dump({'type': 'Feature', 'properties': {}, 'geometry': {'type': 'Polygon',
               'coordinates': [[[-81.10, 33.98], [-81.005, 33.98], [-81.005, 34.02],
                                [-81.10, 34.02], [-81.10, 33.98]]]}},
              open(os.path.join(bdir, 'known_lake.geojson'), 'w'))
    ra = run(['--boundaries', bdir])
    rowa = [dict(zip(open(out).readline().strip().split('\t'), l.strip().split('\t')))
            for l in open(out).readlines()[1:]]
    na = [x for x in rowa if abs(float(x['lon']) + 81.0) < 0.03]
    check(na and na[0]['arm_of'] == 'known_lake',
          'a water touching a registry boundary is labelled an ARM (%s, %s km)'
          % (na[0]['arm_of'] if na else '-', na[0]['arm_km'] if na else '-'))
    check('ARMS' in ra.stdout and 'NOT NEAR ANYTHING KNOWN' in ra.stdout,
          'and the summary separates arms from candidates')
    pa = [x for x in rowa if abs(float(x['lon']) + 82.0) < 0.03]
    check(pa and pa[0]['arm_of'] == ''
          and (pa[0]['arm_km'] == '' or float(pa[0]['arm_km']) > 1.0),
          'a water far from everything is NOT called an arm (arm_km=%r, blank means nothing '
          'within search range)' % (pa[0]['arm_km'] if pa else '-'))

    print('\n--- a subdivision rectangle is not a lake ---')
    # An untrimmed offshore waterbody ring: a 12-point rectangle filling its own bbox, exactly
    # the shape that put 965 rings and 4.4M acres into the first real run.
    boxring = [(-83.05, 33.95), (-83.03, 33.95), (-83.01, 33.95), (-83.00, 33.95),
               (-83.00, 34.00), (-83.00, 34.05), (-83.03, 34.05), (-83.05, 34.05),
               (-83.05, 34.03), (-83.05, 34.01), (-83.05, 33.97), (-83.05, 33.95)]
    write(os.path.join(ex, 'waterbody', 'B0003.geojson.gz'),
          [poly(boxring, {'mode': '6/20', 'zoom': 0, 'subdivision': 77, 'layer': 'waterbody'})])
    rb = run()
    rowsb = [dict(zip(open(out).readline().strip().split('\t'), l.strip().split('\t')))
             for l in open(out).readlines()[1:]]
    check(not [x for x in rowsb if abs(float(x['lon']) + 83.025) < 0.05],
          'the rectangle was dropped, not shipped as a lake')
    check('fills its own bounding box' in rb.stdout, 'and it said so')
    rb2 = run(['--max-boxiness', '1.1'])
    rowsb2 = [dict(zip(open(out).readline().strip().split('\t'), l.strip().split('\t')))
              for l in open(out).readlines()[1:]]
    check([x for x in rowsb2 if abs(float(x['lon']) + 83.025) < 0.05],
          '--max-boxiness 1.1 lets it back through, so the test is the knob')
    shutil.rmtree(os.path.join(ex, 'waterbody'), ignore_errors=True)

    print('\n--- the reported point must be INSIDE its own ring ---')
    import math as _m
    # a C-shape: the mean of its vertices is in the notch, on land
    C = [(-84.02 + 0.02 * _m.cos(t / 40.0), 34.0 + 0.02 * _m.sin(t / 40.0))
         for t in range(20, 232)]
    C = C + [(p[0] * 0.5 + -84.02 * 0.5, p[1] * 0.5 + 34.0 * 0.5) for p in reversed(C)]
    cx = sum(p[0] for p in C) / len(C); cy = sum(p[1] for p in C) / len(C)
    check(not INV.inside(C, cx, cy), 'fixture C-shape: the vertex mean really is OUTSIDE it')
    rp = INV.rep_point(C)
    check(rp is not None and INV.inside(C, rp[0], rp[1]),
          'rep_point() returns a point PROVEN inside (%s)' % (rp,))
    sq = [(-81.0, 34.0), (-80.99, 34.0), (-80.99, 34.01), (-81.0, 34.01)]
    check(INV.inside(sq, -80.995, 34.005) and not INV.inside(sq, -80.98, 34.005),
          'inside() agrees with hand arithmetic on a square')

    print('\n--- no soundings, no water ---')
    import json as _j
    # the rectangle block above removed extract/waterbody; the pond has to exist for this test
    write(os.path.join(ex, 'waterbody', 'B0002.geojson.gz'), wbf)
    cov = os.path.join(tmp, 'cov.json')
    _j.dump({'cell': 0.002, 'cells': [], 'da_cells': []}, open(cov, 'w'))
    rz = run(['--coverage', cov])
    rowz = [dict(zip(open(out).readline().strip().split('\t'), l.strip().split('\t')))
            for l in open(out).readlines()[1:]]
    check('soundings test is OFF' in rz.stdout, 'an empty da_cells says the test is off')
    # now give the named lake soundings and the pond none
    # enough cells to cover the named lake's area, none for the pond
    import math as _mm
    cellac = (0.002 * 111320 * _mm.cos(_mm.radians(34.0))) * (0.002 * 111320) / 4046.86
    need = int(true_acres / cellac) + 2
    # the lake is r=0.02 deg = 10 cells; fill a disc a little wider so it is fully sounded
    da = []
    for dx in range(-14, 15):
        for dy in range(-11, 12):
            if dx * dx * 0.7 + dy * dy <= 12 * 12:
                da.append([int(-81.0 / 0.002) + dx, int(34.0 / 0.002) + dy])
    _j.dump({'cell': 0.002, 'cells': da, 'da_cells': da}, open(cov, 'w'))
    rz2 = run(['--coverage', cov])
    rowz2 = [dict(zip(open(out).readline().strip().split('\t'), l.strip().split('\t')))
             for l in open(out).readlines()[1:]]
    lons = [round(float(x['lon']), 1) for x in rowz2]
    check(-81.0 in lons, 'the lake WITH a depth area survives')
    check(-82.0 not in lons, 'the pond with NO depth area is rejected')
    check('sounded inside' in rz2.stdout, 'and the rejection is printed:\n%s'
          % '\n'.join(l for l in rz2.stdout.split(chr(10)) if 'REJECT' in l or 'sounded' in l))
    lake_row = [x for x in rowz2 if round(float(x['lon']), 1) == -81.0]
    check(lake_row and float(lake_row[0]['da_share']) >= 0.5,
          'the surviving lake reports its sounded share (%s)'
          % (lake_row[0]['da_share'] if lake_row else '-'))
    check(all(x['pt_on_water'] == 'True' for x in rowz2), 'every surviving row proves its point')

    print('\n--- the region gate ---')
    r5 = run()
    check('NO region mask' in r5.stdout,
          'a missing region mask warns instead of silently passing everything')

    print('\n--- failure modes ---')
    r3 = run(['--extract', os.path.join(tmp, 'nothing')])
    check(r3.returncode != 0 and 'no land_fill' in (r3.stdout + r3.stderr),
          'a missing land_fill layer names the extract command (rc=%d)' % r3.returncode)
    shutil.rmtree(os.path.join(ex, 'waterbody'), ignore_errors=True)
    r4 = run()
    check('does not NAME' in r4.stdout, 'a missing waterbody layer warns that unnamed water is lost')

    print('\n--- geometry helpers ---')
    sq = [(-81.0, 34.0), (-80.99, 34.0), (-80.99, 34.01), (-81.0, 34.01)]
    a = INV.acres(sq)
    want = (0.01 * 111320 * math.cos(math.radians(34.005))) * (0.01 * 111320) / 4046.86
    check(abs(a - want) / want < 0.01, 'acres() matches hand arithmetic (%.1f vs %.1f)' % (a, want))
    check(abs(INV.metres((-81.0, 34.0), (-81.0, 34.01)) - 1113.2) < 5,
          'metres() north-south is right')

    shutil.rmtree(tmp, ignore_errors=True)
    print('\n%s  %d failure(s)' % ('FAILED' if FAIL else 'ALL PASS', len(FAIL)))
    for f in FAIL:
        print('   - ' + f)
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
