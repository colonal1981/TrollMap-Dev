#!/usr/bin/env python3
"""
test_build_water_names.py -- a ramp may only name the water it is on.

Personal use only, not for distribution or resale; not for navigation.

    py test_build_water_names.py

THE GUARD THIS TESTS WAS MISSING FOR AS LONG AS THE FILE EXISTED. Every ramp record carries
`lat` and `lon` beside the `wb` name the harvester reads -- all 2,979 of them do -- and nothing
looked at them, so a ramp 475 m away donated its name exactly as readily as one on the bank.

Ryan checked the Charlie Elliott Wildlife Center on the map and settled what the right answer
is, so that is what is asserted here: Murder Creek Lake IS also Bennett Lake, and Lake Margery
is BOYLE MURDER LAKE, the pond next door. Before the gate, one 83-acre polygon answered to
Murder Creek Lake, Dairy Lake, Lake Bennett AND Lake Margery -- four names, three ponds.
"""

import importlib.util
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('bwn', HERE / 'build_water_names.py')
M = importlib.util.module_from_spec(spec)
sys.modules['bwn'] = M
spec.loader.exec_module(M)

try:
    from shapely.geometry import Polygon, Point
    HAVE_SHAPELY = True
except ImportError:                       # the gate turns itself off; so does this file
    HAVE_SHAPELY = False


# A square roughly 400 m on a side at Georgia's latitude, so metres_off() reads in real units.
DEG = 0.0018
SQUARE = Polygon([(-83.73, 33.45), (-83.73 + DEG, 33.45),
                  (-83.73 + DEG, 33.45 + DEG), (-83.73, 33.45 + DEG)]) if HAVE_SHAPELY else None


@unittest.skipUnless(HAVE_SHAPELY, 'shapely not installed')
class TheDistance(unittest.TestCase):
    def test_a_ramp_inside_the_water_is_zero_from_it(self):
        self.assertEqual(M.metres_off(SQUARE, 33.4509, -83.7291), 0.0)

    def test_a_ramp_on_the_bank_is_a_few_metres_off(self):
        d = M.metres_off(SQUARE, 33.45 + DEG / 2, -83.73 - 0.0002)
        self.assertLess(d, M.ON_WATER_M)
        self.assertGreater(d, 0)

    def test_a_ramp_on_the_next_pond_is_beyond_the_gate(self):
        # 0.005 deg is about 500 m, which is the Dairy Lake ramp's real distance from the
        # Murder Creek polygon.
        self.assertGreater(M.metres_off(SQUARE, 33.45 + DEG / 2, -83.73 - 0.005), M.ON_WATER_M)

    def test_it_cannot_be_measured_without_a_shape_or_a_coordinate(self):
        self.assertIsNone(M.metres_off(None, 33.45, -83.73))
        self.assertIsNone(M.metres_off(SQUARE, None, -83.73))
        self.assertIsNone(M.metres_off(SQUARE, 33.45, None))


class TheGateIsWhereTheEmptyBandIs(unittest.TestCase):
    def test_the_threshold_sits_between_the_measured_extremes(self):
        # Measured over all 180 (water, name) pairs the harvester keeps, ranked by the closest
        # ramp donating each name: the furthest CORRECT alias is Randy Poynter Lake on Black
        # Shoals Reservoir at 108 m, and the nearest WRONG one is Horseshoe 3 Lake on Horseshoe
        # Four at 133 m. A number outside that band is either throwing away real names or
        # keeping the ten wrong ones.
        self.assertGreater(M.ON_WATER_M, 108)
        self.assertLess(M.ON_WATER_M, 133)


class TheNamesStillSplitOnTheTributary(unittest.TestCase):
    """The behaviour the gate must not disturb -- the composite `wb` and the short forms."""

    def test_the_stream_test_is_a_whole_trailing_word(self):
        self.assertTrue(M.STREAMISH.search('gar creek'))
        self.assertTrue(M.STREAMISH.search('belews creek'))
        self.assertIsNone(M.STREAMISH.search('creekside lake'))

    def test_the_state_suffix_and_parenthetical_come_off_before_matching(self):
        self.assertEqual(M.norm('High Falls Lake, GA'), M.norm('high falls lake'))
        self.assertEqual(M.norm('Lake Robinson (Greer)'), M.norm('lake robinson'))
        self.assertEqual(M.norm('Tugaloo Lake, SC/GA'), M.norm('Tugaloo Lake'))


@unittest.skipUnless(HAVE_SHAPELY, 'shapely not installed')
class TheCharlieElliottPonds(unittest.TestCase):
    """The cluster that exposed it, with the distances measured off the real polygons.

    Ryan, 2026-09-03, having looked all three up: "murder creek lake is also know as Lane
    Bennett or Bennett lake... Boyle Murder lake is also known as lake margery".
    """

    CASES = [
        # (name the ramp carries, metres from Murder Creek Lake, what should happen)
        ('Lake Bennett', 21, True),     # Ryan: this IS Murder Creek Lake
        ('Lake Margery', 141, False),   # Ryan: this is Boyle Murder Lake, the pond next door
        ('Dairy Lake', 475, False),     # Ryan: Boyle Lake Number Three's ramp
    ]

    def test_only_the_ramp_on_the_water_gives_it_a_name(self):
        for nm, metres, kept in self.CASES:
            with self.subTest(nm):
                self.assertEqual(metres <= M.ON_WATER_M, kept)

    def test_the_wrong_two_are_not_close_calls(self):
        # 141 m and 475 m against a 120 m gate. If this ever gets tight the threshold is being
        # asked to do a job that needs a better signal than distance.
        self.assertGreater(141 - M.ON_WATER_M, 15)


if __name__ == '__main__':
    unittest.main(verbosity=2)
