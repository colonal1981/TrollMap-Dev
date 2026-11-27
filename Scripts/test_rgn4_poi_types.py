"""test_rgn4_poi_types.py -- the point classes Ryan identified by tapping them in Garmin, 2026-11-26.

Personal use only, not for distribution or resale; not for navigation.

    py Scripts\\test_rgn4_poi_types.py

Each case is a tap: he tapped a symbol in Garmin's app, the tap was matched to a point in the
November extract, and Garmin's name for it is what the type below has to agree with. The Moultrie
stumps are the two dotted circles at 33.35911 / 33.35750, -80.0379, one with "Stump" printed over it.
"""
import os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rgn4_pois as R  # noqa: E402
from collections import Counter  # noqa: E402


def typ(mode, name=None, **kw):
    p = dict(mode=mode, **kw)
    if name is not None: p['name'] = name
    return R.poi_type(p)


def test_two_line_labels_survive():
    for raw, want in (('River Bed -\nSantee River', 'River Bed - Santee River'),
                      ('Santee Cooper\nLake Marion', 'Santee Cooper Lake Marion'),
                      ('Creek Bed - \r\nTawcaw Creek', 'Creek Bed - Tawcaw Creek')):
        assert not R.OKTEXT.match(raw)                      # what threw them away
        assert R.one_line(raw) == want and R.OKTEXT.match(R.one_line(raw))


def test_a_class_with_a_name_is_typed_by_the_class():
    assert typ('5/1', 'River Bed - Santee River')[0] == 'river_bed'
    assert typ('5/1', 'Creek Bed - Rocks Creek')[0] == 'creek_bed'
    assert typ('5/1', 'Submerged Major Creek Bed - Entaw Creek')[0] == 'creek_bed'
    assert typ('5/1', 'Road Bed - Hwy 6')[0] == 'road_bed'
    assert typ('5/1', 'Pond - Horse Creek')[0] == 'place_name'
    # only bottom structure is read off a prefix: an old mill dam is not the dam you cannot pass
    assert typ('5/1', 'Dam - Old Mill')[0] == 'place_name'
    assert typ('5/1', 'Submerged Dam')[0] == 'place_name'
    assert typ('5/1', 'Dam')[0] == 'dam'


def test_the_words_on_the_bottom():
    assert typ('5/1', 'Stump')[0] == 'flooded_timber'
    assert typ('5/1', 'Piles PA')[0] == 'pile'
    assert typ('5/1', 'Obstn')[0] == 'obstruction'
    assert typ('5/1', 'Underwater Rocks')[0] == 'rock'
    assert typ('5/1', 'Shallow')[0] == 'shallow_area'
    assert typ('5/1', 'Rocks Creek')[0] == 'place_name'


def test_the_tapped_symbols():
    assert typ('4/1') == ('obstruction', True)             # "Obstruction", the dotted circle
    assert typ('4/7') == ('fish_haven', True)              # "Fish Haven", fish in a dotted oval
    assert typ('4/10') == ('rock', True)                   # "Dangerous Rock"
    assert typ('4/8') == ('obstruction', True)             # "Obstruction that Covers"
    assert typ('4/3') == ('wreck', True)                   # "Exposed Wreck"
    assert typ('4/12') == ('rock', True)                   # "Exposed Rock"
    assert typ('4/9') == ('marine_farm', True)             # "Marine Farm"
    assert typ('3/4') == ('obstruction', True)             # grey square, never named
    assert typ('3/6') == ('obstruction', True)             # "+", never named
    assert typ('3/26') == ('dock', True)                   # purple triangle on a dock
    assert typ('7/0') == ('power_cable', False)            # "OVHD PWR CBL"
    assert typ('3/8') == ('landmark', False)               # tower on land
    assert typ('2/11') == ('special_purpose_buoy', True)   # "Special Purpose Buoy"
    assert typ('7/17') == ('mile_marker', True)            # "Mile Marker", ICW
    assert typ('2/11', '"17"')[0] == 'road_shield'         # numbered: refiled per pack as before


def _run(recs):
    kept = [(la, lo, dict(p)) for la, lo, p in recs]
    st = Counter()
    out = R.name_symbols(kept, st)
    for _la, _lo, p in out:
        p['poi_type'] = R.poi_type(p)[0]
    return out, st


def test_a_word_on_a_symbol_names_it_and_is_not_counted_twice():
    recs = [(33.35911, -80.03790, {'mode': '4/1', 'zoom': 0}),                 # circle, tapped
            (33.35932, -80.03787, {'mode': '5/1', 'zoom': 0, 'name': 'Stump'}),  # 23 m north
            (33.35750, -80.03790, {'mode': '4/1', 'zoom': 0}),                 # second circle
            (33.35773, -80.03793, {'mode': '5/1', 'zoom': 0, 'name': 'Stump'}),
            (33.36500, -80.03000, {'mode': '5/1', 'zoom': 0, 'name': 'Stump'})]  # nothing under it
    out, st = _run(recs)
    types = sorted((p['poi_type'], p.get('name')) for _la, _lo, p in out)
    assert types == [('flooded_timber', 'Stump'), ('obstruction', 'Stump'), ('obstruction', 'Stump')], types
    assert st['label_named_symbol_stump'] == 2 and st['label_alone_stump'] == 1


def test_a_word_a_named_buoy_already_says_is_dropped():
    recs = [(33.50000, -80.30000, {'mode': '2/7', 'zoom': 0, 'navaid': True,
                                   'name': 'Hazard Buoy, Spar/Spindle Buoy'}),
            (33.50020, -80.30000, {'mode': '5/1', 'zoom': 0, 'name': 'Hazard'})]
    out, st = _run(recs)
    assert [p['poi_type'] for _la, _lo, p in out] == ['danger_buoy']
    assert st['label_repeats_named_hazard'] == 1


def test_a_word_far_from_any_symbol_keeps_its_own_type():
    recs = [(33.50000, -80.30000, {'mode': '4/1', 'zoom': 0}),
            (33.50300, -80.30000, {'mode': '5/1', 'zoom': 0, 'name': 'Pile'})]   # 334 m away
    out, _ = _run(recs)
    assert sorted(p['poi_type'] for _la, _lo, p in out) == ['obstruction', 'pile']


if __name__ == '__main__':
    tests = [v for k, v in sorted(globals().items()) if k.startswith('test_')]
    for t in tests: t()
    print('ok: %d tests' % len(tests))
