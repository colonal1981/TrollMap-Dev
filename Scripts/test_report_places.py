#!/usr/bin/env python3
r"""test_report_places.py -- the places a report names go on his chart, and only places do.

    py .\Scripts\test_report_places.py

Personal use only, not for distribution or resale; not for navigation.

A two-water registry and one water's chart names, written here, so the test reads nothing from the drive.
"""
import json, os, shutil, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import report_places as P                                     # noqa: E402

REGISTRY = {
    'lake_test': {'name': 'Lake Test', 'display_name': 'Lake Test (Kershaw Co, SC)', 'feature_type': 'lake',
                  'legacy_display_names': ['Lake Test, SC', 'Little River - Lake Test'],
                  'bounds_wsen': [-80.9, 34.2, -80.6, 34.5], 'centroid': [-80.75, 34.35]},
    'other_lake': {'name': 'Lake Keowee', 'display_name': 'Lake Keowee (Oconee Co, SC)', 'feature_type': 'lake',
                   'legacy_display_names': ['Lake Keowee, SC'], 'bounds_wsen': [-83.0, 34.7, -82.8, 34.9],
                   'centroid': [-82.9, 34.8]},
    'saluda_river': {'name': 'Saluda River', 'display_name': 'Saluda River (Richland Co, SC)', 'feature_type': 'river',
                     'bounds_wsen': [-81.5, 34.0, -80.7, 34.3], 'centroid': [-81.2, 34.1]},
    'santee_river': {'name': 'Santee River', 'display_name': 'Santee River (SC)', 'feature_type': 'river',
                     'bounds_wsen': [-80.8, 34.25, -80.65, 34.3], 'centroid': [-80.7, 34.27]},
}
POIS = [('Colonel Creek', -80.80, 34.37), ('Colonel Creek', -80.79, 34.38), ('Shoal', -80.70, 34.30),
        ('Lake Test', -80.75, 34.35), ('Lake Keowee', -80.75, 34.36), ('Richard B.', -80.7, 34.3), ('Boat Ramp', -80.7, 34.31),
        ('River Bed - Little River', -80.85, 34.25), ('River Bed - Little River', -80.70, 34.45),
        ('Blacks Camp', -80.72, 34.33)]
LANDINGS = [{'name': 'Clearwater Cove Marina (Clearwater Cove)', 'lon': -80.73, 'lat': 34.37}]


class Places(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = tempfile.mkdtemp()
        reg = os.path.join(cls.d, 'registry'); os.makedirs(reg)
        with open(os.path.join(reg, 'lake_index.json'), 'w') as fh: json.dump(REGISTRY, fh)
        pack = os.path.join(cls.d, 'chartpack', 'lake_test'); os.makedirs(pack)
        with open(os.path.join(pack, 'pois.geojson'), 'w') as fh:
            json.dump({'features': [{'type': 'Feature', 'properties': {'poi_type': 'place_name', 'name': n},
                                     'geometry': {'type': 'Point', 'coordinates': [x, y]}} for n, x, y in POIS]}, fh)
        with open(os.path.join(pack, 'launches.json'), 'w') as fh: json.dump({'landings': LANDINGS}, fh)
        cls.gaz = P.gazetteer(os.path.join(cls.d, 'chartpack'), reg, 'lake_test')
        cls.names = {g['as_written'] for g in cls.gaz}
        cls.m = P.Matcher(cls.gaz)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.d, ignore_errors=True)

    def test_the_names_are_places(self):
        for n in ('Colonel Creek', 'Blacks Camp', 'Clearwater Cove Marina', 'Clearwater Cove', 'Little River',
                  'Saluda River', 'Saluda', 'Santee River'):
            self.assertIn(n, self.names)
        for n in ('Shoal', 'Lake Test', 'Lake Keowee', 'Richard B.', 'Boat Ramp', 'Santee'):
            self.assertNotIn(n, self.names, 'a kind of thing, this water itself, another lake, a fragment, or "on Santee"')

    def test_a_name_on_the_chart_twice_is_at_its_middle_and_far_apart_says_so(self):
        cc = next(g for g in self.gaz if g['as_written'] == 'Colonel Creek')
        self.assertEqual((cc['labels'], cc.get('far_apart')), (2, None))
        lr = next(g for g in self.gaz if g['as_written'] == 'Little River')
        self.assertTrue(lr['far_apart'], 'two arms of one name are not one spot')

    def test_a_river_off_the_water_is_put_at_its_edge(self):
        s = next(g for g in self.gaz if g['as_written'] == 'Saluda River')
        self.assertEqual((s['lon'], s['lat']), (-80.9, 34.2))
        self.assertIn('edge', s['approx'])

    def test_what_a_report_names(self):
        got = lambda t: [p['name'] for p in self.m.places(t)]
        self.assertEqual(got('Good catches near Colonel Creek and up the Saluda.'), ['Colonel Creek', 'Saluda River'])
        self.assertEqual(got('Stripers at Lake Saluda are biting.'), [], '"Lake Saluda" is not the river')
        self.assertEqual(got('Fish around the colonel creek mouth.'), [], 'proper names as written')
        self.assertEqual(got("Pack's Camp (803-452-5514) reports fish near Blacks Camp."), ['Blacks Camp'],
                         'a business with its phone number is who reported')
        self.assertEqual(got('Colonel Creeks and Colonel Creek both.'), ['Colonel Creek'], 'once per statement')
        self.assertEqual(got('Fishing on Santee has been good.'), [])
        p = self.m.places('Up the Little River in 20 feet.')[0]
        self.assertTrue(p['far_apart'])

    def test_the_areas_the_words_use(self):
        self.assertEqual(P.areas('Fish the main lake points and the backs of creeks on the upper end.'),
                         ['upper lake', 'main lake', 'backs of creeks'])
        self.assertEqual(P.areas('Nothing here.'), [])

    def test_no_chart_is_no_names(self):
        self.assertEqual(P.gazetteer(os.path.join(self.d, 'nowhere'), os.path.join(self.d, 'registry'), 'other_lake'), [])


if __name__ == '__main__':
    unittest.main()
