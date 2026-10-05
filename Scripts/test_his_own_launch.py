#!/usr/bin/env python3
"""A launch no feed lists is a launch when he says it is one.

Ryan, 2026-10-05, of where he puts in on Bates Old River: *"where i launched is a kayak style launch
its just a dirt rd down to the lake and you launch from the end of it"*. No feed has anything within
600 m of it. registry/_launch_name_overrides.json could name a landing or drop one; now an `add`
entry puts one there, and my_launch.py writes that entry.

WHAT THESE TESTS HOLD.

  1. An `add` entry becomes a landing: his position, his name, filed under the water he named,
     and `ryan` as its source -- and no "matches no landing" warning, because it was never
     meant to match one.
  2. An `add` on a landing a feed already has does not make a second one; it names that one.
  3. --overrides reads another file, so a scratch run does not need the registry's.
  4. my_launch.py writes nothing without --go, refuses --go without a backup, refuses a water the
     registry does not know, keeps the file's own layout, and says so when the entry is already in.

Personal use only, not for distribution or resale; not for navigation.
"""
import contextlib, io, json, os, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_ramp_reach as brr  # noqa: E402
import my_launch  # noqa: E402

HIS = (33.78543, -80.63566)
FEED = (33.00000, -80.00000)


def eq(g, w, m):
    assert g == w, f'{m}: got {g!r} want {w!r}'


def registry(names):
    d = tempfile.mkdtemp(prefix='reg_')
    with open(os.path.join(d, 'dnr_ramps_by_lake.json'), 'w', encoding='utf-8') as fh:
        json.dump({'lake_a': [{'lat': FEED[0], 'lon': FEED[1], 'name': 'Feed Landing'}]}, fh)
    with open(os.path.join(d, 'lake_index.json'), 'w', encoding='utf-8') as fh:
        json.dump({'bates_old_river': {}, 'lake_a': {}}, fh)
    if names is not None:
        with open(os.path.join(d, '_launch_name_overrides.json'), 'w', encoding='utf-8') as fh:
            fh.write(json.dumps({'_note': 'test', 'names': names}, indent=1))
    return d


def points(reg, overrides=None):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        pts = brr.access_points(reg, overrides)
    return pts, buf.getvalue()


def key(p):
    return '%.5f,%.5f' % p


def his_entry(**kw):
    e = {'add': True, 'name': 'Dirt road kayak launch', 'water': 'bates_old_river',
         'why': 'Ryan, 2026-10-05: "a dirt rd down to the lake"'}
    e.update(kw)
    return e


def test_an_add_is_a_landing():
    pts, log = points(registry({key(HIS): his_entry()}))
    r = pts.get((round(HIS[0], 5), round(HIS[1], 5)))
    assert r is not None, 'his launch is a landing'
    eq(r['name'], 'Dirt road kayak launch', 'with his name')
    eq(r['filed'], {'bates_old_river'}, 'on the water he named')
    eq(r['src'], {'ryan'}, 'and it is his')
    eq(len(pts), 2, 'the feed landing is still there beside it')
    assert 'matches no landing' not in log, 'an add is not a misplaced rename:\n' + log
    assert '1 launch(es) of his own added' in log, 'and the run says what it did:\n' + log


def test_an_add_on_a_feed_landing_names_it():
    pts, _ = points(registry({key(FEED): his_entry(water='lake_a', name='His Name')}))
    eq(len(pts), 1, 'no second landing on top of the first')
    r = next(iter(pts.values()))
    eq(r['name'], 'His Name', 'the feed landing takes his name')
    eq('ryan' in r['src'], True, 'and is marked as named by him')


def test_overrides_from_another_file():
    reg = registry(None)
    other = os.path.join(tempfile.mkdtemp(prefix='ovr_'), 'scratch_overrides.json')
    with open(other, 'w', encoding='utf-8') as fh:
        json.dump({'names': {key(HIS): his_entry()}}, fh)
    pts, _ = points(reg)
    eq(len(pts), 1, 'the registry has no overrides file: the feed landing only')
    pts, _ = points(reg, other)
    eq(len(pts), 2, '--overrides reads the file it is given')


def run(argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = my_launch.main(argv)
    return rc, buf.getvalue()


def test_my_launch_writes_his_entry_with_a_backup():
    reg = registry({key(FEED): {'name': 'Feed Landing', 'why': 'x', 'replaces': '(unnamed)'}})
    path = os.path.join(reg, '_launch_name_overrides.json')
    before = open(path, encoding='utf-8').read()
    base = ['--registry', reg, '--lat', str(HIS[0]), '--lon', str(HIS[1]), '--water', 'bates_old_river',
            '--name', 'Dirt road kayak launch', '--why', 'Ryan, 2026-10-05']

    rc, log = run(base)
    eq(rc, 0, 'a dry run is not an error')
    eq(open(path, encoding='utf-8').read(), before, 'and writes nothing')

    rc, log = run(base + ['--go'])
    eq(rc, 2, '--go without a backup folder is refused')
    eq(open(path, encoding='utf-8').read(), before, 'and writes nothing')

    rc, log = run(base[:-6] + ['--water', 'no_such_water'] + base[-4:] + ['--go'])
    eq(rc, 2, 'a water the registry does not know is refused')

    bak = tempfile.mkdtemp(prefix='bak_')
    rc, log = run(base + ['--go', '--backup', bak])
    eq(rc, 0, 'written')
    saved = os.listdir(bak)
    eq(len(saved), 1, 'one backup')
    eq(open(os.path.join(bak, saved[0]), encoding='utf-8').read(), before, 'of the file as it was')
    after = open(path, encoding='utf-8').read()
    doc = json.loads(after)
    eq(doc['names'][key(HIS)], my_launch.entry('Dirt road kayak launch', 'bates_old_river',
                                               'Ryan, 2026-10-05'), 'his entry is in')
    eq(after, json.dumps(doc, indent=1, ensure_ascii=True), 'in the file\'s own layout')
    eq(doc['_note'], 'test', 'and nothing else in the file moved')

    rc, log = run(base + ['--go', '--backup', bak])
    eq(rc, 0, 'running it again is fine')
    assert 'nothing to do' in log, log
    eq(len(os.listdir(bak)), 1, 'and makes no second backup')

    pts, _ = points(reg)
    eq(pts[(round(HIS[0], 5), round(HIS[1], 5))]['filed'], {'bates_old_river'},
       'and build_ramp_reach reads what it wrote')


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
