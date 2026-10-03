"""test_overlap_join_and_shore_cut.py - contour pieces that overlap are one line, and no pass
goes through what the chart draws as shore.

Personal use only, not for distribution or resale; not for navigation.

    py Scripts\\test_overlap_join_and_shore_cut.py

2026-10-03, Lake Moultrie. Every contour along the levee Ryan trolls was held as two pieces that
run past each other for about 10 m at lon -79.99689, and stitch() joins only on a shared vertex,
so none of them was one line. And lane #4281 (L7/L8 of his Oct 3 plan) ran through the concrete
wall at 33.24512, -79.99241: the chart draws it as a shoreline line with deep water both sides.
"""
import math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import build_trolling_runs as B
import fit_trolling_runs as F

LAT = 33.24
D = 1 / (111320.0 * math.cos(math.radians(LAT)))      # degrees of longitude in one metre


def test_two_pieces_that_overlap_at_their_ends_are_one_line():
    a = [[-0.001, LAT], [9 * D, LAT]]                   # runs 9 m past the cut
    b = [[0.0, LAT], [0.001, LAT]]                       # starts at the cut
    r = B.join_overlaps([a, b])
    assert len(r) == 1 and r[0][0] == [-0.001, LAT] and r[0][-1] == [0.001, LAT]


def test_the_join_does_not_care_which_way_either_piece_was_drawn():
    a = [[9 * D, LAT], [-0.001, LAT]]
    b = [[0.001, LAT], [0.0, LAT]]
    r = B.join_overlaps([a, b])
    assert len(r) == 1 and B.length_m(r[0]) > 180


def test_a_line_that_crosses_another_is_not_joined_to_it():
    b = [[0.0, LAT], [0.001, LAT]]
    c = [[0.0005, LAT - 0.0005], [0.0005, LAT + 0.0005]]
    assert len(B.join_overlaps([b, c])) == 2


def test_a_line_that_ends_on_another_part_way_along_is_not_joined():
    b = [[0.0, LAT], [0.001, LAT]]
    t = [[0.0005, LAT - 0.0005], [0.0005, LAT]]
    assert len(B.join_overlaps([b, t])) == 2


def test_two_pieces_with_a_gap_between_them_are_left_apart():
    b = [[0.0, LAT], [0.001, LAT]]
    e = [[0.0012, LAT], [0.002, LAT]]
    assert len(B.join_overlaps([b, e])) == 2


def test_a_piece_nothing_joins_keeps_its_direction():
    b = [[0.0, LAT], [0.001, LAT], [0.002, LAT + 0.0003]]
    assert B.join_overlaps([b]) == [b]


def test_pieces_that_would_close_into_a_ring_are_left_open():
    # A square loop in two pieces that overlap at BOTH seams: joining across one seam would leave
    # the run's ends 1 m apart, which build_one() calls closed -- and the fitter skips closed runs.
    s = 200 * D
    a = [[0.0, LAT], [s, LAT], [s, LAT + 0.0018], [0.5 * s, LAT + 0.0018]]
    b = [[0.5 * s + 9 * D, LAT + 0.0018], [0.0, LAT + 0.0018], [0.0, LAT], [1 * D, LAT]]
    r = B.join_overlaps([a, b])
    # Joined across the 9 m seam its ends would be 1 m apart, so that join is refused; across the
    # 1 m seam its ends stay 9 m apart, an open run the fitter will take.
    assert all(B.metres(x[0], x[-1]) >= 2.0 for x in r)


def test_the_build_joins_after_it_stitches():
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build_trolling_runs.py'),
               encoding='utf-8').read()
    assert 'for run in join_overlaps(stitch(by[dm])):' in src


class _Shore(F.ChartedShore):
    def __init__(self, lines_xy):                       # no pack: lines straight in the metre frame
        from shapely.geometry import LineString
        from shapely.strtree import STRtree
        self.lines = [LineString(l) for l in lines_xy]
        self.tree = STRtree(self.lines)


def test_a_pass_that_meets_a_wall_ends_at_it():
    wall = _Shore([[(500.0, -50.0), (500.0, 50.0)]])
    piece = np.array([[0.0, 0.0], [1000.0, 0.0]])
    bits = wall.cut(piece)
    assert len(bits) == 2
    assert [round(float(F._seglens(b).sum())) for b in bits] == [500, 500]


def test_a_pass_through_the_tip_of_a_wall_is_cut_there_too():
    # #4281 crossed the wall exactly where the wall's line starts.
    wall = _Shore([[(500.0, 0.0), (520.0, -80.0)]])
    bits = wall.cut(np.array([[0.0, 0.0], [1000.0, 0.0]]))
    assert len(bits) == 2


def test_a_pass_clear_of_the_shore_is_untouched():
    wall = _Shore([[(500.0, 10.0), (500.0, 50.0)]])
    piece = np.array([[0.0, 0.0], [1000.0, 0.0]])
    bits = wall.cut(piece)
    assert len(bits) == 1 and bits[0] is piece


def test_no_shore_layer_cuts_nothing(tmp=None):
    s = F.ChartedShore('/nonexistent/pack', LAT)
    piece = np.array([[0.0, 0.0], [1000.0, 0.0]])
    assert s.tree is None and s.cut(piece)[0] is piece


def test_only_shore_joined_to_the_rest_of_the_shore_is_a_barrier(tmp_dir=None):
    import json, tempfile
    d = tempfile.mkdtemp()
    k = 1 / F.m_per_deg_lon(LAT); m = 1 / F.M_PER_DEG_LAT
    def line(pts): return [[x * k, LAT + y * m] for x, y in pts]
    feats = [
        # the dam, and a wall joined to it
        {'type': 'Feature', 'properties': {}, 'geometry': {'type': 'LineString',
         'coordinates': line([(400, -200), (600, -200)])}},
        {'type': 'Feature', 'properties': {}, 'geometry': {'type': 'LineString',
         'coordinates': line([(500, -200), (500, 20)])}},
        # a bridge pier standing free in the water
        {'type': 'Feature', 'properties': {}, 'geometry': {'type': 'LineString',
         'coordinates': line([(200, -5), (210, -5), (210, 5), (200, 5), (200, -5)])}},
    ]
    json.dump({'type': 'FeatureCollection', 'features': feats},
              open(d + '/garmin_shoreline.geojson', 'w'))
    s = F.ChartedShore(d, LAT)
    assert len(s.lines) == 2 and s.free_standing == 1
    # A pass along y=0 meets the pier at x=200 and the wall at x=500; only the wall cuts it.
    piece = F._xy(line([(0, 0), (1000, 0)]), LAT)
    assert len(s.cut(piece)) == 2


def test_the_fitter_cuts_fitted_passes_and_runs_kept_as_drawn():
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fit_trolling_runs.py'),
               encoding='utf-8').read()
    assert 'shore = ChartedShore(pack, lat0)' in src
    # closed/short, and thin; each piece says whether the shore or a keep-out zone cut it (2026-10-03)
    assert src.count('for c2, how in unfitted_at_shore(coords, min_leg):') == 2
    assert 'bits = shore.cut(piece)' in src
    # and the keep-out zones cut the same two paths: fitted passes, and runs kept as drawn
    assert 'zones = KeepOut(pack, lat0)' in src and 'bits = zones.outside(piece)' in src
    assert 'return at_keep_out(pieces, min_leg)' in src


if __name__ == '__main__':
    n = 0
    for k, v in sorted(globals().items()):
        if k.startswith('test_') and callable(v):
            v(); n += 1
    print('%d passed' % n)
