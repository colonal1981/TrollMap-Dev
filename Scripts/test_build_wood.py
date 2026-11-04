#!/usr/bin/env python3
"""The wood he has gone over reaches the pack whole: every piece, every read, nothing decided early.

Personal use only, not for distribution or resale; not for navigation.

Run on the two real files in test/fixtures/wood/: Bates Old River (10/31 and 11/1, no gauge in the
app) and lower Lake Marion (11/2, on USGS 02169921's NGVD29 series).

WHAT THESE TESTS HOLD.

  1. One feature per piece, 24 and 45, by kind as the files say -- a piece with no reads included.
  2. Every read carried through as it is, and the top NOT collapsed: bates_old_river-23 keeps both
     of its reads (10.5 over 13.0 on 10/31, 10.3 over 13.5 on 11/1) and its height is the larger
     gap, 3.2 ft. lake_marion-2026-11-02-m047 keeps its two pictures, tops 6.7 and 6.5, both at
     74.37 ft, 2.43 below full pool.
  3. Bates' `level` is null on the collection, Marion's is the source's block.
  4. A malformed read fails the run and names the piece: a top with no time, a below_full_pool_ft on
     a water with no level.
  5. Nothing is written without --go, and with it the file is what build() made.
"""
import contextlib, copy, io, json, os, shutil, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_wood  # noqa: E402

FIX = HERE.parent / 'test' / 'fixtures' / 'wood'


def eq(g, w, m):
    assert g == w, f'{m}: got {g!r} want {w!r}'


def load(slug):
    with open(FIX / (slug + '.json'), encoding='utf-8') as fh:
        return json.load(fh)


def piece(fc, pid):
    hit = [f for f in fc['features'] if f['properties']['id'] == pid]
    assert len(hit) == 1, f'{pid}: {len(hit)} features'
    return hit[0]


def test_every_piece_is_a_feature():
    b = build_wood.build(load('bates_old_river'))
    m = build_wood.build(load('lake_marion'))
    eq(len(b['features']), 24, 'Bates pieces')
    eq(len(m['features']), 45, 'Marion pieces')
    eq(build_wood.by_kind(b), {'wood': 7, 'low_wood': 9, 'no_height': 8}, 'Bates by kind')
    eq(build_wood.by_kind(m), {'wood': 21, 'low_wood': 15, 'unsure': 9}, 'Marion by kind')
    for fc in (b, m):
        for f in fc['features']:
            eq(f['geometry']['type'], 'Point', f['properties']['id'])
            for k in ('id', 'kind', 'what', 'seen', 'his_mark', 'reads', 'height_ft'):
                assert k in f['properties'], f'{f["properties"]["id"]} has no {k}'


def test_every_read_is_carried_through():
    for slug in ('bates_old_river', 'lake_marion'):
        src = load(slug)
        fc = build_wood.build(src)
        for p in src['pieces']:
            f = piece(fc, p['id'])
            eq(f['properties']['reads'], p['reads'], f'{p["id"]} reads')
            eq(f['geometry']['coordinates'], [p['lon'], p['lat']], f'{p["id"]} position')
    eq(sum(len(f['properties']['reads']) for f in build_wood.build(load('bates_old_river'))['features']),
       24, 'Bates reads')
    eq(sum(len(f['properties']['reads']) for f in build_wood.build(load('lake_marion'))['features']),
       46, 'Marion reads (m047 and m048 are two pictures of one snag)')


def test_a_piece_with_no_reads_keeps_its_place():
    f = piece(build_wood.build(load('bates_old_river')), 'bates_old_river-24')
    eq(f['properties']['kind'], 'no_height', 'his laydown')
    eq(f['properties']['reads'], [], 'no reads')
    eq(f['properties']['height_ft'], None, 'no height')
    eq(f['properties']['his_mark'], 'your 0022 A, the laydown', 'his mark')


def test_the_level_rides_on_the_collection():
    eq(build_wood.build(load('bates_old_river'))['level'], None, 'Bates has no gauge in the app')
    m = build_wood.build(load('lake_marion'))
    eq(m['level']['full_pool_ft'], 76.8, 'Marion full pool')
    eq(m['level']['datum'], 'NGVD29', 'Marion datum')


def test_bates_23_keeps_both_reads_and_the_larger_height():
    p = piece(build_wood.build(load('bates_old_river')), 'bates_old_river-23')['properties']
    eq([(r['at'][:10], r['top_ft'], r['bottom_ft']) for r in p['reads']],
       [('2026-10-31', 10.5, 13.0), ('2026-11-01', 10.3, 13.5)], 'the two reads')
    eq(p['height_ft'], 3.2, 'height is the larger gap')


def test_marion_m047_keeps_both_pictures():
    p = piece(build_wood.build(load('lake_marion')), 'lake_marion-2026-11-02-m047')['properties']
    eq([r['top_ft'] for r in p['reads']], [6.7, 6.5], 'tops')
    eq({r['level_ft'] for r in p['reads']}, {74.37}, 'both at 74.37 ft')
    eq({r['below_full_pool_ft'] for r in p['reads']}, {2.43}, '2.43 below full pool')
    eq(p['height_ft'], 5.7, 'the larger of 5.3 and 5.7')


