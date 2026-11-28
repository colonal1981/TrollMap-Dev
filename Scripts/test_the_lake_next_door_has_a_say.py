"""A partial cut hears from the served waters it is not building. Personal use only, not for distribution or resale;
not for navigation.

    py .\\test_the_lake_next_door_has_a_say.py
"""
import json, os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_all_chartpacks as B


def _sq(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]


def _registry():
    d = tempfile.mkdtemp(prefix='rivals_')
    os.makedirs(os.path.join(d, 'boundaries'))
    shapes = {'lake_a': _sq(-80.10, 33.00, -80.00, 33.10),          # the lake next door
              'river_b': _sq(-80.20, 33.04, -80.10, 33.06),         # the river being cut, meeting it at -80.10
              'coast_x': _sq(-80.50, 32.80, -79.80, 33.30)}         # a zone drawn over both
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
    line = {'type': 'LineString', 'coordinates': [[-80.12, 33.05], [-80.09, 33.05], [-80.06, 33.05], [-80.03, 33.05]]}
    assert r.count('lake_a', line) == 3


def test_a_zone_does_not_count_the_water_that_owns_its_own_boundary():
    d, meta = _registry()
    r = B.Rivals(d, meta, {'lake_a', 'river_b', 'coast_x'})
    r.on_tile(['coast_x'], set())
    inside_lake = {'type': 'LineString', 'coordinates': [[-80.08, 33.02], [-80.05, 33.02]]}
    out_at_sea = {'type': 'LineString', 'coordinates': [[-80.40, 32.90], [-80.35, 32.90]]}
    assert r.count('coast_x', inside_lake) == 0
    assert r.count('coast_x', out_at_sea) == 2


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn(); print('ok  ' + name)
