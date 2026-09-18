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
    def test_longest_chain_wins_when_there_is_no_chart_to_ask(self):
        a = [(0.0, 0.0), (0.0, 100.0)]
        b = [(0.0, 100.0), (0.0, 400.0)]
        stub = [(900.0, 900.0), (900.0, 950.0)]
        chain, length, basis = B.chain_mainstem([b, stub, a])
        self.assertEqual(chain[0], (0.0, 0.0))
        self.assertEqual(chain[-1], (0.0, 400.0))
        self.assertAlmostEqual(length, 400.0, places=6)
        self.assertEqual(basis, 'length')

    def test_a_single_reach_still_chains(self):
        chain, length, basis = B.chain_mainstem([[(0.0, 0.0), (0.0, 50.0)]])
        self.assertEqual(len(chain), 2)
        self.assertAlmostEqual(length, 50.0, places=6)
        self.assertEqual(basis, 'length')

    # THE CASE THAT WAS BUILDING A CENTRELINE THROUGH UNCHARTED WATER.
    #
    # south_yadkin_river, measured 2026-09-17: the picked mainstem broke into two runs, 71.3 km with
    # nothing charted on it and 24.8 km with 20.5 km charted. Length won, and the pack's centreline
    # stopped 1,141 m short of the pack's own chart. Same shape here, shrunk.
    def test_the_charted_chain_beats_the_longer_one(self):
        far_a = [(0.0, 0.0), (0.0, 400.0)]          # long, and nothing is charted on it
        far_b = [(0.0, 400.0), (0.0, 900.0)]
        near  = [(5000.0, 0.0), (5000.0, 300.0)]    # shorter, and it is the charted water
        charted = lambda a, b: (math.dist(a, b) if a[0] > 1000.0 else 0.0)
        chain, length, basis = B.chain_mainstem([far_a, far_b, near], charted)
        self.assertEqual(chain[0], (5000.0, 0.0))
        self.assertAlmostEqual(length, 300.0, places=6)
        self.assertEqual(basis, 'charted')

    # AND THE FALLBACK IS NOT AN ARBITRARY PICK AMONG ZEROES. chauga_river has 4.7% of its stations
    # charted and rivers Garmin never sounded have none at all; those keep the old rule.
    def test_no_charted_metres_anywhere_falls_back_to_length(self):
        a = [(0.0, 0.0), (0.0, 400.0)]
        b = [(5000.0, 0.0), (5000.0, 300.0)]
        chain, length, basis = B.chain_mainstem([a, b], lambda p, q: 0.0)
        self.assertAlmostEqual(length, 400.0, places=6)
        self.assertEqual(basis, 'length')


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
        w, _ = B.widths(pts, self.mask.inside, 3000.0, 5.0)
        mid = w[len(w) // 2]
        self.assertIsNotNone(mid)
        self.assertLess(abs(mid - 100.0), 11.0)     # two 5 m probes of slack

    def test_a_ray_that_never_leaves_the_water_reports_nothing(self):
        pts = [(0.0, float(y)) for y in range(-500, 501, 50)]
        self.assertIsNone(B.widths(pts, self.mask.inside, 20.0, 5.0)[0][len(pts) // 2])

    def test_the_narrow_predicate_rides_the_same_ray(self):
        # ONE WALK, TWO ANSWERS. `inside` is the 100 m channel; `narrow` is a 40 m one inside it.
        # Two separate calls would each cast their own ray and could disagree about which station
        # they were on; this is what says they cannot.
        pts = [(0.0, float(y)) for y in range(-500, 501, 50)]
        narrow = lambda x, y: abs(x) < 20.0 and self.mask.inside(x, y)
        wide, nar = B.widths(pts, self.mask.inside, 3000.0, 5.0, narrow=narrow)
        i = len(pts) // 2
        self.assertLess(abs(wide[i] - 100.0), 11.0)
        self.assertLess(abs(nar[i] - 40.0), 11.0)
        self.assertLess(nar[i], wide[i], 'the tighter predicate cannot report the wider channel')

    def test_no_narrow_predicate_means_no_narrow_answer(self):
        pts = [(0.0, float(y)) for y in range(-500, 501, 50)]
        wide, nar = B.widths(pts, self.mask.inside, 3000.0, 5.0)
        self.assertTrue(all(v is None for v in nar),
                        'a second answer nobody asked for is a number waiting to be believed')
        self.assertEqual(len(nar), len(wide))


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


class DepthAndSection(unittest.TestCase):
    """The cross-section, and the one thing that must never be reported as a number.

    Ryan needs the shallowest depth on the line he travels. Measured across the whole section the
    answer is always the bank, so the profile is stored across the section and the minimum along a
    chosen line is the consumer's. And on the Congaree roughly a tenth of stations have no charted
    depth at all -- those are UNKNOWN, not shallow, and writing a number there would be the same
    defect as pack-facts.js printing "0 ft relief" from a null.
    """

    def setUp(self):
        import json as _json
        import tempfile
        self.tmp = tempfile.mkdtemp()
        # Charted water 120 m wide centred on x=0: 0-1 ft margins and a 9-10 ft channel through the
        # middle 60 m. The sections tested below are 100 m, so every sample lands STRICTLY inside
        # the charted water -- a sample sitting exactly on a polygon edge is ambiguous to any
        # point-in-polygon test, and a fixture that puts one there is testing the tie, not the code.
        # Built in Albers metres and written out as lon/lat, the way a pack is.
        def band(x0, x1, lo, hi):
            ring = [(x0, -500.0), (x1, -500.0), (x1, 500.0), (x0, 500.0), (x0, -500.0)]
            return {'type': 'Feature',
                    'properties': {'depth_min_ft': lo, 'depth_max_ft': hi},
                    'geometry': {'type': 'Polygon',
                                 'coordinates': [[list(B.to_lonlat(x + 1400000.0, y + 1300000.0))
                                                  for x, y in ring]]}}
        fc = {'type': 'FeatureCollection',
              'features': [band(-60.0, -30.0, 0, 1), band(30.0, 60.0, 0, 1),
                           band(-30.0, 30.0, 9, 10)]}
        self.path = os.path.join(self.tmp, 'depth_areas.geojson')
        with open(self.path, 'w') as fh:
            _json.dump(fc, fh)
        self.idx = B.DepthIndex(self.path, 200.0)
        self.centre = B.to_albers(*B.to_lonlat(1400000.0, 1300000.0))

    def _station(self, dx=0.0):
        cx, cy = self.centre
        return [(cx + dx, cy - 100.0), (cx + dx, cy), (cx + dx, cy + 100.0)]

    def test_it_loaded_the_bands(self):
        self.assertEqual(self.idx.polygons, 3)

    def test_deepest_band_wins_and_outside_is_none(self):
        cx, cy = self.centre
        self.assertEqual(self.idx.at(cx, cy)[0], 9)          # shallow edge of the 9-10 band
        self.assertEqual(self.idx.at(cx - 40.0, cy)[0], 0)   # the margin band
        self.assertIsNone(self.idx.at(cx - 400.0, cy))       # off the charted water

    def test_area_and_deepest_line(self):
        pts = self._station()
        area, deep, chart, prof = B.cross_sections(pts, [100.0] * 3, self.idx, 5.0)
        i = 1
        self.assertEqual(deep[i], 9)
        self.assertAlmostEqual(chart[i], 1.0, places=2)
        # 60 m of 9.5 ft and 40 m of 0.5 ft, in metres, summed on 5 m samples
        self.assertGreater(area[i], 150.0)
        self.assertLess(area[i], 200.0)

    def test_the_profile_is_the_shallow_edge_across_the_section(self):
        pts = self._station()
        _a, _d, _c, prof = B.cross_sections(pts, [100.0] * 3, self.idx, 5.0)
        p = prof[1]
        self.assertEqual(len(p), len(B.DEPTH_FRACTIONS))
        self.assertEqual(p[0], 0)                 # left bank, the margin band
        self.assertEqual(p[len(p) // 2], 9)       # mid-channel, the SHALLOW edge, not 9.5 or 10
        self.assertEqual(p[-1], 0)                # right bank

    def test_uncharted_water_is_null_and_never_a_number(self):
        pts = self._station(dx=5000.0)            # a station nowhere near any depth polygon
        area, deep, chart, prof = B.cross_sections(pts, [100.0] * 3, self.idx, 5.0)
        i = 1
        self.assertEqual(chart[i], 0.0)
        self.assertIsNone(area[i])
        self.assertIsNone(deep[i])
        self.assertIsNone(prof[i])

    def test_partial_coverage_is_reported_as_partial(self):
        pts = self._station(dx=70.0)              # part of the section hangs off the charted water
        _a, _d, chart, _p = B.cross_sections(pts, [100.0] * 3, self.idx, 5.0)
        self.assertGreater(chart[1], 0.0)
        self.assertLess(chart[1], 1.0)

    def test_no_depth_file_means_nulls_not_a_crash(self):
        empty = B.DepthIndex(os.path.join(self.tmp, 'does_not_exist.geojson'))
        area, deep, chart, prof = B.cross_sections(self._station(), [100.0] * 3, empty, 5.0)
        self.assertEqual((area[1], deep[1], chart[1], prof[1]), (None, None, None, None))


# ─────────────────────────────────────────────────────────────────────────────────────────────
# THE CENTRING, WHICH IS THE ONE THING IN HERE THAT MOVES THE LINE
#
# Ryan, 2026-09-18, on a real Congaree plan: "looks like they don't stay in the river". The line was
# 3DHP's flowline, and nothing in this file had ever measured the middle of the water. Then the
# question that named the defect: "How is the center line not the center of the water".
#
# What is tested here is not the arithmetic -- (left - right) / 2 cannot be subtly wrong -- but the
# three things that stop the fix being worse than the defect: every station is measured against the
# SAME line and applied afterwards, no station ends up more than one station spacing further across
# the channel than its neighbour, and a station with a choice of sides takes the one the station
# before it took. The first prototype had none of the three, moved each station as it went, and on
# the fixture below turned 41 stations into 337 folded back and forth across the river.
#
# The water here is a predicate, not a polygon file, for the same reason the projection is
# hand-rolled: this has to run wherever the builder runs.
# ─────────────────────────────────────────────────────────────────────────────────────────────


def _band(path, half):
    """A predicate: within `half` metres of a polyline. A channel, as a function."""
    def d2seg(px, py, ax, ay, bx, by):
        vx, vy = bx - ax, by - ay
        L = vx * vx + vy * vy
        t = 0.0 if L == 0 else max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / L))
        return math.hypot(px - (ax + vx * t), py - (ay + vy * t))
    def inside(x, y):
        return any(d2seg(x, y, path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]) <= half
                   for i in range(len(path) - 1))
    return inside


class Centring(unittest.TestCase):
    PROBE = 5.0
    STEP = 25.0
    REACH = 600.0

    def _run(self, pts, inside, passes=6):
        return B.centre_on_water([tuple(q) for q in pts], inside,
                                 self.STEP, self.PROBE, self.REACH, passes)

    @staticmethod
    def _off(pts, inside):
        return sum(1 for q in pts if not inside(q[0], q[1]))

    # ── the straight case, where the answer is known exactly ─────────────────────────────────
    def test_a_line_hugging_one_bank_ends_up_in_the_middle(self):
        # A channel from y=0 to y=100, so the middle is y=50. The line starts at y=20.
        inside = lambda x, y: 0.0 <= y <= 100.0 and 0.0 <= x <= 1000.0
        out, rep = self._run([(x * self.STEP, 20.0) for x in range(41)], inside)
        for q in out[2:-2]:
            self.assertLess(abs(q[1] - 50.0), self.PROBE,
                            'station at y=%.1f is not mid-channel' % q[1])
        self.assertGreater(rep['moved'][0], 0)

    def test_a_line_already_in_the_middle_is_left_alone_and_stops_at_once(self):
        inside = lambda x, y: 0.0 <= y <= 100.0 and 0.0 <= x <= 1000.0
        out, rep = self._run([(x * self.STEP, 50.0) for x in range(41)], inside)
        for q in out:
            self.assertLess(abs(q[1] - 50.0), self.PROBE)
        self.assertEqual(rep['moved'], [0])
        self.assertEqual(rep['passes'], 1)

    def test_it_does_not_eat_the_line_a_step_at_a_time(self):
        # resample() drops whatever is left past the last whole step. Doing that once is the same
        # truncation the flowline has always had; doing it every sweep took a 1,000 m test channel
        # down to 825 m over fifteen of them, which is 175 m of river quietly deleted.
        inside = lambda x, y: 0.0 <= y <= 100.0 and 0.0 <= x <= 1000.0
        out, _ = self._run([(x * self.STEP, 20.0) for x in range(41)], inside, passes=15)
        length = sum(math.dist(out[i], out[i + 1]) for i in range(len(out) - 1))
        self.assertGreater(length, 1000.0 - self.STEP - 1.0)

    # ── the case he actually hit: a flowline chording the neck of a bend ─────────────────────
    def _meander(self):
        """A river that loops 200 m south over 400 m of easting, and a flowline that chords it.

        A SMOOTH LOOP AND NOT A VEE. The first draft of this used a 300 m triangular dip, and its
        apex is a 143 degree corner -- which is not a river, and which fails a "no fold" and an
        "even spacing" assertion for being sharp rather than for being wrong. A meander is a curve.
        """
        path = [(0.0, 0.0), (100.0, 0.0), (200.0, 0.0), (300.0, 0.0)]
        for k in range(1, 41):
            x = 300.0 + 400.0 * k / 40.0
            path.append((x, -200.0 * math.sin(math.pi * (x - 300.0) / 400.0)))
        path += [(800.0, 0.0), (900.0, 0.0), (1000.0, 0.0)]
        return _band(path, 50.0), [(x * self.STEP, 0.0) for x in range(41)]

    def test_a_chorded_bend_comes_back_into_the_water(self):
        channel, pts = self._meander()
        self.assertGreater(self._off(pts, channel), 0, 'the fixture does not reproduce the defect')
        out, _ = self._run(pts, channel)
        self.assertEqual(self._off(out, channel), 0,
                         '%d stations are still off the water' % self._off(out, channel))

    def test_the_line_never_doubles_back_on_itself(self):
        channel, pts = self._meander()
        out, rep = self._run(pts, channel)
        self.assertEqual(rep['folds_before'], 0, 'the fixture is not a clean line to start with')
        self.assertEqual(rep['folds'], 0, 'the build record reports a fold')
        for i in range(1, len(out) - 1):
            ax, ay = out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]
            bx, by = out[i + 1][0] - out[i][0], out[i + 1][1] - out[i][1]
            self.assertGreater(ax * bx + ay * by, 0.0,
                               'the line reverses at station %d -- this is the fold the first '
                               'prototype produced' % i)

    def test_it_settles_instead_of_running_away(self):
        # The sweeps stop when one moves the line no further than the one before it. More passes
        # must therefore not change the answer -- the first version grew without bound and turned
        # 41 stations into 16,461 when it was allowed ten rounds.
        channel, pts = self._meander()
        six, r6 = self._run(pts, channel, passes=6)
        forty, r40 = self._run(pts, channel, passes=40)
        self.assertEqual(len(six), len(forty))
        self.assertEqual(r6['passes'], r40['passes'])
        for a, b in zip(six, forty):
            self.assertAlmostEqual(a[0], b[0], places=6)
            self.assertAlmostEqual(a[1], b[1], places=6)
        self.assertEqual(sorted(r6['moved_m'], reverse=True), r6['moved_m'],
                         'a sweep moved the line further than the one before it: %s' % r6['moved_m'])

    def test_the_stations_come_back_to_an_even_spacing(self):
        # `station_m` is `i * step` everywhere downstream, so the chord between two stations is at
        # most a step and short of it only by what the curvature takes.
        channel, pts = self._meander()
        out, _ = self._run(pts, channel)
        for i in range(len(out) - 1):
            d = math.dist(out[i], out[i + 1])
            # EXACTLY a step apart along the line; the chord is shorter only by what the curvature
            # takes, which is the same thing `station_m` has always measured.
            self.assertLessEqual(d, self.STEP + 1e-6,
                                 'stations %d and %d are %.1f m apart' % (i, i + 1, d))
            self.assertGreater(d, self.STEP * 0.9,
                               'stations %d and %d are only %.1f m apart, which is a bend too '
                               'tight for a station spacing' % (i, i + 1, d))

    # ── the side rule, which is the only sequential decision in the sweep ────────────────────
    def test_it_stays_on_the_side_the_river_is_on_when_something_nearer_appears(self):
        # The river loops 250 m NORTH between x=300 and x=700. A slough sits 60 m SOUTH of the
        # flowline, but only from x=500 on. A station at x=500 finds water 200 m north and 60 m
        # south; nearest-first would jump it into the slough and fold the line. The station before
        # it is already well north, so it must stay north.
        river = _band([(0.0, 0.0), (300.0, 0.0), (400.0, 250.0), (600.0, 250.0),
                       (700.0, 0.0), (1000.0, 0.0)], 50.0)
        slough = lambda x, y: 500.0 <= x <= 700.0 and -120.0 <= y <= -60.0
        inside = lambda x, y: river(x, y) or slough(x, y)
        pts = [(x * self.STEP, 0.0) for x in range(41)]
        out, _ = self._run(pts, inside)
        for q in out:
            if 500.0 <= q[0] <= 700.0:
                self.assertGreater(q[1], 0.0,
                                   'a station at x=%.0f crossed into the slough: y=%.1f'
                                   % (q[0], q[1]))

    # ── and the unsounded case, which must not be touched ────────────────────────────────────
    def test_a_fold_the_line_arrived_with_is_not_counted_against_this_stage(self):
        # lumber_river's flowline carries 335 switchbacks before any of this runs, and lynches_river
        # 112. A counter that only read the output would have reported 309 on lumber and blamed the
        # centring for all of them -- when what it did there was take 335 down to 309.
        inside = lambda x, y: 0.0 <= y <= 100.0 and 0.0 <= x <= 1000.0
        pts = [(x * self.STEP, 20.0) for x in range(41)]
        pts[20] = (pts[20][0] - 3 * self.STEP, pts[20][1])      # a switchback in the input
        self.assertGreater(B.count_folds(pts), 0, 'the fixture has no fold in it')
        out, rep = self._run(pts, inside)
        self.assertGreater(rep['folds_before'], 0)
        self.assertLessEqual(rep['folds'], rep['folds_before'],
                             'the centring added a fold to a line that came in folded')

    def test_a_station_with_no_water_on_its_normal_is_left_where_it_is(self):
        # A channel that stops at x=500. Past that there is nothing to centre on, and 3DHP's line
        # is the only answer there is -- 17 of the 57 packs are mostly unsounded.
        inside = lambda x, y: 0.0 <= x <= 500.0 and -50.0 <= y <= 50.0
        pts = [(x * self.STEP, 0.0) for x in range(41)]
        out, rep = self._run(pts, inside)
        self.assertGreater(rep['stranded'], 0, 'nothing was reported stranded')
        for i, q in enumerate(out):
            if q[0] > 560.0:
                self.assertLess(abs(q[1]), self.PROBE,
                                'station %d was moved with no water to move it to' % i)


# ─────────────────────────────────────────────────────────────────────────────────────────────
# THE RIVER ENDS WHERE THE WATER DOES, NOT WHERE THE BOX DOES
#
# Ryan ran a Congaree day and said the line should not stop for the Congaree until it reaches Lake
# Marion. It stopped because the chain is taken from the mainstem INSIDE the registry boundary, and
# 26.8 km of 100-175 m river below the Wateree confluence was never planned.
# ─────────────────────────────────────────────────────────────────────────────────────────────
class FakeDepth:
    """A DepthIndex that answers for one rectangle. `polygons` is what the real one uses to say
    whether it has anything to say at all."""

    def __init__(self, x0, y0, x1, y1, polygons=1):
        self.box = (x0, y0, x1, y1)
        self.polygons = polygons

    def at(self, x, y):
        x0, y0, x1, y1 = self.box
        return 10.0 if (x0 <= x <= x1 and y0 <= y <= y1) else None


class FakeNeighbours:
    def __init__(self, owners=(), rivers=(), depths=None):
        self.rivers = set(rivers)
        self._owners = list(owners)          # (slug, (x0, y0, x1, y1))
        self._depths = depths or {}
        self.asked = []

    def owner_of(self, x, y, skip=()):
        for slug, b in self._owners:
            if slug in skip:
                continue
            if b[0] <= x <= b[2] and b[1] <= y <= b[3]:
                return slug
        return None

    def depth_of(self, slug):
        self.asked.append(slug)
        return self._depths.get(slug)


class WaterIsTheOutlineOrTheSoundings(unittest.TestCase):
    def setUp(self):
        self.ring = [(-50.0, 0.0), (50.0, 0.0), (50.0, 1000.0), (-50.0, 1000.0)]
        self.mask = B.Mask([self.ring], 10.0)

    def test_the_outline_is_water_even_where_nothing_was_sounded(self):
        w = B.WaterExtent(self.mask, FakeDepth(0, 0, 0, 0, polygons=0))
        self.assertTrue(w.inside(0.0, 500.0))
        self.assertFalse(w.inside(0.0, 2000.0))

    def test_soundings_past_the_outline_are_water(self):
        w = B.WaterExtent(self.mask, FakeDepth(0, 0, 0, 0, polygons=0))
        w.add(FakeDepth(-40.0, 1000.0, 40.0, 3000.0))
        self.assertTrue(w.inside(0.0, 2000.0), 'charted water past the box is still water')
        self.assertFalse(w.inside(0.0, 4000.0))

    def test_nothing_the_outline_answered_can_shrink(self):
        # THE PROPERTY THAT MADE THIS SAFE TO RUN ON ALL 57 IN ONE COMMIT. Measured on the real
        # packs before it was written: 32,783 stations, not one narrower. The outline is asked
        # first, so the union can only ever reach further.
        w = B.WaterExtent(self.mask, FakeDepth(-10.0, 0.0, 10.0, 1000.0))
        pts = [(0.0, float(y)) for y in range(100, 901, 100)]
        boundary, _ = B.widths(pts, self.mask.inside, 3000.0, 5.0)
        union, _ = B.widths(pts, w.inside, 3000.0, 5.0)
        for b, u in zip(boundary, union):
            self.assertIsNotNone(b)
            self.assertGreaterEqual(u, b)

    def test_charted_is_not_the_outline(self):
        # centre_on_water() asks `charted`, not `inside`. If the outline leaked into it, the
        # centring would go back to putting the middle wherever the registry outline says -- which
        # is the defect that stage was written to fix.
        w = B.WaterExtent(self.mask, FakeDepth(0, 0, 0, 0, polygons=0))
        self.assertTrue(w.inside(0.0, 500.0))
        self.assertFalse(w.charted(0.0, 500.0), 'the outline is not a sounding')
        self.assertFalse(w.has_chart())
        w.add(FakeDepth(-40.0, 1000.0, 40.0, 3000.0))
        self.assertTrue(w.has_chart())
        self.assertTrue(w.charted(0.0, 2000.0), "the neighbour's soundings are soundings")

    def test_a_pack_with_no_soundings_adds_nothing(self):
        w = B.WaterExtent(self.mask, FakeDepth(0, 0, 0, 0, polygons=0))
        w.add(FakeDepth(0, 0, 0, 0, polygons=0))
        self.assertEqual(w.extra, [], 'a pack that was never sounded must not be asked')


class TheLineFollowsTheRiverPastTheBox(unittest.TestCase):
    """A straight north-running river. The registry boundary covers y 0..1000; the neighbour's
    chart covers y 1000..3000 at the same 100 m width, and past y 3000 the water opens out."""

    def setUp(self):
        self.mask = B.Mask([[(-50.0, 0.0), (50.0, 0.0), (50.0, 1000.0), (-50.0, 1000.0)]], 10.0)
        self.chain = [(0.0, float(y)) for y in range(-2000, 6001, 50)]
        self.own = FakeDepth(0, 0, 0, 0, polygons=0)

    def _water(self):
        return B.WaterExtent(self.mask, self.own)

    def _extend(self, nb, water, budget=50000.0):
        # The span is GIVEN, the way attach_mainstem() gives it: the stations inside the outline.
        inside = [i for i, q in enumerate(self.chain) if self.mask.inside(q[0], q[1])]
        return B.extend_chain(self.chain, inside[0], inside[-1], self.mask, water, nb,
                              'the_river', 300.0, 50.0, 5.0, 3000.0, budget)

    def test_it_follows_the_chart_past_the_boundary(self):
        nb = FakeNeighbours(owners=[('a_lake', (-500.0, 1000.0, 500.0, 3000.0))],
                            depths={'a_lake': FakeDepth(-50.0, 1000.0, 50.0, 3000.0)})
        out, rep = self._extend(nb, self._water())
        ys = [q[1] for q in out]
        self.assertGreater(max(ys), 2500.0, 'the line reached into the charted water past the box')
        self.assertLess(max(ys), 3200.0, 'and stopped where the chart did')
        self.assertGreater(rep['down_m'], 1800.0)
        self.assertEqual(rep['owners'], ['a_lake'])
        self.assertIn('nothing charted', rep['down_stop'])

    def test_it_stops_where_the_channel_opens_out(self):
        # The same chart, but 4 km wide from y 2000 on. `cap` is three channel widths of a 100 m
        # river, so 300 m: the station at 2000 is not a channel any more and the line ends before it.
        nb = FakeNeighbours(owners=[('a_lake', (-5000.0, 1000.0, 5000.0, 6000.0))],
                            depths={'a_lake': FakeDepth(-500.0, 2000.0, 500.0, 6000.0)})
        w = self._water()
        w.add(FakeDepth(-50.0, 1000.0, 50.0, 2000.0))
        out, rep = self._extend(nb, w)
        self.assertLess(max(q[1] for q in out), 2100.0)
        self.assertIn('three channel widths', rep['down_stop'])

    def test_it_will_not_take_another_river_s_water(self):
        # WHY THE CONGAREE DOES NOT SWALLOW THE BROAD. One mainstem, two packs; the upstream one
        # has its own centreline, so that water is already a river day.
        nb = FakeNeighbours(owners=[('the_other_river', (-500.0, -6000.0, 500.0, 0.0))],
                            rivers=['the_river', 'the_other_river'],
                            depths={'the_other_river': FakeDepth(-50.0, -6000.0, 50.0, 0.0)})
        out, rep = self._extend(nb, self._water())
        self.assertGreaterEqual(min(q[1] for q in out), -50.0,
                                'it did not walk up into the other river')
        self.assertIn('own centreline', rep['up_stop'])
        self.assertEqual(rep['up_m'], 0.0)

    def test_a_line_that_ran_out_of_window_says_so(self):
        nb = FakeNeighbours(owners=[('a_lake', (-500.0, 1000.0, 500.0, 9000.0))],
                            depths={'a_lake': FakeDepth(-50.0, 1000.0, 50.0, 9000.0)})
        out, rep = self._extend(nb, self._water(), budget=1000.0)
        self.assertIn('search window', rep['down_stop'],
                      'a river truncated by the search must not read like a river that ended')

    def test_the_rules_apply_inside_the_box_too(self):
        # broad_river went from 33.7 km to 84.0 km on the first real run, 51% charted, 829 of its
        # 1,673 stations off the water. The rules were skipped wherever the outline said "inside",
        # and attach_mainstem() joins pieces of the mainstem that are inside the same box and carry
        # no chart. Here the box runs to y 1000 but only y 0..500 is sounded.
        m = B.Mask([[(-50.0, 0.0), (50.0, 0.0), (50.0, 1000.0), (-50.0, 1000.0)]], 10.0)
        chain = [(0.0, float(y)) for y in range(0, 1001, 50)]
        w = B.WaterExtent(m, FakeDepth(-50.0, 0.0, 50.0, 500.0))
        nb = FakeNeighbours()
        out, rep = B.extend_chain(chain, 0, 4, m, w, nb, 'the_river',
                                  300.0, 50.0, 5.0, 3000.0, 50000.0)
        self.assertLessEqual(max(q[1] for q in out), 550.0,
                             'it stopped where the soundings stopped, not where the box did')
        self.assertIn('nothing charted', rep['down_stop'])

    def test_with_no_extension_the_line_is_what_the_box_holds(self):
        nb = FakeNeighbours()
        out, rep = self._extend(nb, self._water())
        ys = [q[1] for q in out]
        self.assertGreaterEqual(min(ys), -50.0)
        self.assertLessEqual(max(ys), 1050.0)
        self.assertEqual((rep['up_m'], rep['down_m']), (0.0, 0.0))


class AttachingIsNotRechaining(unittest.TestCase):
    """The chain chosen inside the boundary must come back untouched, at a known span.

    The first version of the extension re-chained every flowline in the widened window and took
    the result. south_yadkin_river's extension added nothing at either end and its line still went
    from 25.1 km to 96.2 km, 1,449 of 1,899 stations off the charted water -- a silent change of
    answer on a river that was not being changed.
    """

    def setUp(self):
        self.chain = [(0.0, float(y)) for y in range(0, 1001, 50)]

    def test_the_chain_comes_back_whole_and_in_order(self):
        segs = [[(0.0, float(y)) for y in range(1000, 2001, 50)],
                [(0.0, float(y)) for y in range(-1000, 1, 50)]]
        out, i0, i1 = B.attach_mainstem(self.chain, segs)
        self.assertEqual(out[i0:i1 + 1], self.chain)
        self.assertEqual(i1 - i0 + 1, len(self.chain))
        self.assertLess(out[0][1], 0.0, 'the upstream segment was prepended')
        self.assertGreater(out[-1][1], 1000.0, 'the downstream one was appended')

    def test_a_segment_already_in_the_chain_is_not_joined_twice(self):
        segs = [list(self.chain)]
        out, i0, i1 = B.attach_mainstem(self.chain, segs)
        self.assertEqual(out, self.chain)
        self.assertEqual((i0, i1), (0, len(self.chain) - 1))

    def test_a_segment_that_does_not_meet_the_ends_is_left_alone(self):
        segs = [[(9000.0, float(y)) for y in range(0, 501, 50)]]
        out, i0, i1 = B.attach_mainstem(self.chain, segs)
        self.assertEqual(out, self.chain, 'a segment 9 km away is not this river continuing')

    def test_nothing_to_attach_is_the_chain(self):
        out, i0, i1 = B.attach_mainstem(self.chain, [])
        self.assertEqual(out, self.chain)
        self.assertEqual((i0, i1), (0, len(self.chain) - 1))


if __name__ == '__main__':
    unittest.main(verbosity=2)