def test_an_unsure_piece_has_no_height():
    m = build_wood.build(load('lake_marion'))
    for f in m['features']:
        if f['properties']['kind'] == 'unsure':
            eq(f['properties']['height_ft'], None, f['properties']['id'])


def fails(doc, needle):
    try:
        build_wood.build(doc)
    except build_wood.Malformed as e:
        assert needle in str(e), f'{needle!r} not in {e}'
        return str(e)
    raise AssertionError(f'built a file that should have failed ({needle})')


def test_a_top_with_no_time_fails_and_names_the_piece():
    doc = load('bates_old_river')
    p = next(p for p in doc['pieces'] if p['id'] == 'bates_old_river-23')
    p['reads'][1]['at'] = None
    msg = fails(doc, 'bates_old_river-23')
    assert 'read 2' in msg and 'no time' in msg, msg


def test_a_level_on_a_water_with_none_fails():
    doc = load('bates_old_river')
    doc['pieces'][0]['reads'][0]['below_full_pool_ft'] = 2.4
    fails(doc, doc['pieces'][0]['id'])


def test_a_top_under_its_bottom_fails():
    doc = load('lake_marion')
    doc['pieces'][0]['reads'][0]['top_ft'] = 30.0
    fails(doc, doc['pieces'][0]['id'])


def test_an_unknown_kind_fails():
    doc = load('lake_marion')
    doc['pieces'][3]['kind'] = 'tree'
    fails(doc, doc['pieces'][3]['id'])


def run(argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = build_wood.main(argv)
    return rc, buf.getvalue()


def scratch():
    root = tempfile.mkdtemp(prefix='wood_')
    reg, pack = os.path.join(root, 'registry'), os.path.join(root, 'chartpack')
    os.makedirs(os.path.join(reg, 'wood'))
    for slug in ('bates_old_river', 'lake_marion'):
        shutil.copy(FIX / (slug + '.json'), os.path.join(reg, 'wood', slug + '.json'))
        os.makedirs(os.path.join(pack, slug))
    return root, reg, pack


def test_nothing_is_written_without_go():
    root, reg, pack = scratch()
    try:
        rc, log = run(['--registry', reg, '--chartpack', pack])
        eq(rc, 0, 'dry run')
        assert 'DRY RUN' in log, log
        assert 'bates_old_river: 24 pieces (9 low_wood, 8 no_height, 7 wood), 24 reads' in log, log
        assert 'lake_marion: 45 pieces (15 low_wood, 9 unsure, 21 wood), 46 reads' in log, log
        for slug in ('bates_old_river', 'lake_marion'):
            eq(os.listdir(os.path.join(pack, slug)), [], f'{slug} untouched')
    finally:
        shutil.rmtree(root)


def test_go_writes_what_build_made():
    root, reg, pack = scratch()
    try:
        rc, log = run(['--registry', reg, '--chartpack', pack, '--only', 'lake_marion', '--go'])
        eq(rc, 0, log)
        eq(os.listdir(os.path.join(pack, 'bates_old_river')), [], '--only leaves Bates alone')
        with open(os.path.join(pack, 'lake_marion', 'wood.geojson'), encoding='utf-8') as fh:
            got = json.load(fh)
        eq(got, build_wood.build(load('lake_marion')), 'the file is the build')
        assert 'Personal use only' in got['_note']
    finally:
        shutil.rmtree(root)


def test_a_malformed_file_writes_nothing():
    root, reg, pack = scratch()
    try:
        p = os.path.join(reg, 'wood', 'lake_marion.json')
        doc = load('lake_marion')
        bad = copy.deepcopy(doc)
        bad['pieces'][5]['reads'][0]['at'] = ''
        with open(p, 'w', encoding='utf-8') as fh:
            json.dump(bad, fh)
        rc, log = run(['--registry', reg, '--chartpack', pack, '--go'])
        eq(rc, 2, 'refused')
        assert doc['pieces'][5]['id'] in log, log
        for slug in ('bates_old_river', 'lake_marion'):
            eq(os.listdir(os.path.join(pack, slug)), [], f'{slug}: nothing written')
    finally:
        shutil.rmtree(root)


def test_a_slug_with_no_pack_writes_nothing():
    root, reg, pack = scratch()
    try:
        shutil.rmtree(os.path.join(pack, 'bates_old_river'))
        rc, log = run(['--registry', reg, '--chartpack', pack, '--go'])
        eq(rc, 2, 'refused')
        assert 'no pack folder' in log, log
        eq(os.listdir(os.path.join(pack, 'lake_marion')), [], 'Marion not written either')
    finally:
        shutil.rmtree(root)


if __name__ == '__main__':
    tests = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    bad = 0
    for t in tests:
        try:
            t()
            print('ok  ', t.__name__)
        except AssertionError as e:
            bad += 1
            print('FAIL', t.__name__, '--', e)
    print('%d/%d passed' % (len(tests) - bad, len(tests)))
    sys.exit(1 if bad else 0)
