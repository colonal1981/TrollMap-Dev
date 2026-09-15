"""test_habitat_join.py -- oyster and marsh onto a trolling run, tested without a chartpack.

The South Atlantic habitat matrix rates marsh edge and oyster at or near the top for every inshore
fish in the roster, and the leg ranker could not see either: a coastal pack's `near[]` carries
hump, pile, hazard, point, cove, obstruction and creek_mouth and nothing else. Measured on
coast_charleston_sc, 11,939 runs, not one marsh or oyster mark.

WHY A COUNT AND A PERCENTAGE RATHER THAN `near[]` ENTRIES, which is the decision these tests hold:

  Charleston has 29,687 oyster beds. Listing them per run adds about 78,000 `near` entries across
  the pack -- roughly doubling a 24 MB file and letting one creek out-score the lake, which is
  precisely what 6,915 ledges did before they were collapsed to `ledge_n`.

  But oyster DISCRIMINATES and ledges did not. Measured over 300 runs: 46% carry some oyster
  within 100 m, median 0, p90 17. A count that is zero on half the water is worth scoring; one
  that is 36-55 on every leg is not.

  Marsh is a shoreline TYPE -- 531 lines carrying 130,168 vertices along the whole front -- so
  counting vertices measures the survey. What discriminates is how much of the RUN lies alongside
  grass: 28% touch none, the median run is 93% alongside, 143 of 300 are entirely alongside.

    python3 test_habitat_join.py
"""
import ast, json, math, os, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, 'build_trolling_runs.py'), encoding='utf-8').read()

_WANT = ['metres', '_poly_points', '_line_points', '_any_centroid',
         'load_habitat', 'habitat_stats']
_fns = [n for n in ast.parse(SRC).body if getattr(n, 'name', None) in _WANT]
assert len(_fns) == len(_WANT), \
    f'missing from build_trolling_runs.py: {set(_WANT) - {n.name for n in _fns}}'
_ns = {'os': os, 'json': json, 'math': math,
       '__file__': os.path.join(HERE, 'build_trolling_runs.py')}
exec(compile(ast.Module(body=_fns, type_ignores=[]), '<lifted>', 'exec'), _ns)
poly_points = _ns['_poly_points']
line_points = _ns['_line_points']
habitat_stats = _ns['habitat_stats']
metres = _ns['metres']
any_centroid = _ns['_any_centroid']

ANN = 100.0
CELL = max(ANN, 50.0) / 111320.0 * 1.5


def grid(points):
    g = {}
    for q in points:
        g.setdefault((int(q[0] / CELL), int(q[1] / CELL)), []).append(q)
    return g


def east(lon, lat, m):
    """A point `m` metres east of (lon, lat)."""
    return (lon + m / (111320.0 * math.cos(math.radians(lat))), lat)


