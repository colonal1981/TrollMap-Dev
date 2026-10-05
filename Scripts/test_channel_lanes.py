#!/usr/bin/env python3
"""A channel lane follows the deep water from his launch, and is a lane like any other.

Ryan, 2026-10-05, of Bates Old River: *"if you look at this folder you can see how i troll that
lake"* -- out the top arm and down the east side, the channel, not one depth -- and of the lanes
drawn down it, *"please"*. channel_lanes.py draws them; fit_trolling_runs.fit_pack() measures them
with measure_pass(), the function every other lane goes through.

WHAT THESE TESTS HOLD.

  1. The lane keeps to the deep water. A strip of shallow water with a deep groove in it that
     crosses from one bank to the other half way along: the lane is in the groove, not down the
     middle and not along the shortest line.
  2. One cut, where the water changes, and only when both sides are a pass. The groove is deeper
     in the first half; the lane is cut where it shallows. A water too short for two 600 m passes
     is not cut at all.
  3. No launch, no lane -- said, not silent.
  4. Through fit_pack(), a channel lane comes out fitted, says it is a channel lane, and carries
     the same measurements as every other lane: envelope, shallowest, an id. A water that is not
     in CHANNEL_WATERS gets none.

Personal use only, not for distribution or resale; not for navigation.
"""
import importlib.util, json, os, subprocess, sys, tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location('ftr', HERE / 'fit_trolling_runs.py')
ftr = importlib.util.module_from_spec(spec); spec.loader.exec_module(ftr)
import channel_lanes as cl  # noqa: E402

LAT0 = 33.78
LON0 = -80.64
K = ftr.m_per_deg_lon(LAT0)


def eq(g, w, m):
    assert g == w, f'{m}: got {g!r} want {w!r}'


def ll(x, y):
    """metres east/north of the origin -> [lon, lat]"""
    return [LON0 + x / K, LAT0 + y / ftr.M_PER_DEG_LAT]


def poly(ring_m):
    r = [ll(x, y) for x, y in ring_m]
    if r[0] != r[-1]:
        r.append(r[0])
    return r


def feature(geom, ft_hi):
    return {'type': 'Feature', 'properties': {'depth_max_dm': int(round(ft_hi * 3.048)),
                                              'depth_max_ft': ft_hi},
            'geometry': geom}


def channel_water(length_m=2000.0, width_m=150.0):
    """A strip of 3 ft water with a groove in it: 15 ft along the north bank for the first half,
    then across to the south bank and 8 ft from there to the end. Tiled, as a chart is."""
    from shapely.geometry import Polygon, mapping
    half = length_m / 2.0
    north = Polygon([(0, 95), (half, 95), (half, 125), (0, 125)])
    south = Polygon([(half, 95), (half + 100, 25), (length_m, 25), (length_m, 55),
                     (half + 100, 55), (half, 125)])
    strip = Polygon([(0, 0), (length_m, 0), (length_m, width_m), (0, width_m)])
    margin = strip.difference(north.union(south))
    feats = []
    for g, ft in ((north, 15), (south, 8)):
        feats.append(feature({'type': 'Polygon', 'coordinates': [poly(list(g.exterior.coords))]}, ft))
    for part in getattr(margin, 'geoms', [margin]):
        gj = mapping(part)
        feats.append(feature({'type': 'Polygon',
                              'coordinates': [poly(list(r)) for r in gj['coordinates']]}, 3))
    return feats, strip


def raster(feats, length_m, width_m=150.0):
    pad = 200.0
    bbox = (LON0 - pad / K, LAT0 - pad / ftr.M_PER_DEG_LAT,
            LON0 + (length_m + pad) / K, LAT0 + (width_m + pad) / ftr.M_PER_DEG_LAT)
    return ftr.DepthRaster(feats, bbox, 12.0, LAT0, 1)


def pack_with(launches):
    d = tempfile.mkdtemp(prefix='chan_')
    if launches is not None:
        with open(os.path.join(d, 'launches.json'), 'w', encoding='utf-8') as fh:
            json.dump({'landings': [{'name': n, 'lon': ll(x, y)[0], 'lat': ll(x, y)[1]}
                                    for n, x, y in launches]}, fh)
    return d


class Args:
    resample_m = 25.0
    structure_min_leg_m = 600.0


def passes(length_m, launches):
    feats, _ = channel_water(length_m)
    depth = raster(feats, length_m)
    pack = pack_with(launches)
    out, why = cl.channel_passes(pack, depth, LAT0, Args, ftr._resample, ftr._seglens, ftr._xy,
                                 depth.at_raw)
    return out, why, depth


def test_change_point():
    eq(cl.change_point([14, 14, 15, 14, 8, 7, 8]), 4, 'cut where the water changes')
    eq(cl.change_point([5]), None, 'one value has nothing to split')


def test_the_lane_keeps_to_the_deep_water():
    out, why, depth = passes(2000.0, [('Dirt road', -20.0, 75.0)])
    eq(why, None, 'no note on a water with a launch')
    assert out, 'a lane is drawn'
    xy = np.concatenate([p for p, _ in out])
    under = np.asarray(depth.at_raw(ftr._resample(xy, 10.0)[0]), float) / 3.048
    in_groove = float(np.mean(under >= 7.5))
    # The launch is on the 3 ft bank and the far end is a corner of the strip, so a little of each
    # end is on the bank; the rest is in the groove. Down the middle would be about half.
    assert in_groove >= 0.85, f'the lane is in the groove for {in_groove:.0%} of its length'
    x = xy[:, 0] - LON0 * K
    ys = xy[x < 900.0][:, 1] - LAT0 * ftr.M_PER_DEG_LAT
    assert np.median(ys) > 90, f'in the first half it runs along the north bank (median y {np.median(ys):.0f} m)'


