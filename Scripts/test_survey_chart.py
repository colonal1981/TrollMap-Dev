#!/usr/bin/env python3
"""His own sounder's chart is built on its own lattice, tiles the water, and wins where he has been.

Ryan, 2026-10-05: *"lets see if you can make contours on bates using my the data from my fish
finder"*, then *"i think those contours will work... better than nothing at all"*, then *"please"*
to making them Bates' chart. survey_chart.py builds it; build_all_chartpacks.py lays it into the
pack with apply().

WHAT THESE TESTS HOLD.

  1. Nothing is drawn where he has not been, and nothing outside the water. Coverage is his
     sounded cells cut to the boundary.
  2. The bands TILE: one band per point, every whole foot, in the fields the app and the fitter
     already read -- so a depth read off them is the depth he recorded, not the shallowest of two
     overlapping bands.
  3. A contour at k ft sits where the water is k ft.
  4. Inside his coverage his chart is the chart: a Garmin feature mostly inside it goes, one
     outside it stays. A layer the run did not read is not touched.
  5. Where he sounded it, it is not "not sounded". Garmin's unsurveyed polygons are CUT by his
     coverage -- on Bates the day this went live, 24.7 of 37.6 hatched acres sat on his water --
     and the part past his coverage is kept.

Personal use only, not for distribution or resale; not for navigation.
"""
import json, os, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import survey_chart as sc  # noqa: E402

from shapely.geometry import box, shape, Point  # noqa: E402
from shapely.ops import unary_union  # noqa: E402

A = sc.cell_deg(0)
LON0, LAT0 = -80.6400, 33.7800
NX, NY = 60, 40


def eq(g, w, m):
    assert g == w, f'{m}: got {g!r} want {w!r}'


def ft_at(lon):
    """The synthetic bottom: 1 ft at the west edge, falling evenly to 9 ft at the east."""
    return 1.0 + 8.0 * (lon - LON0) / ((NX - 1) * A)


def soundings():
    """One sounding per lattice cell, as Quickdraw writes them."""
    i0, j0 = round(LON0 / A), round(LAT0 / A)
    out = []
    for i in range(NX):
        for j in range(NY):
            lon = (i0 + i) * A + A / 2
            lat = (j0 + j) * A + A / 2
            out.append([lon, lat, ft_at(lon)])
    return out


def boundary():
    """The water: all of the sounded block but its last 10 columns, and some way past it to the
    south where he never drove."""
    i0, j0 = round(LON0 / A), round(LAT0 / A)
    return box(i0 * A, (j0 - 20) * A, (i0 + NX - 10) * A, (j0 + NY) * A)


def built():
    return sc.build(soundings(), boundary(), 0)


def test_nothing_where_he_has_not_been():
    res = built()
    b = boundary()
    s = res['stats']
    eq(s['soundings_in'], NX * NY, 'every sounding read')
    eq(s['soundings_inside'], (NX - 10) * NY, 'the ones past the boundary are not his chart of this water')
    cov = res['coverage']
    assert cov.difference(b).area < 1e-12, 'coverage stays inside the water'
    i0, j0 = round(LON0 / A), round(LAT0 / A)
    south = box(i0 * A, (j0 - 20) * A, (i0 + NX) * A, j0 * A)
    assert cov.intersection(south).area < 1e-12, 'nothing drawn where he never drove'
    for f in res['depth_areas'] + res['contours']:
        assert cov.buffer(A * 0.6).contains(shape(f['geometry'])), 'every feature sits on his coverage'


def test_the_bands_tile_the_water():
    res = built()
    gs = [shape(f['geometry']) for f in res['depth_areas']]
    total = sum(g.area for g in gs)
    union = unary_union(gs).area
    # The bands are contoured between cell CENTRES and the coverage is the cells' own squares, so
    # the outer half cell -- 1.2 m at layer 0 -- is his water with no band on it. Inside that rim
    # nothing may be missing.
    inner = res['coverage'].buffer(-A / 2, join_style=2)
    assert total / union < 1.02, f'bands overlap: {total / union:.3f} of their union'
    got = unary_union(gs).intersection(inner).area / inner.area
    assert got > 0.99, f'bands leave his water uncovered: {got:.3f}'
    ks = sorted({f['properties']['depth_min_ft'] for f in res['depth_areas']})
    eq(ks, list(range(ks[0], ks[-1] + 1)), 'every whole foot, none skipped')
    for f in res['depth_areas']:
        p = f['properties']
        k = p['depth_min_ft']
        eq(p['depth_max_ft'], k + 1, 'a band is one foot')
        eq(p['depth_max_dm'], int(round((k + 1) * 3.048)), 'in the decimetres the fitter reads')
        eq(p['band'], '%d-%d ft' % (k, k + 1), 'and the label the app shows')
        eq(p['source'], sc.SOURCE, 'and it says whose it is')
        # The bottom here is a plane, which the 3x3 mean leaves alone, so a band's inside is its
        # own depth -- half a foot of slack for where a band meets the edge of the block.
        d = ft_at(shape(f['geometry']).representative_point().x)
        assert k - 0.5 <= d <= k + 1.5, f'the {p["band"]} band sits on {d:.1f} ft water'


