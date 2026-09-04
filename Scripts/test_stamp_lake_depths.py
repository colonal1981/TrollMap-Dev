#!/usr/bin/env python3
"""test_stamp_lake_depths.py -- the decision that writes to Ryan's registry.

    py .\scripts\test_stamp_lake_depths.py

The measuring is js/utils/pack-facts.js and is tested where it lives. What is tested here is the
one function in this script that MUTATES lake_index.json, because a wrong write there is a wrong
number in every plan on that water until somebody notices.

Personal use only, not for distribution or resale; not for navigation.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stamp_lake_depths as S                                   # noqa: E402

STAMP = {'bytes': 18582646, 'mtime': 1787521623}


class ApplyResult(unittest.TestCase):
    def test_a_trusted_average_is_written_with_the_max(self):
        row = {}
        v = S.apply_result(row, STAMP, {'ok': True, 'maxDepthFt': 66, 'averageDepthFt': 18.5})
        self.assertEqual(v, 'trusted')
        self.assertEqual(row['max_depth_ft'], 66)
        self.assertEqual(row['avg_depth_ft'], 18.5)
        self.assertEqual(row['depth_stamp'], STAMP)

    def test_an_untrusted_average_is_not_written_and_the_max_still_is(self):
        # 43 of 355 rows land here card-wide, and they are the coastal zones and the rivers: the
        # depth bands cover a fraction of the boundary, so an "average depth" over one is not a
        # number about fishing.
        row = {}
        v = S.apply_result(row, STAMP, {'ok': False, 'maxDepthFt': 16,
                                        'averageDepthFtPartial': 0.7, 'coverage': 0.246})
        self.assertEqual(v, 'max only')
        self.assertEqual(row['max_depth_ft'], 16)
        self.assertNotIn('avg_depth_ft', row)

    def test_an_average_that_stops_being_trusted_is_REMOVED(self):
        # A re-cut chart can drop a water below the coverage bar. The old average must not stand
        # beside a new max as though both came off the same pack.
        row = {'max_depth_ft': 20, 'avg_depth_ft': 9.9}
        S.apply_result(row, STAMP, {'ok': False, 'maxDepthFt': 22})
        self.assertEqual(row['max_depth_ft'], 22)
        self.assertNotIn('avg_depth_ft', row)

    def test_a_failed_pack_writes_nothing_at_all(self):
        # Including the stamp: a row stamped on a failure would be skipped forever after.
        for res in ({'error': 'no depth_areas.geojson and no contours.geojson'},
                    {'ok': True, 'maxDepthFt': None},
                    {'ok': True}):
            row = {'max_depth_ft': 40, 'avg_depth_ft': 12}
            self.assertEqual(S.apply_result(row, STAMP, res), 'failed')
            self.assertEqual(row, {'max_depth_ft': 40, 'avg_depth_ft': 12})


class Stamps(unittest.TestCase):
    def test_the_stamp_is_the_file_it_read(self):
        st = S.stamp_of(os.path.abspath(__file__))
        self.assertEqual(sorted(st), ['bytes', 'mtime'])
        self.assertGreater(st['bytes'], 0)

    def test_depth_areas_wins_over_contours_and_absence_is_none(self):
        # deriveDepthStatistics only falls back to contours when there are no depth areas --
        # 1,513 of 1,566 packs never need them, and on Thurmond that file is another 133 MB.
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(S.depth_file(d))
            open(os.path.join(d, 'contours.geojson'), 'w').close()
            self.assertTrue(S.depth_file(d).endswith('contours.geojson'))
            open(os.path.join(d, 'depth_areas.geojson'), 'w').close()
            self.assertTrue(S.depth_file(d).endswith('depth_areas.geojson'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
