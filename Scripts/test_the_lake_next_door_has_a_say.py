"""A partial cut hears from the served waters it is not building. Personal use only, not for distribution or resale;
not for navigation.

    py .\\test_the_lake_next_door_has_a_say.py
"""
import json, os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_all_chartpacks as B
from build_chartpack import LakeMask


def _sq(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]


def _shape(x0, y0, x1, y1):
    # not a rectangle (a notch in one corner), so it is rasterised like a real lake
    return [[x0, y0], [x1, y0], [x1, y1], [x0 + (x1 - x0) / 4, y1], [x0, y1 - (y1 - y0) / 4], [x0, y0]]


def _registry():
    d = tempfile.mkdtemp(prefix='rivals_')
    os.makedirs(os.path.join(d, 'boundaries'))
    shapes = {'lake_a': _shape(-80.020, 33.000, -80.000, 33.020),   # the lake next door
              'river_b': _sq(-80.040, 33.009, -80.020, 33.011),     # the river being cut, meeting it at -80.020
              'coast_x': _shape(-80.050, 32.990, -79.990, 33.030)}  # a zone drawn over both
    meta = {}
    for s, ring in shapes.items():
        with open(os.path.join(d, 'boundaries', s + '.geojson'), 'w', encoding='utf-8') as fh:
            json.dump({'type': 'FeatureCollection', 'features': [
                {'type': 'Feature', 'properties': {}, 'geometry': {'type': 'Polygon', 'coordinates': [ring]}}]}, fh)
        xs, ys = [p[0] for p in ring], [p[1] for p in ring]
        meta[s] = {'slug': s, 'bounds_wsen': [min(xs), min(ys), max(xs), max(ys)]}
    return d, meta


def test_the_lake_holds_more_of_a_contour_that_is_mostly_in_it():
    d, meta = _registry()
    r = B.Rivals(d, meta, {'lake_a', 'river_b', 'coast_x'})
    assert r.on_tile(['lake_a', 'river_b', 'coast_x', 'not_served'], {'river_b'}) == ['lake_a', 'coast_x']
    line = {'type': 'LineString', 'coordinates': [[-80.030, 33.010], [-80.015, 33.010], [-80.010, 33.010], [-80.005, 33.010]]}
    assert r.count('lake_a', line) == 3


def test_a_zone_does_not_count_the_water_that_owns_its_own_boundary():
    d, meta = _registry()
    r = B.Rivals(d, meta, {'lake_a', 'river_b', 'coast_x'})
    r.on_tile(['coast_x'], set())
    inside_lake = {'type': 'LineString', 'coordinates': [[-80.015, 33.005], [-80.005, 33.005]]}
    open_zone = {'type': 'LineString', 'coordinates': [[-80.045, 32.995], [-80.040, 32.995]]}
    assert r.count('coast_x', inside_lake) == 0
    assert r.count('coast_x', open_zone) == 2


def test_a_rival_takes_only_what_it_draws_whole():
    # a contour inside the lake and its collar: the lake's pack carries all of it, so the river may give it up;
    # one running 2 km up the river: the lake carries it only to its collar, so the river keeps its copy
    d, meta = _registry()
    r = B.Rivals(d, meta, {'lake_a', 'river_b'})
    r.on_tile(['lake_a'], {'river_b'})
    short = {'type': 'LineString', 'coordinates': [[-80.021, 33.010], [-80.015, 33.010], [-80.010, 33.010]]}
    long_ = {'type': 'LineString', 'coordinates': [[-80.040, 33.010], [-80.030, 33.010], [-80.010, 33.010]]}
    assert r.whole('lake_a', short)
    assert not r.whole('lake_a', long_)


def test_a_rival_is_counted_on_the_grid_a_built_water_would_be():
    # the same cells as the mask main() builds for the same water, core for core
    d, meta = _registry()
    r = B.Rivals(d, meta, {'lake_a'}, buffer_deg=250 / 111320.0)
    full = LakeMask(B.load_boundary(d, 'lake_a'), 250 / 111320.0)
    assert r.water('lake_a').core == full.core


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn(); print('ok  ' + name)
