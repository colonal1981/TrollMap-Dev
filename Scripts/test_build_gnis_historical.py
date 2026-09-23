#!/usr/bin/env python3
r"""test_build_gnis_historical.py -- inside the outline, and only on the water.

    py .\scripts\test_build_gnis_historical.py

Personal use only, not for distribution or resale; not for navigation.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_gnis_historical as G                              # noqa: E402


class Names(unittest.TestCase):
    def test_the_suffix_goes_because_the_style_says_it(self):
        self.assertEqual(G.clean_name("Peays Ferry (historical)"), "Peays Ferry")
        self.assertEqual(G.clean_name("Loyston"), "Loyston")
        self.assertEqual(G.clean_name(None), "")


class InsideNotNear(unittest.TestCase):
    """Wateree's bounding box holds nine; its outline holds seven. The two on the shore --
    Biddle and Kingsbury -- are the reason the test is the outline and not the box."""

    def test_a_point_on_the_water_is_in_and_one_on_the_shore_is_out(self):
        from shapely.geometry import Polygon
        lake = Polygon([(0, 0), (4, 0), (4, 1), (1, 1), (1, 4), (0, 4)])   # an L-shaped water
        feats = [{"name": "ferry", "lat": 0.5, "lon": 3.0},     # in the arm
                 {"name": "town", "lat": 3.0, "lon": 3.0}]      # inside the box, on the shore
        got = G.inside(feats, lake, lake.bounds)
        self.assertEqual([f["name"] for f in got], ["ferry"])


class WhatIsLeftOut(unittest.TestCase):
    def test_administrative_units_are_not_on_the_bottom(self):
        self.assertEqual(G.NOT_ON_THE_BOTTOM, {"Civil", "Census"})

    def test_coastal_zones_are_not_read(self):
        # A zone's outline includes land; inside it does not mean drowned. 44 forts and batteries
        # came in on the first run, 18 of them around Charleston.
        src = open(G.__file__, encoding="utf-8").read()
        self.assertIn('row.get("feature_type") not in ("lake", "river")', src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
