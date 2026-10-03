"""test_claude_fish_sorter.py -- the parts of the Claude fish sorter that are not Claude.

Personal use only, not for distribution or resale; not for navigation.

    py Scripts\\test_claude_fish_sorter.py
"""
import datetime as dt, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import claude_fish_sorter as S  # noqa: E402

E = S.EASTERN
HERE = os.path.dirname(os.path.abspath(__file__))


def ph(name, h, m, s=0, sha=None):
    return {'name': name, 'path': 'x/' + name, 'when': dt.datetime(2024, 12, 7, h, m, s, tzinfo=E),
            'lat': 33.25, 'lon': -80.0, 'sha256': sha or name}


def test_species_are_the_apps_own_list():
    js = open(os.path.join(HERE, '..', 'js', 'modules', 'catch-journal.js'), encoding='utf-8').read()
    block = re.search(r'const SPECIES = \[(.*?)\];', js, re.S).group(1)
    app = [x for x in re.findall(r"'([^']*)'", block) if x not in ('', 'Not Fish')]
    assert S.SPECIES == app, (S.SPECIES, app)


def test_google_cut_sidecar_names_find_their_photo():
    for side in ('PXL_20241207_150257366.jpg.supplemental-metadata.json',
                 'PXL_20241207_150257366.jpg.supplemental-met.json',
                 'PXL_20241207_150257366.jpg.suppl.json',
                 'PXL_20241207_150257366.jpg.s.json',
                 'PXL_20241207_150257366.jpg.json'):
        assert S.SIDECAR_CUT.sub('', side) == 'PXL_20241207_150257366.jpg', side


def test_a_long_day_is_cut_at_its_longest_gaps():
    day = [ph('a%02d' % i, 9, i) for i in range(20)] + [ph('b%02d' % i, 13, i) for i in range(20)]
    parts = S.chunks_of(day, batch=30)
    assert [len(p) for p in parts] == [20, 20]
    assert parts[1][0]['name'] == 'b00'
    assert S.chunks_of(day[:5], batch=30) == [day[:5]]


def test_one_fish_carries_all_its_photos_and_its_board_shot():
    chunk = [ph('lure.jpg', 13, 14), ph('board.jpg', 13, 15), ph('water.jpg', 13, 30)]
    ans = {'_model': 'claude-sonnet', 'photos': [{'i': 1, 'what': 'fish with lure'}, {'i': 2, 'what': 'on board'}],
           'fish': [{'photos': [1], 'board_photo': 2, 'best_photo': 2, 'species_guess': 'Striped Bass',
                     'why_same_fish': 'same stripes, same lure'},
                    {'photos': [], 'board_photo': None}, {'photos': [9]}]}
    fish = S.fish_from(ans, chunk)
    assert len(fish) == 1
    assert [p['name'] for p in fish[0]['photos']] == ['lure.jpg', 'board.jpg']
    assert fish[0]['board']['name'] == 'board.jpg'


def test_a_fish_already_in_the_history_does_not_come_in_again():
    f = {'photos': [ph('a.jpg', 13, 14), ph('b.jpg', 13, 16)]}
    assert S.already_held(f, ({'b.jpg'}, set(), {}))
    assert S.already_held(f, (set(), {'a.jpg'}, {}))
    assert S.already_held(f, (set(), set(), {'2024-12-07': ['13:15:02']}))
    assert not S.already_held(f, (set(), set(), {'2024-12-07': ['13:20:00'], '2024-12-08': ['13:15:00']}))


def test_a_row_is_in_catch_centers_columns_and_left_for_review():
    b = ph('board.jpg', 13, 15, sha='abc')
    fish = {'photos': [ph('lure.jpg', 13, 14), b], 'board': b, 'best': b, 'species_guess': 'Striped Bass',
            'why': 'same fish', 'sort_model': 'claude-sonnet'}
    r = S.row_for(fish, {'species': 'Striped Bass', 'length_in': 32.0, 'confidence': 'high',
                         'how_read': 'tail at 32', 'problems': [], '_model': 'claude-opus'}, 'tag')
    assert list(r) == S.CSV_COLUMNS
    assert r['review_status'] == '' and r['ai_length_inches'] == 32.0 and r['verified_length_inches'] == ''
    assert r['time'] == '13:15:00' and r['sha256'] == 'abc' and 'Same fish: lure.jpg' in r['notes']
    assert 'verify_board_length_from_photo' in r['review_flags']
    r2 = S.row_for({**fish, 'board': None}, None, 'tag')
    assert 'handheld_no_board' in r2['review_flags'] and r2['ai_length_inches'] == ''
    r3 = S.row_for(fish, {'species': 'Trout', 'length_in': None, 'confidence': 'low', '_model': 'm'}, 'tag')
    for flag in ('species_needs_review', 'board_missing_length', 'low_confidence'):
        assert flag in r3['review_flags'], flag


if __name__ == '__main__':
    n = 0
    for k, v in sorted(globals().items()):
        if k.startswith('test_') and callable(v):
            v()
            n += 1
            print('ok', k)
    print('%d passed' % n)
