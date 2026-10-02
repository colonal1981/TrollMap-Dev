#!/usr/bin/env python3
"""
Tests for build_pools.py -- which water a ramp can reach on its own lake (item 50).

Personal use only, not for distribution or resale; not for navigation.

    py Scripts/test_build_pools.py
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_pools  # noqa: E402


def dump(obj, path):
    with open(path, 'w') as fh:
        json.dump(obj, fh)


def sq(x0, y0, x1, y1):
    return {'type': 'Feature', 'properties': {},
            'geometry': {'type': 'Polygon',
                         'coordinates': [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}}


class Pools(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        P = os.path.join(self.root, 'test_lake')
        os.makedirs(P)
        # The main lake: two bands that touch. The pool behind the dike: one band, 0.001 deg away.
        main = [sq(0.0, 34.0, 0.02, 34.01), sq(0.02, 34.0, 0.03, 34.01)]
        behind = [sq(0.0, 34.011, 0.005, 34.016)]
        dump({'type': 'FeatureCollection', 'features': main + behind},
             os.path.join(P, 'depth_areas.geojson'))
        dump({'landings': [
            {'name': 'Main ramp', 'lat': 34.0, 'lon': 0.01, 'on_main_water': True},
            {'name': 'Unmeasured', 'lat': 34.0, 'lon': 0.025, 'on_main_water': None},
            # On the bank of the pool behind the dike, which is also next to the main lake: the
            # producer's on_main_water says which, and this file only finds which pool.
            {'name': 'Behind the dike', 'lat': 34.0165, 'lon': 0.002, 'on_main_water': False},
            {'name': 'Off main, nothing near', 'lat': 35.0, 'lon': 1.0, 'on_main_water': False},
        ]}, os.path.join(P, 'launches.json'))
        dump({'type': 'FeatureCollection', 'features': [
            {'type': 'Feature', 'properties': {}, 'geometry': {'type': 'LineString',
             'coordinates': [[0.001, 34.012], [0.004, 34.015]]}},
            {'type': 'Feature', 'properties': {}, 'geometry': {'type': 'LineString',
             'coordinates': [[0.001, 34.002], [0.019, 34.008]]}},
        ]}, os.path.join(P, 'trolling_runs.geojson'))

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_the_pool_behind_the_dike_is_written_and_the_main_one_is_not(self):
        body, stat = build_pools.pools_for('test_lake', self.root)
        self.assertEqual(len(body['pools']), 1)
        p = body['pools'][0]
        self.assertEqual(p['id'], 1)
        # 0.005 x 0.005 deg at 34 N: 461 m by 557 m, about 63.5 acres.
        self.assertTrue(60 < p['acres'] < 67, p['acres'])
        self.assertEqual(len(p['rings']), 1)
        self.assertEqual(stat['lanes_off_main'], {'1': 1})

    def test_a_ramp_on_the_main_water_stays_on_it_and_one_off_it_finds_its_pool(self):
        body, _ = build_pools.pools_for('test_lake', self.root)
        got = {l['name']: l['pool'] for l in body['landings']}
        self.assertEqual(got['Main ramp'], 0)
        self.assertEqual(got['Unmeasured'], 0, 'null is not measured, which is reachable')
        self.assertEqual(got['Behind the dike'], 1)
        self.assertIsNone(got['Off main, nothing near'])

    def test_check_mode_writes_nothing_and_says_stale(self):
        st = build_pools._one(('test_lake', self.root, True))
        self.assertTrue(st['stale'])
        self.assertFalse(os.path.exists(os.path.join(self.root, 'test_lake', 'pools.json')))
        build_pools._one(('test_lake', self.root, False))
        self.assertFalse(build_pools._one(('test_lake', self.root, True))['stale'])


if __name__ == '__main__':
    unittest.main()
