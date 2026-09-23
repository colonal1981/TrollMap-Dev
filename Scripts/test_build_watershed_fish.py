#!/usr/bin/env python3
r"""test_build_watershed_fish.py -- the parsing and the three rules the watershed build rests on.

    py .\scripts\test_build_watershed_fish.py

Personal use only, not for distribution or resale; not for navigation.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_watershed_fish as B                               # noqa: E402

# One real row off fishmap.org/watershed.html?huc=06010108, 2026-09-23, and the spacer after it.
FISHMAP_ROWS = (
    '<tr><td><a href="/species/Channel-Darter.html">Channel Darter</a></td><td><i>Percina copelandi'
    '</i></td><td>Native</td><td><font color="#BA0000"><strong>Historic</strong></font></td><td>'
    '<a href="http://www.natureserve.org/x" target="_new">NatureServe</a></td></tr>'
    '<tr><td colspan="5">&nbsp;&nbsp;</td></tr>'
    '<tr><td><a href="/species/Smallmouth-Bass.html">Smallmouth Bass</a></td><td><i>Micropterus '
    'dolomieu</i></td><td>Native</td><td>Current</td><td><a href="x">NatureServe</a></td></tr>'
    '<tr><td><b>Common Name</b></td><td><b>Scientific Name</b></td><td>Origin</td><td>Occurrence'
    '</td><td>Source</td></tr>')


class ParseFishmap(unittest.TestCase):
    def test_rows_are_read_by_shape(self):
        rows = B.parse_fishmap(FISHMAP_ROWS)
        self.assertEqual([r["scientific"] for r in rows], ["Percina copelandi", "Micropterus dolomieu"])
        self.assertEqual(rows[0]["occurrence"], "historic")
        self.assertEqual(rows[1]["origin"], "native")

    def test_an_empty_page_is_no_rows_not_an_error(self):
        self.assertEqual(B.parse_fishmap(""), [])
        self.assertEqual(B.parse_fishmap(None), [])


class ParseNas(unittest.TestCase):
    def test_a_record_keeps_status_year_and_point(self):
        doc = {"results": [{"scientificName": "Alosa aestivalis", "commonName": "Blueback Herring",
                            "family": "Clupeidae", "status": "established", "year": 2009,
                            "locality": "Keowee Reservoir [=Lake Keowee]",
                            "decimalLatitude": 34.72843, "decimalLongitude": -82.9132,
                            "latLongAccuracy": "Approximate"}]}
        r = B.parse_nas(doc)[0]
        self.assertEqual((r["status"], r["year"], r["lat"], r["lon"]),
                         ("established", 2009, 34.72843, -82.9132))

    def test_a_record_with_no_name_is_dropped(self):
        self.assertEqual(B.parse_nas({"results": [{"scientificName": ""}]}), [])


class WhatCountsAsLivingThere(unittest.TestCase):
    def test_a_current_native_does(self):
        self.assertEqual(B.present({"native": {"occurrence": "current"}}), (True, "native"))

    def test_a_historic_native_does_not(self):
        self.assertEqual(B.present({"native": {"occurrence": "historic"}}), (False, None))

    def test_an_established_or_stocked_introduction_does(self):
        for st in ("established", "stocked"):
            self.assertEqual(B.present({"introduced": {"statuses": [st]}}), (True, "introduced"))

    def test_collected_once_or_failed_does_not(self):
        # NAS's own words for "it was seen" and "it did not take" -- not "it lives here".
        for st in (["collected"], ["failed"], ["unknown"], [""]):
            self.assertEqual(B.present({"introduced": {"statuses": st}}), (False, None))


class NatureServesExoticRowsAreNotRead(unittest.TestCase):
    """NatureServe's metadata: its exotic rows 'are primarily derived from expert review of
    published records thought (falsely) to represent native occurrence ... recommend that this
    data be excluded'. Only a Native row is taken from it; introductions come from USGS."""

    def test_an_introduced_natureserve_row_carries_nothing(self):
        t = B.watershed_table([{"common": "X", "scientific": "Genus species", "origin": "introduced",
                                "occurrence": "current", "source": "NatureServe"}], [], {}, {})
        self.assertEqual(t["Genus species"]["native"], None)
        self.assertEqual(B.present(t["Genus species"]), (False, None))


class TheWatershedLineHasAWidth(unittest.TestCase):
    def test_the_number_is_the_wbd_s_own_accuracy(self):
        # 1:24,000 NMAS: 1/50 inch at scale = 40 ft = 12.2 m. Not a chosen share.
        self.assertAlmostEqual(B.WBD_POSITIONAL_ACCURACY_M, 40 * 0.3048, places=1)


class DerivedListsForOneWater(unittest.TestCase):
    def test_roles_and_evidence_are_kept_apart(self):
        from shapely.geometry import box
        water = box(-83.0, 34.7, -82.8, 34.8)
        tables = {"03060101": {
            "Alosa aestivalis": {"name": "Blueback Herring", "role": "forage", "family": "Alosidae",
                                 "native": None,
                                 "introduced": {"statuses": ["established"], "records": 1,
                                                "last_year": 2009,
                                                "_pts": [(-82.9132, 34.72843, "established")]}},
            "Micropterus dolomieu": {"name": "Smallmouth Bass", "role": "target",
                                     "family": "Centrarchidae", "native": {"occurrence": "current"},
                                     "introduced": None},
            "Percina copelandi": {"name": None, "role": None, "family": "Percidae",
                                  "native": {"occurrence": "historic"}, "introduced": None},
            "Salmo trutta": {"name": "Brown Trout", "role": "target", "family": "Salmonidae",
                             "native": None, "introduced": {"statuses": ["failed"], "records": 1,
                                                            "last_year": 1990, "_pts": []}},
        }}
        d = B.derive_water(water, [{"huc8": "03060101", "name": "Seneca", "share": 1.0}], tables)
        self.assertEqual([t["name"] for t in d["targets"]], ["Smallmouth Bass"])
        self.assertEqual([f["name"] for f in d["forage"]], ["Blueback Herring"])
        self.assertEqual(d["forage"][0]["in_water"], 1)
        self.assertEqual(d["reported"], {"Brown Trout": ["failed"]})
        # A historic native with no app name counts nowhere, and not in the living families.
        self.assertNotIn("Percidae", d["families"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