class Shapes(unittest.TestCase):
    def test_a_polygon_gives_one_point(self):
        # An oyster bed is metres across and a run is hundreds of metres long, so its centroid and
        # its edge are the same answer here -- and walking every vertex of 29,687 beds to learn
        # that is work for nothing.
        p = poly_points({'type': 'Polygon',
                         'coordinates': [[[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]]]})
        self.assertEqual(len(p), 1)
        self.assertAlmostEqual(p[0][0], 0.8, places=6)

    def test_a_multipolygon_gives_one_point_per_part(self):
        # 41 of Charleston's beds are MultiPolygons. Taking only the first part would lose the rest
        # of a bed that the survey split around a channel.
        ring = [[0, 0], [0, 2], [2, 2], [0, 0]]
        p = poly_points({'type': 'MultiPolygon', 'coordinates': [[ring], [ring], [ring]]})
        self.assertEqual(len(p), 3)

    def test_holes_are_not_counted_as_beds(self):
        # A ring after the first is a HOLE -- water inside the bed. Its centroid is not oyster.
        outer = [[0, 0], [0, 4], [4, 4], [4, 0], [0, 0]]
        hole = [[1, 1], [1, 2], [2, 2], [1, 1]]
        self.assertEqual(len(poly_points({'type': 'Polygon', 'coordinates': [outer, hole]})), 1)

    def test_a_line_gives_every_vertex(self):
        # Marsh coverage is measured ALONG the run, so the shoreline's shape is what is sampled.
        self.assertEqual(len(line_points({'type': 'LineString',
                                          'coordinates': [[0, 0], [0, 1], [0, 2]]})), 3)
        self.assertEqual(len(line_points({'type': 'MultiLineString',
                                          'coordinates': [[[0, 0], [0, 1]], [[1, 1], [1, 2]]]})), 4)

    def test_rubbish_geometry_is_skipped_not_crashed(self):
        for g in (None, {}, {'type': 'Polygon', 'coordinates': []},
                  {'type': 'Polygon', 'coordinates': [[]]},
                  {'type': 'GeometryCollection', 'coordinates': []}):
            self.assertEqual(poly_points(g), [])
            self.assertEqual(line_points(g), [])


class Stats(unittest.TestCase):
    # VERTICES 470 m APART, deliberately wider than the 100 m radius twice over.
    #
    # The first draft spaced them 0.001 degrees -- about 94 m at this latitude -- and the
    # half-alongside test read 75%, because a marsh point beside vertex 1 is 94 m from vertex 2
    # and 94 m is inside the radius. The code was right and the fixture was too tight to say what
    # it meant. That bleed is real and intended at the working radius: "alongside" has a tolerance,
    # and on rdp-simplified runs it is a vertex or so of softness. A test about halves must not
    # sit inside it.
    RUN = [(-79.900, 32.80), (-79.895, 32.80), (-79.890, 32.80), (-79.885, 32.80)]

    def test_A_FRESHWATER_PACK_ADDS_NO_PROPERTY_AT_ALL(self):
        # `oyster_n: 0` and "nobody ran the extractor on this water" are different sentences, and
        # only one of them is about the water. Every freshwater pack lands here.
        self.assertEqual(habitat_stats(self.RUN, {}, CELL, ANN), {})
        self.assertEqual(habitat_stats(self.RUN, None, CELL, ANN), {})

    def test_a_zone_with_oyster_and_no_marsh_reports_only_oyster(self):
        st = habitat_stats(self.RUN, {'oyster': grid([east(*self.RUN[0], 20)])}, CELL, ANN)
        self.assertEqual(st, {'oyster_n': 1})

    def test_a_bed_is_counted_ONCE_however_many_vertices_pass_it(self):
        # A bed sitting between two vertices, inside the radius of both. Counting per vertex would
        # turn one rake into two and make a densely-sampled run look richer than a sparse one --
        # which is the bug that would quietly favour whichever runs the rdp pass happened to keep
        # more points on.
        mid = ((self.RUN[0][0] + self.RUN[1][0]) / 2, self.RUN[0][1])
        bed = east(*mid, 5)
        # Prove the setup: it really is within reach of both.
        self.assertLess(metres(bed, self.RUN[0]), ANN * 3)
        st = habitat_stats([self.RUN[0], mid, self.RUN[1]], {'oyster': grid([bed])}, CELL, ANN)
        self.assertEqual(st['oyster_n'], 1)

    def test_a_bed_outside_the_radius_is_not_counted(self):
        # OFF THE LINE, not along it. The first draft put this 400 m EAST of the first vertex and
        # landed 68 m from the second, because the run runs east. A bed "far from the start" is
        # not the same as a bed far from the run, and the run is what it has to be far from.
        far = (self.RUN[0][0], self.RUN[0][1] + 300 / 111132.0)
        for v in self.RUN:
            self.assertGreater(metres(far, v), ANN)
        self.assertEqual(habitat_stats(self.RUN, {'oyster': grid([far])}, CELL, ANN)['oyster_n'], 0)

    def test_marsh_is_a_PERCENTAGE_of_the_run_and_never_a_count(self):
        # 130,168 marsh vertices in one zone; a count would measure the survey, not the water.
        allside = [east(v[0], v[1], 10) for v in self.RUN]
        st = habitat_stats(self.RUN, {'marsh': grid(allside)}, CELL, ANN)
        self.assertEqual(st['marsh_pct'], 100)

    def test_half_a_run_alongside_grass_reads_as_half(self):
        half = [east(self.RUN[0][0], self.RUN[0][1], 10), east(self.RUN[1][0], self.RUN[1][1], 10)]
        st = habitat_stats(self.RUN, {'marsh': grid(half)}, CELL, ANN)
        self.assertEqual(st['marsh_pct'], 50)

    def test_a_run_nowhere_near_grass_reads_zero_rather_than_absent(self):
        # The distinction that matters: the ZONE has marsh (so the key exists) and this RUN has
        # none. That is a fact about the run and is worth scoring. A zone with no marsh file at
        # all omits the key entirely -- see the freshwater test above.
        far = [east(-79.90, 33.50, 10)]
        st = habitat_stats(self.RUN, {'marsh': grid(far)}, CELL, ANN)
        self.assertEqual(st['marsh_pct'], 0)
        self.assertIn('marsh_pct', st)

    def test_both_layers_together(self):
        st = habitat_stats(self.RUN,
                           {'oyster': grid([east(*self.RUN[0], 15)]),
                            'marsh': grid([east(*v, 10) for v in self.RUN[:2]])},
                           CELL, ANN)
        self.assertEqual(st, {'oyster_n': 1, 'marsh_pct': 50})


