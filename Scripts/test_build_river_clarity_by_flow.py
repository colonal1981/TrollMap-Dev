#!/usr/bin/env python3
r"""test_build_river_clarity_by_flow.py -- the band a reading is filed under is the card's band.

    py .\scripts\test_build_river_clarity_by_flow.py

Personal use only, not for distribution or resale; not for navigation.
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_river_clarity_by_flow as B                        # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ST = {'p10': 100.0, 'p25': 200.0, 'p50': 400.0, 'p75': 800.0, 'p90': 1600.0}


class TheBandIsTheCardsBand(unittest.TestCase):
    def test_every_edge_lands_where_statBand_puts_it(self):
        # statBand(): below the first set point, at-or-above the last, else [lo, hi).
        self.assertEqual(B.stat_band(99, ST), 'below the 10th percentile')
        self.assertEqual(B.stat_band(100, ST), 'between the 10th and 25th percentile')
        self.assertEqual(B.stat_band(399.9, ST), 'between the 25th and 50th percentile')
        self.assertEqual(B.stat_band(400, ST), 'between the 50th and 75th percentile')
        self.assertEqual(B.stat_band(1600, ST), 'above the 90th percentile')

    def test_a_missing_set_point_is_skipped_exactly_as_the_card_skips_it(self):
        st = dict(ST, p90=None)
        self.assertEqual(B.stat_band(5000, st), 'above the 75th percentile')

    def test_the_labels_are_the_workers_own_words(self):
        js = open(os.path.join(HERE, '..', 'Worker', 'conditions.js'), encoding='utf-8').read()
        body = js[js.index('export function statBand'):js.index('async function flowVsHistory')]
        for pattern in ('below the ${steps[0][1]}th percentile',
                        'above the ${steps[steps.length - 1][1]}th percentile',
                        'between the ${below}th and ${above}th percentile'):
            self.assertIn(pattern, body)

    def test_an_empty_cell_is_not_a_zero(self):
        rdb = ('agency_cd\tsite_no\tparameter_cd\tts_id\tloc_web_ds\tmonth_nu\tday_nu\tbegin_yr\tend_yr'
               '\tcount_nu\tp10_va\tp25_va\tp50_va\tp75_va\tp90_va\n5s\t15s\t5s\t10n\t15s\t3n\t3n\t6n\t6n'
               '\t8n\t12s\t12s\t12s\t12s\t12s\nUSGS\t02153200\t00060\t1\t\t9\t24\t1990\t2025\t35\t\t200\t400\t800\t1600\n')
        st = B.parse_daily_stats(rdb)[(9, 24)]
        self.assertIsNone(st['p10'])
        self.assertEqual(B.stat_band(50, st), 'below the 25th percentile')


class Summaries(unittest.TestCase):
    def test_median_and_count_per_kind(self):
        s = B.summarise([('turbidity', 5), ('turbidity', 9), ('turbidity', 7), ('secchi', 2.5)])
        self.assertEqual(s, {'turbidity': {'median_ntu': 7, 'n': 3}, 'secchi': {'median_ft': 2.5, 'n': 1}})
        self.assertEqual(B.median([1, 2, 3, 4]), 2.5)

    def test_normal_is_the_middle_half(self):
        self.assertEqual(B.NORMAL, {'between the 25th and 50th percentile',
                                    'between the 50th and 75th percentile'})


class OnTheWater(unittest.TestCase):
    def test_a_station_in_the_island_is_not_on_the_water(self):
        polys = B.polygons_of({'type': 'Polygon', 'coordinates': [
            [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
            [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]]})
        self.assertTrue(B.on_water(polys, 1, 1))
        self.assertFalse(B.on_water(polys, 5, 5))
        self.assertFalse(B.on_water(polys, 11, 1))

    def test_every_bound_discharge_gauge_gets_its_own_table(self):
        b = {'pool': None, 'tailwater': {'usgs_site': 'A', 'parms': ['00060', '00065']},
             'gauges': [{'usgs_site': 'B', 'usgs_parms': ['00060']}, {'usgs_site': 'C', 'parms': ['00065']},
                        {'usgs_site': 'A', 'parms': ['00060']}]}
        self.assertEqual(B.flow_sites(b), ['A', 'B'])


if __name__ == '__main__':
    unittest.main()
