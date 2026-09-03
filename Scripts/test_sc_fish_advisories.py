#!/usr/bin/env python3
"""
test_sc_fish_advisories.py -- the parser must read the water Ryan checked by hand.

Personal use only, not for distribution or resale; not for navigation.

Lake H.B. Robinson is the calibration target because it is the water this source was found for
and the only one whose full advisory has been read by a person. Both renderings below are real:
the first is how the map popup laid it out, the second is how a summarising reader rendered the
same attribute. NOTHING HERE KNOWS WHICH ONE THE SERVER ACTUALLY SENDS -- the sandbox has no
network -- so the parser must read both and the run must say what it could not read.

    py test_sc_fish_advisories.py
"""

import importlib.util
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('fsa', HERE / 'fetch_sc_fish_advisories.py')
M = importlib.util.module_from_spec(spec)
sys.modules['fsa'] = M
spec.loader.exec_module(M)

# Verbatim from the map popup, 2026-09-03.
POPUP = """Bass- Largemouth
One meal per month
Bluegill
One meal per week
Bowfin (Mudfish)
DO NOT EAT ANY
Chain Pickerel
One meal per week
Sunfish- Redear
No Restrictions
Warmouth
One meal per week"""

# The same field as a colon/semicolon string.
INLINE = ('Bass- Largemouth: One meal per month; Bluegill: One meal per week; '
          'Bowfin (Mudfish): DO NOT EAT ANY; Chain Pickerel: One meal per week; '
          'Sunfish- Redear: No Restrictions; Warmouth: One meal per week')

EXPECTED = [
    ('Largemouth Bass', 'One meal per month'),
    ('Bluegill', 'One meal per week'),
    ('Bowfin (Mudfish)', 'DO NOT EAT ANY'),
    ('Chain Pickerel', 'One meal per week'),
    ('Redear Sunfish', 'No Restrictions'),
    ('Warmouth', 'One meal per week'),
]


class TheNames(unittest.TestCase):
    def test_the_inverted_form_is_turned_back_into_a_fish(self):
        # 'Bass- Largemouth' is how a table is SORTED, not how a fish is called.
        self.assertEqual(M.uninvert('Bass- Largemouth'), 'Largemouth Bass')
        self.assertEqual(M.uninvert('Sunfish- Redear'), 'Redear Sunfish')
        self.assertEqual(M.uninvert('Crappie- Black'), 'Black Crappie')
        self.assertEqual(M.uninvert('Bass- Spotted'), 'Spotted Bass')

    def test_a_parenthetical_is_left_alone(self):
        # species_alternates() already expands 'Bowfin (Mudfish)' into both halves; splitting it
        # here would be a second normaliser doing the same job slightly differently.
        self.assertEqual(M.uninvert('Bowfin (Mudfish)'), 'Bowfin (Mudfish)')
        self.assertEqual(M.uninvert('Warmouth'), 'Warmouth')

    def test_a_hyphen_inside_a_name_is_not_an_inversion(self):
        self.assertEqual(M.uninvert('Bluegill'), 'Bluegill')
        self.assertEqual(M.uninvert(''), '')
        self.assertEqual(M.uninvert(None), '')