def test_a_contour_sits_on_its_depth():
    res = built()
    assert res['contours'], 'contours are drawn'
    for f in res['contours']:
        k = f['properties']['depth_ft']
        eq(k, float(int(k)), 'whole feet')
        for lon, lat in shape(f['geometry']).coords:
            assert abs(ft_at(lon) - k) < 0.3, f'the {k:.0f} ft line runs over {ft_at(lon):.2f} ft'


def _sq(lon, lat, n):
    return {'type': 'Polygon', 'coordinates': [[[lon, lat], [lon + n * A, lat], [lon + n * A, lat + n * A],
                                                [lon, lat + n * A], [lon, lat]]]}


def test_his_chart_wins_inside_his_coverage():
    res = built()
    survey = {'depth_areas': res['depth_areas'], 'contours': res['contours'], 'coverage': res['coverage']}
    c = res['coverage'].centroid
    i0, j0 = round(LON0 / A), round(LAT0 / A)
    out_lon, out_lat = i0 * A, (j0 - 15) * A          # south of his block, inside the water
    garmin = {
        'depth_areas': [{'type': 'Feature', 'properties': {'g': 'inside'}, 'geometry': _sq(c.x, c.y, 4)},
                        {'type': 'Feature', 'properties': {'g': 'outside'}, 'geometry': _sq(out_lon, out_lat, 4)}],
        'contours': [{'type': 'Feature', 'properties': {'g': 'line'},
                      'geometry': {'type': 'LineString', 'coordinates': [[c.x, c.y], [c.x + A, c.y]]}}],
    }
    layers = json.loads(json.dumps(garmin))
    st = sc.apply(layers, survey)
    eq(st['depth_areas'], {'his': len(res['depth_areas']), 'garmin_replaced': 1, 'garmin_kept': 1},
       'the area inside goes, the one outside stays')
    eq([f['properties'].get('g') for f in layers['depth_areas'] if 'g' in f['properties']], ['outside'],
       'and the one that stays is Garmin\'s outside')
    eq(len(layers['depth_areas']), len(res['depth_areas']) + 1, 'his bands, then what Garmin keeps')
    eq(st['contours']['garmin_replaced'], 1, 'a Garmin contour inside goes too')

    layers = json.loads(json.dumps(garmin))
    st = sc.apply(layers, survey, allowed={'depth_areas'})
    assert 'contours' not in st, 'a layer the run did not read is not touched'
    eq(layers['contours'], garmin['contours'], 'and is left exactly as it was')


def test_where_he_sounded_it_is_not_unsurveyed():
    res = built()
    cov = res['coverage']
    survey = {'depth_areas': res['depth_areas'], 'contours': res['contours'], 'coverage': cov}
    i0, j0 = round(LON0 / A), round(LAT0 / A)
    # Garmin's "no survey here": one polygon half over his block and half over the water south of
    # it he never drove, and one wholly inside his block.
    half = box(i0 * A, (j0 - 10) * A, (i0 + 20) * A, (j0 + 10) * A)
    inside = box((i0 + 25) * A, (j0 + 5) * A, (i0 + 30) * A, (j0 + 10) * A)
    feats = [{'type': 'Feature', 'properties': {'layer': 'unsurveyed', 'k': n}, 'geometry': g.__geo_interface__}
             for n, g in (('half', half), ('inside', inside))]
    feats = json.loads(json.dumps(feats))
    layers = {'unsurveyed': json.loads(json.dumps(feats))}
    st = sc.apply(layers, survey)
    u = st['unsurveyed']
    eq((u['cut'], u['gone']), (1, 1), 'the straddling one is cut, the one inside goes')
    left = unary_union([shape(f['geometry']) for f in layers['unsurveyed']])
    assert left.intersection(cov).area < 1e-14, 'nothing hatched on water he sounded'
    assert abs(left.area - half.difference(cov).area) < 1e-14, 'and all of the water past him still is'
    eq({f['properties']['k'] for f in layers['unsurveyed']}, {'half'}, 'keeping the properties it had')

    layers = {'unsurveyed': json.loads(json.dumps(feats))}
    st = sc.apply(layers, survey, allowed={'depth_areas', 'contours'})
    assert 'unsurveyed' not in st, 'a run that did not read it does not touch it'
    eq(layers['unsurveyed'], feats, 'left exactly as it was')


def test_load_says_none_when_he_has_not_recorded_it():
    d = tempfile.mkdtemp(prefix='surveys_')
    eq(sc.load(d, 'some_lake'), None, 'no survey folder, no survey')


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
