#!/usr/bin/env python3
"""
test_river_centrelines.py -- the sign conventions in build_river_centrelines.py, pinned.

Personal use only, not for distribution or resale; not for navigation.

WHY THESE AND NOT OTHERS. Everything this script computes is either arithmetic that cannot
silently be wrong (a length, a count) or a SIGN, and a sign that is inverted produces a result that
looks entirely reasonable and is exactly backwards -- every scour hole reported on the inside of
its bend and every point bar on the outside. Nothing downstream would complain. So the sign
convention is what is tested here, from both ends: the geometry directly, and the physics it has
to reproduce.

It also finds its own subject, rather than assuming a layout. test_feature_type_corrections.py was
committed after being run in only one of its two delivery directories and its ROOT assumption broke
in the other. This one looks for build_river_centrelines.py beside itself and then walks up, so it
passes from scripts/ and from Scripts/ alike.
"""
import importlib.util
import math
import os
import struct
import sys
import unittest


def _load():
    here = os.path.dirname(os.path.abspath(__file__))
    d = here
    for _ in range(4):
        p = os.path.join(d, 'build_river_centrelines.py')
        if os.path.exists(p):
            spec = importlib.util.spec_from_file_location('brc', p)
            m = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(m)
            return m
        d = os.path.dirname(d)
    raise SystemExit('build_river_centrelines.py not found beside %s or above it' % here)


B = _load()


class Projection(unittest.TestCase):
    def test_round_trip_is_exact_enough_to_store(self):
        for lon, lat in ((-80.9, 33.9), (-82.5, 34.9), (-79.6, 33.3), (-84.3, 35.6)):
            x, y = B.to_albers(lon, lat)
            back = B.to_lonlat(x, y)
            self.assertLess(abs(back[0] - lon), 1e-9)
            self.assertLess(abs(back[1] - lat), 1e-9)

    def test_origin_is_the_origin(self):
        x, y = B.to_albers(-96.0, 23.0)
        self.assertLess(abs(x), 1e-6)
        self.assertLess(abs(y), 1e-6)


class Offset(unittest.TestCase):
    """Positive is the LEFT bank looking downstream. Flowing north, left is west."""

    def setUp(self):
        self.pts = [(0.0, 0.0), (0.0, 100.0), (0.0, 200.0)]

    def test_west_of_a_northbound_river_is_left(self):
        self.assertAlmostEqual(B.signed_offset(self.pts, 1, -10.0, 100.0), 10.0, places=6)

    def test_east_of_a_northbound_river_is_right(self):
        self.assertAlmostEqual(B.signed_offset(self.pts, 1, 10.0, 100.0), -10.0, places=6)

    def test_on_the_line_is_zero(self):
        self.assertAlmostEqual(B.signed_offset(self.pts, 1, 0.0, 100.0), 0.0, places=6)


class Bearing(unittest.TestCase):
    def test_compass_not_maths(self):
        self.assertAlmostEqual(B.bearings([(0, 0), (0, 100), (0, 200)])[1], 0.0, places=3)     # north
        self.assertAlmostEqual(B.bearings([(0, 0), (100, 0), (200, 0)])[1], 90.0, places=3)    # east
        self.assertAlmostEqual(B.bearings([(0, 0), (0, -100), (0, -200)])[1], 180.0, places=3)  # south
        self.assertAlmostEqual(B.bearings([(0, 0), (-100, 0), (-200, 0)])[1], 270.0, places=3)  # west