class GwrapShapes(unittest.TestCase):
    """ONE FEATURE IS ONE MARK, whatever shape Georgia drew it in.

    G-WRAP's reef structures are polygons and its armoured shoreline is lines -- 4,264 segments
    typed revetment, bulkhead or causeway. Sampling a line's vertices would make a 900 m revetment
    outscore a 40 m one purely by having more of them, which measures the digitising and not the
    water. The same mistake in the other direction is what made marsh a PERCENTAGE rather than a
    count, and the difference is that a marsh front is a continuous edge while a revetment is a
    thing somebody built.
    """

    def test_a_line_becomes_exactly_one_mark(self):
        short = {'type': 'LineString', 'coordinates': [[0, 0], [0, 0.001]]}
        long_ = {'type': 'LineString',
                 'coordinates': [[0, 0], [0, 0.002], [0, 0.004], [0, 0.006], [0, 0.008]]}
        self.assertEqual(len(any_centroid(short)), 1)
        self.assertEqual(len(any_centroid(long_)), 1)

    def test_the_mark_sits_on_the_line_not_at_an_end(self):
        pts = any_centroid({'type': 'LineString', 'coordinates': [[0, 0], [0, 2]]})
        self.assertAlmostEqual(pts[0][1], 1.0, places=6)

    def test_a_reef_polygon_becomes_one_mark(self):
        reef = {'type': 'Polygon', 'coordinates': [[[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]]]}
        self.assertEqual(len(any_centroid(reef)), 1)

    def test_a_multipart_reef_gives_one_mark_per_part(self):
        ring = [[0, 0], [0, 2], [2, 2], [0, 0]]
        self.assertEqual(len(any_centroid({'type': 'MultiPolygon',
                                           'coordinates': [[ring], [ring]]})), 2)

    def test_rubbish_gives_nothing_rather_than_a_mark_at_zero_zero(self):
        # A centroid of an empty list is a point in the Gulf of Guinea, and it would be scored.
        for g in (None, {}, {'type': 'LineString', 'coordinates': []},
                  {'type': 'MultiLineString', 'coordinates': [[]]}):
            self.assertEqual(any_centroid(g), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