def test_one_cut_where_it_shallows():
    out, _, depth = passes(2000.0, [('Dirt road', -20.0, 75.0)])
    eq(len(out), 2, 'two passes')
    for piece, info in out:
        eq(info['passes'], 2, 'each knows it is one of two')
        eq(info['launch'], 'Dirt road', 'and which launch it is from')
        assert float(ftr._seglens(piece).sum()) >= 600.0, 'both sides are a pass'
    cut_x = out[0][0][-1][0] - LON0 * K
    assert 900 <= cut_x <= 1250, f'cut where the groove crosses over and shallows, at {cut_x:.0f} m'
    d1 = np.nanmedian(depth.at_raw(out[0][0])) / 3.048
    d2 = np.nanmedian(depth.at_raw(out[1][0])) / 3.048
    assert d1 > d2, f'the first pass is the deep one ({d1:.1f} ft against {d2:.1f})'


def test_too_short_for_two_passes_is_one():
    out, _, _ = passes(1000.0, [('Dirt road', -20.0, 75.0)])
    eq(len(out), 1, 'one pass')
    eq(out[0][1]['passes'], 1, 'and it says so')


def test_no_launch_no_lane():
    out, why, _ = passes(2000.0, None)
    eq(out, [], 'nothing drawn')
    assert 'no launch' in why, f'and the reason is said: {why!r}'


def test_two_launches_on_one_spot_are_one_lane():
    out, _, _ = passes(2000.0, [('A', -20.0, 75.0), ('B', -18.0, 76.0)])
    eq({info['launch'] for _, info in out}, {'A'}, 'the second launch lands on the same water cell')


def _fit(slug):
    """Run the fitter itself on a synthetic pack, as Ryan's run does."""
    feats, strip = channel_water(2000.0)
    root = tempfile.mkdtemp(prefix='fit_')
    pack = os.path.join(root, slug)
    os.makedirs(pack)
    with open(os.path.join(pack, 'depth_areas.geojson'), 'w', encoding='utf-8') as fh:
        json.dump({'type': 'FeatureCollection', 'features': feats}, fh)
    # One closed contour round the strip: closed runs are kept as drawn, and it gives the raster
    # its extent the way a real water's contours do.
    ring = poly(list(strip.buffer(-5).exterior.coords))
    with open(os.path.join(pack, 'trolling_runs.geojson'), 'w', encoding='utf-8') as fh:
        json.dump({'type': 'FeatureCollection', 'features': [{
            'type': 'Feature', 'properties': {'depth_dm': 9, 'depth_ft': 3.0, 'depth_m': 0.91,
                                              'closed': True, 'length_m': 4280.0},
            'geometry': {'type': 'LineString', 'coordinates': ring}}]}, fh)
    with open(os.path.join(pack, 'launches.json'), 'w', encoding='utf-8') as fh:
        json.dump({'landings': [{'name': 'Dirt road', 'lon': ll(-20, 75)[0], 'lat': ll(-20, 75)[1]}]}, fh)
    r = subprocess.run([sys.executable, str(HERE / 'fit_trolling_runs.py'), '--packs', root,
                        '--only', slug, '--backup-dir', os.path.join(root, '_bak')],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    with open(os.path.join(pack, 'trolling_runs.geojson'), encoding='utf-8') as fh:
        return json.load(fh)['features'], r.stdout


def test_through_the_fitter_a_channel_lane_is_a_lane():
    slug = next(iter(cl.CHANNEL_WATERS))
    fs, log = _fit(slug)
    ch = [f for f in fs if f['properties'].get('seed_kind') == 'channel']
    eq(len(ch), 2, 'both passes are written')
    assert 'channel lanes: 2' in log, 'and the run says so:\n' + log
    for f in ch:
        p = f['properties']
        eq(p['fitted'], True, 'fitted, so the planners take it')
        eq(p['closed'], False, 'a pass, not a ring')
        eq(p['channel_from'], 'Dirt road', 'it says which launch it is from')
        assert p['id'].startswith(slug + '#'), 'it has an id like every other lane'
        assert p.get('envelope_ft'), 'measure_pass gave it an envelope'
        assert p['shallowest_ft'] <= p['depth_ft'], 'shallowest is the shallowest'
        assert p['length_m'] >= 600.0, 'and it is a pass'
    ring = [f for f in fs if f['properties'].get('closed')]
    eq(len(ring), 1, 'the contour it was given is still there')
    eq(ring[0]['properties']['fitted'], False, 'and left as drawn')
    lens = [f['properties']['length_m'] for f in fs]
    eq(lens, sorted(lens, reverse=True), 'sorted longest first, as the ids assume')


def test_a_water_he_has_not_named_gets_none():
    fs, log = _fit('some_other_lake')
    eq([f for f in fs if f['properties'].get('seed_kind') == 'channel'], [], 'no channel lanes')
    assert 'channel lanes' not in log, 'and nothing said about them'


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