class TheRestrictionText(unittest.TestCase):
    def test_the_popup_shape_reads_all_six(self):
        pairs, unparsed = M.parse_restrictions(POPUP)
        self.assertEqual([(p['species'], p['advice']) for p in pairs], EXPECTED)
        self.assertEqual(unparsed, [])

    def test_the_inline_shape_reads_the_same_six(self):
        pairs, unparsed = M.parse_restrictions(INLINE)
        self.assertEqual([(p['species'], p['advice']) for p in pairs], EXPECTED)
        self.assertEqual(unparsed, [])

    def test_what_was_published_is_kept_beside_what_we_call_it(self):
        # The state's own words have to survive, or nothing can be checked against the page.
        pairs, _ = M.parse_restrictions(POPUP)
        by = {p['species']: p['published_as'] for p in pairs}
        self.assertEqual(by['Largemouth Bass'], 'Bass- Largemouth')
        self.assertEqual(by['Redear Sunfish'], 'Sunfish- Redear')

    def test_text_the_parser_cannot_read_is_returned_not_dropped(self):
        # THE WHOLE POINT. A line nobody anticipated must show up in the run, not vanish.
        pairs, unparsed = M.parse_restrictions(
            'Bluegill\nOne meal per week\nsome sentence the state added later')
        self.assertEqual([p['species'] for p in pairs], ['Bluegill'])
        self.assertEqual(unparsed, ['some sentence the state added later'])

    def test_empty_is_empty_and_never_a_throw(self):
        for v in (None, '', '   '):
            self.assertEqual(M.parse_restrictions(v), ([], []))

    def test_do_not_eat_is_its_own_question(self):
        self.assertTrue(M.do_not_eat('DO NOT EAT ANY'))
        self.assertTrue(M.do_not_eat('Do not eat any'))
        self.assertFalse(M.do_not_eat('One meal per week'))
        self.assertFalse(M.do_not_eat('No Restrictions'))
        self.assertFalse(M.do_not_eat(None))

    def test_no_restrictions_is_still_a_species_that_is_present(self):
        # A fish with no restriction is a fish the state sampled HERE. Dropping it because the
        # advice is boring would throw away the presence fact, which is the point of the source.
        pairs, _ = M.parse_restrictions(POPUP)
        self.assertIn('Redear Sunfish', [p['species'] for p in pairs])


class TheNameGate(unittest.TestCase):
    def test_a_generic_word_is_not_agreement(self):
        # 'Lake' identifies nothing. This is the gate that stops an advisory landing on the
        # wrong water, and it is the same rule the ATTAINS binder and the Duke alert matcher use.
        self.assertEqual(M.name_agrees('Lake Robinson', 'Lake Wateree (Kershaw Co, SC)'), set())
        self.assertEqual(M.name_agrees('Big Creek', 'Little Creek (Aiken Co, SC)'), set())

    def test_a_real_name_agrees(self):
        self.assertIn('robinson',
                      M.name_agrees('Lake H.B. Robinson', 'Lake Robinson (Chesterfield Co, SC)'))
        self.assertIn('jocassee',
                      M.name_agrees('Lake Jocassee', 'Lake Jocassee (Oconee Co, SC)'))

    def test_the_two_lake_robinsons_both_agree_on_the_name(self):
        # WHICH IS WHY GEOMETRY IS NOT OPTIONAL. Both SC Lake Robinsons share `robinson`; only
        # one of them is 61 km from Sumter and only one of them the polygon overlaps. The name
        # gate cannot separate these two and is not asked to.
        a = M.name_agrees('Lake H.B. Robinson', 'Lake Robinson (Chesterfield Co, SC)')
        b = M.name_agrees('Lake H.B. Robinson', 'Lake Robinson (Greer) (Greenville Co, SC)')
        self.assertTrue(a and b)


def cw(x, y, d):
    """A clockwise ring -- how ArcGIS writes an EXTERIOR."""
    return [[x, y], [x, y + d], [x + d, y + d], [x + d, y], [x, y]]


def ccw(x, y, d):
    """A counter-clockwise ring -- how ArcGIS writes a HOLE."""
    return [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]


