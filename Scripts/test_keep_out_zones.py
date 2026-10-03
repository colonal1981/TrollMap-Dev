"""test_keep_out_zones.py -- keep-out buoys, dam zones, and lanes cut at them.

Personal use only, not for distribution or resale; not for navigation.

    py Scripts\\test_keep_out_zones.py
"""
import json, math, os, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np                     # noqa: E402
import build_keep_out_zones as Z       # noqa: E402
import refile_navaids as N             # noqa: E402
import close_keep_out_in_graph as G    # noqa: E402
import fit_trolling_runs as F          # noqa: E402

LAT = 33.24
KX = 111320.0 * math.cos(math.radians(LAT))
def ll(x, y):            # metres east/north of (-80, LAT) -> lon, lat
    return [-80.0 + x / KX, LAT + y / 110540.0]


def buoy(x, y, t, name):
    return {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': ll(x, y)},
            'properties': {'poi_type': t, 'class': name, 'name': name, 'navaid': True}}


def pack_with(tmp, pois, dam_xy=None):
    """A lake 4 km x 4 km; the dam is its south shore, y = 0."""
    os.makedirs(tmp, exist_ok=True)
    sq = [ll(-2000, 0), ll(2000, 0), ll(2000, 4000), ll(-2000, 4000), ll(-2000, 0)]
    json.dump({'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'properties': {'depth_min_ft': 40, 'depth_max_ft': 60},
         'geometry': {'type': 'Polygon', 'coordinates': [sq]}}]}, open(os.path.join(tmp, 'depth_areas.geojson'), 'w'))
    json.dump({'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'properties': {}, 'geometry': {'type': 'LineString', 'coordinates': sq}}]},
        open(os.path.join(tmp, 'garmin_shoreline.geojson'), 'w'))
    json.dump({'type': 'FeatureCollection', 'features': pois}, open(os.path.join(tmp, 'pois.geojson'), 'w'))
    dams = {}
    if dam_xy:
        lon, lat = ll(*dam_xy)
        dams = {'test_lake': [{'lat': lat, 'lon': lon, 'dam': 'Test Dam', 'nid_id': 'SC00000'}]}
    return dams


def test_the_chart_spellings_of_keep_out_are_restricted():
    feats = [buoy(0, 0, 'nav_buoy', n) for n in (
        'No Boat Buoy, Spar/Spindle Buoy', 'Keep Out', 'Boats Keep Out Buoy', 'No Wake, Spar/Spindle Buoy',
        'Spar/Spindle Buoy')]
    changed = N.refile(feats)
    assert [f['properties']['poi_type'] for f in feats] == [
        'restricted_area', 'restricted_area', 'restricted_area', 'slow_no_wake', 'nav_buoy']
    assert sum(changed.values()) == 4
    assert not N.refile(feats)                       # twice changes nothing


def test_only_navaids_are_touched():
    f = {'type': 'Feature', 'geometry': None, 'properties': {'poi_type': 'place_name', 'name': 'Keep Out Cove'}}
    assert not N.refile([f]) and f['properties']['poi_type'] == 'place_name'


def test_unnamed_buoys_at_a_dam_mark_its_zone_and_a_harbour_does_not():
    # Pinopolis's shape: six buoys 80-240 m off the dam, a no-wake harbour 970 m away
    pois = [buoy(x, y, t, n) for x, y, t, n in (
        (-150, 80, 'slow_no_wake', 'No Wake'), (0, 100, 'slow_no_wake', 'No Wake'), (150, 120, 'slow_no_wake', 'No Wake'),
        (-200, 200, 'nav_buoy', 'Spar/Spindle Buoy'), (0, 230, 'nav_buoy', 'Spar/Spindle Buoy'),
        (200, 240, 'nav_buoy', 'Spar/Spindle Buoy'),
        (900, 970, 'slow_no_wake', 'No Wake'), (950, 1000, 'slow_no_wake', 'No Wake'),
        (300, 300, 'fish_attractor_buoy', 'Fish Attractor'))]
    with tempfile.TemporaryDirectory() as tmp:
        dams = pack_with(tmp, pois, dam_xy=(0, 0))
        feats, st = Z.build(tmp, 'test_lake', dams)
    assert len(feats) == 1, feats
    p = feats[0]['properties']
    assert p['kind'] == 'dam' and p['buoys'] == 6 and p['dam'] == 'Test Dam'
    from shapely.geometry import shape, Point
    zone = shape(feats[0]['geometry'])
    assert zone.contains(Point(ll(0, 60)))           # between the buoys and the dam
    assert not zone.contains(Point(ll(0, 400)))      # out on the lake side
    assert not zone.contains(Point(ll(920, 985)))    # the harbour


def test_a_named_line_is_a_zone_at_any_distance_from_a_dam():
    pois = [buoy(-1500, 3000 + 60 * k, 'restricted_area', 'No Boats') for k in range(4)]
    with tempfile.TemporaryDirectory() as tmp:
        dams = pack_with(tmp, pois, dam_xy=(0, 0))
        feats, _ = Z.build(tmp, 'test_lake', dams)
    assert len(feats) == 1 and feats[0]['properties']['kind'] == 'keep_out'
    from shapely.geometry import shape, Point
    assert shape(feats[0]['geometry']).contains(Point(ll(-1800, 3100)))   # between the line and the bank


def test_a_lone_buoy_far_from_everything_is_no_zone():
    with tempfile.TemporaryDirectory() as tmp:
        dams = pack_with(tmp, [buoy(0, 2000, 'nav_buoy', 'Spar/Spindle Buoy')], dam_xy=(0, 0))
        feats, _ = Z.build(tmp, 'test_lake', dams)
    assert feats == []


def test_a_lane_is_cut_where_it_enters_a_zone_and_kept_outside():
    with tempfile.TemporaryDirectory() as tmp:
        sq = [ll(-300, 0), ll(300, 0), ll(300, 250), ll(-300, 250), ll(-300, 0)]
        json.dump({'type': 'FeatureCollection', 'features': [
            {'type': 'Feature', 'properties': {'kind': 'dam'}, 'geometry': {'type': 'Polygon', 'coordinates': [sq]}}]},
            open(os.path.join(tmp, 'keep_out.geojson'), 'w'))
        k = F.KeepOut(tmp, LAT)
        assert k.n == 1
        lane = F._xy([ll(-1500, 100), ll(1500, 100)], LAT)        # straight through the zone
        bits = k.outside(lane)
        assert len(bits) == 2
        lens = sorted(float(np.hypot(*np.diff(b, axis=0).T).sum()) for b in bits)
        assert abs(lens[0] - 1200) < 5 and abs(lens[1] - 1200) < 5
        assert k.outside(F._xy([ll(-1500, 600), ll(1500, 600)], LAT)) is None   # near is fine
        assert k.outside(F._xy([ll(-100, 100), ll(100, 100)], LAT)) == []        # all inside


def test_no_layer_changes_nothing():
    with tempfile.TemporaryDirectory() as tmp:
        k = F.KeepOut(tmp, LAT)
        assert k.n == 0 and k.outside(F._xy([ll(0, 0), ll(100, 0)], LAT)) is None


def test_the_graph_is_closed_at_a_zone_and_no_node_moves():
    from shapely.geometry import Polygon
    # a 5 x 5 grid 100 m apart; the zone is the square around the middle node
    nodes = [tuple(ll(100 * i, 100 * j)) for j in range(5) for i in range(5)]
    idx = lambda i, j: j * 5 + i
    edges = [(idx(i, j), idx(i + 1, j)) for j in range(5) for i in range(4)] + \
            [(idx(i, j), idx(i, j + 1)) for j in range(4) for i in range(5)]
    g = {'ver': 2, 'layer': 0, 'base': 0, 'nodes': nodes, 'edges': edges, 'depths': bytes([40] * 25), 'tail': b''}
    zone = Polygon([ll(150, 150), ll(250, 150), ll(250, 250), ll(150, 250)])
    kept, n_in, removed = G.close(g, [zone])
    assert n_in == 1 and removed == 4
    assert all(idx(2, 2) not in e for e in kept)
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'water_graph.bin')
        g['edges'] = kept
        G.write(path, g)
        back = G.read(path)
        assert len(back['nodes']) == 25 and len(back['edges']) == len(kept) and back['depths'] == bytes([40] * 25)
        again, _, removed2 = G.close(back, [zone])
        assert removed2 == 0


if __name__ == '__main__':
    n = 0
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            n += 1
            print('ok', name)
    print('%d passed' % n)