class Curvature(unittest.TestCase):
    def _arc(self, radius, sweep_deg, n, left=True):
        pts = []
        for k in range(n):
            a = math.radians(sweep_deg) * k / (n - 1)
            # left=True heads east and curves north: east -> north is counterclockwise, a LEFT
            # turn. Getting this backwards is how the first draft of these two tests "failed" a
            # correct sign convention, so it is spelled out rather than remembered.
            if left:
                pts.append((radius * math.sin(a), radius * (1 - math.cos(a))))
            else:
                pts.append((-radius * math.sin(a), radius * (1 - math.cos(a))))
        return pts

    def test_a_left_turn_is_positive_and_the_radius_comes_back(self):
        step = 10.0
        pts = B.resample(self._arc(500.0, 90, 4000, left=True), step)
        turn, rad = B.curvature(pts, step, 200.0)
        mid = len(pts) // 2
        self.assertGreater(turn[mid], 0)
        self.assertLess(abs(rad[mid] - 500.0), 25.0)

    def test_a_right_turn_is_negative(self):
        step = 10.0
        pts = B.resample(self._arc(500.0, 90, 4000, left=False), step)
        turn, rad = B.curvature(pts, step, 200.0)
        mid = len(pts) // 2
        self.assertLess(turn[mid], 0)
        self.assertLess(abs(rad[mid] - 500.0), 25.0)

    def test_a_straight_reach_has_no_radius(self):
        pts = [(0.0, float(i) * 10.0) for i in range(200)]
        turn, rad = B.curvature(pts, 10.0, 200.0)
        self.assertIsNone(rad[len(pts) // 2])


class BendSide(unittest.TestCase):
    """The rule the builder applies, stated once here so an inversion cannot pass unnoticed.

    A scour hole is on the OUTSIDE of a bend and a point bar is on the INSIDE -- that is the
    physics the builder reproduced at 65% and 65% across 22,939 real features, and it is only
    evidence if the convention is fixed independently, which is what this pins.
    """

    @staticmethod
    def side(off, turn):
        return 'outside' if (off > 0) != (turn > 0) else 'inside'

    def test_left_turn_puts_the_outside_on_the_right(self):
        self.assertEqual(self.side(-5.0, +0.2), 'outside')   # right bank, turning left
        self.assertEqual(self.side(+5.0, +0.2), 'inside')    # left bank, turning left

    def test_right_turn_puts_the_outside_on_the_left(self):
        self.assertEqual(self.side(+5.0, -0.2), 'outside')
        self.assertEqual(self.side(-5.0, -0.2), 'inside')


class Chaining(unittest.TestCase):
    def test_longest_chain_wins_and_keeps_flow_order(self):
        a = [(0.0, 0.0), (0.0, 100.0)]
        b = [(0.0, 100.0), (0.0, 400.0)]
        stub = [(900.0, 900.0), (900.0, 950.0)]
        chain, length = B.chain_mainstem([b, stub, a])
        self.assertEqual(chain[0], (0.0, 0.0))
        self.assertEqual(chain[-1], (0.0, 400.0))
        self.assertAlmostEqual(length, 400.0, places=6)

    def test_a_single_reach_still_chains(self):
        chain, length = B.chain_mainstem([[(0.0, 0.0), (0.0, 50.0)]])
        self.assertEqual(len(chain), 2)
        self.assertAlmostEqual(length, 50.0, places=6)


class Resample(unittest.TestCase):
    def test_stations_land_on_the_step(self):
        pts = B.resample([(0.0, 0.0), (0.0, 1000.0)], 50.0)
        self.assertEqual(len(pts), 21)
        self.assertAlmostEqual(pts[7][1], 350.0, places=6)


class MaskAndWidth(unittest.TestCase):
    def setUp(self):
        self.ring = [(-50.0, -1000.0), (50.0, -1000.0), (50.0, 1000.0), (-50.0, 1000.0)]
        self.mask = B.Mask([self.ring], 10.0)

    def test_inside_and_outside(self):
        self.assertTrue(self.mask.inside(0.0, 0.0))
        self.assertFalse(self.mask.inside(80.0, 0.0))
        self.assertFalse(self.mask.inside(0.0, 5000.0))

    def test_width_of_a_hundred_metre_channel(self):
        pts = [(0.0, float(y)) for y in range(-500, 501, 50)]
        w = B.widths(pts, self.mask, 3000.0, 5.0)
        mid = w[len(w) // 2]
        self.assertIsNotNone(mid)
        self.assertLess(abs(mid - 100.0), 11.0)     # two 5 m probes of slack

    def test_a_ray_that_never_leaves_the_water_reports_nothing(self):
        pts = [(0.0, float(y)) for y in range(-500, 501, 50)]
        self.assertIsNone(B.widths(pts, self.mask, 20.0, 5.0)[len(pts) // 2])


class GeoPackageBlob(unittest.TestCase):
    def test_parses_a_linestring_with_no_envelope(self):
        wkb = struct.pack('<BII', 1, 2, 3) + struct.pack('<6d', 1, 2, 3, 4, 5, 6)
        blob = b'GP' + bytes([0, 1]) + struct.pack('<i', 6350) + wkb
        self.assertEqual(B.gpkg_lines(blob), [[(1.0, 2.0), (3.0, 4.0), (5.0, 6.0)]])

    def test_skips_an_xy_envelope(self):
        wkb = struct.pack('<BII', 1, 2, 2) + struct.pack('<4d', 1, 2, 3, 4)
        blob = b'GP' + bytes([0, 0b0000_0011]) + struct.pack('<i', 6350) + struct.pack('<4d', 1, 3, 2, 4) + wkb
        self.assertEqual(B.gpkg_lines(blob), [[(1.0, 2.0), (3.0, 4.0)]])

    def test_a_blob_that_is_not_one_returns_nothing_rather_than_raising(self):
        self.assertEqual(B.gpkg_lines(b'not a geopackage blob'), [])
        self.assertEqual(B.gpkg_lines(None), [])


class RepresentativePoint(unittest.TestCase):
    def test_point_polygon_and_line(self):
        self.assertEqual(B.first_point({'type': 'Point', 'coordinates': [-81.0, 34.0]}), (-81.0, 34.0))
        ll = B.first_point({'type': 'LineString', 'coordinates': [[-81.0, 34.0], [-80.0, 33.0]]})
        self.assertEqual(ll, (-80.0, 33.0))


if __name__ == '__main__':
    unittest.main(verbosity=2)