class TheRingShape(unittest.TestCase):
    """THE BUG THIS CLASS EXISTS FOR: the first version returned a FLAT list of rings.

    geomcore._shapely_geom() reads `p[0]` as the exterior and `p[1:]` as holes, so a flat list
    made `p[0]` a single coordinate pair, `len(p[0]) < 4` was true for every feature, and the
    binder reported "advisory polygon did not build" on all of them -- a total failure that
    looked like a data problem. Caught by driving the binder with a fixture before handing the
    script over, which is the only reason it was caught at all.
    """

    def test_a_clockwise_ring_is_one_polygon(self):
        self.assertEqual(len(M.arcgis_polygons({'rings': [cw(-80.2, 34.4, 0.1)]})), 1)

    def test_a_counter_clockwise_ring_after_it_is_a_hole_in_it(self):
        p = M.arcgis_polygons({'rings': [cw(-80.2, 34.4, 0.1), ccw(-80.18, 34.42, 0.02)]})
        self.assertEqual(len(p), 1)
        self.assertEqual(len(p[0]), 2, 'exterior plus one hole')

    def test_two_clockwise_rings_are_two_polygons(self):
        p = M.arcgis_polygons({'rings': [cw(-80.2, 34.4, 0.1), cw(-80.0, 34.4, 0.1)]})
        self.assertEqual(len(p), 2)

    def test_all_one_winding_still_returns_something(self):
        # A producer that ignores the convention must not silently cost us the water.
        p = M.arcgis_polygons({'rings': [ccw(-80.2, 34.4, 0.1), ccw(-80.18, 34.42, 0.02)]})
        self.assertEqual(len(p), 1)
        self.assertEqual(len(p[0][0]), 5, 'the largest ring is the exterior')

    def test_junk_geometry_is_empty_not_a_throw(self):
        for g in (None, {}, {'rings': []}, {'rings': [[[1, 2]]]}):
            self.assertEqual(M.arcgis_polygons(g), [])


class TheBinding(unittest.TestCase):
    """GEOMETRY IS WHAT SEPARATES THE TWO LAKE ROBINSONS. The name cannot."""

    def _run(self, advisory_ring):
        import json
        import os
        import tempfile
        try:
            import shapely  # noqa: F401
        except ImportError:
            self.skipTest('shapely not installed -- THE BINDER IS NOT BEING CHECKED')
        with tempfile.TemporaryDirectory() as td:
            bd = os.path.join(td, 'boundaries')
            os.makedirs(bd)
            for slug, x, y in (('lake_robinson', -80.2, 34.4),
                               ('lake_robinson_greer', -82.4, 34.9)):
                json.dump({'type': 'Feature', 'properties': {},
                           'geometry': {'type': 'Polygon', 'coordinates': [ccw(x, y, 0.1)]}},
                          open(os.path.join(bd, slug + '.geojson'), 'w'))
            index = {
                'lake_robinson': {'state': 'SC',
                                  'display_name': 'Lake Robinson (Chesterfield Co, SC)'},
                'lake_robinson_greer': {'state': 'SC',
                                        'display_name': 'Lake Robinson (Greer) (Greenville Co, SC)'},
                'lake_norman': {'state': 'NC', 'display_name': 'Lake Norman (Iredell Co, NC)'},
            }
            feats = [{'attributes': {
                'NAME': 'Lake H.B. Robinson', 'ADVISORY': 'Mercury', 'Basin': 'PeeDee',
                'TYPE': 'Lake/Pond',
                'Waterbody_URL': 'Bass- Largemouth: One meal per month; '
                                 'Bowfin (Mudfish): DO NOT EAT ANY; '
                                 'Sunfish- Redear: No Restrictions'},
                'geometry': {'rings': [advisory_ring]}}]
            return M.build({'2': feats, '3': []}, index, bd)

    def test_it_lands_on_the_lake_the_polygon_overlaps(self):
        out = self._run(cw(-80.19, 34.41, 0.05))
        self.assertEqual(list(out['waters']), ['lake_robinson'])
        rec = out['waters']['lake_robinson']
        self.assertEqual([s['species'] for s in rec['species']],
                         ['Largemouth Bass', 'Bowfin (Mudfish)', 'Redear Sunfish'])
        self.assertEqual(rec['do_not_eat'], ['Bowfin (Mudfish)'])
        self.assertEqual(rec['advisories'][0]['confidence'], 'name+geom')
        self.assertEqual(rec['advisories'][0]['matched_on']['tokens'], ['robinson'])

    def test_a_polygon_over_neither_binds_to_neither(self):
        # Name alone would have matched both Robinsons. Geometry refuses.
        out = self._run(cw(-79.0, 33.0, 0.05))
        self.assertEqual(out['waters'], {})
        self.assertEqual(len(out['unbound']), 1)

    def test_the_record_says_it_is_a_floor_and_not_a_roster(self):
        out = self._run(cw(-80.19, 34.41, 0.05))
        self.assertIn('PRESENCE FLOOR', out['waters']['lake_robinson']['basis'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
