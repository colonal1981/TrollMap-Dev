"""test_refile_channel_markers.py - a numbered mark on the water is a channel marker.

Personal use only, not for distribution or resale; not for navigation.

    py -m pytest Scripts\\test_refile_channel_markers.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shapely.geometry import Polygon
from shapely.strtree import STRtree
import refile_channel_markers as R

LAKE = Polygon([(-80.01, 33.24), (-79.99, 33.24), (-79.99, 33.26), (-80.01, 33.26)])
POLYS = [LAKE]
TREE = STRtree(POLYS)


def mark(name, lon, lat, t='road_shield', on_water=False):
    return {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
            'properties': {'poi_type': t, 'name': name, 'on_water': on_water, 'mode': '2/6'}}


def test_moultries_marker_2_on_the_water_is_a_red_channel_marker():
    f = mark('"2"', -79.99603, 33.24911)
    assert R.refile([f], POLYS, TREE) == (1, 0)
    p = f['properties']
    assert p['poi_type'] == 'channel_marker' and p['on_water'] is True
    assert p['marker_number'] == 2 and p['side'] == 'red'
    assert '62.43' in p['side_from'] and p['refiled_from'] == 'road_shield'


def test_odd_is_green():
    f = mark('"5"', -80.0, 33.25)
    R.refile([f], POLYS, TREE)
    assert f['properties']['side'] == 'green'


def test_a_number_on_land_stays_a_road():
    f = mark('"601"', -80.05, 33.30)
    assert R.refile([f], POLYS, TREE) == (0, 1)
    assert f['properties']['poi_type'] == 'road_shield' and f['properties']['on_water'] is False


def test_nothing_else_is_touched():
    fs = [mark('Road Bed', -80.0, 33.25, t='road_bed', on_water=True),
          mark('"7"', -80.0, 33.25, t='nav_buoy', on_water=True)]
    assert R.refile(fs, POLYS, TREE) == (0, 0)
    assert [f['properties']['poi_type'] for f in fs] == ['road_bed', 'nav_buoy']


def test_a_label_that_is_not_a_number_is_left_alone():
    f = mark('US 52', -80.0, 33.25)
    assert R.refile([f], POLYS, TREE) == (0, 1)


def test_no_water_layer_refiles_nothing():
    f = mark('"3"', -80.0, 33.25)
    assert R.refile([f], [], None) == (0, 1)


def test_number_of_reads_garmins_quoted_labels():
    assert R.number_of('"23"') == 23 and R.number_of('23') == 23
    assert R.number_of('"2A"') is None and R.number_of(None) is None


if __name__ == '__main__':
    n = 0
    for k, v in sorted(globals().items()):
        if k.startswith('test_') and callable(v):
            v(); n += 1
    print('%d passed' % n)
