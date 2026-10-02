#!/usr/bin/env python3
"""
test_build_moving_water.py -- the gauges each lake gets are derived, not named.

Personal use only, not for distribution or resale; not for navigation.

    python3 Scripts/test_build_moving_water.py
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_moving_water as bmw  # noqa: E402


def write(p, obj):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding='utf-8') as fh:
        json.dump(obj, fh)


class FakeParams:
    def __init__(self, sites):
        self.sites = sites
        self.asked = 0
        self.read_at = 'test'

    def prefetch(self, gauges):
        self.seen = [g['usgs_site'] for g in gauges]

    def of(self, site):
        return self.sites.get(site, [])


class Build(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        reg, cp = os.path.join(self.d, 'registry'), os.path.join(self.d, 'chartpack')
        write(os.path.join(reg, 'lake_index.json'), {
            'a_lake': {'name': 'A Lake', 'feature_type': 'lake', 'centroid': [-80.0, 33.0]},
            'b_lake': {'name': 'B Lake', 'feature_type': 'lake', 'centroid': [-80.5, 33.5]},
            'out_river': {'name': 'Out River', 'feature_type': 'river'},
            'in_river': {'name': 'In River', 'feature_type': 'river'},
        })
        write(os.path.join(reg, 'water_chain.json'), {'waters': {
            'a_lake': {'outlets': ['out_river', 'b_lake'], 'upstream': ['in_river'], 'routed_drainage_km2': 2589.988},
            'b_lake': {'outlets': [], 'upstream': []},
        }})
        g = lambda site, lon, lat: {'usgs_site': site, 'lat': lat, 'lon': lon, 'name': f'G{site}'}
        write(os.path.join(reg, 'water_bindings.json'), {'bindings': {
            'a_lake': {'pool': g('100', -80.0, 33.0)},
            'b_lake': {'pool': g('200', -80.5, 33.5)},
            # The nearer outlet gauge reports only stage, so the next one, with discharge, is taken.
            'out_river': {'gauges': [g('301', -79.99, 33.0), g('302', -79.95, 33.0), g('303', -79.5, 33.0)]},
            'in_river': {'gauges': [g('401', -80.3, 33.0), g('402', -80.05, 33.0)]},
        }})
        write(os.path.join(cp, 'a_lake', 'waterbody.geojson'), {'features': [{'geometry': {
            'type': 'Polygon', 'coordinates': [[[-80.02, 32.98], [-80.0, 33.02], [-79.98, 32.98], [-80.02, 32.98]]]}}]})
        self.reg, self.cp = reg, cp

    def test_derives_level_outflow_inflow_and_skips_a_lake_outlet(self):
        params = FakeParams({'100': ['00062'], '301': ['00065'], '302': ['00060'], '303': ['00060'],
                             '401': ['00060'], '402': ['00065'], '200': []})
        # 1,000 sq mi through the lake; the outlet gauge sees 1,500 (most came through the lake),
        # the inlet gauge 800 (most of what flows in).
        table, report = bmw.build(self.reg, self.cp, params, drainage={'302': 1500.0, '402': 800.0})
        rows = {r['role']: r for r in table['a_lake']}
        self.assertEqual(rows['level']['site'], '100')
        self.assertEqual(rows['level']['param'], '00062')
        self.assertEqual(rows['outflow']['site'], '302')          # nearest with discharge, not 301
        self.assertEqual(rows['outflow']['via'], 'out_river')
        self.assertEqual(rows['inflow']['site'], '402')           # nearest; stage is enough for inflow
        self.assertEqual(rows['inflow']['param'], '00065')
        self.assertIn('outflow b_lake is a lake, not a river', report['a_lake']['why_not'])
        # b_lake's pool gauge reports no level now, so b_lake gets nothing and says why.
        self.assertNotIn('b_lake', table)
        self.assertTrue(any('reports no lake level' in w for w in report['b_lake']['why_not']))

    def test_a_gauge_that_is_mostly_other_water_is_not_this_lakes(self):
        params = FakeParams({'100': ['00062'], '302': ['00060'], '402': ['00065']})
        table, report = bmw.build(self.reg, self.cp, params, drainage={'302': 8850.0, '402': 140.0})
        self.assertEqual([r['role'] for r in table['a_lake']], ['level'])
        why = ' '.join(report['a_lake']['why_not'])
        self.assertIn('1,000 of its 8,850 sq mi come through the lake, not most', why)
        self.assertIn("inflow gauges carry 140 of the lake's 1,000 sq mi, not most", why)

    def test_a_gauge_filed_under_two_rivers_goes_to_the_one_its_name_says(self):
        g = {'usgs_site': '9', 'lat': 33.0, 'lon': -80.0, 'name': 'Congaree River above Fort Motte'}
        h = {'usgs_site': '8', 'lat': 33.0, 'lon': -80.3, 'name': 'Wateree R. bl Eastover'}
        params = FakeParams({'9': ['00065'], '8': ['00060']})
        pick = bmw.nearest_reporting([(-80.0, 33.0)], [g, h], ['00060', '00065'], params,
                                     mine={'wateree'}, others=[{'congaree'}])
        self.assertEqual(pick[0]['usgs_site'], '8')

    def test_no_lake_is_named_in_the_script(self):
        with open(bmw.__file__, encoding='utf-8') as fh:
            src = fh.read()
        code = '\n'.join(l for l in src.split('\n') if not l.strip().startswith('#'))
        code = code.split('"""', 2)[2]      # past the module docstring
        for slug in ('lake_moultrie', 'lake_marion', 'monticello', 'wateree', 'lake_murray'):
            self.assertNotIn(slug, code)


if __name__ == '__main__':
    unittest.main()
